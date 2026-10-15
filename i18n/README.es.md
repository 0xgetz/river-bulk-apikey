<div align="center">

<img src="../brand/logo.svg" alt="river-bulk" width="140" />

# river-bulk-apikey

**Crea cuentas de [River AI](https://console.river.ai) en lote y genera automáticamente una API key para cada una — mediante un Chrome/Chromium real en tu máquina o VPS vía CDP. Cero dependencias.**

[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg?style=for-the-badge)](../LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg?style=for-the-badge)](#)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI--compatible-412991.svg?style=for-the-badge&logo=openai&logoColor=white)](https://docs.river.ai/guides/inference)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6.svg?style=for-the-badge)](#-conectar-con-9router)

[English](../README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Deutsch](README.de.md)

</div>

---

## ✨ Características

- 🔑 **Creación masiva de cuentas + API keys** — una cuenta River *y* una clave `rv_…` por ejecución.
- 🧼 **Sesiones totalmente aisladas** — cada cuenta se ejecuta en su propio contexto de navegador CDP; cookies y `localStorage` no se filtran.
- 🪶 **Cero dependencias** — cliente WebSocket RFC6455 + CDP hecho a mano. Sin `npm install`.
- 🤖 **Registro en navegador real** — la página hospedada de AuthKit se maneja en Chrome/Chromium real en tu máquina o VPS.
- 📧 **Buzones desechables** — los códigos se leen directamente de [mail.tm](https://mail.tm).
- 📦 **Exportación** — resultados en JSON **y** CSV.
- 🔌 **Conector 9Router** — expón tus claves River como proveedor compatible con OpenAI en [9Router](https://9router.com) con un comando.
- 🌍 **6 idiomas** — EN, ID, ZH, JA, ES, DE.

## 🚀 Inicio rápido

```bash
# 1. Inicia Chrome headless con un puerto de depuración (máquina o VPS)
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &

# 2. Crea 3 cuentas, cada una con su API key
node src/cli.js --count 3 --cdp-url http://127.0.0.1:9222

# resultados en outputs/river-accounts.json (+ .csv)
```

## 🧭 Cómo funciona

La consola de River registra a los usuarios mediante un **flujo hospedado en el
navegador** (WorkOS AuthKit), y su API REST usa tokens bearer — no hay registro
HTTP automatizable. Por eso `river-bulk` maneja la UI hospedada real en un
navegador, captura el token de sesión y luego usa la API de la consola:

> **Aviso:** el registro de River ahora pide verificación telefónica tras ver
> unas cuantas altas; la herramienta se detiene en ese paso — registra en lotes
> pequeños.

```
buzón mail.tm ──▶ UI de registro ──▶ código ──▶ consola (token capturado)
                                                    │
                                        POST /api/keys { name }
                                                    ▼
                                               rv_…  API key
```

Detalle completo: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

## 🖥️ Requisitos — un Chrome que controlar

`river-bulk` habla con cualquier Chrome/Chromium accesible por el **puerto de
depuración CDP**. Tu máquina o un VPS es suficiente — sin servicios cloud.

```bash
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &
```

| Flag / env | Valor | Notas |
| --- | --- | --- |
| `--cdp-url` / `CDP_URL` | `http://127.0.0.1:9222` | Resuelve `/json/version` automáticamente. **Por defecto.** |
| `--cdp-ws` / `CDP_WS` | `ws://host:9222/devtools/browser/<id>` | URL WebSocket explícita. |

## 🧰 Referencia de la CLI

```
node src/cli.js [opciones]

  -n, --count <n>          número de cuentas                    [1]
  -c, --concurrency <n>    cuentas en paralelo (1 por navegador) [1]
      --cdp-url <url>      endpoint HTTP de depuración      [http://127.0.0.1:9222]
      --cdp-ws <url>       URL WebSocket CDP explícita
      --out <file>         salida JSON        [outputs/river-accounts.json]
      --csv <file>         salida CSV         (junto a --out)
      --key-prefix <name>  prefijo del nombre de la key      [river-bulk]
      --quiet              silenciar el progreso
  -h, --help               ayuda
```

### Uso como librería

```js
const { CDP, provisionAccount, listModels } = require('./src/river');
const { MailTM } = require('./src/mailtm');

const cdp = new CDP('ws://127.0.0.1:9222/devtools/browser/<id>', {});
await cdp.connect();
await cdp.attachToPage();

const account = await provisionAccount(cdp, new MailTM(), { keyName: 'mi-key' });
console.log(account.email, account.apiKey, account.balanceUsd);
cdp.close();
```

## 🤖 Modelos y plan gratuito

| Model ID | Entrada | Entrada cache | Salida | Contexto | Salida máx |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-ai/DeepSeek-V4.1-Flash` | $0.12 | $0.0024 | $0.48 | 1.048.576 | 384.000 |
| `zai-org/GLM-5.3-Flash` | $0.12 | $0.024 | $0.40 | 1.048.576 | 128K |

*Precios en USD por millón de tokens. Ambos admiten texto + imagen, streaming, razonamiento y llamadas a funciones.*

**Lo que recibe una cuenta nueva:** un saldo de **$25** — la herramienta lee `balanceUsd` en cada
cuenta y lo escribe en la exportación JSON/CSV (`"balanceUsd": 25`), así el crédito queda visible
por key en lugar de darse por supuesto.

**Cómo obtener más:** el saldo vive en la **cuenta** — una cuenta por key, y una cuenta nueva es un
saldo nuevo. `--count N` crea N cuentas, cada una con su propia key `rv_…`.

Consulta la lista de modelos y precios en vivo con `GET https://api.river.ai/v1/models`.

```bash
curl https://api.river.ai/v1/chat/completions \
  -H "Authorization: Bearer $RIVER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"zai-org/GLM-5.3-Flash","messages":[{"role":"user","content":"hola"}]}'
```

## 🔌 Conectar con 9Router

```bash
node src/connect-9router.js \
  --base http://localhost:20128 --password 123456 \
  --api-key rv_xxxxxxxx
```

Modelos en 9Router:

```
river/zai-org/GLM-5.3-Flash
river/deepseek-ai/DeepSeek-V4.1-Flash
```

## ⚠️ Aviso legal

Este proyecto es para **fines educativos y de investigación**. Automatizar la
creación de cuentas puede violar los Términos de Servicio del proveedor. El uso
es bajo tu responsabilidad.

## 📄 Licencia

[MIT](../LICENSE) © 2026 river-bulk-apikey contributors
