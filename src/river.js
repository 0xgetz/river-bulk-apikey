'use strict';

/**
 * River AI Console automation primitives.
 *
 * Sign-up / e-mail verification run on WorkOS AuthKit's hosted flow
 * (login.console.river.ai) which is protected by Cloudflare Turnstile +
 * WorkOS Radar. Those pages are deliberately hostile to pure HTTP clients,
 * so accounts are created by driving the real UI in a (cloud) browser over CDP.
 *
 * After e-mail verification the console exchanges the OAuth code and starts
 * calling its own API with an `Authorization: Bearer <workos access token>`
 * header. That token is short-lived and never written to web storage, so the
 * toolkit captures it from the first authenticated request via CDP network
 * events, then uses it out-of-band against the console REST API:
 *
 *   POST   https://console.river.ai/api/keys   -> mint an API key
 *   GET    https://console.river.ai/api/keys   -> list API keys
 *   GET    https://console.river.ai/api/me     -> account identity
 *
 * River inference (https://api.river.ai/v1) is OpenAI-compatible.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { CDP } = require('./cdp');
const { browserUrl, createAgent, attachProxyAuth } = require('./proxy');
const { applyHygiene } = require('./hygiene');

const HOST = 'https://console.river.ai';
const LOGIN_HOST = 'https://login.console.river.ai';
const API_HOST = 'https://api.river.ai';
const CLIENT_ID = 'client_01M0TG5W3GBNMFS87K40PYHM98';
const REDIRECT_URI = `${HOST}/auth/callback`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomPassword(len = 16) {
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digit = '23456789';
  const sym = '!@#$%^&*';
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  let p = pick(upper) + pick(lower) + pick(digit) + pick(sym);
  const all = lower + upper + digit + sym;
  while (p.length < len) p += pick(all);
  return p;
}

/**
 * Small JSON-over-HTTP helper. `agent` lets a caller pin the request to a
 * proxy (see ./proxy createAgent) — when it is set there is no direct route.
 */
function httpJson(method, url, { headers = {}, body, timeoutMs = 30000, agent } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = lib.request(
      {
        method,
        agent,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: Object.assign(
          {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
            Accept: 'application/json',
          },
          data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
          headers
        ),
      },
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
          resolve({ status: res.statusCode, headers: res.headers, body: parsed });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Drives the hosted AuthKit UI inside one isolated browser context and returns
 * the context's live state. One instance per account.
 */
class RiverBrowser {
  constructor(cdp, { sessionId, log = () => {} } = {}) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.log = log;
  }

  async eval(expression) {
    const r = await this.cdp.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId
    );
    if (r.exceptionDetails) {
      const ex = r.exceptionDetails.exception;
      throw new Error(`eval failed: ${(ex && (ex.description || ex.value)) || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  async goto(url, { waitMs = 4000 } = {}) {
    const loaded = this.cdp
      .waitFor('Page.loadEventFired', { timeoutMs: 30000, sessionId: this.sessionId })
      .catch(() => {});
    await this.cdp.send('Page.navigate', { url }, this.sessionId);
    await Promise.race([loaded, sleep(15000)]);
    await sleep(waitMs);
  }

  text() {
    return this.eval('document.body ? document.body.innerText : ""');
  }

  async waitForText(substr, { timeoutMs = 45000, pollMs = 700 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const txt = await this.text().catch(() => '');
      if (txt && txt.toLowerCase().includes(substr.toLowerCase())) return true;
      await sleep(pollMs);
    }
    return false;
  }

  currentUrl() {
    return this.eval('location.href');
  }

  async fillSignup({ firstName, lastName, email }) {
    return this.eval(`(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      function set(name, val){
        const el = document.querySelector('input[name="'+name+'"]');
        if(!el) return false;
        setter.call(el, val);
        el.dispatchEvent(new Event('input',{bubbles:true}));
        el.dispatchEvent(new Event('change',{bubbles:true}));
        return true;
      }
      const ok1 = set('first_name', ${JSON.stringify(firstName)});
      const ok2 = set('last_name', ${JSON.stringify(lastName)});
      const ok3 = set('email', ${JSON.stringify(email)});
      const btn = [...document.querySelectorAll('button')].find(b => /continue|sign ?up/i.test(b.innerText));
      if(btn) btn.click();
      return { ok1, ok2, ok3, clicked: !!btn };
    })()`);
  }

  async fillPassword(password) {
    return this.eval(`(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const el = document.querySelector('input[type="password"]');
      if(!el) return { ok:false, reason:'no password field' };
      setter.call(el, ${JSON.stringify(password)});
      el.dispatchEvent(new Event('input',{bubbles:true}));
      el.dispatchEvent(new Event('change',{bubbles:true}));
      const btn = [...document.querySelectorAll('button')].find(b => /continue|create account|sign ?up/i.test(b.innerText));
      if(btn) btn.click();
      return { ok:true, clicked: !!btn };
    })()`);
  }

  async enterOtp(code) {
    return this.eval(`(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const inputs = [...document.querySelectorAll('input')].filter(i => i.type !== 'hidden');
      if(inputs.length < 6) return { ok:false, n: inputs.length };
      const code = ${JSON.stringify(code)};
      for(let i=0;i<6;i++){
        setter.call(inputs[i], code[i] || '');
        inputs[i].dispatchEvent(new Event('input',{bubbles:true}));
        inputs[i].dispatchEvent(new Event('change',{bubbles:true}));
      }
      // The screen usually advances on its own once the last digit lands; when it
      // does not, submitting is what a person would do — observed once in a real
      // run where the code was accepted but the console never moved on.
      const last = inputs[5];
      last.focus();
      for (const type of ['keydown','keypress','keyup']) {
        last.dispatchEvent(new KeyboardEvent(type, { key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true }));
      }
      const btn = [...document.querySelectorAll('button')].find(b => /continue|verify|submit|confirm/i.test(b.innerText||''));
      if(btn) btn.click();
      return { ok:true, n: inputs.length, submitted: !!btn };
    })()`);
  }
}

/**
 * Snapshot of what the page currently shows — folded into step failures so a
 * blocked flow reports *why* instead of just which screen never appeared.
 */
async function pageState(rb) {
  const url = await rb.currentUrl().catch(() => '?');
  const text = await rb.text().catch(() => '');
  return `${url} · "${String(text).replace(/\s+/g, ' ').trim().slice(0, 300)}"`;
}

/**
 * Full single-account provisioning. Creates an isolated browser context,
 * signs up via the hosted AuthKit UI with a mail.tm inbox, verifies e-mail,
 * captures the console access token, and mints an API key.
 *
 * Pass `proxy` (see ./proxy) to send both the page traffic and the console API
 * calls out through it; without one, everything leaves from this machine.
 *
 * @returns {Promise<{email,password,apiKey,apiKeyId,token,balanceUsd,raw}>}
 */
async function provisionAccount(cdp, mail, opts = {}) {
  const {
    firstName = 'Alex',
    lastName = 'Morgan',
    password = randomPassword(16),
    keyName = opts.keyName || `key-${Math.random().toString(36).slice(2, 8)}`,
    description,
    expiresInDays,
    log = () => {},
    proxy = null,
    allowDirect = false,
    signupTimeoutMs = 60000,
    verifyTimeoutMs = 120000,
  } = opts;

  // The CLI already refuses to run without a proxy list; the library refuses
  // the same way, so a caller cannot reach River from this machine's address
  // merely by forgetting to pass one.
  if (!proxy && !allowDirect) {
    throw new Error(
      "no proxy given — refusing to sign up from this machine's own IP.\n" +
        '  Pass { proxy } (see ./proxy) or { allowDirect: true } to opt in explicitly.'
    );
  }

  const acct = await mail.createAccount();
  const email = acct.address;
  log(`inbox ${email}`);

  // One context per account, and — whenever a proxy is in play — one exit
  // address per account: page traffic through the context's proxy, console API
  // traffic through an agent pinned to the same proxy. No request has a direct
  // fallback, so a broken proxy fails the account instead of leaking the host IP.
  const agent = proxy ? createAgent(proxy) : undefined;
  const browserContextId = await cdp.createBrowserContext({ proxyServer: proxy ? browserUrl(proxy) : undefined });
  const { targetId, sessionId } = await cdp.newPage({ browserContextId });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);
  // Chrome's disk cache is per profile, not per context: without this, account
  // #2 can be served account #1's bytes and never touch its own proxy.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  // Announcing "HeadlessChrome" is enough for the sign-up to be refused even
  // from a clean address (see ./hygiene); override before the first navigation.
  if (opts.hygiene !== false) await applyHygiene(cdp, sessionId, { log });
  const detachProxyAuth = await attachProxyAuth(cdp, sessionId, proxy);

  let token = null;
  const off = cdp.on(
    'Network.requestWillBeSent',
    (p) => {
      const a = p.request.headers.Authorization || p.request.headers.authorization;
      if (!token && a && a.startsWith('Bearer ')) token = a.slice(7);
    },
    sessionId
  );

  const rb = new RiverBrowser(cdp, { sessionId, log });
  try {
    const url =
      `${LOGIN_HOST}/sign-up?client_id=${CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
    await rb.goto(url, { waitMs: 5000 });

    // Step 1: name + email
    let ok = await rb.waitForText('First name', { timeoutMs: signupTimeoutMs });
    if (!ok) throw new Error(`sign-up form did not load — page ${await pageState(rb)}`);
    const filled = await rb.fillSignup({ firstName, lastName, email });
    if (!filled.ok1 || !filled.ok2 || !filled.ok3 || !filled.clicked) {
      throw new Error(`sign-up form did not accept input (${JSON.stringify(filled)}) — page ${await pageState(rb)}`);
    }

    // Step 2: password
    await rb.waitForText('Password', { timeoutMs: signupTimeoutMs });
    await sleep(1500);
    const pwd = await rb.fillPassword(password);
    if (!pwd.ok) throw new Error(`password step failed (${JSON.stringify(pwd)}) — page ${await pageState(rb)}`);

    // Step 3: e-mail verification code
    const atOtp = await rb.waitForText('Verify your email', { timeoutMs: signupTimeoutMs });
    if (!atOtp) throw new Error(`email verification screen did not appear — page ${await pageState(rb)}`);
    const code = await mail.waitForCode({ address: email, subjectIncludes: 'verify', timeoutMs: verifyTimeoutMs });
    log(`code ${code}`);
    await rb.enterOtp(code);

    // Step 4: wait for console to finish and the bearer token to appear.
    // 45s was enough when the console redirected straight away, but the hosted
    // flow stalls sometimes (observed: code accepted, token still absent after
    // 45s on an otherwise identical run), so the window is generous and the
    // failure reports what the page was showing.
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline && !token) await sleep(1000);
    if (!token) throw new Error(`did not capture console access token — page ${await pageState(rb)}`);
  } finally {
    off();
  }

  let balanceUsd = null;
  let key = null;
  try {
    const me = await httpJson('GET', `${HOST}/api/me`, { headers: { Authorization: `Bearer ${token}` }, agent });
    if (me.body && me.body.authenticated !== true) throw new Error('token not accepted by /api/me');
    const billing = await httpJson('GET', `${HOST}/api/billing/account`, {
      headers: { Authorization: `Bearer ${token}` },
      agent,
    });
    balanceUsd = billing.body && billing.body.balance_usd != null ? billing.body.balance_usd : null;
    key = await createApiKey(token, { name: keyName, description, expiresInDays, agent });
  } finally {
    await detachProxyAuth();
    await cdp.closePage(targetId);
    await cdp.disposeBrowserContext(browserContextId);
  }

  return {
    email,
    password,
    firstName,
    lastName,
    apiKey: key ? key.key : null,
    apiKeyId: key ? key.id : null,
    keyName,
    token,
    balanceUsd,
    raw: key,
  };
}

async function createApiKey(token, { name, description, expiresInDays, teamId, agent } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (teamId) headers['X-River-Team'] = teamId;
  const body = { name };
  if (description) body.description = description;
  if (expiresInDays) body.expires_in_days = expiresInDays;
  const res = await httpJson('POST', `${HOST}/api/keys`, { headers, body, agent });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`createApiKey failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function listApiKeys(token, { teamId, agent } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (teamId) headers['X-River-Team'] = teamId;
  const res = await httpJson('GET', `${HOST}/api/keys`, { headers, agent });
  if (res.status !== 200) throw new Error(`listApiKeys failed (${res.status})`);
  return res.body;
}

async function whoami(token, { agent } = {}) {
  const res = await httpJson('GET', `${HOST}/api/me`, { headers: { Authorization: `Bearer ${token}` }, agent });
  return res.body;
}

async function listModels(apiKey, { agent } = {}) {
  const res = await httpJson('GET', `${API_HOST}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, agent });
  return res.body;
}

module.exports = {
  HOST,
  LOGIN_HOST,
  API_HOST,
  CLIENT_ID,
  REDIRECT_URI,
  RiverBrowser,
  provisionAccount,
  createApiKey,
  listApiKeys,
  whoami,
  listModels,
  httpJson,
  randomPassword,
  sleep,
  CDP,
};
