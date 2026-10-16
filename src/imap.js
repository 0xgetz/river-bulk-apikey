'use strict';

/**
 * Minimal IMAP client — just enough to read a verification code out of a real
 * mailbox, through the same proxy tunnel as the rest of the tool.
 *
 * Why it exists: the sign-up gate accepts mainstream domains (gmail.com,
 * outlook.com) and refuses every disposable-inbox domain that has an API
 * (mail.tm, mail.gw, guerrillamail, mailinator, maildrop — measured
 * 2026-10-13). Those mainstream providers have no free HTTP API, but they do
 * speak IMAP, and an app password is enough to log in.
 *
 * Scope: connect over the tunnel, LOGIN, SELECT, UID SEARCH, UID FETCH, and
 * decode a body well enough to find a 6-digit code. No IDLE, no flags, no
 * folder management — polling UID SEARCH is enough at this scale.
 *
 * Zero dependencies: Node's net/tls plus the hand-rolled tunnel from ./proxy.
 */

const tls = require('tls');
const net = require('net');
const { openTunnel } = require('./proxy');

const DEFAULT_TIMEOUT_MS = 20000;

/** Splits "text/plain; charset=utf-8" into its parts. */
function parseHeaderBlock(raw) {
  const headers = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z-]+):\s*(.*)$/.exec(line);
    if (m) headers[m[1].toLowerCase()] = m[2].trim();
  }
  return headers;
}

function decodeQuotedPrintable(text) {
  return text
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function decodeBase64(text) {
  try {
    return Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
  } catch (e) {
    return text;
  }
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

/** All readable text of a raw RFC822 message, multipart included. */
function messageText(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const sep = split === -1 ? raw.indexOf('\n\n') : split;
  if (sep === -1) return raw;
  const headers = parseHeaderBlock(raw.slice(0, sep));
  const body = raw.slice(sep + (split === -1 ? 2 : 4));
  const ctype = headers['content-type'] || 'text/plain';

  const boundary = /boundary="?([^";]+)"?/i.exec(ctype)?.[1];
  if (/^multipart\//i.test(ctype) && boundary) {
    const parts = body.split(`--${boundary}`);
    return parts
      .map((p) => (/^\s*$/.test(p) || /^--/.test(p.trim()) ? '' : messageText(p.replace(/^\r?\n/, ''))))
      .filter(Boolean)
      .join('\n');
  }

  const encoding = (headers['content-transfer-encoding'] || '').toLowerCase();
  let text = body;
  if (encoding.includes('quoted-printable')) text = decodeQuotedPrintable(text);
  else if (encoding.includes('base64')) text = decodeBase64(text);
  if (/text\/html/i.test(ctype)) text = htmlToText(text);
  return text;
}

/** 6-digit code, preferring one sitting next to the word "code". */
function extractCode(text) {
  const words = text.replace(/\s+/g, ' ');
  const near = /(?:code|kod|otp|verification)[^0-9]{0,40}(\d{6})/i.exec(words);
  if (near) return near[1];
  const any = /\b(\d{6})\b/.exec(words);
  return any ? any[1] : null;
}

class Imap {
  /**
   * @param {{host?: string, port?: number, user: string, password: string, proxy?: object|null, timeoutMs?: number, log?: Function}} opts
   */
  constructor({ host = 'imap.gmail.com', port = 993, user, password, proxy = null, timeoutMs = DEFAULT_TIMEOUT_MS, log } = {}) {
    this.host = host;
    this.port = port;
    this.user = user;
    this.password = password;
    this.proxy = proxy;
    this.timeoutMs = timeoutMs;
    this.log = log || (() => {});
    this.socket = null;
    this.buffer = '';
    this.seq = 0;
    this.pending = null; // { tag, resolve, reject, until, literals }
  }

  /** Opens the socket — through the proxy when one is given — and reads the greeting. */
  async connect() {
    if (this.socket) return;
    const greeting = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IMAP greeting timeout')), this.timeoutMs);
      const onData = () => {
        if (/\* OK/.test(this.buffer)) {
          clearTimeout(timer);
          resolve();
        }
      };
      this.buffer = '';
      this._onGreeting = onData;
      this._onGreetingReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });

    const socket = this.proxy
      ? tls.connect({ socket: await openTunnel(this.proxy, { host: this.host, port: this.port, timeoutMs: this.timeoutMs }), servername: this.host })
      : tls.connect({ host: this.host, port: this.port, servername: this.host });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('error', (e) => {
      if (this._onGreetingReject) this._onGreetingReject(e);
      if (this.pending) this.pending.reject(e);
    });
    socket.on('close', () => {
      if (this.pending) this.pending.reject(new Error('IMAP connection closed'));
      this.socket = null;
    });
    await greeting;
    this._onGreeting = null;
    this._onGreetingReject = null;
  }

  _onData(chunk) {
    this.buffer += chunk.toString('binary');
    // Greeting path
    if (!this.pending) {
      if (this._onGreeting && /\* OK/.test(this.buffer)) this._onGreeting();
      return;
    }
    this._process();
  }

  /**
   * Walks complete lines. A line ending in `{n}` is a literal: n raw bytes
   * follow, and a body containing "\r\nA2 OK" must not be mistaken for the
   * tagged completion of the command that asked for it.
   */
  _process() {
    for (;;) {
      const lineEnd = this.buffer.indexOf('\n');
      if (lineEnd === -1) return;
      const line = this.buffer.slice(0, lineEnd + 1);
      const literal = /\{(\d+)\}\r?\n$/.exec(line);
      if (literal) {
        const need = parseInt(literal[1], 10);
        if (this.buffer.length < lineEnd + 1 + need + 1) return; // wait for the rest
        this.buffer = this.buffer.slice(lineEnd + 1 + need);
        continue;
      }
      this.buffer = this.buffer.slice(lineEnd + 1);
      this.pending.response += line;
      if (line.startsWith(`${this.pending.tag} `)) {
        const { resolve, reject, response } = this.pending;
        this.pending = null;
        const status = line.trim();
        if (/\sOK\b/i.test(status)) resolve(response.trim());
        else reject(new Error(`IMAP ${status}`));
        return;
      }
    }
  }

  /** Sends a command and resolves with the untagged response text. */
  command(text) {
    if (!this.socket) return Promise.reject(new Error('IMAP not connected'));
    const tag = `A${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending && this.pending.tag === tag) {
          this.pending = null;
          reject(new Error(`IMAP timeout on ${text.split(' ')[0]}`));
        }
      }, this.timeoutMs);
      this.pending = {
        tag,
        response: '',
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.socket.write(`${tag} ${text}\r\n`);
    });
  }

  async login() {
    await this.command(`LOGIN ${JSON.stringify(this.user)} ${JSON.stringify(this.password)}`);
    this.log(`imap: logged in as ${this.user}`);
  }

  async select(mailbox = 'INBOX') {
    return this.command(`SELECT ${JSON.stringify(mailbox)}`);
  }

  /** UIDs of unseen messages addressed to `to` (IMAP TO search is a substring match). */
  async searchUnseenTo(to) {
    const res = await this.command(`UID SEARCH UNSEEN TO ${JSON.stringify(to)}`);
    const line = res.split(/\r?\n/).find((l) => /^\* SEARCH/.test(l)) || '';
    return line.replace(/^\* SEARCH\s*/, '').trim().split(/\s+/).filter(Boolean);
  }

  /** Raw message for a UID. */
  async fetchMessage(uid) {
    const res = await this.command(`UID FETCH ${uid} BODY.PEEK[]`);
    const start = res.search(/BODY\[\][^\n]*\n|\{\d+\}\r?\n/);
    if (start === -1) return res;
    // Everything after the literal header is the message.
    const literal = /\{(\d+)\}\r?\n/.exec(res);
    if (literal) return res.slice(literal.index + literal[0].length, literal.index + literal[0].length + parseInt(literal[1], 10));
    const nl = res.indexOf('\n', start);
    return nl === -1 ? res : res.slice(nl + 1);
  }

  /**
   * Polls the mailbox until a message addressed to `to` carries a 6-digit code.
   * Leaves the message unseen: nothing here marks it, so a second look is free.
   */
  async waitForCode({ to, timeoutMs = 120000, pollMs = 4000, log } = {}) {
    await this.connect();
    if (!this.loggedIn) {
      await this.login();
      await this.select('INBOX');
      this.loggedIn = true;
    }
    const say = log || this.log;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const uids = await this.searchUnseenTo(to);
      for (const uid of uids.reverse()) {
        const text = messageText(await this.fetchMessage(uid));
        const code = extractCode(text);
        if (code) {
          say(`imap: code ${code} from message ${uid}`);
          return code;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`no verification code for ${to} within ${Math.round(timeoutMs / 1000)}s`);
  }

  close() {
    if (!this.socket) return;
    try {
      this.socket.write(`A${++this.seq} LOGOUT\r\n`);
    } catch (e) {}
    this.socket.end();
    this.socket = null;
    this.loggedIn = false;
  }
}

module.exports = { Imap, messageText, extractCode, decodeQuotedPrintable, htmlToText };
