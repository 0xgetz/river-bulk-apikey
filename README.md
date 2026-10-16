<div align="center">

<img src="brand/logo.svg" alt="river-bulk" width="140" />

# river-bulk-apikey

**Bulk-create [River AI](https://console.river.ai) accounts and auto-generate an API key for each — driven through a real (cloud) browser over CDP. Zero dependencies.**

[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg?style=for-the-badge)](LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg?style=for-the-badge)](#)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI--compatible-412991.svg?style=for-the-badge&logo=openai&logoColor=white)](https://docs.river.ai/guides/inference)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6.svg?style=for-the-badge)](#-connect-to-9router)
[![Browsers](https://img.shields.io/badge/Browser-Chrome%20%2F%20Chromium-4285F4.svg?style=for-the-badge&logo=googlechrome&logoColor=white)](#-requirements)

[English](README.md) · [Bahasa Indonesia](i18n/README.id.md) · [简体中文](i18n/README.zh.md) · [日本語](i18n/README.ja.md) · [Español](i18n/README.es.md) · [Deutsch](i18n/README.de.md)

</div>

---

## ✨ Features

- 🔑 **Bulk account + API key creation** — one River account *and* one `rv_…` key per run.
- 🧼 **Fully isolated sessions** — every account runs in its own CDP browser context, so no cookies or `localStorage` leak between accounts.
- 🪶 **Zero dependencies** — a hand-rolled RFC6455 WebSocket + CDP client. No `npm install`.
- 🤖 **Real-browser sign-up** — the hosted AuthKit page is driven in a real Chrome/Chromium on your own machine or VPS.
- 📧 **Disposable inboxes** — verification codes are read straight from [mail.tm](https://mail.tm).
- 📦 **Exports** — JSON, CSV, and a plain-text key list (one `rv_…` per line).
- 🌐 **Proxy rotation** — one exit address per account: the browser *and* the API calls go through the proxy, and a dead proxy fails that account instead of leaking your IP.
- 🔌 **9Router connector** — expose your River keys as an OpenAI-compatible provider in [9Router](https://9router.com) in one command.
- 🌍 **6 languages** — EN, ID, ZH, JA, ES, DE.

## 🚀 Quick start

```bash
# 1. Start a headless Chrome with a debug port
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &

# 2. One proxy per line, then create 3 accounts — one per exit address
printf '%s\n' 'http://user:pass@10.0.0.1:8080' 'socks5://10.0.0.2:1080' > proxies.txt
node src/cli.js --count 3 --proxies proxies.txt --cdp-url http://127.0.0.1:9222

# results land in outputs/river-accounts.json (+ .csv + .txt)
```

Example output:

```
  🌊 river-bulk  ·  bulk River AI API-key minter

connected to browser · minting 3 account(s), concurrency 1
  [1/3] ✔ z2cb0obwmv54w7an@maxxspace.com · key rv_z6_ybbX… · $25 · 21.4s
  [2/3] ✔ zsrg2lmjmv54wnhz@maxxspace.com · key rv_fXpWm42… · $25 · 21.2s
  [3/3] ✔ 9m1x…@maxxspace.com             · key rv_…        · $25 · 20.9s

  done · 3/3 succeeded
  json → outputs/river-accounts.json
  csv  → outputs/river-accounts.csv
  txt  → outputs/river-accounts.txt   (3 key(s), one per line)
```

## 🧭 How it works

River's Console signs users up through a **hosted browser flow** (WorkOS AuthKit)
and its own REST API is bearer-token based, so there is no scriptable HTTP
sign-up. `river-bulk` therefore drives the real hosted UI in a browser, captures
the session bearer token and then talks to the console's own API:

> **Heads-up:** River's sign-up currently asks for phone verification once it has
> seen a few sign-ups, and the tool stops at that step when it appears — mint in
> small batches.

```
mail.tm inbox ──▶ sign-up UI ──▶ e-mail code ──▶ console (bearer token captured)
                                                      │
                                          POST /api/keys { name }
                                                      ▼
                                                 rv_…  API key
                                                      │
                                                      ▼
                                    https://api.river.ai/v1  (OpenAI-compatible)
```

Full breakdown: [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## 🖥️ Requirements — a Chrome to drive

`river-bulk` talks to any Chrome/Chromium reachable over the **CDP debug port**.
Your machine or a VPS is enough — no cloud service required.

```bash
# Linux / VPS, headless
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/.river-chrome"

# Windows (PowerShell)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 --user-data-dir="$env:USERPROFILE\.river-chrome"
```

Then point the tool at it:

| Flag / env | Value | Notes |
| --- | --- | --- |
| `--cdp-url` / `CDP_URL` | `http://127.0.0.1:9222` | Resolves `/json/version` automatically. **Default.** |
| `--cdp-ws` / `CDP_WS` | `ws://host:9222/devtools/browser/<id>` | Explicit WebSocket URL. |

> On a headless VPS, Chromium needs a few shared libraries (`libnss3`, `libatk1.0-0`,
> `libgbm1`, `libasound2`, …). Install them via your distro's package manager if Chrome
> exits immediately.

## 🌐 Proxies

Each account gets its own exit address: the browser context is created with a
per-context proxy, and every console API call is pinned to the same proxy
through a dependency-free CONNECT / SOCKS tunnel. An account never mixes
addresses, and a broken proxy fails that account instead of leaking your IP —
there is no direct fallback.

### Your own address — the one value the egress check needs

The preflight drops any proxy whose exit address *is* yours, so the check is
only as good as that value. Three sources, in increasing order of exposure:

| Source | How it is obtained | Worth knowing |
| --- | --- | --- |
| `--own-ip <address>` / `OWN_IP` | you supply it | nothing is sent anywhere — but a **stale value silently disables the filter**, because a transparent proxy then matches an address that is no longer yours |
| `--own-ip auto` | the router, over UPnP (LAN-only) | useless behind **carrier-grade NAT**, where the router's WAN address is not the address the internet sees — such an answer is rejected rather than trusted |
| `--allow-direct-lookup` | one HTTPS request from this machine to an echo service | always current, and the only source that itself leaves from your own address |

The tool prints the address it used on every run; refresh `--own-ip` per session
(print it on a phone that is not on this LAN, read it from a provider panel, or
let `--allow-direct-lookup` fetch it).

```bash
node src/cli.js --count 10 --proxies proxies.txt
```

`proxies.txt` — one entry per line, `#` comments allowed:

```
http://10.0.0.1:8080
http://user:pass@10.0.0.2:8080
socks5://10.0.0.3:1080
10.0.0.4:8080
10.0.0.5:8080:user:pass
```

| Behaviour | Detail |
| --- | --- |
| No list | The run is refused. `--allow-direct` is the explicit opt-in to minting from your own IP. |
| Preflight | Entries are probed with a *verified* TLS handshake to the sign-up host, until enough are alive for `--count` (`--no-probe`, `--probe-limit <n>`). A proxy that terminates TLS itself is rejected here, before it can burn an account. |
| Rotation | Working proxies are assigned round-robin, one per account. |
| Egress check | Each surviving proxy is asked what exit address it presents, and one that answers with **your own** address (a transparent proxy) is dropped. Your own address comes from `--own-ip <address>` / `OWN_IP`, or from the router over UPnP (`--own-ip auto`, LAN-only, nothing leaves the machine). If neither is available the run stops — a direct echo-service lookup happens only with `--allow-direct-lookup` (`--no-verify-egress` skips the check entirely). **A stale `--own-ip` silently disables this filter**, so refresh it whenever your ISP address may have moved. |
| Loopback entries | `127.0.0.1`, LAN and link-local entries are dropped — a proxy there relays straight out of your own connection (`--allow-local-proxies` re-enables them for testing). |
| Authenticated proxies | Chrome ignores `user:pass@` inside a proxy URL, so credentials are answered through `Fetch.handleAuthRequests` (`proxyUsername`/`proxyPassword`) instead. |
| SOCKS with credentials | Dropped with a warning — Chrome cannot authenticate to SOCKS proxies. |
| Cache | Disabled per account: Chrome's disk cache is shared between contexts, so a cached document would bypass the account's proxy entirely. |
| Recorded | The proxy that minted each account lands in the JSON/CSV `proxy` field. |

### What a free proxy list is actually worth

Free lists are volatile — expect a different set of survivors minutes later — and
expect the survivors to be someone else's compromised router: independent
measurement puts ~10% of working free proxies at outright malicious, TLS
interception included ([NDSS'24 open-proxy study](https://arxiv.org/html/2403.02445v1)).
A proxy sees everything sent through it — including the bearer token this tool
captures. The built-in preflight is strict on purpose; a paid or self-hosted exit
is the safer choice for anything you care about.

## 📬 Mailboxes

The sign-up refuses known disposable-inbox domains, so pick a backend whose domain
it accepts — **`mailtrap` is the one that mints end to end today**, and `imap` with
a mailbox you already own works too.

| `--mailbox` | Inbox | Needs |
| --- | --- | --- |
| `mailtm` (default) | mail.tm / any mail.tm-compatible API (`--mail-base`) | nothing |
| `imap` | a real mailbox you already own, one `local+tag@domain` alias per account | an app password |
| `guerrilla` | Guerrilla Mail (`api.guerrillamail.com`) | nothing |
| `inboxes` | Inboxes.com — eighteen domains on a public JSON API | nothing |
| `tempmailio` | temp-mail.io — a rotating domain pool, JSON API | nothing |
| `tempmailorg` | temp-mail.org — a rotating domain pool | an API session taken from a **headed** browser (the backend fails loudly without one) |
| `mailtrap` | **Mailtrap Inbound — one fresh inbox per account on `inbound-mailtrap.io`** | a Mailtrap API token (`MAILTRAP_TOKEN`, `--mailtrap-token-file`, or `%USERPROFILE%\.river-mailtrap-token`) |

`--mail-domain <domain>` forces the backend to keep minting addresses until the
pool yields exactly that domain.

```bash
# one account through a fresh mailbox; add --allow-direct to run from your own IP
node src/cli.js --count 1 --allow-direct --mailbox mailtrap \
  --mail-domain inbound-mailtrap.io --cdp-url http://127.0.0.1:9222
# keys land in outputs/*.json|.csv|.txt, one key per line in the .txt
```

```bash
# keep the app password out of the shell history AND out of the checkout
printf '%s' 'abcd efgh ijkl mnop' > "$HOME/.river-imap-pass"     # %USERPROFILE% on Windows
node src/cli.js --count 1 --allow-direct \
  --mailbox imap --imap-user you@gmail.com --imap-pass-file "$HOME/.river-imap-pass"
# or export IMAP_USER / IMAP_PASS / IMAP_HOST (default imap.gmail.com)
```

`--mailbox imap` warns when the password file sits inside the repository, and
`.gitignore` already covers `.river-imap-pass`, `*-imap-pass` and `outputs/` —
the exported keys land in `outputs/` and must never be committed.

The IMAP client (`src/imap.js`) is dependency-free, speaks through the account's
proxy tunnel when one is in play, and never marks messages read. Gmail needs
2-step verification for an app password; Outlook, Fastmail and a mailbox on your
own domain work the same way. `--mail-domain` overrides which domain the aliases
are minted on (default: the domain of `IMAP_USER`).

## 🧰 CLI reference

```
node src/cli.js [options]

  -n, --count <n>          number of accounts to create             [1]
  -c, --concurrency <n>    parallel accounts (1 per browser)         [1]
      --cdp-url <url>      Chrome debug HTTP endpoint     [http://127.0.0.1:9222]
      --cdp-ws <url>       explicit CDP WebSocket URL
      --proxies <file>     proxy list, one per line    [none → the run is refused]
      --allow-direct       allow minting from this machine's own IP
      --allow-local-proxies  permit loopback/private proxy entries
      --no-probe           skip the proxy liveness preflight        [egress check still runs]
      --no-verify-egress   skip the exit-address check
      --own-ip <addr|auto> your own public IP so the egress check makes no
                           request of its own; "auto" = ask the router over
                           UPnP (LAN-only); stale values silently disable the
                           transparent-proxy filter                [env OWN_IP]
      --allow-direct-lookup  let the tool learn your address with one direct
                           HTTPS request to an echo service
      --probe-limit <n>    how many list entries to probe           [200]
      --out <file>         JSON output        [outputs/river-accounts.json]
      --csv <file>         CSV output         (defaults beside --out)
      --txt <file>         plain-text key list (defaults beside --out)
      --no-txt             skip the plain-text key list
      --key-prefix <name>  API key name prefix                  [river-bulk]
      --quiet              suppress per-account progress
  -h, --help               show help
```

### Library use

```js
const { CDP, provisionAccount, listModels } = require('./src/river');
const { MailTM } = require('./src/mailtm');
const { parseProxy, createAgent } = require('./src/proxy');

const cdp = new CDP('ws://127.0.0.1:9222/devtools/browser/<id>', {});
await cdp.connect();
await cdp.attachToPage();

const proxy = parseProxy('http://user:pass@host:8080');
const account = await provisionAccount(cdp, new MailTM({ agent: createAgent(proxy) }), {
  keyName: 'my-key',
  proxy,                       // page traffic exits here too
});
console.log(account.email, account.apiKey, account.balanceUsd);

const models = await listModels(account.apiKey);
cdp.close();
```

`provisionAccount` throws without a `proxy`, exactly like the CLI: a caller who
wants to sign up from the machine's own address has to say `allowDirect: true`.

## 🤖 Models & free tier

New accounts can call these models through `https://api.river.ai/v1`
(OpenAI-compatible). Both support text **and** image input, streaming,
reasoning, and function calling.

| Model ID | Input | Cached input | Output | Context | Max output |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-ai/DeepSeek-V4.1-Flash` | $0.12 | $0.0024 | $0.48 | 1,048,576 | 384,000 |
| `zai-org/GLM-5.3-Flash` | $0.12 | $0.024 | $0.40 | 1,048,576 | 128K |

*Prices in USD per million tokens. Reasoning tokens are billed as output.*

**What a fresh account gets:** a **$25 balance** — the tool reads `balanceUsd` for every account it
creates and records it in the JSON/CSV export (`"balanceUsd": 25`), so the credit is visible per key
rather than assumed.

**How to get more:** the balance lives on the **account** — one account per key, and a new account is
a new balance. `--count N` creates N accounts, each with its own `rv_…` key.

Confirm the live model list and prices at runtime with `GET https://api.river.ai/v1/models`.

```bash
curl https://api.river.ai/v1/chat/completions \
  -H "Authorization: Bearer $RIVER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"zai-org/GLM-5.3-Flash","messages":[{"role":"user","content":"hi"}]}'
```

## 🔌 Connect to 9Router

River is OpenAI-compatible, so register it once and use every key:

```bash
node src/connect-9router.js \
  --base http://localhost:20128 --password 123456 \
  --api-key rv_xxxxxxxx
```

Then pick a model inside 9Router:

```
river/zai-org/GLM-5.3-Flash
river/deepseek-ai/DeepSeek-V4.1-Flash
```

Point the connector at a different key to rotate accounts; the model list stays
the same.

## 📦 Output format

`outputs/river-accounts.json`:

```json
{
  "generated_at": "2026-10-12T10:51:20.000Z",
  "total": 2,
  "succeeded": 2,
  "failed": 0,
  "accounts": [
    {
      "status": "ok",
      "email": "z2cb0obwmv54w7an@maxxspace.com",
      "password": "…",
      "apiKey": "rv_z6_ybbX…",
      "apiKeyId": "8f14bb5a-…",
      "keyName": "river-bulk-1",
      "balanceUsd": 25,
      "proxy": "http://145.220.227.2:9050"
    }
  ]
}
```

The same rows are written to `outputs/river-accounts.csv`, and the bare keys to
`outputs/river-accounts.txt` — one `rv_…` per line, no header, pipe-ready:

```
rv_z6_ybbX…
rv_fXpWm42…
```

## 📁 Project structure

See [`STRUCTURE.md`](STRUCTURE.md) for the full tree and data-flow diagram.

```
river-bulk-apikey/
├── src/        cdp.js · proxy.js · river.js · mailtm.js · cli.js · connect-9router.js
├── examples/   basic.js · inference.js
├── docs/       PROTOCOL.md
├── brand/      logo.svg · icon.svg
└── i18n/       6 translated READMEs
```

## ⚠️ Disclaimer

This project is for **educational and research purposes**. Automating account
creation may violate a provider's Terms of Service. You are responsible for how
you use it and for complying with all applicable terms and laws. The authors
accept no liability for misuse.

## 📄 License

[MIT](LICENSE) © 2026 river-bulk-apikey contributors
