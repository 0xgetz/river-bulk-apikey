'use strict';

/**
 * temp-mail.org (web2) backend.
 *
 * What was measured on 2026-10-14, from a browser session whose Cloudflare
 * interstitial a human cleared once (headed Chrome, proxy-lab/tm-headed-unlock.js):
 *
 *   API base                https://web2.temp-mail.org
 *                           (decoded from the site's own bundle: `api_url` is
 *                           that URL base64-obfuscated)
 *   auth                    the SPA keeps a JWT in the `token` cookie
 *                           (HS256, payload `{uuid, mailbox, iat}`) and sends it
 *                           as `Authorization: Bearer <token>` on every call;
 *                           the Cloudflare cookies (`cf_clearance`, `__cf_bm`)
 *                           ride along or the edge answers 403
 *   GET  /mailbox           -> 200 {"mailbox":"<local>@<domain>"}   (204 when empty)
 *   GET  /messages          -> 200 {"mailbox":"<local>@<domain>","messages":[…]}
 *   GET  /messages (no auth)-> 401 {"errorMessage":"Unauthorized to access this
 *                                    resource","errorName":"UnauthorizedException"}
 *   POST /token             -> 404 E_ROUTE_NOT_FOUND — there is no such route;
 *                           the JWT arrives with the page load, not from a mint
 *   GET  /domains           -> 401: the site's own client calls it with a
 *                           `secret` query parameter (bundle evidence); that
 *                           secret was never captured, so domain listing is
 *                           not usable here
 *   POST /mailbox           -> the site's own generated client (`newMailboxRaw`)
 *                           POSTs `/mailbox` with a `{domain}` body; never
 *                           exercised end to end (the line was stopped)
 *
 * Cloudflare fact worth keeping: every request from this machine and from the
 * public datacenter proxies we tried is answered with the "Just a moment…"
 * interstitial (403) — Node alone cannot pass it, and headless Chrome never
 * clears the widget. A headed browser must clear it once, and the harvested
 * `{cookies, token}` **is not enough to replay from Node**: measured 2026-10-15,
 * a jar of 17 cookies taken straight from CDP (`Network.getAllCookies`, so
 * `cf_clearance` included) was refused with the same 403 on `GET /mailbox`,
 * `GET /messages` and `POST /mailbox`. The edge fingerprints the client, not
 * just the cookie, so the working reader is an in-page `fetch()` from the
 * cleared page (`Runtime.evaluate`), which answers 200 — see the page mode in
 * `tools/inbox-factory.js` and `outputs/inbox-rail/tempmailorg-session-evidence.json`.
 * This module still speaks the raw protocol and fails loudly rather than
 * pretending when the edge refuses it.
 *
 * Same shape as MailTM / TempMailIo / GuerrillaMail for provisionAccount():
 *   createAccount() -> {address, token}
 *   waitForCode()   -> the 6-digit code
 */

const https = require('https');
const { URL } = require('url');
const { createAgent } = require('./proxy');

const BASE = 'https://web2.temp-mail.org';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';

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

function looksLikeChallenge(text) {
  return /just a moment/i.test(text) || /challenge-platform|cf-mitigated|_cf_chl/i.test(text);
}

/** `{name: value}` or a raw `a=1; b=2` string -> the raw header form. */
function cookieHeader(cookies) {
  if (!cookies) return '';
  if (typeof cookies === 'string') return cookies;
  return Object.entries(cookies)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function addressOf(json) {
  if (!json || typeof json !== 'object') return null;
  const a = json.mailbox || json.address || json.email || (json.data && (json.data.mailbox || json.data.address || json.data.email));
  return typeof a === 'string' && a.includes('@') ? a : null;
}

class TempMailOrg {
  /**
   * @param {{proxy?: object|null, domain?: string, log?: Function, timeoutMs?: number,
   *          session?: {token?: string, cookies?: object|string, address?: string}}} opts
   *   session — `{cookies, token}` harvested from a Cloudflare-cleared browser
   *             (proxy-lab/tm-session-harvest2.js writes
   *             proxy-lab/out/tempmailorg-session.json in exactly this shape).
   *             Without it every call is refused by the edge; the constructor
   *             still builds, and use before harvest throws a pointed error.
   *   domain  — the address domain to insist on; the API assigns the domain, so
   *             a mismatch is an error, never a silent substitution.
   */
  constructor({ proxy = null, domain = null, log, timeoutMs = 25000, session = null } = {}) {
    this.proxy = proxy;
    this.domain = domain;
    this.log = log || (() => {});
    this.timeoutMs = timeoutMs;
    this.cookies = session ? session.cookies || null : null;
    this.token = (session && (session.token || (session.cookies && session.cookies.token))) || null;
    this.address = (session && session.address) || null;
  }

  /** The live session material, for persisting next to the run evidence. */
  exportSession() {
    return { token: this.token, cookies: this.cookies, address: this.address };
  }

  requireSession(what) {
    if (!this.token && !this.cookies) {
      throw new Error(
        `temp-mail.org ${what}: no session — the edge only talks to a Cloudflare-cleared browser; run proxy-lab/tm-headed-unlock.js, clear the interstitial, harvest with proxy-lab/tm-session-harvest2.js, then pass {session}`
      );
    }
  }

  /**
   * One API call. Returns `{ status, text, json() }`; the caller decides what a
   * status means (204 "nothing", 401 auth, 403 Cloudflare carry different
   * stories on this host).
   */
  request(method, path, { token, body } = {}) {
    this.requireSession(`${method} ${path}`);
    return new Promise((resolve, reject) => {
      const u = new URL(BASE + path);
      const payload =
        body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const headers = {
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'User-Agent': UA,
        Origin: 'https://temp-mail.org',
        Referer: 'https://temp-mail.org/',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="155", "Google Chrome";v="155"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-site',
      };
      const cookie = cookieHeader(this.cookies);
      if (cookie) headers.Cookie = cookie;
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      const bearer = token === undefined ? this.token : token;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      const req = https.request(
        {
          method,
          host: u.hostname,
          port: 443,
          path: u.pathname + u.search,
          agent: this.proxy ? createAgent(this.proxy) : undefined,
          headers,
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => {
            // Keep the session alive: merge any refreshed cookies back in.
            const setCookies = res.headers['set-cookie'];
            if (setCookies && setCookies.length) {
              const jar = typeof this.cookies === 'object' && this.cookies ? { ...this.cookies } : {};
              for (const c of setCookies) {
                const [pair] = String(c).split(';');
                const eq = pair.indexOf('=');
                if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
              }
              this.cookies = jar;
              if (jar.token) this.token = jar.token;
            }
            resolve({
              status: res.statusCode,
              text,
              json() {
                try {
                  return JSON.parse(text);
                } catch {
                  return null;
                }
              },
            });
          });
        }
      );
      req.setTimeout(this.timeoutMs, () =>
        req.destroy(new Error(`temp-mail.org timeout after ${this.timeoutMs}ms (${method} ${path})`))
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Status/JSON guard; Cloudflare is looked at first and reported as itself. */
  expect(res, what) {
    if (res.status === 403 && looksLikeChallenge(res.text)) {
      throw new Error(
        `temp-mail.org ${what}: Cloudflare challenge (403) — a Node client is refused here even with a jar taken from a cleared page (measured 2026-10-15: 17 cookies incl. cf_clearance, still 403). The working reader is an in-page fetch() from the cleared page; see tools/inbox-factory.js and outputs/inbox-rail/tempmailorg-session-evidence.json`
      );
    }
    if (res.status === 401) {
      throw new Error(
        `temp-mail.org ${what}: 401 unauthorized — session token missing or expired; re-harvest from a cleared browser`
      );
    }
    if (res.status !== 200) {
      throw new Error(`temp-mail.org ${what}: HTTP ${res.status} ${res.text.slice(0, 120).replace(/\s+/g, ' ')}`);
    }
    const json = res.json();
    if (json === null) throw new Error(`temp-mail.org ${what}: non-JSON body ${res.text.slice(0, 120)}`);
    return json;
  }

  /** GET /mailbox — the address this session owns (204 when nothing yet). */
  async getMailbox() {
    const res = await this.request('GET', '/mailbox');
    if (res.status === 204) return res;
    this.expect(res, 'GET /mailbox');
    return res;
  }

  /** GET /messages — `{mailbox, messages}` (204 when there is nothing new). */
  async messages() {
    const res = await this.request('GET', '/messages');
    if (res.status === 204) return res;
    this.expect(res, 'GET /messages');
    return res;
  }

  /**
   * The session's address. The edge assigns the mailbox per session (observed
   * rotating: @aahzz.com, @comzx.com), so when `domain` is requested and the
   * answer is on another domain, the site's own creation call (`POST /mailbox`,
   * body `{domain}` — shape from the site's bundle, unverified end to end) gets
   * one shot; if that still does not land on `domain`, this is an error, never
   * a silent substitution.
   */
  async createAccount({ domain = this.domain } = {}) {
    this.requireSession('createAccount');
    const res = await this.getMailbox();
    let address = res.status === 204 ? null : addressOf(res.json());
    let note = null;

    if (!address) throw new Error('temp-mail.org: session has no mailbox yet (GET /mailbox → 204)');

    if (domain && String(address).split('@')[1] !== domain) {
      const post = await this.request('POST', '/mailbox', { body: { domain } });
      const pj = post.json();
      const created = post.status === 200 || post.status === 201 ? addressOf(pj) : null;
      if (created) address = created;
      else note = `POST /mailbox {domain:"${domain}"} → HTTP ${post.status} ${post.text.slice(0, 100).replace(/\s+/g, ' ')}`;
    }

    if (domain && String(address).split('@')[1] !== domain) {
      throw new Error(
        `temp-mail.org assigned ${address}, not an @${domain} address${note ? ` (${note})` : ''} — the API owns domain choice; domain pinning is unproven`
      );
    }
    this.address = address;
    return { address, password: '(none — public inbox)', token: this.token };
  }

  /** GET /domains — needs the site's `secret` query parameter; 401 without it. */
  async domains() {
    const res = await this.request('GET', '/domains');
    if (res.status === 401) {
      throw new Error(
        'temp-mail.org GET /domains: 401 — the route wants the site\'s `secret` parameter (bundle evidence: getDomains(requestParameters.secret)); the value was never captured'
      );
    }
    const json = this.expect(res, 'GET /domains');
    return json.domains || json.data || json;
  }

  /** Polls the inbox until a message carries a 6-digit code. */
  async waitForCode({ address = this.address, token = this.token, timeoutMs = 120000, pollMs = 4000, log } = {}) {
    if (!token) throw new Error('TempMailOrg: createAccount() first (no session token)');
    const say = log || this.log;
    const deadline = Date.now() + timeoutMs;
    let lastCount = -1;
    while (Date.now() < deadline) {
      const res = await this.request('GET', '/messages', { token });
      if (res.status === 204) {
        if (lastCount !== 0) {
          lastCount = 0;
          say(`temp-mail.org: 0 message(s) so far for ${address || 'mailbox'}`);
        }
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      if (res.status === 403 && looksLikeChallenge(res.text)) {
        throw new Error(
          'temp-mail.org GET /messages: Cloudflare challenge (403) — this exit is not cleared; use a session harvested from a cleared headed browser'
        );
      }
      if (res.status === 401) throw new Error('temp-mail.org GET /messages: 401 unauthorized — session token expired');
      if (res.status !== 200)
        throw new Error(`temp-mail.org GET /messages: HTTP ${res.status} ${res.text.slice(0, 120)}`);
      const json = res.json() || {};
      const messages = Array.isArray(json) ? json : json.messages || json.data || [];
      const code = extractCode(allStrings(json));
      if (code) {
        say(`temp-mail.org: code ${code} (${messages.length} message(s))`);
        return code;
      }
      if (messages.length !== lastCount) {
        lastCount = messages.length;
        say(`temp-mail.org: ${messages.length} message(s) so far for ${address || 'mailbox'}`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`no verification code for ${address || 'mailbox'} within ${Math.round(timeoutMs / 1000)}s`);
  }

  close() {
    this.address = null;
    this.token = null;
  }
}

module.exports = { TempMailOrg, extractCode, allStrings };
