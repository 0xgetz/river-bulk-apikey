'use strict';

/**
 * temp-mail.io backend — a disposable inbox whose address domains rotate through
 * a large pool, and whose API is plain JSON with no key and no account.
 *
 * Why it is here: the sign-up gate is a domain-list membership test (measured:
 * the whole known-disposable set is refused, `schema.org` is accepted), while
 * this provider's pool keeps producing domains that the public blocklist has
 * never seen. Reader verified 2026-10-13: the messages endpoint answers 200 and
 * `[]` for a fresh address — note the address must sit in the path *unencoded*,
 * `…/email/<addr>@<domain>/messages?token=…`; the URL-encoded form answers
 * `400 Email not found`, which is a trap worth remembering.
 *
 * Same shape as MailTM / MailboxImap / GuerrillaMail for provisionAccount():
 *   createAccount() -> {address, token}
 *   waitForCode()   -> the 6-digit code
 */

const { fetchText } = require('./proxy');

const API = 'https://api.internal.temp-mail.io/api/v3';
const CODE_RE = /(?:code|kod|otp|verification)[^0-9]{0,40}(\d{6})/i;

function extractCode(text) {
  const words = String(text).replace(/\s+/g, ' ');
  const near = CODE_RE.exec(words);
  if (near) return near[1];
  const any = /\b(\d{6})\b/.exec(words);
  return any ? any[1] : null;
}

/** Every string anywhere in a JSON value, joined — schema-independent. */
function allStrings(value) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out.join('\n');
}

class TempMailIo {
  /**
   * @param {{proxy?: object|null, domain?: string, log?: Function, timeoutMs?: number}} opts
   *   domain — keep creating addresses until the pool hands out this domain.
   */
  constructor({ proxy = null, domain = null, log, timeoutMs = 20000 } = {}) {
    this.proxy = proxy;
    this.domain = domain;
    this.log = log || (() => {});
    this.timeoutMs = timeoutMs;
    this.address = null;
    this.token = null;
  }

  async get(url) {
    const body = await fetchText(this.proxy, url, {
      timeoutMs: this.timeoutMs,
      headers: { Accept: 'application/json', 'User-Agent': 'river-bulk/1.0' },
    });
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(`temp-mail.io returned non-JSON: ${body.slice(0, 80)}`);
    }
  }

  async mint() {
    const body = await fetchText(this.proxy, `${API}/email/new?min_name_length=8&max_name_length=12`, {
      method: 'POST',
      body: {},
      timeoutMs: this.timeoutMs,
      headers: { Accept: 'application/json', 'User-Agent': 'river-bulk/1.0' },
    });
    const j = JSON.parse(body);
    const address = j.email || j.address;
    if (!address || !j.token) throw new Error(`temp-mail.io did not return an address: ${body.slice(0, 120)}`);
    return { address, token: j.token };
  }

  /** A fresh address, on `domain` when one is requested. */
  async createAccount({ domain = this.domain, attempts = 40 } = {}) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      const minted = await this.mint();
      last = minted;
      const got = String(minted.address).split('@')[1];
      if (!domain || got === domain) {
        this.address = minted.address;
        this.token = minted.token;
        return { address: this.address, password: '(none — public inbox)', token: this.token };
      }
    }
    throw new Error(`temp-mail.io never handed out @${domain} in ${attempts} addresses (last: ${last && last.address})`);
  }

  /**
   * Message list for an address.
   *
   * The address goes into the path **unencoded**: `…/email/<addr>@<domain>/messages`
   * answers 200, while the `%40` form answers `400 Email not found` — measured,
   * and the kind of trap that looks like a broken mailbox.
   */
  async messages({ address = this.address, token = this.token } = {}) {
    if (!address || !token) throw new Error('TempMailIo: createAccount() first');
    const json = await this.get(`${API}/email/${address}/messages?token=${encodeURIComponent(token)}`);
    return Array.isArray(json) ? json : json.messages || [];
  }

  /** Polls the inbox until a message carries a 6-digit code. */
  async waitForCode({ timeoutMs = 120000, pollMs = 4000, log } = {}) {
    if (!this.address || !this.token) throw new Error('TempMailIo: createAccount() first');
    const say = log || this.log;
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    while (Date.now() < deadline) {
      const messages = await this.messages();
      const code = extractCode(allStrings(messages));
      if (code) {
        say(`temp-mail.io: code ${code} (${messages.length} message(s))`);
        return code;
      }
      if (messages.length !== lastCount) {
        lastCount = messages.length;
        say(`temp-mail.io: ${messages.length} message(s) so far`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`no verification code for ${this.address} within ${Math.round(timeoutMs / 1000)}s`);
  }

  close() {
    this.address = null;
    this.token = null;
  }
}

module.exports = { TempMailIo, extractCode, allStrings };
