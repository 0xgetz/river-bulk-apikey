# How it works

This document explains the exact flow `river-bulk` drives, so you can audit,
extend, or re-implement it in another language.

## 1. Why a browser is required

River's Console (`console.river.ai`) does **not** expose a public password/signup
HTTP API. Its own front end reports:

```json
GET https://console.river.ai/api/auth/config
{
  "workos_client_id": "client_01M0TG5W3GBNMFS87K40PYHM98",
  "workos_api_hostname": "auth.console.river.ai",
  "password_login": false,
  "password_signup": false
}
```

Authentication is delegated to **WorkOS AuthKit**, whose hosted pages live at
`login.console.river.ai` and are protected by **Cloudflare Turnstile** plus
**WorkOS Radar**. `POST /api/auth/signup` returns `404 Password signup is
disabled`. A real browser is therefore the only reliable way to create an
account, and the only reliable way to create one is to drive the real UI in a
Chromium instance started with a CDP remote-debugging port (on your own machine
or a VPS).

## 2. The flow, step by step

```
┌─────────┐  1 GET /sign-up?client_id=…&redirect_uri=…   ┌──────────────────────────┐
│  driver │ ───────────────────────────────────────────▶ │ login.console.river.ai   │
│ (CDP)   │                                              │  (WorkOS AuthKit hosted) │
└─────────┘                                              └──────────────────────────┘
     │  fill first_name / last_name / email → Continue
     │  fill password → Continue
     │  read 6-digit code from mail.tm inbox
     │  type code
     ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│ console.river.ai                                                              │
│  · exchanges the OAuth code, then calls its own API with                      │
│    Authorization: Bearer <workos access token>                                 │
│  · the token is captured from the first authenticated request via             │
│    CDP Network.requestWillBeSent                                               │
└───────────────────────────────────────────────────────────────────────────────┘
     │  POST /api/keys  { name, description?, expires_in_days? }
     ▼
   rv_…  (API key — shown once)
```

### Detailed steps

| # | Action | Endpoint / selector |
|---|--------|---------------------|
| 0 | Isolate the session | `Target.createBrowserContext` + `Target.createTarget` |
| 1 | Open sign-up | `login.console.river.ai/sign-up?client_id=…&redirect_uri=…` |
| 2 | Submit identity | `input[name=first_name|last_name|email]` → `Continue` |
| 3 | Submit password | `input[type=password]` → `Continue` (≥ 12 chars) |
| 4 | Fetch code | mail.tm `GET /messages` → regex `\b\d{6}\b` |
| 5 | Submit code | six OTP inputs |
| 6 | Capture token | `Network.requestWillBeSent` → `Authorization: Bearer …` |
| 7 | Mint key | `POST https://console.river.ai/api/keys` |
| 8 | Read balance | `GET  https://console.river.ai/api/billing/account` |

Each account gets its own **browser context**, so cookies and `localStorage`
never leak between accounts and the console does not recognise a returning user.

## 3. Capturing the access token

The WorkOS access token is a short-lived RS256 JWT. It is **not** written to
`localStorage` or `sessionStorage` by the console — the app attaches it as a
request header at runtime. `river-bulk` therefore subscribes to the CDP
`Network` domain and reads the header off the first request the console makes
after login:

```js
cdp.on('Network.requestWillBeSent', (p) => {
  const a = p.request.headers.Authorization;
  if (a?.startsWith('Bearer ')) token = a.slice(7);
}, sessionId);
```

That token is then used out-of-band, which is faster and more stable than
scraping the DOM for the key after it is created.

## 4. Creating the API key

The console front end mints keys with:

```http
POST /api/keys HTTP/1.1
Host: console.river.ai
Authorization: Bearer <token>
Content-Type: application/json

{ "name": "river-bulk-1", "description": "optional", "expires_in_days": 30 }
```

The response contains the **only** copy of the secret:

```json
{
  "id": "8f14bb5a-…",
  "key": "rv_8ljbGglz…",
  "key_prefix": "8ljbGglz",
  "key_hash": "027ed890…",
  "name": "river-bulk-1",
  "created_at": "2026-10-12T10:51:19.580351Z",
  "expires_at": null
}
```

## 5. Using the key

River is OpenAI-compatible at `https://api.river.ai/v1`:

```bash
curl https://api.river.ai/v1/models -H "Authorization: Bearer rv_…"
curl https://api.river.ai/v1/chat/completions \
  -H "Authorization: Bearer rv_…" -H "Content-Type: application/json" \
  -d '{"model":"zai-org/GLM-5.3-Flash","messages":[{"role":"user","content":"hi"}]}'
```

## 6. Notes & limits

- New accounts receive a **$25.00** starting balance (`/api/billing/account`).
- Each run needs a fresh browser context; reusing one re-logs the same user.
- Turnstile is solved inside the real browser. Do not add a stealth patch.
- mail.tm domains may rate-limit aggressive bursts — keep concurrency modest.

## 7. The proxy layer

An account is only properly proxied when *both* of its transports leave from the
same address:

| Transport | Mechanism |
| --- | --- |
| Page traffic (Chrome) | `Target.createBrowserContext { proxyServer }` — one proxy per context. Chrome **ignores** `user:pass@` inside that URL and sends an unauthenticated `CONNECT`, so credentials are supplied instead by enabling `Fetch.handleAuthRequests` and answering the challenge with `proxyUsername` / `proxyPassword`. SOCKS with credentials cannot be authenticated at all and is dropped. |
| Node traffic (mail.tm, `console.river.ai/api/*`) | `src/proxy.js` opens a CONNECT / SOCKS5 / SOCKS4a tunnel and gives `https.request` an `https.Agent` whose sockets are TLS-wrapped over that tunnel. |

There is no fallback path: if the tunnel cannot be established the account
fails, and the request is never sent directly.

One more shared-state trap: Chrome's disk cache is per **profile**, not per
context, so each account session also sets `Network.setCacheDisabled: true`.
Without it account #2 can be served account #1's cached document and never touch
its own proxy — which looks exactly like a working proxy until you compare
egress IPs.

Before any account is minted the preflight asks each candidate proxy what exit
address it presents, and drops the ones that answer with this machine's own
address — that is what catches a transparent proxy, which passes every other
test. Knowing that address normally means asking an echo service, and asking it
*directly* is one request sent from the very address the list exists to hide, so
it is not the default: `--own-ip <address>` (or `OWN_IP`) takes the operator's
value, `--own-ip auto` reads it from the router over UPnP inside the LAN, and
only `--allow-direct-lookup` performs the lookup. If none of those produce an
address the run stops. A stale `--own-ip` is worse than none — a transparent
proxy would match it and pass — so the value in use is printed on every run and
needs refreshing whenever the ISP address may have moved. On a **carrier-grade
NAT** line it moves without the router showing anything: the router keeps
reporting the same private WAN address (`100.64.0.7` on the line this was
measured on) while the public address changed from `198.51.100.42` to
`198.51.100.77` inside nine hours. UPnP answers with the private one and is
therefore rejected as useless rather than trusted. `--no-probe` skips only
the liveness probe: the egress check still runs, and only `--no-verify-egress`
turns it off.
