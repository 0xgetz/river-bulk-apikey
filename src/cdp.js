'use strict';

/**
 * Minimal, dependency-free Chrome DevTools Protocol client.
 *
 * Speaks the CDP JSON protocol over a WebSocket. Node's global WebSocket
 * cannot send custom headers, so we implement a tiny RFC6455 client on top of
 * `tls` for wss:// endpoints, and use it directly for plain ws:// endpoints
 * too (a local or VPS-hosted Chrome with a remote-debugging port).
 *
 * Exposes a Promise-based `send(method, params)` plus an event emitter.
 */

const tls = require('tls');
const crypto = require('crypto');
const { URL } = require('url');
const { EventEmitter } = require('events');

function frame(payload, opcode = 0x1) {
  const data = Buffer.from(payload);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

class RawWebSocket extends EventEmitter {
  constructor(wsUrl, { headers = {}, timeoutMs = 20000 } = {}) {
    super();
    this.wsUrl = wsUrl;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
    this._queue = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      const u = new URL(this.wsUrl);
      const secure = u.protocol === 'wss:';
      const port = u.port || (secure ? 443 : 80);
      const key = crypto.randomBytes(16).toString('base64');
      const path = u.pathname + u.search;

      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${u.host}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
      ];
      for (const [k, v] of Object.entries(this.headers)) lines.push(`${k}: ${v}`);
      const req = lines.join('\r\n') + '\r\n\r\n';

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('WebSocket handshake timed out'));
      }, this.timeoutMs);

      const onConnect = () => socket.write(req);
      const socket = secure
        ? tls.connect({ host: u.hostname, port, servername: u.hostname }, onConnect)
        : require('net').connect({ host: u.hostname, port }, onConnect);

      socket.on('error', (err) => {
        clearTimeout(timer);
        if (!this.connected) reject(err);
        else this.emit('error', err);
      });
      socket.on('close', () => {
        clearTimeout(timer);
        this.emit('close');
      });

      let handshakeDone = false;
      socket.on('data', (chunk) => {
        if (!handshakeDone) {
          this.buffer = Buffer.concat([this.buffer, chunk]);
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end === -1) return;
          const head = this.buffer.slice(0, end).toString('latin1');
          this.buffer = this.buffer.slice(end + 4);
          const statusLine = head.split('\r\n')[0];
          if (!/ 101 /.test(statusLine)) {
            clearTimeout(timer);
            socket.destroy();
            return reject(new Error(`WebSocket upgrade failed: ${statusLine}`));
          }
          handshakeDone = true;
          this.connected = true;
          this.socket = socket;
          clearTimeout(timer);
          if (this.buffer.length) this._parse(this.buffer);
          resolve(this);
          return;
        }
        this._parse(chunk);
      });
    });
  }

  _parse(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < 4) return;
        len = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buffer.length < 10) return;
        len = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let maskKey;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.slice(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + len) return;
      let payload = this.buffer.slice(offset, offset + len);
      if (masked) {
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
      }
      this.buffer = this.buffer.slice(offset + len);

      if (opcode === 0x1) {
        this.emit('message', payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this.emit('close');
        this.socket && this.socket.end();
        return;
      } else if (opcode === 0x9) {
        this.sendFrame(payload, 0xa);
      }
    }
  }

  sendFrame(payload, opcode) {
    if (this.socket && !this.socket.destroyed) this.socket.write(frame(payload, opcode));
  }

  send(text) {
    this.sendFrame(text, 0x1);
  }

  close() {
    try {
      this.sendFrame(Buffer.alloc(0), 0x8);
      this.socket && this.socket.end();
    } catch {
      /* ignore */
    }
  }
}

class CDP extends EventEmitter {
  constructor(wsUrl, opts = {}) {
    super();
    this.wsUrl = wsUrl;
    this.opts = opts;
    this._id = 0;
    this._pending = new Map();
    this._sessions = new Map();
    this._listeners = new Map();
    this.defaultSessionId = null;
  }

  async connect() {
    this.ws = new RawWebSocket(this.wsUrl, this.opts);
    this.ws.on('message', (raw) => this._onMessage(raw));
    this.ws.on('close', () => this.emit('disconnect'));
    this.ws.on('error', (e) => this.emit('error', e));
    await this.ws.connect();
    return this;
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(Object.assign(new Error(msg.error.message), { data: msg.error.data, code: msg.error.code }));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      const key = msg.sessionId ? `${msg.sessionId}:${msg.method}` : msg.method;
      const handlers = this._listeners.get(key) || [];
      for (const h of handlers) h(msg.params, msg);
      this.emit('event', msg);
    }
  }

  send(method, params = {}, sessionId) {
    if (sessionId === undefined) sessionId = this.defaultSessionId || undefined;
    const id = ++this._id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, this.opts.commandTimeoutMs || 45000);
    });
  }

  on(method, handler, sessionId) {
    const key = sessionId ? `${sessionId}:${method}` : method;
    if (!this._listeners.has(key)) this._listeners.set(key, []);
    this._listeners.get(key).push(handler);
    return () => {
      const arr = this._listeners.get(key) || [];
      const i = arr.indexOf(handler);
      if (i >= 0) arr.splice(i, 1);
    };
  }

  waitFor(method, { timeoutMs = 30000, sessionId } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params, msg) => {
        clearTimeout(timer);
        off();
        resolve(params);
      }, sessionId);
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
    });
  }

  async attachToPage() {
    const { targetInfos } = await this.send('Target.getTargets');
    const page = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('chrome://')) ||
      targetInfos.find((t) => t.type === 'page');
    if (!page) throw new Error('No page target available');
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    this.defaultSessionId = sessionId;
    return { targetId: page.targetId, sessionId };
  }

  async newPage(opts = {}) {
    const params = { url: opts.url || 'about:blank' };
    if (opts.browserContextId) params.browserContextId = opts.browserContextId;
    // Target.createTarget must go to the browser-level session.
    const { targetId } = await this.send('Target.createTarget', params, null);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }, null);
    this.defaultSessionId = sessionId;
    return { targetId, sessionId };
  }

  /**
   * Creates an isolated incognito-like browser context. Accounts created in
   * separate contexts do not share cookies or localStorage, which is required
   * when minting many independent River accounts in one browser.
   *
   * A context can carry its own proxy, so each account reaches the outside
   * world from a different address:
   *   await cdp.createBrowserContext({ proxyServer: 'http://127.0.0.1:8899' })
   *
   * Note: Chrome ignores `user:pass@` inside that URL — authenticated proxies
   * need `attachProxyAuth()` from ./proxy (Fetch.handleAuthRequests).
   */
  async createBrowserContext({ proxyServer, proxyBypassList } = {}) {
    const params = { disposeOnDetach: false };
    if (proxyServer) params.proxyServer = proxyServer;
    if (proxyBypassList) params.proxyBypassList = proxyBypassList;
    const { browserContextId } = await this.send('Target.createBrowserContext', params, null);
    return browserContextId;
  }

  async disposeBrowserContext(browserContextId) {
    try {
      await this.send('Target.disposeBrowserContext', { browserContextId }, null);
    } catch {
      /* ignore */
    }
  }

  async closePage(targetId) {
    try {
      await this.send('Target.closeTarget', { targetId });
    } catch {
      /* ignore */
    }
  }

  close() {
    this.ws && this.ws.close();
  }
}

module.exports = { CDP, RawWebSocket };
