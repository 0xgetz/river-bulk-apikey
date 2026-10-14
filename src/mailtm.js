'use strict';

/**
 * Minimal mail.tm client (https://docs.mail.tm).
 * Creates disposable inboxes and polls for verification e-mails.
 * Zero dependencies - uses Node's built-in https.
 */

const https = require('https');
const { URL } = require('url');

const API = 'https://api.mail.tm';

function request(method, path, { token, body, agent, baseUrl = API } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL((baseUrl || API) + path);
    const data = body ? JSON.stringify(body) : null;
    const headers = { Accept: 'application/json' };
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.request(
      { method, agent, hostname: u.hostname, port: 443, path: u.pathname + u.search, headers },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = chunks ? JSON.parse(chunks) : null;
          } catch {
            parsed = chunks;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class MailTM {
  constructor({ domain, agent, baseUrl } = {}) {
    this.domain = domain || null;
    this.agent = agent;
    this.baseUrl = baseUrl || API;
    this.token = null;
  }

  /** Inbox calls leave through this instance's agent — i.e. through its proxy. */
  request(method, path, opts = {}) {
    return request(method, path, { agent: this.agent, baseUrl: this.baseUrl, ...opts });
  }

  async getDomain() {
    if (this.domain) return this.domain;
    const res = await this.request('GET', '/domains');
    const list = res.body['hydra:member'] || res.body;
    const active = (list || []).find((d) => d.isActive) || (list || [])[0];
    if (!active) throw new Error('No active mail.tm domain available');
    this.domain = active.domain;
    return this.domain;
  }

  async createAccount({ address, password, domain } = {}) {
    const d = domain || (await this.getDomain());
    const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const addr = address || `${rand}@${d}`;
    const pass = password || Math.random().toString(36).slice(2, 14) + 'Aa1!';
    const res = await this.request('POST', '/accounts', { body: { address: addr, password: pass } });
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`mail.tm account creation failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    this.token = await this.login({ address: addr, password: pass });
    return { address: addr, password: pass, token: this.token, id: res.body.id };
  }

  async login({ address, password }) {
    const res = await this.request('POST', '/token', { body: { address, password } });
    if (res.status !== 200) throw new Error(`mail.tm login failed (${res.status})`);
    this.token = res.body.token;
    return this.token;
  }

  async messages({ address, password } = {}) {
    const token = this.token || (address ? await this.login({ address, password }) : null);
    if (!token) throw new Error('Not authenticated: call createAccount/login or pass address+password');
    const res = await this.request('GET', '/messages', { token });
    if (res.status !== 200) throw new Error(`mail.tm messages failed (${res.status})`);
    return res.body['hydra:member'] || res.body;
  }

  async message(id, { address, password } = {}) {
    const token = this.token || (address ? await this.login({ address, password }) : null);
    const res = await this.request('GET', `/messages/${id}`, { token });
    if (res.status !== 200) throw new Error(`mail.tm message failed (${res.status})`);
    return res.body;
  }

  /**
   * Poll the inbox until a message arrives and contains a 6-digit code.
   */
  async waitForCode({ timeoutMs = 90000, pollMs = 3000, subjectIncludes } = {}) {
    const deadline = Date.now() + timeoutMs;
    let seen = new Set();
    while (Date.now() < deadline) {
      let msgs = [];
      try {
        msgs = await this.messages();
      } catch {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      for (const m of msgs) {
        if (subjectIncludes && !(m.subject || '').toLowerCase().includes(subjectIncludes.toLowerCase())) continue;
        const full = await this.message(m.id);
        const text = `${full.text || ''}\n${Array.isArray(full.html) ? full.html.join(' ') : full.html || ''}`;
        const match = text.match(/\b(\d{6})\b/);
        if (match) {
          // Prefer a code that appears in a "verify" context; else first 6-digit run.
          const ctx = text.match(/code[^0-9]{0,40}(\d{6})/i);
          return ctx ? ctx[1] : match[1];
        }
        seen.add(m.id);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error('Timed out waiting for verification e-mail');
  }
}

module.exports = { MailTM, request };
