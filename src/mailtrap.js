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
 *   DELETE /api/inbound/folders/{fid}/inboxes/{id} 204, no body — frees a slot
 *
 * The account refuses more than 300 inboxes across all folders
 * (`{"errors":{"base":["account cannot have more than 300 inboxes"]}}`,
 * measured 2026-10-15 at 299 held), and the delete route above is the only one
 * that answers — `/inbound/inboxes/{id}` is not routed.
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
const TRANSPORT_TRIES = 3;

/**
 * Retry a request whose *connection* failed.
 *
 * mailtrap.io drops the odd connection from this line with a bare ETIMEDOUT —
 * measured 2026-10-15: 3 of 10 requests in a burst (while a mint was running),
 * then 40 of 40 when quiet, so it is contention, not a family or a route. A
 * retry costs a second; a create that aborts on one dropped SYN costs an
 * account, and the account it costs is the one the campaign was counting on.
 */
async function fetchWithRetry(proxy, url, options, tries = TRANSPORT_TRIES) {
  const failures = [];
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fetchText(proxy, url, options);
    } catch (e) {
      failures.push([e.code, e.message].filter(Boolean).join(': ') || 'connect failed');
      if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw new Error(`unreachable after ${tries} tries (${failures.join(' | ')})`);
}
/**
 * The live River mail is `multipart/alternative` quoted-printable and its
 * plain-text part reads "Enter the code below in your open browser window." one
 * blank line above the code — 36 characters between the anchor word and the
 * digits once whitespace is collapsed (measured on a delivered message,
 * 2026-10-15, fixture: outputs/inbox-rail/fixture-river-email.eml). The old
 * 40-character window left four characters of slack, so one rewording on
 * River's side would stop the reader without any error to show for it.
 */
const CODE_RE = /(?:code|kod|otp|verification)[^0-9]{0,80}(\d{6})/i;

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

/**
 * One header field of a part: continuation lines are unfolded onto the field
 * they belong to and the first real occurrence wins.
 *
 * The unfolding is not cosmetic — a DKIM-Signature header carries `h=content-
 * type:date:from:…` on a folded line, and a header-blind regex reads that as a
 * Content-Type of "date:from:mime-version:…" and then finds no body at all.
 */
function headerValue(head, name) {
  const unfolded = [];
  for (const line of String(head).split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += ' ' + line.trim();
    else unfolded.push(line);
  }
  const prefix = `${name.toLowerCase()}:`;
  const hit = unfolded.find((line) => line.toLowerCase().startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : '';
}

/**
 * Leaf parts of a MIME message, flattened — enough of RFC2045 to read a body.
 */
function mimeParts(raw) {
  const part = String(raw).replace(/^\r?\n/, '');
  const cut = part.search(/\r?\n\r?\n/);
  if (cut < 0) return [{ ctype: 'text/plain', body: part, encoding: '' }];
  const head = part.slice(0, cut);
  const body = part.slice(cut).replace(/^\r?\n\r?\n/, '');
  const contentType = headerValue(head, 'content-type');
  const ctype = (contentType.split(';')[0] || '').trim().toLowerCase() || 'text/plain';
  const encoding = (headerValue(head, 'content-transfer-encoding').split(';')[0] || '').trim();
  if (!ctype.startsWith('multipart/')) return [{ ctype, body, encoding }];
  const boundary = (/boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(contentType) || [])[1] || '';
  if (!boundary) return [{ ctype: 'text/plain', body, encoding }];
  const marker = new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  return body
    .split(marker)
    .slice(1)
    .filter((chunk) => !/^--\s*$/.test(chunk))
    .flatMap((chunk) => mimeParts(chunk));
}

/** base64, quoted-printable, or byte-for-byte. */
function decodeTransfer(body, encoding) {
  const enc = String(encoding).trim().toLowerCase();
  if (enc === 'base64') {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch (e) {
      return body;
    }
  }
  if (enc === 'quoted-printable') {
    const bytes = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8'); // =E2=80=8A and friends
  }
  return body;
}

/** What a human would read: the text part first, then the HTML with its tags off. */
function emlToText(raw) {
  const parts = mimeParts(raw);
  const text = parts.filter((p) => p.ctype === 'text/plain').map((p) => decodeTransfer(p.body, p.encoding));
  const html = parts
    .filter((p) => p.ctype === 'text/html')
    .map((p) => decodeTransfer(p.body, p.encoding).replace(/<[^>]+>/g, ' '));
  return [...text, ...html].join('\n');
}

/**
 * The sentence inside a Mailtrap error payload, whatever shape it arrives in.
 *
 * @returns {string|null} null when the payload is data, not an error.
 */
function mailtrapError(json) {
  if (!json || typeof json !== 'object' || json.errors === undefined || json.errors === null) return null;
  const flatten = (value) =>
    Array.isArray(value)
      ? value.map(flatten).filter(Boolean).join('; ')
      : value && typeof value === 'object'
        ? Object.entries(value).map(([key, inner]) => `${key}: ${flatten(inner)}`).join('; ')
        : String(value);
  const sentence = flatten(json.errors).trim();
  return sentence || 'request refused without a message';
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
    const text = await fetchWithRetry(this.proxy, `${API}${path_}`, {
      method,
      body,
      timeoutMs: this.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        'User-Agent': 'river-bulk/1.0',
      },
    });
    // A DELETE answers 204 with no body at all, so an empty reply is a success.
    if (!String(text).trim()) return null;
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`Mailtrap ${method} ${path_} returned non-JSON (${text.slice(0, 80)})`);
    }
    // Errors arrive as JSON with 2xx-adjacent shapes, and Mailtrap has used at
    // least three of them: `{errors: ["…"]}`, `{errors: {base: ["…"]}}` and
    // `{errors: "…"}`. Returning one as data is how a rate limit turns into "the
    // inbox is empty" and the reader waits out its whole timeout — and how the
    // 300-inbox cap surfaced as "[object Object]" instead of the actual sentence.
    const failure = mailtrapError(json);
    if (failure) throw new Error(`Mailtrap ${method} ${path_} -> ${failure}`);
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

  /**
   * Readable body text for one message.
   *
   * Mailtrap inlines `text_body`/`html_body` for most senders, but it answers
   * some with neither key and `text_size: null` (measured 2026-10-15: every
   * OrcaRouter notification, and a plain SMTP probe) while the message still
   * carries a signed `raw_message_url`. Without this fallback those messages
   * read as empty and the poll burns its whole timeout on a code that is
   * sitting right there in the EML.
   */
  async body(message) {
    const inline = `${message.text_body || ''}\n${message.html_body || ''}`;
    if (inline.trim()) return inline;
    if (!message.raw_message_url) return '';
    try {
      return emlToText(await fetchWithRetry(this.proxy, message.raw_message_url, { timeoutMs: this.timeoutMs }));
    } catch (e) {
      this.log(`mailtrap: raw body fetch failed (${String(e.message).slice(0, 80)})`);
      return '';
    }
  }

  /**
   * Message list with bodies attached, oldest first.
   *
   * The shape is the one every reader in the repo speaks — `{id, subject, from,
   * text}` — because the extractor walks those fields, not a provider schema.
   *
   * @param {{match?: (message: {subject: string, from: string, text: string}) => boolean}} opts
   */
  async inboxContents({ match = null } = {}) {
    const out = [];
    for (const item of await this.messages()) {
      const id = item.id || item.message_id;
      if (!id) continue;
      const full = await this.message(id);
      const message = {
        id: String(id),
        subject: String(full.subject || item.subject || ''),
        from: String(full.from || ''),
        inline: Boolean(String(full.text_body || full.html_body || '').trim()),
        text: await this.body(full),
      };
      if (!match || match(message)) out.push(message);
    }
    return out.reverse();
  }

  /**
   * Polls until a message carries a 6-digit code.
   *
   * @param {{timeoutMs?: number, pollMs?: number, match?: Function, subjectIncludes?: string, log?: Function}} opts
   *   match — keep only messages this predicate accepts (subject/from/text).
   *   subjectIncludes — the shape the mint already asks for (`river.js`), so an
   *   inbox that also attracts unrelated mail cannot hand over a stranger's code.
   */
  async waitForCode({ timeoutMs = 150000, pollMs = 4000, match = null, subjectIncludes = null, log } = {}) {
    if (!this.inboxId) throw new Error('Mailtrap: createAccount() first');
    const say = log || this.log;
    const wanted = subjectIncludes ? String(subjectIncludes).toLowerCase() : null;
    const accepts = (message) =>
      (!wanted || message.subject.toLowerCase().includes(wanted)) && (!match || match(message));
    const deadline = Date.now() + timeoutMs;
    const seen = new Set();
    while (Date.now() < deadline) {
      const list = await this.messages();
      for (const item of list) {
        const id = item.id || item.message_id;
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const full = await this.message(id);
        const subject = String(full.subject || item.subject || '');
        const text = await this.body(full);
        if (!accepts({ subject, from: String(full.from || ''), text })) {
          say(`mailtrap: skipped "${subject.slice(0, 40)}"`);
          continue;
        }
        const code =
          extractCode(text) || extractCode(allStrings({ ...full, raw_message_url: null, raw_message_expires_at: null }));
        if (code) {
          say(`mailtrap: code ${code} ("${subject.slice(0, 40)}")`);
          return code;
        }
        say(`mailtrap: message without a code ("${subject.slice(0, 40)}")`);
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

module.exports = { Mailtrap, extractCode, allStrings, resolveToken, emlToText };
