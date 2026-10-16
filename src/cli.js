#!/usr/bin/env node
'use strict';

/**
 * river-bulk — bulk create River AI (console.river.ai) accounts with an
 * auto-generated API key each, then export the results.
 *
 * Usage:
 *   node src/cli.js --count 3
 *   node src/cli.js --count 10 --concurrency 2 --out accounts.json
 *
 * A CDP-reachable Chrome is required. On a VPS start one headless:
 *   google-chrome --headless=new --remote-debugging-port=9222 \
 *     --user-data-dir="$HOME/.river-chrome" --no-sandbox
 * then point the tool at it with --cdp-url http://127.0.0.1:9222
 * (or CDP_URL / CDP_WS in the environment).
 *
 * Zero dependencies. Node.js >= 18.
 */

const fs = require('fs');
const path = require('path');
const { CDP, provisionAccount } = require('./river');
const { MailTM } = require('./mailtm');
const { MailboxImap } = require('./mailbox-imap');
const { GuerrillaMail } = require('./guerrilla');
const { InboxesCom } = require('./inboxes');
const { TempMailIo } = require('./tempmailio');
const { TempMailOrg } = require('./tempmailorg');
const { Mailtrap } = require('./mailtrap');
const {
  loadProxyList,
  createAgent,
  proxyForIndex,
  probe,
  label,
  usableInBrowser,
  isLocalHost,
  fetchText,
} = require('./proxy');
const { upnpExternalIp, isIPv4, isPrivateOrCarrierNat } = require('./own-ip');
const { advertisesHeadless } = require('./hygiene');
const { warnIfSecretInsideRepo } = require('./secrets');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

function banner() {
  process.stderr.write(
    '\n' +
      '  \x1b[38;5;39m╭──────────────────────────────────────────────╮\x1b[0m\n' +
      '  \x1b[38;5;39m│\x1b[0m  \x1b[1m🌊 river-bulk\x1b[0m  ·  bulk River AI API-key minter   \x1b[38;5;39m│\x1b[0m\n' +
      '  \x1b[38;5;39m╰──────────────────────────────────────────────╯\x1b[0m\n\n'
  );
}

/**
 * Inbox backends the CLI can build. Kept in one place so an unknown name fails
 * before the run instead of once per account.
 */
const MAILBOX_BACKENDS = ['mailtm', 'imap', 'guerrilla', 'inboxes', 'tempmailio', 'tempmailorg', 'mailtrap'];

/**
 * Builds the inbox backend for one account.
 *
 * `mailtm` (default) talks to a disposable-inbox API and needs no setup, but no
 * disposable domain survives the sign-up gate any more — see ./mailbox-imap.
 * `imap` reads a real mailbox (gmail.com, outlook.com, a domain of your own)
 * over IMAP, giving each account its own `local+tag@domain` alias.
 */
function makeMailbox(args, proxy, log) {
  const backend = String(args.mailbox || (process.env.IMAP_USER ? 'imap' : 'mailtm')).toLowerCase();
  if (backend === 'imap') {
    const passFile = args['imap-pass-file'];
    const password = args['imap-pass'] || process.env.IMAP_PASS || (passFile ? fs.readFileSync(String(passFile), 'utf8').trim() : '');
    return new MailboxImap({
      user: args['imap-user'] || process.env.IMAP_USER,
      password,
      host: args['imap-host'] || process.env.IMAP_HOST || 'imap.gmail.com',
      domain: args['mail-domain'] || process.env.MAIL_DOMAIN,
      proxy,
      log,
    });
  }
  if (backend === 'guerrilla') {
    return new GuerrillaMail({ proxy, domain: args['mail-domain'] || null, log });
  }
  if (backend === 'inboxes') {
    return new InboxesCom({ proxy, domain: args['mail-domain'] || null, log });
  }
  if (backend === 'tempmailio') {
    return new TempMailIo({ proxy, domain: args['mail-domain'] || null, log });
  }
  if (backend === 'tempmailorg') {
    return new TempMailOrg({ proxy, domain: args['mail-domain'] || null, log });
  }
  if (backend === 'mailtrap') {
    return new Mailtrap({
      proxy,
      domain: args['mail-domain'] || null,
      tokenFile: args['mailtrap-token-file'],
      folder: args['mailtrap-folder'],
      log,
    });
  }
  if (backend !== 'mailtm') {
    // Never fall back silently: a typo would quietly switch the inbox provider
    // and every account would then fail at a gate the operator did not choose.
    throw new Error(`unknown --mailbox backend: ${backend} (expected mailtm | imap | guerrilla | inboxes | tempmailio | tempmailorg)`);
  }
  return new MailTM({ agent: proxy ? createAgent(proxy) : undefined, baseUrl: args['mail-base'] });
}

/**
 * Resolve the CDP WebSocket URL from, in priority order:
 *   --cdp-ws <wss://…>         explicit websocket
 *   --cdp-url <http://…>       HTTP endpoint → resolved via /json/version
 *   CDP_WS / CDP_URL env vars
 *   ws://127.0.0.1:9222 default
 */
async function resolveWs(args) {
  if (args['cdp-ws']) return String(args['cdp-ws']);
  const httpUrl = args['cdp-url'] || process.env.CDP_URL;
  if (httpUrl) {
    const base = String(httpUrl).replace(/\/$/, '');
    const res = await fetch(`${base}/json/version`);
    if (!res.ok) throw new Error(`could not reach Chrome at ${base} (${res.status})`);
    const j = await res.json();
    return j.webSocketDebuggerUrl;
  }
  if (process.env.CDP_WS) return process.env.CDP_WS;

  const fallback = 'http://127.0.0.1:9222';
  const res = await fetch(`${fallback}/json/version`);
  const j = await res.json();
  return j.webSocketDebuggerUrl;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  let active = 0;
  return new Promise((resolve) => {
    const next = () => {
      if (idx >= items.length && active === 0) return resolve(results);
      while (active < limit && idx < items.length) {
        const i = idx++;
        active++;
        Promise.resolve(worker(items[i], i))
          .then((r) => (results[i] = r))
          .catch((e) => (results[i] = { error: e.message }))
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

/**
 * Free proxy lists are mostly dead (single-digit % alive at any moment), and
 * the ones that answer often terminate TLS themselves — measured 2026-10-13,
 * live entries re-signed `login.console.river.ai` with a private CA ("Research",
 * UNABLE_TO_VERIFY_LEAF_SIGNATURE). Probing against the host the flow actually
 * needs, with certificate verification on, rejects those before an account is
 * wasted on them.
 */
const PROBE_TARGET = { host: 'login.console.river.ai', port: 443 };

/**
 * Probes in list order — through a real, verified TLS handshake to the sign-up
 * host — until there are enough working exits for the requested account count.
 */
async function selectLiveProxies(proxies, { need, limit, log }) {
  const live = [];
  await mapLimit(proxies.slice(0, limit), 20, async (p) => {
    if (live.length >= need) return null;
    const r = await probe(p, PROBE_TARGET);
    if (r.ok) {
      live.push(p);
      log(`  ✔ ${label(p)} · ${r.ms}ms`);
    } else {
      log(`  ✘ ${label(p)} · ${r.error}`);
    }
    return null;
  });
  return live;
}

/**
 * Resolves the proxy rotation for this run. Without a list the tool refuses to
 * mint anything unless --allow-direct is passed: the whole point of a proxy
 * list is that no request leaves the machine from its own address.
 */
async function resolveProxies(args, { count, quiet }) {
  const listFile = args.proxies;
  if (!listFile) {
    if (!args['allow-direct']) {
      throw new Error(
        'no proxy list given — refusing to mint from this machine\'s own IP.\n' +
          '  Pass --proxies <file> (one proxy per line) or --allow-direct to override.'
      );
    }
    return { proxies: [], source: 'direct', dropped: 0, probed: 0 };
  }

  if (!fs.existsSync(String(listFile))) throw new Error(`proxy list not found: ${listFile}`);
  const all = loadProxyList(String(listFile));
  const log = (m) => !quiet && process.stderr.write(`${m}\n`);

  const browserOk = all.filter(usableInBrowser);
  const socksAuthDropped = all.length - browserOk.length;
  const localDropped = args['allow-local-proxies'] ? [] : browserOk.filter((p) => isLocalHost(p.host));
  const usable = browserOk.filter((p) => !localDropped.includes(p));
  const dropped = socksAuthDropped + localDropped.length;

  if (!usable.length) {
    throw new Error(
      `no usable proxies in ${listFile} (${all.length} line(s)): ` +
        `${socksAuthDropped} credentialed SOCKS (Chrome cannot authenticate), ${localDropped.length} loopback/private`
    );
  }
  if (socksAuthDropped) log(`  proxy list: dropped ${socksAuthDropped} credentialed SOCKS entr(ies)`);
  if (localDropped.length) {
    log(`  proxy list: dropped ${localDropped.length} loopback/private entr(ies) — those exit from this machine's own address`);
  }

  const limit = Math.max(1, parseInt(args['probe-limit'] || '200', 10));
  // `--no-probe` skips the liveness preflight only: the egress check below is
  // what keeps a transparent proxy from handing River this machine's address,
  // so it still runs unless it is turned off explicitly.
  let live = usable;
  let probed = 0;
  if (!args['no-probe']) {
    live = await selectLiveProxies(usable, { need: count, limit, log });
    probed = Math.min(usable.length, limit);
    if (!live.length) {
      throw new Error(
        `no working proxy found in ${String(listFile)} (probed ${probed}) — refusing to fall back to a direct connection`
      );
    }
  }

  let proxies = live;
  if (!args['no-verify-egress']) {
    const own = await resolveOwnIp(args, { log });
    const { ok } = await verifyEgress(live, { log, own });
    log(`  egress check: ${ok.length}/${live.length} proxy(ies) exit ≠ ${own.ip}`);
    if (!ok.length) {
      throw new Error(`every candidate proxy would surface this machine's own IP (${own.ip}) — refusing to run`);
    }
    proxies = ok;
  }

  return { proxies, source: String(listFile), dropped, probed };
}

/** Public IP echo, used to prove a proxy is not just relaying this machine. */
const EGRESS_CHECK_URL = 'https://api.ipify.org/';

/**
 * Where "this machine's own address" comes from, in order of how little it
 * costs in exposure:
 *
 *   1. `--own-ip <addr>` / `OWN_IP` — supplied by the operator, no request.
 *   2. `--own-ip auto` — the router, over UPnP. LAN-only, so nothing leaves.
 *   3. `--allow-direct-lookup` — one HTTPS GET from this machine to an echo
 *      service, i.e. exactly the request a proxy list exists to avoid.
 *
 * Nothing else: if the address cannot be established, the run stops. A stale
 * `--own-ip` is worse than no value at all — a transparent proxy would then
 * match it and pass, so the operator has to refresh it, and it is printed on
 * every run to make that possible.
 */
async function resolveOwnIp(args, { log }) {
  const supplied = args['own-ip'] && args['own-ip'] !== true ? String(args['own-ip']).trim() : process.env.OWN_IP;
  if (supplied && supplied !== 'auto') {
    if (!isIPv4(supplied)) throw new Error(`--own-ip is not an IPv4 address: ${supplied}`);
    if (isPrivateOrCarrierNat(supplied)) {
      throw new Error(
        `--own-ip ${supplied} is a private or carrier-grade-NAT address — the internet never sees it,\n` +
          "  so comparing proxies against it would let a transparent one through. Use the address a public\n" +
          '  site reports (router WAN pages behind CGNAT show an address only your ISP can see).'
      );
    }
    log(`  egress check: this machine's address supplied as ${supplied} (operator value, no request made)`);
    log('  note: a stale value disables the transparent-proxy filter — refresh it if your ISP address may have changed');
    return { ip: supplied, source: 'operator' };
  }

  const upnp = await upnpExternalIp({}).catch((e) => ({ ip: null, error: e.message }));
  if (upnp && upnp.ip) {
    if (supplied === 'auto') log(`  egress check: router reports this machine's address as ${upnp.ip} (${upnp.source})`);
    else log(`  egress check: router reports this machine's address as ${upnp.ip} (${upnp.source}) — no request left the machine`);
    return { ip: upnp.ip, source: upnp.source };
  }

  if (args['allow-direct-lookup']) {
    const own = (await fetchText(null, EGRESS_CHECK_URL, { timeoutMs: 10000 })).trim();
    if (!isIPv4(own)) throw new Error(`direct lookup returned: ${own.slice(0, 40)}`);
    if (isPrivateOrCarrierNat(own)) throw new Error(`direct lookup returned a private/CGNAT address: ${own}`);
    log(`  egress check: this machine's address looked up directly as ${own} — that request left from your own IP`);
    return { ip: own, source: 'direct lookup' };
  }

  throw new Error(
    `cannot learn this machine's public IP without a request of its own (${upnp.error || 'UPnP unavailable'}) — refusing to run.\n` +
      '  Pass --own-ip <address> with your current public address (router status page, no request needed), or\n' +
      '  --allow-direct-lookup to accept one direct request to an echo service, or\n' +
      '  --no-verify-egress to skip the transparent-proxy check entirely at your own risk.'
  );
}

/**
 * A proxy is only trusted once the address the world sees is *not* this
 * machine's. Transparent proxies pass every other check and still hand the
 * target your own IP, so they are dropped here.
 */
async function verifyEgress(proxies, { log, own }) {
  const single = own.ip;

  const ok = [];
  await mapLimit(proxies, 10, async (p) => {
    let ip;
    try {
      ip = (await fetchText(p, EGRESS_CHECK_URL, { timeoutMs: 20000 })).trim();
    } catch (e) {
      log(`  ✘ ${label(p)} · egress check failed: ${e.message}`);
      return null;
    }
    if (ip === single) {
      log(`  ✘ ${label(p)} · egress is this machine's own address (${single}) — dropped`);
      return null;
    }
    if (!isIPv4(ip)) {
      log(`  ✘ ${label(p)} · egress check returned garbage — dropped`);
      return null;
    }
    ok.push(p);
    return null;
  });
  return { ok };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) return usage();

  const count = parseInt(args.count || args.n || '1', 10);
  const concurrency = Math.max(1, parseInt(args.concurrency || args.c || '1', 10));
  const outPath = args.out || 'outputs/river-accounts.json';
  const csvPath = args.csv || outPath.replace(/\.json$/, '.csv');
  const keyPrefix = args['key-prefix'] || 'river-bulk';
  const quiet = !!args.quiet;

  // Fail loudly about a secret in the checkout before doing anything else.
  if (args['imap-pass-file']) warnIfSecretInsideRepo(String(args['imap-pass-file']));
  // …and about an inbox backend that does not exist, rather than letting every
  // account fail one by one on a typo.
  {
    const backend = String(args.mailbox || (process.env.IMAP_USER ? 'imap' : 'mailtm')).toLowerCase();
    if (!MAILBOX_BACKENDS.includes(backend)) {
      throw new Error(`unknown --mailbox backend: ${backend} (expected ${MAILBOX_BACKENDS.join(' | ')})`);
    }
  }

  banner();

  const { proxies: activeProxies, source, probed } = await resolveProxies(args, { count, quiet });
  if (activeProxies.length) {
    console.log(
      `  proxies: ${activeProxies.length} live${probed ? ` / ${probed} probed` : ''} · ${source}` +
        (activeProxies.length < count ? ' · accounts share them round-robin' : '')
    );
  } else {
    console.log('  proxies: none — DIRECT MODE (--allow-direct), every request leaves from this machine');
  }

  let wsUrl;
  try {
    wsUrl = await resolveWs(args);
  } catch (e) {
    throw new Error(
      `${e.message}\n  Start Chrome with a debug port first, e.g.:\n` +
        '    google-chrome --headless=new --remote-debugging-port=9222 \\\n' +
        '      --user-data-dir="$HOME/.river-chrome" --no-sandbox\n' +
        '  then run: node src/cli.js --cdp-url http://127.0.0.1:9222'
    );
  }

  const cdp = new CDP(wsUrl, {});
  await cdp.connect();
  await cdp.attachToPage();

  // Reporting only: a headless UA is refused by the sign-up (see ./hygiene), so
  // say out loud that the attached browser announces one and is being masked.
  const browserUa = await cdp
    .send('Browser.getVersion', {}, null)
    .then((v) => v.userAgent || '')
    .catch(() => '');
  const headlessUa = advertisesHeadless(browserUa);
  if (!args['no-hygiene'] && headlessUa) {
    console.log('  browser: announces HeadlessChrome · UA override applied per page (--no-hygiene to keep it)');
  } else if (!args['no-hygiene']) {
    console.log('  browser: not advertising headless · UA override applied per page anyway');
  } else {
    console.log('  browser: UA override disabled (--no-hygiene) — the sign-up refuses a headless User-Agent');
  }
  console.log(`connected to browser · minting ${count} account(s), concurrency ${concurrency}`);

  const jobs = Array.from({ length: count }, (_, i) => i);

  const results = await mapLimit(jobs, concurrency, async (i) => {
    const tag = `[${i + 1}/${count}]`;
    const log = (m) => !quiet && process.stderr.write(`  ${tag} ${m}\n`);
    const proxy = proxyForIndex(activeProxies, i);
    // One inbox per account, bound to the same proxy: MailTM stores a login
    // token per instance and IMAP keeps a connection per instance, so a shared
    // one would mix sessions under concurrency.
    const mail = makeMailbox(args, proxy, log);
    log(`starting${proxy ? ` · ${label(proxy)}` : ''}`);
    const t0 = Date.now();
    // Keep the failure and the exit that produced it: which proxy got refused
    // is the first question a blocked run raises, and it is worth an export row.
    const r = await provisionAccount(cdp, mail, {
      keyName: `${keyPrefix}-${i + 1}`,
      log,
      proxy,
      allowDirect: !!args['allow-direct'],
      hygiene: !args['no-hygiene'],
    })
      .catch((e) => ({ error: e.message }))
      .finally(() => {
        if (mail.close) mail.close();
      });
    r.proxy = proxy ? label(proxy) : 'direct';
    if (r.apiKey) log(`✔ ${r.email} · key ${r.apiKey} · $${r.balanceUsd} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    else log(`✘ ${r.error}`);
    return r;
  });

  cdp.close();

  const ok = results.filter((r) => r && r.apiKey);
  const failed = results.filter((r) => !r || !r.apiKey);

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = {
    generated_at: new Date().toISOString(),
    total: count,
    succeeded: ok.length,
    failed: failed.length,
    accounts: results.map((r) => ({
      status: r && r.apiKey ? 'ok' : 'error',
      email: r && r.email,
      password: r && r.password,
      firstName: r && r.firstName,
      lastName: r && r.lastName,
      apiKey: r && r.apiKey,
      apiKeyId: r && r.apiKeyId,
      keyName: r && r.keyName,
      balanceUsd: r && r.balanceUsd,
      proxy: r && r.proxy,
      error: r && r.error,
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  const csv = [
    'status,email,password,first_name,last_name,api_key,key_name,balance_usd,proxy,error',
    ...payload.accounts.map((a) =>
      [
        a.status,
        a.email,
        a.password,
        a.firstName,
        a.lastName,
        a.apiKey,
        a.keyName,
        a.balanceUsd,
        a.proxy,
        a.error ? `"${String(a.error).replace(/"/g, '""')}"` : '',
      ].join(',')
    ),
  ].join('\n');
  fs.writeFileSync(csvPath, csv);

  // Plain-text key list: one API key per line, no headers — pipe-friendly.
  const txtPath = typeof args.txt === 'string' ? args.txt : outPath.replace(/\.json$/, '.txt');
  if (!args['no-txt']) {
    fs.writeFileSync(txtPath, ok.length ? ok.map((a) => a.apiKey).join('\n') + '\n' : '');
  }

  console.log(`\n  done · ${ok.length}/${count} succeeded`);
  console.log(`  json → ${outPath}`);
  console.log(`  csv  → ${csvPath}`);
  if (!args['no-txt']) console.log(`  txt  → ${txtPath}   (${ok.length} key(s), one per line)\n`);
  else console.log('');
}

function usage() {
  console.log(`
river-bulk — bulk create River AI accounts + API keys

Options:
  -n, --count <n>          number of accounts to create            [1]
  -c, --concurrency <n>    parallel accounts (1 per browser/context) [1]
      --cdp-url <url>      Chrome debug HTTP endpoint     [http://127.0.0.1:9222]
      --cdp-ws <url>       explicit CDP WebSocket URL
      --proxies <file>     proxy list, one per line      [none → the run is refused]
                           http://host:port · http://user:pass@host:port
                           socks5://host:port · host:port:user:pass
      --allow-direct       allow minting from this machine's own IP
      --no-hygiene         keep the browser's real (headless) User-Agent; the
                           sign-up refuses it, so this is for diagnosis only
      --allow-local-proxies  permit loopback/private proxy entries (they exit
                           from this machine — off by default, for testing)
      --no-probe           skip the proxy liveness preflight (the egress
                           check still runs — use --no-verify-egress for that)
      --no-verify-egress   skip the "is the exit really someone else?" check
      --own-ip <addr|auto> this machine's public IP, so the egress check needs
                           no request of its own; "auto" asks the router over
                           UPnP (LAN-only). A stale value silently disables the
                           transparent-proxy filter              [env OWN_IP]
      --allow-direct-lookup  accept one HTTPS request from your own IP to an
                           echo service just to learn that address
      --probe-limit <n>    how many list entries to probe            [200]
      --out <file>         JSON output path           [outputs/river-accounts.json]
      --csv <file>         CSV output path (defaults beside --out)
      --txt <file>         plain-text key list, one key per line
                           [derived from --out: outputs/river-accounts.txt]
      --no-txt             skip the plain-text key list
      --key-prefix <name>  API key name prefix                 [river-bulk]
      --mail-base <url>    disposable-inbox API base, mail.tm-compatible
                           e.g. https://api.mail.gw        [https://api.mail.tm]
      --mailbox <kind>     inbox backend: mailtm | imap | guerrilla | inboxes |
                           tempmailio | tempmailorg | mailtrap
                           [auto: imap when IMAP_USER is set, else mailtm]
      --mail-domain <d>    force a specific inbox domain: the alias domain for
                           --mailbox imap, or the address domain for
                           guerrilla|inboxes               [domain of IMAP_USER]
      --imap-user <addr>   real mailbox to read codes from      [env IMAP_USER]
      --imap-pass <pass>   app password for that mailbox        [env IMAP_PASS]
      --mailtrap-token-file <f>  Mailtrap API token file   [env MAILTRAP_TOKEN,
                           default %USERPROFILE%\.river-mailtrap-token]
      --mailtrap-folder <name>   Mailtrap inbound folder    [river-bulk]
      --imap-pass-file <f> read the app password from a file instead of the
                           command line (kept out of shell history); keep the
                           file outside the checkout, e.g. %USERPROFILE%
      --quiet              suppress per-account progress
  -h, --help               show this help

Environment:
  CDP_URL / CDP_WS         CDP endpoint of the Chrome to drive
  OWN_IP                   this machine's public IP (same as --own-ip; 'auto' = UPnP)
  IMAP_USER / IMAP_PASS    real mailbox for the imap inbox backend
  IMAP_HOST                IMAP server (default imap.gmail.com)

Quick start (VPS):
  google-chrome --headless=new --remote-debugging-port=9222 \\
    --user-data-dir="$HOME/.river-chrome" --no-sandbox &
  printf '%s\\n' 'http://127.0.0.1:8899' 'socks5://10.0.0.7:1080' > proxies.txt
  node src/cli.js --count 5 --proxies proxies.txt --cdp-url http://127.0.0.1:9222
`);
}

main().catch((e) => {
  console.error('\x1b[31m[fatal]\x1b[0m ' + e.message);
  process.exit(1);
});
