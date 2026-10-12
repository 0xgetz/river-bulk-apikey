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

function httpJson(method, url, { headers = {}, body, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = lib.request(
      {
        method,
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
      return { ok:true, n: inputs.length };
    })()`);
  }
}

/**
 * Full single-account provisioning. Creates an isolated browser context,
 * signs up via the hosted AuthKit UI with a mail.tm inbox, verifies e-mail,
 * captures the console access token, and mints an API key.
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
    signupTimeoutMs = 60000,
    verifyTimeoutMs = 120000,
  } = opts;

  const acct = await mail.createAccount();
  const email = acct.address;
  log(`inbox ${email}`);

  const browserContextId = await cdp.createBrowserContext();
  const { targetId, sessionId } = await cdp.newPage({ browserContextId });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

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
    if (!ok) throw new Error('sign-up form did not load');
    await rb.fillSignup({ firstName, lastName, email });

    // Step 2: password
    await rb.waitForText('Password', { timeoutMs: signupTimeoutMs });
    await sleep(1500);
    await rb.fillPassword(password);

    // Step 3: e-mail verification code
    const atOtp = await rb.waitForText('Verify your email', { timeoutMs: signupTimeoutMs });
    if (!atOtp) throw new Error('email verification screen did not appear');
    const code = await mail.waitForCode({ subjectIncludes: 'verify', timeoutMs: verifyTimeoutMs });
    log(`code ${code}`);
    await rb.enterOtp(code);

    // Step 4: wait for console to finish and the bearer token to appear
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !token) await sleep(1000);
    if (!token) throw new Error('did not capture console access token');
  } finally {
    off();
  }

  let balanceUsd = null;
  let key = null;
  try {
    const me = await httpJson('GET', `${HOST}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (me.body && me.body.authenticated !== true) throw new Error('token not accepted by /api/me');
    const billing = await httpJson('GET', `${HOST}/api/billing/account`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    balanceUsd = billing.body && billing.body.balance_usd != null ? billing.body.balance_usd : null;
    key = await createApiKey(token, { name: keyName, description, expiresInDays });
  } finally {
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

async function createApiKey(token, { name, description, expiresInDays, teamId } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (teamId) headers['X-River-Team'] = teamId;
  const body = { name };
  if (description) body.description = description;
  if (expiresInDays) body.expires_in_days = expiresInDays;
  const res = await httpJson('POST', `${HOST}/api/keys`, { headers, body });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`createApiKey failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

async function listApiKeys(token, { teamId } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  if (teamId) headers['X-River-Team'] = teamId;
  const res = await httpJson('GET', `${HOST}/api/keys`, { headers });
  if (res.status !== 200) throw new Error(`listApiKeys failed (${res.status})`);
  return res.body;
}

async function whoami(token) {
  const res = await httpJson('GET', `${HOST}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  return res.body;
}

async function listModels(apiKey) {
  const res = await httpJson('GET', `${API_HOST}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
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
