'use strict';

/**
 * Inbox factory — one fresh inbox per River account, one interface over every
 * mailbox rail this workspace has measured (report: `local://inbox-rail.md`,
 * raw numbers: `outputs/inbox-rail/*.json`).
 *
 *   node tools/inbox-factory.js --backend mailtrap --count 3 --selftest
 *   node tools/inbox-factory.js --backend mailtrap --count 100 > /dev/null   # mint
 *   node tools/inbox-factory.js --probe --count 10                           # measure
 *
 * Library — the mint loop wants exactly this:
 *
 *   const { createOne } = require('./tools/inbox-factory');
 *   const box = await createOne('mailtrap');
 *   box.email                          // what the sign-up form gets
 *   const code = await box.readCode(['river'], 150000);   // the verification code
 *
 * Every backend answers the same two calls, and each one defers the protocol
 * work to the class that already implements it (`src/mailtrap.js`,
 * `src/inboxes.js`, `src/tempmailio.js`, `proxy-lab/emailnator-backend.js`) —
 * this file only normalises their messages, feeds them to the same extractor
 * the mint uses, and records evidence.
 *
 * Backends, in the order the campaign wants them:
 *
 *   mailtrap         Mailtrap Inbound, own API token, @inbound-mailtrap.io
 *   broker-mailtrap  proxy-lab/as-inbox-broker.js on :9700 (same provider, broker contract)
 *   broker-inboxes   proxy-lab/as-inbox-broker.js on :9701 (inboxes.com behind the broker)
 *   inboxes          inboxes.com directly
 *   tempmailio       temp-mail.io directly
 *   emailnator       Emailnator dotted-gmail (module lives in proxy-lab/)
 *
 * `--selftest` delivers into every inbox it just created and reads the code back
 * with the same extractor the mint uses. The rail is SMTP on port 465 to
 * Mailtrap's inbound host — the only external delivery path reachable from this
 * line (25/587 are blackholed by the ISP, measured; see the report). It only
 * serves `inbound-mailtrap.io` recipients, so selftest is a real end-to-end proof
 * for the mailtrap and broker-mailtrap backends and says so out loud for the rest.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const tls = require('tls');

const { fetchText } = require('../src/proxy');
const { Mailtrap, extractCode: extractMailtrap } = require('../src/mailtrap');
const { InboxesCom, extractCode: extractInboxes } = require('../src/inboxes');
const { TempMailIo, extractCode: extractTempmail } = require('../src/tempmailio');
const { extractCode: extractTempmailorg } = require('../src/tempmailorg');

const MAILTRAP_DOMAIN = 'inbound-mailtrap.io';
const BROKER_PORTS = { 'broker-mailtrap': 9700, 'broker-inboxes': 9701 };
const SMTP_SINK = { host: 'inbound.smtp.mailtrap.io', port: 465, domains: [MAILTRAP_DOMAIN] };
const POLL_MS = 4000;
const READ_TIMEOUT_MS = 150000;
const SEND_FROM = 'inbox-factory-selftest@inbox-rail.local';
const OUT_DIR = path.join(__dirname, '..', 'outputs', 'inbox-rail');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getText = (url) =>
  new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => (res.statusCode >= 400 ? reject(new Error(`${url} -> ${res.statusCode} ${text.slice(0, 120)}`)) : resolve(text)));
    });
    req.setTimeout(30000, () => req.destroy(new Error(`${url} -> timeout`)));
    req.on('error', reject);
  });

const postJson = (url, payload) =>
  new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload || {}));
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': String(body.length) } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => (res.statusCode >= 400 ? reject(new Error(`${url} -> ${res.statusCode} ${text.slice(0, 120)}`)) : resolve(text)));
      }
    );
    req.setTimeout(60000, () => req.destroy(new Error(`${url} -> timeout`)));
    req.on('error', reject);
    req.end(body);
  });

// ---------------------------------------------------------------- extraction

/**
 * The repo's extractors are the same function per provider, but a code can sit
 * in any field of an unfamiliar schema — so every message is flattened to text
 * before it is scanned, exactly like the mint does with `allStrings()`.
 */
const extractFromMessage = (extract) => (message) =>
  extract(`${message.subject}\n${message.from}\n${message.text || ''}\n${message.html || ''}`);

/**
 * `readCode(matchers, timeoutMs)`: a message qualifies when at least one matcher
 * appears case-insensitively in its subject, sender or body; an empty list
 * qualifies everything. Matchers are how a caller ignores a shared inbox's other
 * tenants — and also why a shared inbox proves nothing except the code itself.
 */
const qualifies = (message, matchers) => {
  if (!matchers || !matchers.length) return true;
  const haystack = `${message.subject}\n${message.from}\n${message.text || ''}\n${message.html || ''}`.toLowerCase();
  return matchers.some((needle) => haystack.includes(String(needle).toLowerCase()));
};

// ------------------------------------------------------------------ backends

let mailtrapFolderId = null;
/** The gmail base plus-alias mode tags for the rest of this run. */
let aliasHome = null;

/** One Mailtrap inbox; the folder lookup is shared between the whole run. */
async function createMailtrapInbox({ folder } = {}) {
  const box = new Mailtrap({ folder: folder || undefined });
  if (mailtrapFolderId) box.folderId = mailtrapFolderId;
  const made = await box.createAccount();
  mailtrapFolderId = box.folderId;
  return { email: made.address, handle: box };
}

/** A Mailtrap instance for reads only — used by the broker fallback. */
function mailtrapReader() {
  return new Mailtrap({});
}

/**
 * The Emailnator backend lives outside this repo (`proxy-lab/`), because that is
 * where the fleet's copy is consumed from — `EMAILNATOR_MODULE` overrides it.
 */
function loadEmailnator() {
  return require(process.env.EMAILNATOR_MODULE || path.join(__dirname, '..', '..', 'proxy-lab', 'emailnator-backend.js'));
}

// ------------------------------------------------------------------ temp-mail.org

const TEMPMAILORG_DIR = path.join(__dirname, '..', '..', 'proxy-lab', 'out');

/**
 * The Cloudflare-cleared session temp-mail.org needs.
 *
 * Two shapes exist in the workspace and both are accepted: what
 * `proxy-lab/tm-session-harvest2.js` writes (`{cookies, token, address}` — the
 * class's documented input) and what `proxy-lab/tm-headed-unlock.js` writes
 * (`{storage:{cookie}, token, cookies?}`, the newer one). The unlock file is the
 * fallback, newest first, so a fresh unlock works without a second step.
 */
function tempmailorgSession(file = process.env.TEMPMAILORG_SESSION || null) {
  const candidates = [];
  if (file) candidates.push(file);
  candidates.push(path.join(TEMPMAILORG_DIR, 'tempmailorg-session.json'));
  try {
    candidates.push(
      ...fs
        .readdirSync(TEMPMAILORG_DIR)
        .filter((name) => /^tm-headed-unlock-.*\.json$/.test(name))
        .sort()
        .reverse()
        .map((name) => path.join(TEMPMAILORG_DIR, name))
    );
  } catch (e) {
    /* no proxy-lab in this checkout */
  }
  for (const candidate of candidates) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch (e) {
      continue;
    }
    const cookies = parsed.cookies || cookieJar(parsed.storage && parsed.storage.cookie);
    const token = parsed.token || (parsed.storage && parsed.storage.token) || (cookies && cookies.token) || null;
    if (cookies || token) return { at: parsed.at || null, file: candidate, cookies, token, address: parsed.address || null };
  }
  throw new Error(
    `temp-mail.org: no session in ${candidates.length} candidate file(s) — clear the interstitial with proxy-lab/tm-headed-unlock.js (headed) and harvest it`
  );
}

/**
 * The mailbox a temp-mail.org JWT names — its payload is `{uuid, mailbox, iat}`,
 * which is how the site's own SPA learns the address it was just handed.
 */
function mailboxFromToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return payload && payload.mailbox ? String(payload.mailbox) : null;
  } catch (e) {
    return null;
  }
}

/** `a=1; b=2` -> `{a: '1', b: '2'}`. */
function cookieJar(header) {
  if (!header) return null;
  if (typeof header === 'object') return header;
  const jar = {};
  for (const pair of String(header).split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return Object.keys(jar).length ? jar : null;
}

const backends = {
  mailtrap: {
    label: 'Mailtrap Inbound (own token)',
    create: createMailtrapInbox,
    fetchMessages: (box, log) => box.inboxContents(),
    extract: extractMailtrap,
    async attach(address, { folder = 'river-bulk' } = {}) {
      const box = new Mailtrap({ folder });
      const folders = await box.call('GET', '/inbound/folders');
      for (const entry of Array.isArray(folders) ? folders : folders.folders || []) {
        const raw = await box.call('GET', `/inbound/folders/${entry.id}/inboxes`);
        const inbox = (Array.isArray(raw) ? raw : raw.inboxes || raw.data || []).find((i) => i.address === address);
        if (inbox) {
          box.folderId = entry.id;
          box.inboxId = inbox.id;
          box.address = address;
          return { email: address, handle: box };
        }
      }
      throw new Error(`no inbox ${address} in any folder of this account`);
    },
    async census() {
      const box = mailtrapReader();
      const folders = await box.call('GET', '/inbound/folders');
      const list = Array.isArray(folders) ? folders : folders.folders || [];
      let total = 0;
      for (const folder of list) {
        const inboxes = await box.call('GET', `/inbound/folders/${folder.id}/inboxes`);
        total += (Array.isArray(inboxes) ? inboxes : inboxes.inboxes || inboxes.data || []).length;
      }
      return { folders: list.length, inboxes: total };
    },
  },

  'broker-mailtrap': {
    label: 'inbox broker :9700 (Mailtrap)',
    async create({ folder = 'inbox-rail', tag = 'rail' } = {}) {
      const made = JSON.parse(await postJson(`http://127.0.0.1:${BROKER_PORTS['broker-mailtrap']}/create`, { folder, tag }));
      if (!made.address || !made.token) throw new Error(`broker returned ${JSON.stringify(made).slice(0, 120)}`);
      return { email: made.address, handle: { inboxId: String(made.token) } };
    },
    async attach() {
      throw new Error('a broker inbox is only addressable by the token it was minted with');
    },
    async fetchMessages({ inboxId }, log) {
      const port = BROKER_PORTS['broker-mailtrap'];
      const list = JSON.parse(await getText(`http://127.0.0.1:${port}/list?token=${encodeURIComponent(inboxId)}`));
      const out = [];
      for (const stub of list.messages || []) {
        const full = JSON.parse(await getText(`http://127.0.0.1:${port}/read?id=${encodeURIComponent(stub.id)}&token=${encodeURIComponent(inboxId)}`));
        let text = `${full.text || ''}\n${full.html || ''}`;
        if (!text.trim()) {
          // The broker reads `text_body` off the message detail, which Mailtrap
          // leaves unset for senders it does not parse — those bodies only exist
          // behind `raw_message_url`, so read them through the API instead.
          try {
            const reader = mailtrapReader();
            text = await reader.body(await reader.message(full.id, { inboxId }));
          } catch (e) {
            log?.(`broker body fallback: ${String(e.message).slice(0, 80)}`);
          }
        }
        out.push({ id: String(full.id ?? stub.id), subject: full.subject || stub.subject || '', from: full.from || stub.from || '', text, html: '' });
      }
      return out;
    },
    extract: extractMailtrap,
  },

  'broker-inboxes': {
    label: 'inbox broker :9701 (inboxes.com)',
    async create() {
      const made = JSON.parse(await postJson(`http://127.0.0.1:${BROKER_PORTS['broker-inboxes']}/create`, {}));
      if (!made.address) throw new Error(`broker returned ${JSON.stringify(made).slice(0, 120)}`);
      return { email: made.address, handle: { inboxId: String(made.token || made.address) } };
    },
    async fetchMessages({ inboxId }) {
      const port = BROKER_PORTS['broker-inboxes'];
      const list = JSON.parse(await getText(`http://127.0.0.1:${port}/list?token=${encodeURIComponent(inboxId)}`));
      const out = [];
      for (const stub of list.messages || []) {
        const full = JSON.parse(await getText(`http://127.0.0.1:${port}/read?id=${encodeURIComponent(stub.id)}&token=${encodeURIComponent(inboxId)}`));
        out.push({ id: String(full.id ?? stub.id), subject: full.subject || stub.subject || '', from: full.from || stub.from || '', text: `${full.text || ''}\n${full.html || ''}`, html: '' });
      }
      return out;
    },
    extract: extractInboxes,
  },

  inboxes: {
    label: 'inboxes.com (direct)',
    async attach(address) {
      const box = new InboxesCom({});
      box.address = address;
      return { email: address, handle: { box, bodies: new Map() } };
    },
    async create() {
      const box = new InboxesCom({});
      const made = await box.createAccount();
      return { email: made.address, handle: { box, bodies: new Map() } };
    },
    async fetchMessages({ box, bodies }) {
      const inbox = await box.get(`/inbox/${encodeURIComponent(box.address)}`);
      const out = [];
      for (const stub of inbox.msgs || inbox.messages || []) {
        const id = String(stub.uid ?? stub.id);
        if (!bodies.has(id)) {
          // Previews in the list are truncated; the full message is one call away
          // and the code is often past the cut.
          let full = stub;
          try {
            full = await box.get(`/message/${encodeURIComponent(id)}`);
          } catch (e) {
            /* keep the preview */
          }
          bodies.set(id, JSON.stringify(full));
        }
        out.push({ id, subject: stub.s || stub.subject || '', from: stub.f || stub.from || '', text: bodies.get(id), html: '' });
      }
      return out;
    },
    extract: extractInboxes,
  },

  tempmailio: {
    label: 'temp-mail.io (direct)',
    async create() {
      const box = new TempMailIo({});
      const made = await box.createAccount();
      return { email: made.address, handle: { box } };
    },
    async fetchMessages({ box }) {
      // The list schema is undocumented, so it goes in whole rather than through
      // a field-by-field guess that a rename would silently break.
      return (await box.messages()).map((message, index) => ({
        id: String(message.id ?? index),
        subject: String(message.subject || ''),
        from: String(message.from || ''),
        text: JSON.stringify(message),
        html: '',
      }));
    },
    extract: extractTempmail,
  },

  tempmailorg: {
    label: 'temp-mail.org (Cloudflare-cleared session)',
    async create({ domain = null, sessionFile = null } = {}) {
      const { TempMailOrg } = require('../src/tempmailorg');
      const session = tempmailorgSession(sessionFile);
      const box = new TempMailOrg({ domain, session });
      const made = await box.createAccount({ domain: domain || undefined });
      return { email: made.address, handle: { box, session: session.file } };
    },
    async attach(address, { sessionFile = null } = {}) {
      const { TempMailOrg } = require('../src/tempmailorg');
      const session = tempmailorgSession(sessionFile);
      const box = new TempMailOrg({ session, address });
      // The address is the session's own mailbox; attaching to another one is not
      // something this API offers, so a mismatch is loud rather than silent.
      const live = (await box.getMailbox()).json();
      const assigned = live && (live.mailbox || live.address);
      if (assigned && assigned !== address) throw new Error(`session owns ${assigned}, not ${address}`);
      box.address = address;
      return { email: address, handle: { box, session: session.file } };
    },
    async fetchMessages({ box }) {
      const res = await box.messages();
      if (res.status === 204) return [];
      const json = res.json() || {};
      const messages = Array.isArray(json) ? json : json.messages || json.data || [];
      // Same reasoning as the other undocumented shapes: the message goes in
      // whole, so a renamed field cannot silently hide the code.
      return messages.map((message, index) => ({
        id: String(message.id || message._id || index),
        subject: String(message.subject || ''),
        from: String(message.from || message.sender || ''),
        text: JSON.stringify(message),
        html: '',
      }));
    },
    extract: extractTempmailorg,
  },

  emailnator: {
    label: 'Emailnator dotted-gmail',
    async create({ alias = false, aliasBase = null } = {}) {
      const { Emailnator, plain } = loadEmailnator();
      const box = new Emailnator({});
      if (!alias) {
        const made = await box.createAccount();
        return { email: made.address, handle: { box, bodies: new Map() } };
      }

      // Plus-alias mode. The pool hands out only ~11 distinct bases in 20 paced
      // calls (measured), so 100 accounts cannot each hold a base of their own;
      // a tag is what makes the address fresh, and the base is reused for the
      // rest of the run (`--alias-base` pins or rotates it). `plain()` strips the
      // dots but keeps the tag, which is exactly the key `message-list` is asked
      // for. Whether a tagged recipient is *ingested* is the one thing this
      // machine cannot test — nothing here can deliver into gmail (port 25 is
      // blocked, and Mailtrap's host refuses foreign recipients) — so it is the
      // pilot's delivery check, not an assumption of this file.
      let base = aliasBase || aliasHome;
      if (base) {
        // A base we did not mint in this process still needs the staleness mark,
        // or the reader would accept a stranger's code from the shared inbox.
        box.createdAt = Math.floor(Date.now() / 1000) - 60;
      } else {
        const made = await box.createAccount();
        base = made.address;
        aliasHome = plain(base);
      }
      const [local, domain] = plain(base).split('@');
      const address = `${local.replace(/\+.*$/, '')}+r${Math.random().toString(36).slice(2, 8)}@${domain}`;
      box.address = address;
      box.listAddress = plain(address);
      return { email: address, handle: { box, bodies: new Map() } };
    },
    async attach(address) {
      const { Emailnator, plain } = loadEmailnator();
      const box = new Emailnator({});
      box.address = address;
      box.listAddress = plain(address);
      box.createdAt = Math.floor(Date.now() / 1000) - 60;
      return { email: address, handle: { box, bodies: new Map() } };
    },
    async fetchMessages({ box, bodies }) {
      const out = [];
      for (const stub of await box.messages()) {
        const id = String(stub.id ?? stub.message_id);
        // The gmail pool is public: the same address is handed to everyone, so a
        // message older than this run is somebody else's stale code.
        if (box.createdAt && Number(stub.date || stub.timestamp || 0) && Number(stub.date || stub.timestamp || 0) < box.createdAt) continue;
        if (!id) continue;
        if (!bodies.has(id)) {
          let full = stub;
          try {
            full = await box.call('GET', `/message/${encodeURIComponent(id)}`);
          } catch (e) {
            /* keep the stub */
          }
          bodies.set(id, JSON.stringify(full));
        }
        out.push({ id, subject: String(stub.subject || ''), from: String(stub.from || ''), text: bodies.get(id), html: '' });
      }
      return out;
    },
    extract: extractMailtrap,
  },
};

// ------------------------------------------------------------------ creation

/**
 * One inbox, ready to read: `{ email, backend, domain, handle, readCode, … }`.
 *
 * @param {string} name  key of the backend registry
 * @param {{folder?: string, log?: Function}} opts
 */
async function createOne(name, opts = {}) {
  const backend = backends[name];
  if (!backend) throw new Error(`unknown backend "${name}" (${Object.keys(backends).join(', ')})`);
  const started = Date.now();
  const made = await backend.create(opts);
  const box = {
    email: made.email,
    backend: name,
    label: backend.label,
    domain: String(made.email).split('@')[1],
    createMs: Date.now() - started,
    handle: made.handle,
    last: null,
    async readCode(matchers = [], timeoutMs = READ_TIMEOUT_MS) {
      const until = Date.now() + timeoutMs;
      let messages = [];
      while (Date.now() < until) {
        try {
          messages = await backend.fetchMessages(made.handle, opts.log);
        } catch (e) {
          // A mailbox that answers 5xx mid-poll is a transient, not a verdict.
          opts.log?.(`${name}: ${String(e.message).slice(0, 90)}`);
          await sleep(POLL_MS);
          continue;
        }
        for (const message of messages) {
          if (!qualifies(message, matchers)) continue;
          const code = extractFromMessage(backend.extract)(message);
          if (code) {
            box.last = { code, message, messages };
            return code;
          }
        }
        await sleep(POLL_MS);
      }
      box.last = { code: null, message: null, messages };
      return null;
    },
    async snapshot() {
      return backend.fetchMessages(made.handle, opts.log);
    },
  };
  return box;
}

// --------------------------------------------------------------- selftest rail

/** quoted-printable with soft line breaks — the wrapping the live mail uses. */
function quotedPrintable(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      const tokens = [];
      for (const byte of Buffer.from(line, 'utf8')) {
        tokens.push(byte === 0x3d || byte < 0x20 || byte > 0x7e ? `=${byte.toString(16).toUpperCase().padStart(2, '0')}` : String.fromCharCode(byte));
      }
      let out = '';
      let length = 0;
      for (const token of tokens) {
        if (length + token.length > 74) {
          out += '=\r\n';
          length = 0;
        }
        out += token;
        length += token.length;
      }
      return out;
    })
    .join('\r\n');
}

/**
 * The live River message, verbatim except for address and code (fixture:
 * outputs/inbox-rail/fixture-river-email.eml). Testing the extractor against the
 * real wording is the whole point — a synthetic "code: 123456" body would pass
 * while the anchor window that ships stays untested.
 */
function riverShapedMessage(to, code) {
  const text = [
    'Verify your email',
    '\u200a',
    `We need to verify your email address ${to}`,
    'before you can access your account. Enter the code below in your open browser',
    'window.',
    '\u200a',
    code,
    '',
    'This code expires in 15 minutes.',
    '\u200a',
    'If you didn\u2019t sign up for River Console, you can safely ignore this email.',
    'Someone else might have typed your email address by mistake.',
  ].join('\n');
  const html = `<p>Verify your email</p><p>We need to verify your email address ${to} before you can access your account. Enter the code below in your open browser window.</p><p><strong>${code}</strong></p><p>This code expires in 15 minutes.</p>`;
  return { subject: 'Verify your email address', text, html };
}

/** SMTP into Mailtrap's inbound host — unauthenticated, implicit TLS, port 465. */
function smtpDeliver({ to, subject, text, html, bare = false }) {
  return new Promise((resolve, reject) => {
    const body = bare
      ? `Subject: ${subject}\r\nFrom: ${SEND_FROM}\r\nTo: ${to}\r\n\r\n${text.replace(/\u200a/g, '').replace(/\n/g, '\r\n')}\r\n`
      : `Subject: ${subject}\r\nFrom: ${SEND_FROM}\r\nTo: ${to}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="rail-sep"\r\n\r\n--rail-sep\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(text)}\r\n--rail-sep\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(html)}\r\n--rail-sep--\r\n`;

    const conversation = [
      [null, /^220/],
      ['EHLO inbox-rail.local\r\n', /^250/],
      [`MAIL FROM:<${SEND_FROM}>\r\n`, /^250/],
      [`RCPT TO:<${to}>\r\n`, /^25\d/],
      ['DATA\r\n', /^354/],
      [`${body}.\r\n`, /^250/],
      ['QUIT\r\n', /^221/],
    ];

    const sock = tls.connect({ host: SMTP_SINK.host, port: SMTP_SINK.port, servername: SMTP_SINK.host });
    const transcript = [];
    let buffer = '';
    let deliver = null;

    // A reply ends at the first line whose code is followed by a space; the
    // dashed continuation lines of an EHLO banner must not be mistaken for one.
    const drain = () => {
      if (!deliver) return;
      const lines = buffer.split('\r\n');
      const end = lines.findIndex((line) => /^\d{3} /.test(line));
      if (end < 0) return;
      const reply = lines.slice(0, end + 1).join('\r\n');
      buffer = lines.slice(end + 1).join('\r\n');
      const resume = deliver;
      deliver = null;
      resume(reply);
    };
    const readReply = () =>
      new Promise((resume) => {
        deliver = resume;
        drain();
      });

    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      drain();
    });
    sock.on('error', reject);
    sock.setTimeout(30000, () => {
      sock.destroy();
      reject(new Error('SMTP timeout'));
    });

    (async () => {
      try {
        for (const [send, expect] of conversation) {
          if (send) sock.write(send);
          const reply = await readReply();
          transcript.push(`${send ? send.split('\r\n')[0].slice(0, 16) : 'greeting'} -> ${reply.split('\r\n').pop().slice(0, 60)}`);
          if (!expect.test(reply)) throw new Error(`SMTP ${reply.split('\r\n').pop().slice(0, 90)} after ${send ? send.split('\r\n')[0] : 'greeting'}`);
        }
        sock.destroy();
        resolve(transcript);
      } catch (e) {
        sock.destroy();
        reject(e);
      }
    })();
  });
}

// ------------------------------------------------------------------- evidence

/**
 * Evidence is read by humans and committed, so nothing that authenticates may
 * travel in it: the run's own token is cut by value, and bearer-ish shapes by
 * pattern.
 */
function scrub(value, secret) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (secret) text = text.split(secret).join('<redacted>');
  return text.replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1<redacted>');
}

function mailtrapToken() {
  try {
    return require('../src/mailtrap').resolveToken({});
  } catch (e) {
    return null;
  }
}

function writeEvidence(name, payload) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

const stats = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null);
  return { min: at(0), median: at(0.5), max: at(sorted.length - 1), all: values };
};

// ------------------------------------------------------------------ selftest

async function selftest(name, count, { timeoutMs, log, quiet, alias, aliasBase }) {
  const secret = mailtrapToken();
  const run = { mode: 'selftest', startedAt: new Date().toISOString(), backend: name, count, smtp: { ...SMTP_SINK, from: SEND_FROM }, inboxes: [] };
  const boxes = [];
  for (let i = 0; i < count; i++) {
    const box = await createOne(name, { log, alias, aliasBase });
    boxes.push(box);
    if (!quiet) log(`  [${i + 1}/${count}] ${box.email} · ${(box.createMs / 1000).toFixed(1)}s`);
  }
  run.addresses = boxes.map((b) => b.email);

  const railWorks = SMTP_SINK.domains.includes(boxes[0].domain);
  if (!railWorks) {
    run.rail = 'none';
    run.note = `no external delivery rail for @${boxes[0].domain} — port 25 is blocked by this ISP, and Mailtrap's host only accepts its own domain. Selftest is a delivery proof for the mailtrap backends only.`;
    if (!quiet) log(`  ! ${run.note}`);
  } else {
    run.rail = `smtp ${SMTP_SINK.host}:${SMTP_SINK.port} (unauthenticated, from ${SEND_FROM})`;
  }

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const entry = { email: box.email, domain: box.domain, createMs: box.createMs, sent: null, read: null };
    if (railWorks) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const { subject, text, html } = riverShapedMessage(box.email, code);
      try {
        entry.sent = { subject, code, transcript: await smtpDeliver({ to: box.email, subject, text, html }), acceptedAt: new Date().toISOString() };
      } catch (e) {
        entry.sent = { subject, code, error: scrub(String(e.message), secret) };
      }
      const started = Date.now();
      const read = await box.readCode(['verify'], timeoutMs);
      entry.read = { code: read, expected: code, ms: Date.now() - started, matchedSubject: box.last?.message?.subject ?? null, inline: box.last?.message?.inline ?? null };
      entry.read.ok = read === code;
      entry.read.messages = (box.last?.messages || []).map((m) => ({
        id: m.id,
        subject: m.subject,
        from: m.from,
        inline: m.inline ?? null,
        text: scrub(String(m.text || '').replace(/\s+/g, ' ').slice(0, 400), secret),
      }));
      // One probe per run in the format Mailtrap does *not* parse, so the raw-EML
      // fallback in `Mailtrap.body()` is exercised rather than assumed.
      if (i === 0) {
        const bareCode = String(Math.floor(100000 + Math.random() * 900000));
        try {
          entry.bare = { code: bareCode, transcript: await smtpDeliver({ to: box.email, subject: 'inbox-factory bare probe', text: `inbox-factory bare probe, code ${bareCode}`, html: null, bare: true }) };
          entry.bare.readCode = await box.readCode(['bare probe'], timeoutMs);
          entry.bare.ok = entry.bare.readCode === bareCode;
        } catch (e) {
          entry.bare = { error: scrub(String(e.message), secret) };
        }
      }
      if (!quiet) {
        const verdict = entry.read.ok ? '✔' : '✘';
        log(`  [${i + 1}/${boxes.length}] ${verdict} code ${entry.read.code} from "${entry.read.matchedSubject}" · inline=${entry.read.inline} · ${(entry.read.ms / 1000).toFixed(1)}s`);
      }
    }
    run.inboxes.push(entry);
  }

  run.summary = {
    created: boxes.length,
    codesRead: run.inboxes.filter((e) => e.read && e.read.ok).length,
    createMs: stats(boxes.map((b) => b.createMs)),
    readMs: stats(run.inboxes.filter((e) => e.read).map((e) => e.read.ms)),
  };
  return { run, file: writeEvidence(`selftest-${name}-${Date.now()}`, run) };
}

// --------------------------------------------------------------------- probe

const QUOTA_RE = /429|quota|rate.?limit|too many|limit reached|upgrade|payment|plan|exceed|cap\b/i;

async function probe(list, count, { log, quiet, alias, aliasBase }) {
  const secret = mailtrapToken();
  const run = { mode: 'probe', startedAt: new Date().toISOString(), count, backends: [] };
  for (const name of list) {
    const backend = backends[name];
    const entry = { backend: name, label: backend.label, attempted: count, created: 0, domains: {}, latencyMs: null, duplicates: [], errors: [], quotaSignals: [], inboxes: [] };
    if (!backend) {
      entry.errors.push(`unknown backend`);
      run.backends.push(entry);
      continue;
    }
    if (!quiet) log(`\n${name} · ${backend.label}`);
    if (backend.census) {
      try {
        entry.census = await backend.census();
        if (!quiet) log(`  census: ${entry.census.inboxes} inboxes in ${entry.census.folders} folders`);
      } catch (e) {
        entry.censusError = scrub(String(e.message), secret);
      }
    }
    for (let i = 0; i < count; i++) {
      const started = Date.now();
      try {
        const box = await createOne(name, { log, alias, aliasBase });
        const ms = Date.now() - started;
        entry.created++;
        entry.domains[box.domain] = (entry.domains[box.domain] || 0) + 1;
        entry.inboxes.push({ email: box.email, domain: box.domain, ms, ok: true });
        if (entry.inboxes.filter((b) => b.email === box.email).length > 1) entry.duplicates.push(box.email);
        if (!quiet) log(`  [${i + 1}/${count}] ✔ ${box.email} · ${(ms / 1000).toFixed(1)}s`);
      } catch (e) {
        const message = scrub(String(e.message), secret);
        entry.inboxes.push({ email: null, ms: Date.now() - started, ok: false, error: message.slice(0, 300) });
        entry.errors.push(message.slice(0, 300));
        if (QUOTA_RE.test(message)) entry.quotaSignals.push(message.slice(0, 300));
        if (!quiet) log(`  [${i + 1}/${count}] ✘ ${message.slice(0, 110)}`);
      }
    }
    entry.latencyMs = stats(entry.inboxes.map((b) => b.ms));
    delete entry.latencyMs.all;
    run.backends.push(entry);
  }
  return { run, file: writeEvidence(`probe-${Date.now()}`, run) };
}

// ----------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = { backend: 'mailtrap', count: 1, selftest: false, probe: false, timeoutMs: READ_TIMEOUT_MS, quiet: false, alias: false, aliasBase: null, log: console.log };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i];
    if (arg === '--backend') opts.backend = value();
    else if (arg === '--count' || arg === '-n') opts.count = parseInt(value(), 10);
    else if (arg === '--selftest') opts.selftest = true;
    else if (arg === '--probe') opts.probe = true;
    else if (arg === '--timeout') opts.timeoutMs = parseInt(value(), 10);
    else if (arg === '--quiet') opts.quiet = true;
    else if (arg === '--alias') opts.alias = true;
    else if (arg === '--alias-base') opts.aliasBase = value();
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new Error(`unknown argument "${arg}"`);
  }
  return opts;
}

const HELP = `
inbox-factory — one fresh inbox per River account, one interface for every rail

  node tools/inbox-factory.js --backend <name> [--count <n>] [--selftest]
  node tools/inbox-factory.js --probe [--count <n>] [--backend <name>]

  --backend <name>   ${Object.keys(backends).join(' | ')}   [mailtrap]
  --count <n>        inboxes to create                        [1]
  --selftest         deliver a River-shaped message into every inbox and read
                     the code back (delivery needs a @${MAILTRAP_DOMAIN} address)
  --probe            measure every backend, write outputs/inbox-rail/probe-*.json
  --timeout <ms>     how long to wait for a code              [${READ_TIMEOUT_MS}]
  --quiet            no per-inbox progress
  --alias            emailnator only: mint base+r<tag>@gmail.com instead of a fresh
                     base (the pool hands out ~11 distinct bases in 20 paced calls)
  --alias-base <a>   emailnator only: pin the gmail base to derive tags from

Library:  const { createOne } = require('./tools/inbox-factory');
          const box = await createOne('mailtrap');
          box.email; await box.readCode(['river'], 150000);
`;

async function main(argv) {
  const opts = parseArgs(argv);
  const log = opts.quiet ? () => {} : console.log;
  if (opts.help) return console.log(HELP);

  if (opts.probe) {
    const list = argv.includes('--backend') ? [opts.backend] : Object.keys(backends);
    const { run, file } = await probe(list, opts.count, opts);
    console.log(`\nprobe · ${run.backends.map((b) => `${b.backend} ${b.created}/${b.attempted}`).join(' · ')}`);
    console.log(`  json → ${path.relative(process.cwd(), file)}`);
    return undefined;
  }

  if (opts.selftest) {
    log(`\ninbox-factory · ${opts.backend} · ${opts.count} inbox(es)`);
    const { run, file } = await selftest(opts.backend, opts.count, opts);
    log(`\n  done · ${run.summary.codesRead}/${run.summary.created} codes read end to end`);
    log(`  json → ${path.relative(process.cwd(), file)}`);
    if (run.summary.codesRead !== run.summary.created) process.exitCode = 1;
    return undefined;
  }

  log(`\ninbox-factory · ${opts.backend} · ${opts.count} inbox(es)`);
  for (let i = 0; i < opts.count; i++) {
    const box = await createOne(opts.backend, { log, alias: opts.alias, aliasBase: opts.aliasBase });
    log(`  [${i + 1}/${opts.count}] ${box.email}`);
  }
  return undefined;
}

// A library caller (`require('./tools/inbox-factory')`) must not mint anything —
// the CLI only runs when this file is the process entry point.
if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`inbox-factory: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { createOne, backends, createMailtrapInbox, smtpDeliver, riverShapedMessage, quotedPrintable };
