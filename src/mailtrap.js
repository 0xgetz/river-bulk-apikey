'use strict';

/**
 * Mailtrap Inbound backend — the inbox the sign-up gate accepts, with a reader.
 *
 * Why this one: the sign-up decides on the *domain*, and it keeps a list. Every
 * disposable-mail domain tested is on that list (`mail.tm`, `mail.gw`,
 * guerrillamail, mailinator, maildrop, tempmail.lol, mailslurp, inboxkitten,
 * tempmail.plus, all eighteen inboxes.com domains, the whole YOPmail family),
 * while `inbound-mailtrap.io` — Mailtrap's developer inbound service — is not.
 * Measured 2026-10-14: an address on it walks straight past the gate.
 *
 * The reader is Mailtrap's own REST API, so no Cloudflare challenge, no captcha
 * and no browser is involved on the inbox side:
 *
 *   GET  /api/inbound/folders                      list folders
 *   POST /api/inbound/folders            {name}    create one
 *   POST /api/inbound/folders/{id}/inboxes {name}  create an inbox -> address
 *   GET  /api/inbound/inboxes/{id}/messages        newest first
 *   GET  /api/inbound/inboxes/{id}/messages/{msg}  decoded text_body / html_body
 *
 * Auth: `Authorization: Bearer <API token>` (or `Api-Token:`); the token comes
 * from `MAILTRAP_TOKEN`, `--mailtrap-token-file`, or `%USERPROFILE%\.river-mailtrap-token`.
 * Their free plan includes inbound and, per their documentation, a generated
 * address "can receive mail from any sender".
 *
 * Same shape as MailTM / TempMailIo / GuerrillaMail for provisionAccount():
 *   createAccount() -> { address }
 *   waitForCode()   -> the 6-digit code
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fetchText } = require('./proxy');

const API = 'https://mailtrap.io/api';
const DEFAULT_FOLDER = 'river-bulk';
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

/** Token lookup order: explicit value, file, environment, home directory. */
function resolveToken({ token, tokenFile, log = () => {} } = {}) {
  const fromFile = (file) => {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value) return value;
    } catch (e) {}
    return null;
  };
  if (token) return token;
  if (tokenFile) {
    const value = fromFile(tokenFile);
    if (value) return value;
    throw new Error(`Mailtrap: no token in ${tokenFile}`);
  }
  if (process.env.MAILTRAP_TOKEN) return process.env.MAILTRAP_TOKEN;
  const home = path.join(os.homedir(), '.river-mailtrap-token');
  const value = fromFile(home);
  if (value) return value;
  throw new Error(
    'Mailtrap: no API token. Set MAILTRAP_TOKEN, pass --mailtrap-token-file, or write the token to ' +
      path.join(os.homedir(), '.river-mailtrap-token') +
      ' (Mailtrap → Settings → API Tokens).'
  );
}

class Mailtrap {
  /**
   * @param {{proxy?: object|null, token?: string, tokenFile?: string, folder?: string, domain?: string, log?: Function, timeoutMs?: number}} opts
   */
  constructor({ proxy = null, token, tokenFile, folder = DEFAULT_FOLDER, domain = null, log, timeoutMs = 25000 } = {}) {
    this.proxy = proxy;
    this.token = resolveToken({ token, tokenFile, log });
    this.folderName = folder;
    this.domain = domain;
    this.log = log || (() => {});
    this.timeoutMs = timeoutMs;
    this.folderId = null;
    this.inboxId = null;
    this.address = null;
  }

  async call(method, path_, { body } = {}) {
    const text = await fetchText(this.proxy, `${API}${path_}`, {
      method,
      body,
      timeoutMs: this.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        'User-Agent': 'river-bulk/1.0',
      },
    });
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`Mailtrap ${method} ${path_} returned non-JSON (${text.slice(0, 80)})`);
    }
    return json;
  }

  /** Folder that inboxes live in — created on first use. */
  async ensureFolder() {
    if (this.folderId) return this.folderId;
    const folders = await this.call('GET', '/inbound/folders');
    const list = Array.isArray(folders) ? folders : folders.folders || [];
    const found = list.find((f) => f.name === this.folderName);
    if (found) {
      this.folderId = found.id;
      return this.folderId;
    }
    const created = await this.call('POST', '/inbound/folders', { body: { name: this.folderName } });
    if (!created || !created.id) throw new Error(`Mailtrap: folder creation returned ${JSON.stringify(created).slice(0, 120)}`);
    this.log(`mailtrap: created folder "${this.folderName}" (${created.id})`);
    this.folderId = created.id;
    return this.folderId;
  }

  /** One fresh inbox per account; the generated address is what the sign-up gets. */
  async createAccount({ domain = this.domain } = {}) {
    const folderId = await this.ensureFolder();
    const name = `rb${Math.random().toString(36).slice(2, 8)}`;
    const inbox = await this.call('POST', `/inbound/folders/${folderId}/inboxes`, { body: { name } });
    if (!inbox || !inbox.address) throw new Error(`Mailtrap: inbox creation returned ${JSON.stringify(inbox).slice(0, 140)}`);
    if (domain && !String(inbox.address).endsWith(`@${domain}`)) {
      throw new Error(`Mailtrap: asked for @${domain} but got ${inbox.address}`);
    }
    this.inboxId = inbox.id;
    this.address = inbox.address;
    return { address: this.address, password: '(none — Mailtrap inbox)', inboxId: inbox.id };
  }

  /** Message list, newest first — the API wraps it as `{data, total_count, last_id}`. */
  async messages({ inboxId = this.inboxId } = {}) {
    if (!inboxId) throw new Error('Mailtrap: createAccount() first');
    const json = await this.call('GET', `/inbound/inboxes/${inboxId}/messages`);
    if (Array.isArray(json)) return json;
    return json.data || json.messages || [];
  }

  async message(id, { inboxId = this.inboxId } = {}) {
    return this.call('GET', `/inbound/inboxes/${inboxId}/messages/${id}`);
  }

  /** Polls until a message carries a 6-digit code. */
  async waitForCode({ timeoutMs = 150000, pollMs = 4000, log } = {}) {
    if (!this.inboxId) throw new Error('Mailtrap: createAccount() first');
    const say = log || this.log;
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    while (Date.now() < deadline) {
      const list = await this.messages();
      for (const item of list) {
        const id = item.id || item.message_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const full = await this.message(id);
        const code = extractCode(allStrings(full));
        if (code) {
          say(`mailtrap: code ${code} ("${String(full.subject || item.subject || '').slice(0, 40)}")`);
          return code;
        }
        say(`mailtrap: message without a code ("${String(full.subject || '').slice(0, 40)}")`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`Mailtrap: no verification code for ${this.address} within ${Math.round(timeoutMs / 1000)}s`);
  }

  close() {
    this.inboxId = null;
    this.address = null;
  }
}

module.exports = { Mailtrap, extractCode, allStrings, resolveToken };
