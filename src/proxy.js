'use strict';

/**
 * Proxy plumbing: list parsing plus dependency-free tunnels.
 *
 * Three dialects are supported, because that is what public lists contain:
 *   · HTTP/HTTPS proxies  -> CONNECT tunnel (RFC 7231 §4.3.6)
 *   · SOCKS5              -> RFC 1928 + RFC 1929 username/password auth
 *   · SOCKS4/4a           -> CONNECT with SOCKS4a hostname extension
 *
 * Two consumers use this module:
 *   · Chrome, via `Target.createBrowserContext { proxyServer }`  -> `browserUrl()`
 *   · Node's https client, via `createAgent()`                    -> an https.Agent
 *     whose `createConnection()` returns a TLS socket layered on the tunnel.
 *
 * Everything here is written so a failed proxy fails the *account*, never
 * falls back to a direct connection: the whole point is that no request ever
 * leaves the machine from its own address.
 */

const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// Free exits on a degraded WAN need more than the old 15 s: measured on
// 2026-10-14, survivors that answer in ~8 s through a healthy line needed up to
// ~35 s while the upstream path was flapping, and a 15 s cap silently scored
// them as dead (a false negative that looked like a 1 % pool yield).
const DEFAULT_TIMEOUT_MS = 35000;
// A dead exit must free its socket fast: hundreds of SYN_SENT slots held for the
// full handshake budget starve the CPE for the whole fleet (measured: 651
// sockets in SYN_SENT, mostly our own screens, while ICMP was clean).
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

/** Accepted line shapes:
 *    host:port
 *    host:port:user:pass        (some lists put credentials after the port)
 *    user:pass@host:port
 *    scheme://[user:pass@]host:port
 *    host|port|user|pass
 *  Blank lines and `#`/`//` comments are skipped by the caller.
 */
function parseProxy(line, { defaultProtocol = 'http' } = {}) {
  const raw = String(line).trim();
  if (!raw) return null;

  let protocol = defaultProtocol;
  let rest = raw;
  const scheme = raw.match(/^([a-z0-9]+):\/\/(.+)$/i);
  if (scheme) {
    protocol = scheme[1].toLowerCase();
    rest = scheme[2];
  } else if (raw.includes('|')) {
    const parts = raw.split('|').map((p) => p.trim());
    return buildProxy(protocol, parts[0], parts[1], parts[2], parts[3], raw);
  }

  let username;
  let password;
  const at = rest.lastIndexOf('@');
  let hostport = rest;
  if (at !== -1) {
    const creds = rest.slice(0, at);
    hostport = rest.slice(at + 1);
    const colon = creds.indexOf(':');
    if (colon === -1) username = creds;
    else {
      username = creds.slice(0, colon);
      password = creds.slice(colon + 1);
    }
  }

  let host;
  let port;
  let extraUser;
  let extraPass;
  const bits = hostport.split(':');
  if (bits.length === 4) {
    // host:port:user:pass
    [host, port, extraUser, extraPass] = bits;
  } else if (bits.length === 2) {
    [host, port] = bits;
  } else {
    return null;
  }
  if (extraUser !== undefined && username === undefined) {
    username = extraUser;
    password = extraPass;
  }
  return buildProxy(protocol, host, port, username, password, raw);
}

function buildProxy(protocol, host, port, username, password, raw) {
  const p = String(protocol || 'http').toLowerCase();
  const normalized = p === 'https' ? 'https' : p === 'socks4' || p === 'socks4a' ? 'socks4' : p === 'socks' || p === 'socks5h' || p === 'socks5' ? 'socks5' : 'http';
  const portNum = parseInt(port, 10);
  if (!host || !Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) return null;
  const cleanHost = String(host).replace(/^\[|\]$/g, '');
  return {
    raw,
    protocol: normalized,
    host: cleanHost,
    port: portNum,
    username: username || undefined,
    password: password || undefined,
  };
}

/** `http://host:port` — the form Chrome's per-context proxyServer expects. */
function browserUrl(proxy) {
  const scheme = proxy.protocol === 'socks5' ? 'socks5' : proxy.protocol === 'socks4' ? 'socks4' : proxy.protocol;
  return `${scheme}://${proxy.host}:${proxy.port}`;
}

function label(proxy) {
  if (!proxy) return '(direct)';
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:***@` : '';
  return `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
}

/** Reads a list file: one proxy per line, `#`/`//` comments and blanks skipped. */
function loadProxyList(file) {
  const fs = require('fs');
  const text = fs.readFileSync(file, 'utf8');
  return parseProxyText(text);
}

/**
 * Same, but tolerant: strips inline `# …` comments too (other agents' pool
 * files carry `scheme://host:port  # exit=1.2.3.4` notes).
 */
function loadPoolFile(file) {
  const fs = require('fs');
  const text = fs.readFileSync(file, 'utf8');
  const clean = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+#.*$/, '').replace(/\s+\/\/.*$/, '').trim())
    .filter(Boolean)
    .join('\n');
  const out = [];
  const seen = new Set();
  for (const p of parseProxyText(clean)) {
    if (p.protocol === 'socks4') continue;
    const k = `${p.protocol}://${p.host}:${p.port}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function parseProxyText(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const proxy = parseProxy(trimmed);
    if (!proxy) continue;
    const key = `${proxy.protocol}//${proxy.host}:${proxy.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(proxy);
  }
  return out;
}

function once(emitter, event, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = timeoutMs
      ? setTimeout(() => {
          cleanup();
          reject(new Error(`timeout waiting for ${event}`));
        }, timeoutMs)
      : null;
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    function cleanup() {
      clearTimeout(timer);
      emitter.removeListener(event, onEvent);
      emitter.removeListener('error', onError);
    }
    emitter.once(event, onEvent);
    emitter.once('error', onError);
  });
}

// ---------------------------------------------------------------- HTTP CONNECT

function connectHttpProxy(proxy, { host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`proxy CONNECT timeout (${label(proxy)})`)), timeoutMs);
    socket.on('error', (e) => {
      clearTimeout(timer);
      fail(new Error(`proxy connect failed (${label(proxy)}): ${e.message}`));
    });
    socket.setNoDelay(true);

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      clearTimeout(timer);
      const head = buffer.slice(0, end).toString('latin1');
      const status = parseInt((head.split('\r\n')[0].match(/^HTTP\/\d\.\d (\d{3})/) || [])[1], 10);
      if (status !== 200) {
        let hint = '';
        if (status === 407) hint = ' (proxy authentication required/rejected)';
        else if (status === 403) hint = ' (proxy refused the destination)';
        else if (!status) hint = ' (not an HTTP proxy response)';
        return fail(new Error(`proxy CONNECT ${status || 'garbage'}${hint} via ${label(proxy)}`));
      }
      if (settled) return;
      settled = true;
      const rest = buffer.slice(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);

    socket.on('connect', () => {
      const headers = [
        `CONNECT ${host}:${port} HTTP/1.1`,
        `Host: ${host}:${port}`,
        'Proxy-Connection: Keep-Alive',
      ];
      if (proxy.username) {
        const creds = Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
        headers.push(`Proxy-Authorization: Basic ${creds}`);
      }
      socket.write(headers.join('\r\n') + '\r\n\r\n');
    });
  });
}

// -------------------------------------------------------------------- SOCKS5

function connectSocks5(proxy, { host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`SOCKS5 timeout (${label(proxy)})`)), timeoutMs);
    socket.on('error', (e) => fail(new Error(`SOCKS5 connect failed (${label(proxy)}): ${e.message}`)));
    socket.setNoDelay(true);

    let stage = 'method';
    let buffer = Buffer.alloc(0);

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 'method') {
        if (buffer.length < 2) return;
        const method = buffer[1];
        buffer = buffer.slice(2);
        if (method === 0xff) return fail(new Error(`SOCKS5 proxy rejected auth methods (${label(proxy)})`));
        if (method === 0x02) {
          if (!proxy.username) return fail(new Error(`SOCKS5 proxy wants username/password (${label(proxy)})`));
          stage = 'auth';
          const u = Buffer.from(proxy.username);
          const p = Buffer.from(proxy.password || '');
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
          return;
        }
        stage = 'reply';
        return sendRequest();
      }
      if (stage === 'auth') {
        if (buffer.length < 2) return;
        const ok = buffer[1] === 0x00;
        buffer = buffer.slice(2);
        if (!ok) return fail(new Error(`SOCKS5 auth rejected (${label(proxy)})`));
        stage = 'reply';
        return sendRequest();
      }
      // stage === 'reply'
      if (buffer.length < 4) return;
      const rep = buffer[1];
      const atyp = buffer[3];
      const need = atyp === 0x01 ? 10 : atyp === 0x04 ? 22 : 7 + buffer[4];
      if (buffer.length < need) return;
      if (rep !== 0x00) {
        const reasons = { 1: 'general failure', 2: 'not allowed', 3: 'network unreachable', 4: 'host unreachable', 5: 'connection refused', 6: 'TTL expired', 7: 'command not supported', 8: 'address type not supported' };
        return fail(new Error(`SOCKS5 error ${reasons[rep] || rep} (${label(proxy)})`));
      }
      clearTimeout(timer);
      const rest = buffer.slice(need);
      if (settled) return;
      settled = true;
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on('data', onData);

    function sendRequest() {
      const hostBuf = Buffer.from(host);
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
        hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]);
      socket.write(req);
    }

    socket.on('connect', () => {
      const methods = proxy.username ? [0x00, 0x02] : [0x00];
      socket.write(Buffer.from([0x05, methods.length, ...methods]));
    });
  });
}

// ------------------------------------------------------------------ SOCKS4a

function connectSocks4(proxy, { host, port, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`SOCKS4 timeout (${label(proxy)})`)), timeoutMs);
    socket.on('error', (e) => fail(new Error(`SOCKS4 connect failed (${label(proxy)}): ${e.message}`)));
    socket.setNoDelay(true);

    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 8) return;
      clearTimeout(timer);
      if (buffer[1] !== 0x5a) return fail(new Error(`SOCKS4 error code ${buffer[1]} (${label(proxy)})`));
      const rest = buffer.slice(8);
      if (settled) return;
      settled = true;
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    });

    socket.on('connect', () => {
      const user = Buffer.from(proxy.username || '');
      // SOCKS4a: invalid IP 0.0.0.1 + hostname after the user id.
      const req = Buffer.concat([
        Buffer.from([0x04, 0x01, (port >> 8) & 0xff, port & 0xff, 0, 0, 0, 1]),
        user,
        Buffer.from([0x00]),
        Buffer.from(host),
        Buffer.from([0x00]),
      ]);
      socket.write(req);
    });
  });
}

function openTunnel(proxy, { host, port, timeoutMs } = {}) {
  if (proxy.protocol === 'socks5') return connectSocks5(proxy, { host, port, timeoutMs });
  if (proxy.protocol === 'socks4') return connectSocks4(proxy, { host, port, timeoutMs });
  return connectHttpProxy(proxy, { host, port, timeoutMs });
}

// --------------------------------------------------------------------- agent

/**
 * `https.Agent` whose sockets are opened through the proxy and then wrapped in
 * TLS locally, so `https.request({ agent })` transparently exits via the proxy.
 */
class ProxyAgent extends https.Agent {
  constructor(proxy, options = {}) {
    super({ keepAlive: false, ...options });
    this.proxy = proxy;
  }

  createConnection(options, callback) {
    const host = options.host;
    const port = Number(options.port) || 443;
    let tunnel = null;
    // Connect phase and handshake phase need different budgets: a dead exit must
    // give up its socket quickly (a 35 s connect timeout left hundreds of
    // SYN_SENT slots open across the fleet and starved the CPE), while a live
    // line on a flapping path may legitimately need ~30 s for TLS.
    const connectMs = this.proxy.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS;
    const handshakeMs = this.proxy.timeoutMs || DEFAULT_TIMEOUT_MS;
    openTunnel(this.proxy, { host, port, timeoutMs: connectMs })
      .then((socket) => {
        tunnel = socket;
        if (options.secureEndpoint === false) return socket;
        const tlsSocket = tls.connect({
          socket,
          servername: options.servername || host,
          rejectUnauthorized: this.proxy.rejectUnauthorized !== false,
        });
        return once(tlsSocket, 'secureConnect', handshakeMs).then(() => tlsSocket);
      })
      .then((socket) => callback(null, socket))
      .catch((err) => {
        if (tunnel) tunnel.destroy();
        callback(err);
      });
  }
}

function createAgent(proxy, options) {
  return new ProxyAgent(proxy, options);
}

/**
 * Fetches a URL through `proxy` (or straight out when it is null) and returns
 * the body as text. Used to check what exit address a proxy really presents —
 * a transparent proxy passes every other test and still leaks your own IP — and
 * as the HTTP layer of the inbox backends.
 *
 * `method`/`body` exist because several of those backends hand out an address
 * with a POST; a body that is not a Buffer is JSON-encoded, and the JSON content
 * type is only filled in when the caller did not set one.
 */
function fetchText(proxy, url, { timeoutMs = 15000, headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const payload =
      body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const finalHeaders = { ...headers };
    if (payload && !Object.keys(finalHeaders).some((h) => h.toLowerCase() === 'content-type')) {
      finalHeaders['Content-Type'] = 'application/json';
    }
    if (payload && !Object.keys(finalHeaders).some((h) => h.toLowerCase() === 'content-length')) {
      finalHeaders['Content-Length'] = payload.length;
    }
    const req = lib.request(
      {
        method,
        host: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        agent: proxy ? createAgent(proxy) : undefined,
        headers: finalHeaders,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve(text));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** One-shot reachability probe: does this proxy carry a TLS request to host:port? */
async function probe(proxy, { host = 'api.ipify.org', port = 443, timeoutMs = 10000 } = {}) {
  const started = Date.now();
  let tunnel = null;
  try {
    tunnel = await openTunnel(proxy, { host, port, timeoutMs });
    const tlsSocket = tls.connect({ socket: tunnel, servername: host });
    await once(tlsSocket, 'secureConnect', timeoutMs);
    const ms = Date.now() - started;
    tlsSocket.destroy();
    return { ok: true, ms };
  } catch (e) {
    if (tunnel) tunnel.destroy();
    return { ok: false, ms: Date.now() - started, error: e.message };
  }
}

/** Round-robin, then wrap around; `index` is the account number. */
function proxyForIndex(proxies, index) {
  if (!proxies || !proxies.length) return null;
  return proxies[index % proxies.length];
}

/**
 * Chrome ignores credentials embedded in a per-context `proxyServer` URL — it
 * sends an unauthenticated CONNECT and the page dies on the resulting 407.
 * The working path is the Fetch domain: enable `handleAuthRequests`, keep every
 * paused request moving, and answer each challenge with the list's credentials.
 *
 * Returns an async teardown; call it before the context is disposed.
 */
async function attachProxyAuth(cdp, sessionId, proxy) {
  if (!proxy || !proxy.username) return async () => {};

  const offAuth = cdp.on(
    'Fetch.authRequired',
    (p) => {
      cdp
        .send(
          'Fetch.continueWithAuth',
          {
            requestId: p.requestId,
            authChallengeResponse: {
              response: 'ProvideCredentials',
              username: proxy.username,
              password: proxy.password || '',
              proxyUsername: proxy.username,
              proxyPassword: proxy.password || '',
            },
          },
          sessionId
        )
        .catch(() => {});
    },
    sessionId
  );

  const offPaused = cdp.on(
    'Fetch.requestPaused',
    (p) => {
      cdp.send('Fetch.continueRequest', { requestId: p.requestId }, sessionId).catch(() => {});
    },
    sessionId
  );

  await cdp.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] }, sessionId);

  return async () => {
    offAuth();
    offPaused();
    try {
      await cdp.send('Fetch.disable', {}, sessionId);
    } catch {
      /* session is already gone */
    }
  };
}

/** Chrome cannot authenticate to a SOCKS5 proxy, so those lines are unusable. */
function usableInBrowser(proxy) {
  return !(proxy.username && (proxy.protocol === 'socks5' || proxy.protocol === 'socks4'));
}

/**
 * Loopback, link-local and RFC1918 addresses are this machine or its LAN: a
 * "proxy" there relays straight out of your own connection, so it must never
 * end up in a rotation whose entire point is not to be your own address.
 */
function isLocalHost(host) {
  const h = String(host);
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

module.exports = {
  parseProxy,
  parseProxyText,
  loadProxyList,
  loadPoolFile,
  browserUrl,
  label,
  openTunnel,
  createAgent,
  fetchText,
  proxyForIndex,
  probe,
  attachProxyAuth,
  usableInBrowser,
  isLocalHost,
  ProxyAgent,
};
