'use strict';

/**
 * Guerrilla Mail backend (api.guerrillamail.com) — a disposable inbox whose
 * domains are NOT all on the public disposable-domain blocklist.
 *
 * Why it is here: the sign-up gate refuses the well-known disposable domains
 * (mail.tm, mail.gw, guerrillamail.com, sharklasers.com, mailinator, maildrop,
 * tempmail.lol, … — all measured). Guerrilla Mail rotates a wider pool of
 * domains and hands out addresses on them for free with a small JSON API, so a
 * pool member that never made it onto the blocklist can pass.
 *
 * Same shape as MailTM / MailboxImap, so provisionAccount() does not care:
 *   createAccount() -> {address, …}
 *   waitForCode()   -> the 6-digit code
 *
 * Requests go through the account's proxy whenever one is given (./proxy
 * fetchText), so an account's inbox is read from the same address as its
 * browser traffic.
 */

const { fetchText } = require('./proxy');

const API = 'https://api.guerrillamail.com/ajax.php';
const CODE_RE = /(?:code|kod|otp|verification)[^0-9]{0,40}(\d{6})/i;

function extractCode(text) {
  const words = String(text).replace(/\s+/g, ' ');
  const near = CODE_RE.exec(words);
  if (near) return near[1];
  const any = /\b(\d{6})\b/.exec(words);
  return any ? any[1] : null;
}

/** Guerrilla's JSON body wrapped in its anti-XSSI prefix. */
function parseJson(text) {
  const cleaned = String(text).replace(/^\s*for\s*\(;;\);/, '').trim();
  return JSON.parse(cleaned);
}

class GuerrillaMail {
  /**
   * @param {{proxy?: object|null, domain?: string, log?: Function, timeoutMs?: number}} opts
   *   domain — request addresses on this domain; a session is opened repeatedly
   *   until the pool hands one out (Guerrilla rotates them per session).
   */
  constructor({ proxy = null, domain = null, log, timeoutMs = 20000 } = {}) {
    this.proxy = proxy;
    this.domain = domain;
    this.log = log || (() => {});
    this.timeoutMs = timeoutMs;
    this.sid = null;
    this.address = null;
  }

  async call(params) {
    const query = new URLSearchParams(params).toString();
    const body = await fetchText(this.proxy, `${API}?${query}`, {
      timeoutMs: this.timeoutMs,
      headers: { 'User-Agent': 'river-bulk/1.0' },
    });
    return parseJson(body);
  }

  /** Opens a session; repeats until the pool yields the requested domain. */
  async createAccount({ domain = this.domain, attempts = 12 } = {}) {
    for (let i = 0; i < attempts; i++) {
      const j = await this.call({ f: 'get_email_address', ip: '127.0.0.1', agent: 'river-bulk' });
      const address = j.email_addr;
      this.sid = j.sid_token;
      this.address = address;
      const got = String(address).split('@')[1];
      if (!domain || got === domain) return { address, password: '(guerrilla session)', sid: this.sid };
    }
    throw new Error(`guerrilla mail never handed out @${domain} in ${attempts} sessions (last: ${this.address})`);
  }

  /** Polls the session's inbox until a message carries a 6-digit code. */
  async waitForCode({ timeoutMs = 120000, pollMs = 4000, log } = {}) {
    if (!this.sid) throw new Error('GuerrillaMail: createAccount() first');
    const say = log || this.log;
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    while (Date.now() < deadline) {
      const list = await this.call({ f: 'check_email', seq: 0, sid_token: this.sid });
      for (const item of list.list || []) {
        if (seen.has(item.mail_id)) continue;
        seen.add(item.mail_id);
        const full = await this.call({ f: 'fetch_email', email_id: item.mail_id, sid_token: this.sid });
        const code = extractCode(`${full.mail_subject || ''} ${full.mail_body || ''}`);
        if (code) {
          say(`guerrilla: code ${code} from "${String(full.mail_subject || '').slice(0, 40)}"`);
          return code;
        }
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`no verification code for ${this.address} within ${Math.round(timeoutMs / 1000)}s`);
  }

  close() {
    this.sid = null;
  }
}

module.exports = { GuerrillaMail, extractCode, parseJson };
