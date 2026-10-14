# Project structure

```
river-bulk-apikey/
│
├── src/                        # zero-dependency Node.js source
│   ├── cdp.js                  # raw WebSocket + CDP client (RFC6455, no deps)
│   ├── proxy.js                # proxy lists + CONNECT/SOCKS5/SOCKS4a tunnels
│   ├── own-ip.js               # public IP via the router's UPnP (LAN-only, no egress)
│   ├── hygiene.js              # per-page User-Agent override (a HeadlessChrome UA is refused)
│   ├── secrets.js              # warns when a credential file sits inside the checkout
│   ├── river.js                # River/AuthKit flow + console REST API
│   ├── mailtm.js               # mail.tm disposable-inbox client
│   ├── mailbox-imap.js         # inbox backend for a real mailbox
│   ├── imap.js                 # dependency-free IMAP client (rides the proxy tunnel)
│   ├── guerrilla.js            # Guerrilla Mail backend (rotating domains)
│   ├── inboxes.js              # Inboxes.com backend (public JSON API)
│   ├── tempmailio.js           # temp-mail.io backend (rotating domains)
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
| `src/cdp.js` | Dependency-free CDP client: RFC6455 framing over `tls`, session routing, event emitter, browser-context helpers (including a per-context `proxyServer`). |
| `src/proxy.js` | Proxy list parsing (`host:port`, `user:pass@`, `scheme://`, `host:port:user:pass`) plus CONNECT / SOCKS5 / SOCKS4a tunnels, an `https.Agent` that dials through them, and the Fetch-based answer to Chrome's proxy-auth challenge. |
| `src/own-ip.js` | The operator's own public address for the egress check: SSDP discovery plus a `GetExternalIPAddress` SOAP call to the router (UPnP IGD). LAN-only, so the check never needs a request from the address it is protecting. |
| `src/river.js` | `provisionAccount()` orchestrates sign-up → verify → token capture → key mint; plus thin REST helpers. Browser traffic exits through the account's proxy, and so do the console API calls — without a `proxy` it throws unless `allowDirect: true` spells out the intent. |
| `src/hygiene.js` | Per-page User-Agent override (and nothing else), because a `HeadlessChrome` UA is refused by the sign-up before the account is even considered. The operator's Chrome is untouched. |
| `src/mailtm.js` | Creates mail.tm inboxes and polls them for the verification code; its instance carries the agent of the account's proxy. |
| `src/mailbox-imap.js` + `src/imap.js` | Inbox backend for a real mailbox over IMAP (one `local+tag@domain` alias per account), with a dependency-free IMAP client that rides the account's proxy tunnel when there is one. |
| `src/guerrilla.js` | Guerrilla Mail backend (api.guerrillamail.com) — free addresses from a rotating domain pool. |
| `src/inboxes.js` | Inboxes.com backend — eighteen free domains over a public JSON API; code extraction is schema-independent because the public endpoint has no published shape. |
| `src/tempmailorg.js` | temp-mail.org backend — rotating pool, plain JSON API; the address must sit unencoded in the message path (`…/email/<addr>@<domain>/messages?token=…`), the encoded form answers `400 Email not found`. |
| `src/mailtrap.js` | **Mailtrap Inbound backend** — the inbox the sign-up gate accepts: `inbound-mailtrap.io` is not on the domain list, one fresh inbox per account via `POST /api/inbound/folders/{id}/inboxes`, codes read from `GET /api/inbound/inboxes/{id}/messages`. Meaures the whole flow's missing half. |
| `src/secrets.js` | Warns when a credential file (IMAP app password) sits inside the checkout where a `git add -A` could publish it. |
| `src/cli.js` | Argument parsing, proxy gate + liveness preflight, own-address resolution for the egress check, bounded-concurrency batch runner, JSON/CSV/TXT export. |
| `src/connect-9router.js` | Turns a River key into a 9Router `openai-compatible` provider. |
