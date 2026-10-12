#!/usr/bin/env node
'use strict';

/**
 * river-bulk — bulk create River AI (console.river.ai) accounts with an
 * auto-generated API key each, then export the results.
 *
 * Usage:
 *   node src/cli.js --count 3
 *   node src/cli.js --count 10 --concurrency 2 --out accounts.json
 *   node src/cli.js --cookies "solar_session=..."          # advanced
 *
 * Environment:
 *   BU_CDP_WS     Browser Use cloud CDP WebSocket URL (recommended)
 *   CDP_WS        Generic wss:// or ws:// CDP endpoint
 *   CDP_URL       http(s)://host:port used to resolve /json/version
 *
 * Zero dependencies. Node.js >= 18 (global fetch not required).
 */

const fs = require('fs');
const path = require('path');
const { CDP, provisionAccount } = require('./river');
const { MailTM } = require('./mailtm');

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

async function resolveWs() {
  if (process.env.BU_CDP_WS) return process.env.BU_CDP_WS;
  if (process.env.CDP_WS) return process.env.CDP_WS;
  if (process.env.CDP_URL) {
    const base = process.env.CDP_URL.replace(/\/$/, '');
    const res = await fetch(`${base}/json/version`);
    const j = await res.json();
    return j.webSocketDebuggerUrl;
  }
  throw new Error('No CDP endpoint. Set BU_CDP_WS, CDP_WS, or CDP_URL.');
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) return usage();

  const count = parseInt(args.count || args.n || '1', 10);
  const concurrency = Math.max(1, parseInt(args.concurrency || args.c || '1', 10));
  const outPath = args.out || 'outputs/river-accounts.json';
  const csvPath = args.csv || outPath.replace(/\.json$/, '.csv');
  const keyPrefix = args['key-prefix'] || 'river-bulk';
  const quiet = !!args.quiet;

  banner();
  const wsUrl = await resolveWs();
  const cdp = new CDP(wsUrl, {});
  await cdp.connect();
  await cdp.attachToPage();
  console.log(`connected to browser · minting ${count} account(s), concurrency ${concurrency}`);

  const mail = new MailTM();
  const jobs = Array.from({ length: count }, (_, i) => i);

  const results = await mapLimit(jobs, concurrency, async (i) => {
    const tag = `[${i + 1}/${count}]`;
    const log = (m) => !quiet && process.stderr.write(`  ${tag} ${m}\n`);
    log('starting');
    const t0 = Date.now();
    const r = await provisionAccount(cdp, mail, {
      keyName: `${keyPrefix}-${i + 1}`,
      log,
    });
    log(`✔ ${r.email} · key ${r.apiKey} · $${r.balanceUsd} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
      error: r && r.error,
    })),
  };
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

  const csv = [
    'status,email,password,first_name,last_name,api_key,key_name,balance_usd,error',
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
        a.error ? `"${String(a.error).replace(/"/g, '""')}"` : '',
      ].join(',')
    ),
  ].join('\n');
  fs.writeFileSync(csvPath, csv);

  console.log(`\n  done · ${ok.length}/${count} succeeded`);
  console.log(`  json → ${outPath}`);
  console.log(`  csv  → ${csvPath}\n`);
}

function usage() {
  console.log(`
river-bulk — bulk create River AI accounts + API keys

Options:
  -n, --count <n>          number of accounts to create            [1]
  -c, --concurrency <n>    parallel accounts (use 1 for one browser) [1]
      --out <file>         JSON output path           [outputs/river-accounts.json]
      --csv <file>         CSV output path (defaults beside --out)
      --key-prefix <name>  API key name prefix                [river-bulk]
      --quiet              suppress per-account progress
  -h, --help               show this help

Environment:
  BU_CDP_WS / CDP_WS / CDP_URL   CDP endpoint of the browser to drive

Example:
  BU_CDP_WS=wss://... node src/cli.js --count 5 --concurrency 1 --out outputs/batch.json
`);
}

main().catch((e) => {
  console.error('\x1b[31m[fatal]\x1b[0m ' + e.message);
  process.exit(1);
});
