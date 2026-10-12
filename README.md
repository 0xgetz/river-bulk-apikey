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
- 🤖 **Real-browser sign-up** — the WorkOS AuthKit page (Cloudflare Turnstile + WorkOS Radar) is driven in a real Chrome/Chromium on your own machine or VPS.
- 📧 **Disposable inboxes** — verification codes are read straight from [mail.tm](https://mail.tm).
- 📦 **Exports** — results written to JSON **and** CSV.
- 🔌 **9Router connector** — expose your River keys as an OpenAI-compatible provider in [9Router](https://9router.com) in one command.
- 🌍 **6 languages** — EN, ID, ZH, JA, ES, DE.

## 🚀 Quick start

```bash
# 1. Start a headless Chrome with a debug port
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &

# 2. Create 3 accounts, each with its own API key
node src/cli.js --count 3 --cdp-url http://127.0.0.1:9222

# results land in outputs/river-accounts.json (+ .csv)
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
```

## 🧭 How it works

River's Console authenticates through **WorkOS AuthKit** with **Cloudflare
Turnstile**, so there is no scriptable signup HTTP endpoint
(`POST /api/auth/signup` → `404 Password signup is disabled`). `river-bulk`
therefore drives the real hosted UI in a browser and then talks to the
console's own REST API with the captured session token:

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
> exits immediately. Turnstile widgets on the sign-up page render normally in a real Chrome.

## 🧰 CLI reference

```
node src/cli.js [options]

  -n, --count <n>          number of accounts to create             [1]
  -c, --concurrency <n>    parallel accounts (1 per browser)         [1]
      --cdp-url <url>      Chrome debug HTTP endpoint     [http://127.0.0.1:9222]
      --cdp-ws <url>       explicit CDP WebSocket URL
      --out <file>         JSON output        [outputs/river-accounts.json]
      --csv <file>         CSV output         (defaults beside --out)
      --key-prefix <name>  API key name prefix                  [river-bulk]
      --quiet              suppress per-account progress
  -h, --help               show help
```

### Library use

```js
const { CDP, provisionAccount, listModels } = require('./src/river');
const { MailTM } = require('./src/mailtm');

const cdp = new CDP('ws://127.0.0.1:9222/devtools/browser/<id>', {});
await cdp.connect();
await cdp.attachToPage();

const account = await provisionAccount(cdp, new MailTM(), { keyName: 'my-key' });
console.log(account.email, account.apiKey, account.balanceUsd);

const models = await listModels(account.apiKey);
cdp.close();
```

## 🤖 Available models

New accounts can call these models through `https://api.river.ai/v1`
(OpenAI-compatible). Both support text **and** image input, streaming,
reasoning, and function calling.

| Model ID | Input | Cached input | Output | Context | Max output |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-ai/DeepSeek-V4.1-Flash` | $0.12 | $0.0024 | $0.48 | 1,048,576 | 384,000 |
| `zai-org/GLM-5.3-Flash` | $0.12 | $0.024 | $0.40 | 1,048,576 | 128K |

*Prices in USD per million tokens. Reasoning tokens are billed as output.*
Confirm at runtime with `GET https://api.river.ai/v1/models`.

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
      "balanceUsd": 25
    }
  ]
}
```

The same rows are written to `outputs/river-accounts.csv`.

## 📁 Project structure

See [`STRUCTURE.md`](STRUCTURE.md) for the full tree and data-flow diagram.

```
river-bulk-apikey/
├── src/        cdp.js · river.js · mailtm.js · cli.js · connect-9router.js
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
