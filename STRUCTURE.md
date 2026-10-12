# Project structure

```
river-bulk-apikey/
│
├── src/                        # zero-dependency Node.js source
│   ├── cdp.js                  # raw WebSocket + CDP client (RFC6455, no deps)
│   ├── river.js                # River/AuthKit flow + console REST API
│   ├── mailtm.js               # mail.tm disposable-inbox client
│   ├── cli.js                  # `river-bulk` command-line entry point
│   └── connect-9router.js      # register River as a 9Router provider
│
├── examples/
│   ├── basic.js                # create one account, print key + models
│   └── inference.js            # call the OpenAI-compatible endpoint
│
├── docs/
│   └── PROTOCOL.md             # exact end-to-end flow, endpoints, payloads
│
├── brand/
│   ├── logo.svg                # full-colour logo
│   └── icon.svg                # app-style icon
│
├── i18n/                       # translations of the README
│   ├── README.id.md            # Bahasa Indonesia
│   ├── README.zh.md            # 简体中文
│   ├── README.ja.md            # 日本語
│   ├── README.es.md            # Español
│   └── README.de.md            # Deutsch
│
├── README.md                   # English (default)
├── STRUCTURE.md                # this file
├── LICENSE                     # MIT
└── package.json
```

## Data flow

```
                 ┌─────────────────────────────────────────────────────────────┐
                 │                    river-bulk (this repo)                    │
                 │                                                             │
  mail.tm  ◀─────┤  mailtm.js                                                  │
  inbox          │     │  create inbox / poll 6-digit code                      │
                 │     ▼                                                       │
                 │  river.js ──▶ provisionAccount() ──▶ cli.js                 │
                 │     │                 │                    │                │
                 │  cdp.js               │                    ▼                │
                 └─────┼─────────────────┼──────────── accounts.json / .csv    │
                       │                 │
              raw WebSocket (RFC6455)    │  drive UI + capture bearer token
                       ▼                 ▼
        ┌──────────────────────────┐   ┌──────────────────────────────────────┐
        │  Browser Use cloud (CDP)  │   │ login.console.river.ai  (WorkOS)      │
        │  one isolated context     │──▶│ console.river.ai/api/keys, /api/me …  │
        └──────────────────────────┘   └──────────────────────────────────────┘
                       │
                       ▼
        POST https://console.river.ai/api/keys  →  rv_…
                       │
                       ▼
        https://api.river.ai/v1/chat/completions  (OpenAI-compatible)
```

## Modules

| File | Responsibility |
| --- | --- |
| `src/cdp.js` | Dependency-free CDP client: RFC6455 framing over `tls`, session routing, event emitter, browser-context helpers. |
| `src/river.js` | `provisionAccount()` orchestrates sign-up → verify → token capture → key mint; plus thin REST helpers. |
| `src/mailtm.js` | Creates mail.tm inboxes and polls them for the verification code. |
| `src/cli.js` | Argument parsing, bounded-concurrency batch runner, JSON/CSV export. |
| `src/connect-9router.js` | Turns a River key into a 9Router `openai-compatible` provider. |
