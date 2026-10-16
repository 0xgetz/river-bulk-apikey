'use strict';

/**
 * Inboxes.com backend (api.inboxes.com domains) — free disposable inboxes whose
 * domains are read over HTTP with no key and no account.
 *
 * Why it is here: the sign-up gate refuses the well-known disposable domains
 * (mail.tm, mail.gw, guerrillamail.com, sharklasers.com, mailinator, maildrop,
 * tempmail.lol, … — all measured), and inboxes.com publishes a pool of eighteen
 * domains, several of which are missing from the public disposable-domain
 * blocklist. A pool member that the gate has never seen is what this backend
 * exists to test.
 *
 * Message bodies: the public v2 endpoint answers `{"msgs": […]}` and has no
 * published schema, so the reader does not assume one — it walks every string
 * in the response and looks for the code. That keeps it working when the shape
 * changes, which a field-by-field parser would not.
 *
 * Same shape as MailTM / MailboxImap for provisionAccount():
 *   createAccount() -> {address, …}
 *   waitForCode()   -> the 6-digit code
 */

const { fetchText } = require('./proxy');

const API = 'https://inboxes.com/api/v2';
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

class InboxesCom {
  /**
   * @param {{proxy?: object|null, domain?: string, log?: Function, timeoutMs?: number}} opts
   */
  constructor({ proxy = null, domain = null, log, timeoutMs = 20000 } = {}) {
    this.proxy = proxy;
    this.domain = domain;
    this.log = log || (() => {});
    this.timeoutMs = timeoutMs;
    this.address = null;
  }

  async get(path) {
    const body = await fetchText(this.proxy, `${API}${path}`, {
      timeoutMs: this.timeoutMs,
      headers: { Accept: 'application/json', 'User-Agent': 'river-bulk/1.0' },
    });
    try {
      return JSON.parse(body);
    } catch (e) {
      throw new Error(`inboxes.com returned non-JSON: ${body.slice(0, 80)}`);
    }
  }

  /** Domains this service currently hands out. */
  async domains() {
    const j = await this.get('/domain');
    const list = (j.domains || j || []).map((d) => d.qdn || d.domain || d).filter(Boolean);
    return list.map((d) => String(d).toLowerCase());
  }

  /** A fresh address — on `domain` when one is requested. */
  async createAccount({ domain = this.domain } = {}) {
    const pool = await this.domains();
    const chosen = domain ? pool.find((d) => d === domain) || domain : pool[0];
    if (!chosen) throw new Error('inboxes.com published no domains');
    this.address = `rb${Math.random().toString(36).slice(2, 9)}@${chosen}`;
    return { address: this.address, password: '(none — public inbox)' };
  }

  /** Polls the inbox until a message carries a 6-digit code. */
  async waitForCode({ address = this.address, timeoutMs = 120000, pollMs = 4000, log } = {}) {
    if (!address) throw new Error('InboxesCom: createAccount() first');
    const say = log || this.log;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const json = await this.get(`/inbox/${encodeURIComponent(address)}`);
      const flat = allStrings(json);
      const count = (json.msgs || json.messages || []).length;
      const code = extractCode(flat);
      if (code) {
        say(`inboxes.com: code ${code} (${count} message(s))`);
        return code;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`no verification code for ${address} within ${Math.round(timeoutMs / 1000)}s`);
  }

  close() {
    this.address = null;
  }
}

module.exports = { InboxesCom, extractCode, allStrings };
