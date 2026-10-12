<div align="center">

<img src="../brand/logo.svg" alt="river-bulk" width="140" />

# river-bulk-apikey

**Erstelle [River AI](https://console.river.ai)-Konten im Batch und generiere automatisch einen API-Key pro Konto — gesteuert über einen echten (Cloud-)Browser via CDP. Null Abhängigkeiten.**

[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg?style=for-the-badge)](../LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg?style=for-the-badge)](#)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI--compatible-412991.svg?style=for-the-badge&logo=openai&logoColor=white)](https://docs.river.ai/guides/inference)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6.svg?style=for-the-badge)](#-mit-9router-verbinden)

[English](../README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Deutsch](README.de.md)

</div>

---

## ✨ Funktionen

- 🔑 **Massenhaft Konten + API-Keys** — ein River-Konto *und* ein `rv_…`-Key pro Durchlauf.
- 🧼 **Vollständig isolierte Sitzungen** — jedes Konto läuft in einem eigenen CDP-Browserkontext; keine Cookie- oder `localStorage`-Leaks.
- 🪶 **Null Abhängigkeiten** — handgeschriebener RFC6455-WebSocket + CDP-Client. Kein `npm install`.
- 🤖 **Turnstile-freundlich** — die Registrierung läuft in einem echten Browser, daher löst der Browser-Use-Cloud-Browser Cloudflare Turnstile und WorkOS Radar automatisch.
- 📧 **Wegwerf-Postfächer** — Bestätigungscodes direkt von [mail.tm](https://mail.tm).
- 📦 **Export** — Ergebnisse als JSON **und** CSV.
- 🔌 **9Router-Connector** — River-Keys mit einem Befehl als OpenAI-kompatiblen Provider in [9Router](https://9router.com) einbinden.
- 🌍 **6 Sprachen** — EN, ID, ZH, JA, ES, DE.

## 🚀 Schnellstart

```bash
# 1. Einen Browser zum Steuern besorgen (Browser Use Cloud oder lokaler Chrome-Debug-Port)
export BU_CDP_WS="wss://<dein-browser>.cdp.browser-use.com/devtools/browser/<id>"

# 2. 3 Konten erstellen, jedes mit eigenem API-Key
node src/cli.js --count 3

# Ergebnisse: outputs/river-accounts.json (+ .csv)
```

## 🧭 Funktionsweise

Die River-Konsole authentifiziert über **WorkOS AuthKit** mit **Cloudflare
Turnstile**, es gibt also keinen skriptbaren Signup-HTTP-Endpunkt
(`POST /api/auth/signup` → `404 Password signup is disabled`). Daher steuert
`river-bulk` die echte UI im Browser und nutzt anschließend die REST-API der
Konsole mit dem abgefangenen Sitzungstoken:

```
mail.tm-Postfach ──▶ Signup-UI ──▶ E-Mail-Code ──▶ Konsole (Token erfasst)
                                                        │
                                            POST /api/keys { name }
                                                        ▼
                                                   rv_…  API-Key
```

Vollständige Details: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

## 🖥️ Einen Browser bereitstellen

| Methode | Variable | Hinweis |
| --- | --- | --- |
| **Browser Use Cloud** (empfohlen) | `BU_CDP_WS` | Löst Turnstile automatisch, Residential-Proxy. |
| Lokaler Chrome-Debug-Port | `CDP_WS` | `google-chrome --remote-debugging-port=9222 --user-data-dir=./.bcode/chrome-data-dir` |
| Aus HTTP auflösen | `CDP_URL` | z. B. `CDP_URL=http://127.0.0.1:9222` |

## 🧰 CLI-Referenz

```
node src/cli.js [Optionen]

  -n, --count <n>          Anzahl der Konten                     [1]
  -c, --concurrency <n>    parallele Konten (1 pro Browser)       [1]
      --out <file>         JSON-Ausgabe      [outputs/river-accounts.json]
      --csv <file>         CSV-Ausgabe       (neben --out)
      --key-prefix <name>  Präfix des Key-Namens            [river-bulk]
      --quiet              Fortschritt unterdrücken
  -h, --help               Hilfe anzeigen
```

### Nutzung als Bibliothek

```js
const { CDP, provisionAccount, listModels } = require('./src/river');
const { MailTM } = require('./src/mailtm');

const cdp = new CDP(process.env.BU_CDP_WS, {});
await cdp.connect();
await cdp.attachToPage();

const account = await provisionAccount(cdp, new MailTM(), { keyName: 'mein-key' });
console.log(account.email, account.apiKey, account.balanceUsd);
cdp.close();
```

## 🤖 Verfügbare Modelle

| Modell-ID | Input | Gecachter Input | Output | Kontext | Max. Output |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-ai/DeepSeek-V4.1-Flash` | $0.12 | $0.0024 | $0.48 | 1.048.576 | 384.000 |
| `zai-org/GLM-5.3-Flash` | $0.12 | $0.024 | $0.40 | 1.048.576 | 128K |

*Preise in USD pro Million Tokens. Beide unterstützen Text + Bild, Streaming, Reasoning und Function Calling.*

```bash
curl https://api.river.ai/v1/chat/completions \
  -H "Authorization: Bearer $RIVER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"zai-org/GLM-5.3-Flash","messages":[{"role":"user","content":"hallo"}]}'
```

## 🔌 Mit 9Router verbinden

```bash
node src/connect-9router.js \
  --base http://localhost:20128 --password 123456 \
  --api-key rv_xxxxxxxx
```

Modelle in 9Router:

```
river/zai-org/GLM-5.3-Flash
river/deepseek-ai/DeepSeek-V4.1-Flash
```

## ⚠️ Haftungsausschluss

Dieses Projekt dient **Bildungs- und Forschungszwecken**. Die automatisierte
Kontoerstellung kann gegen die Nutzungsbedingungen eines Anbieters verstoßen.
Die Nutzung erfolgt auf eigene Verantwortung.

## 📄 Lizenz

[MIT](../LICENSE) © 2026 river-bulk-apikey contributors
