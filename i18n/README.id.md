<div align="center">

<img src="../brand/logo.svg" alt="river-bulk" width="140" />

# river-bulk-apikey

**Buat banyak akun [River AI](https://console.river.ai) sekaligus dan hasilkan satu API key untuk setiap akun — digerakkan lewat browser Chrome/Chromium nyata di mesin atau VPS Anda melalui CDP. Tanpa dependensi.**

[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg?style=for-the-badge)](../LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg?style=for-the-badge)](#)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI--compatible-412991.svg?style=for-the-badge&logo=openai&logoColor=white)](https://docs.river.ai/guides/inference)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6.svg?style=for-the-badge)](#-hubungkan-ke-9router)

[English](../README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Deutsch](README.de.md)

</div>

---

## ✨ Fitur

- 🔑 **Buat massal akun + API key** — satu akun River *dan* satu key `rv_…` per akun.
- 🧼 **Sesi terisolasi** — setiap akun berjalan di konteks browser CDP sendiri, cookie dan `localStorage` tidak bocor antar akun.
- 🪶 **Tanpa dependensi** — WebSocket RFC6455 + klien CDP buatan sendiri. Tidak perlu `npm install`.
- 🤖 **Pendaftaran lewat browser nyata** — halaman AuthKit yang dihosting digerakkan di Chrome/Chromium sungguhan di mesin atau VPS Anda.
- 📧 **Kotak masuk sekali pakai** — kode verifikasi dibaca langsung dari [mail.tm](https://mail.tm).
- 📦 **Ekspor** — hasil ditulis ke JSON **dan** CSV.
- 🔌 **Konektor 9Router** — jadikan key River sebagai provider kompatibel-OpenAI di [9Router](https://9router.com) dengan satu perintah.
- 🌍 **6 bahasa** — EN, ID, ZH, JA, ES, DE.

## 🚀 Mulai cepat

```bash
# 1. Jalankan Chrome headless dengan debug port (mesin atau VPS)
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &

# 2. Buat 3 akun, masing-masing dengan API key sendiri
node src/cli.js --count 3 --cdp-url http://127.0.0.1:9222

# hasil tersimpan di outputs/river-accounts.json (+ .csv)
```

## 🧭 Cara kerja

Console River mendaftarkan pengguna lewat **alur browser yang dihosting**
(WorkOS AuthKit), dan REST API-nya memakai token bearer — jadi tidak ada
pendaftaran HTTP yang bisa diskrip. Karena itu `river-bulk` menggerakkan UI
hosting yang asli di browser, menangkap token sesi, lalu memanggil API console:

> **Peringatan:** pendaftaran River kini meminta verifikasi telepon setelah
> beberapa pendaftaran; alat ini berhenti di langkah itu — daftar dalam batch
> kecil.

```
inbox mail.tm ──▶ UI pendaftaran ──▶ kode e-mail ──▶ console (token ditangkap)
                                                          │
                                              POST /api/keys { name }
                                                          ▼
                                                     rv_…  API key
```

Penjelasan lengkap: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md).

## 🖥️ Kebutuhan — Chrome untuk digerakkan

`river-bulk` berbicara dengan Chrome/Chromium apa pun lewat **debug port CDP**.
Mesin Anda atau sebuah VPS sudah cukup — tidak perlu layanan cloud.

```bash
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &
```

| Flag / env | Nilai | Catatan |
| --- | --- | --- |
| `--cdp-url` / `CDP_URL` | `http://127.0.0.1:9222` | Otomatis resolve `/json/version`. **Default.** |
| `--cdp-ws` / `CDP_WS` | `ws://host:9222/devtools/browser/<id>` | URL WebSocket eksplisit. |

## 🧰 Referensi CLI

```
node src/cli.js [opsi]

  -n, --count <n>          jumlah akun                          [1]
  -c, --concurrency <n>    akun paralel (1 per konteks)          [1]
      --cdp-url <url>      endpoint HTTP debug Chrome  [http://127.0.0.1:9222]
      --cdp-ws <url>       URL WebSocket CDP eksplisit
      --out <file>         keluaran JSON      [outputs/river-accounts.json]
      --csv <file>         keluaran CSV       (default di samping --out)
      --key-prefix <name>  awalan nama API key             [river-bulk]
      --quiet              senyapkan progres per akun
  -h, --help               tampilkan bantuan
```

### Penggunaan sebagai library

```js
const { CDP, provisionAccount, listModels } = require('./src/river');
const { MailTM } = require('./src/mailtm');

const cdp = new CDP('ws://127.0.0.1:9222/devtools/browser/<id>', {});
await cdp.connect();
await cdp.attachToPage();

const account = await provisionAccount(cdp, new MailTM(), { keyName: 'kunci-saya' });
console.log(account.email, account.apiKey, account.balanceUsd);
cdp.close();
```

## 🤖 Model & kuota gratis

| Model ID | Input | Input cache | Output | Konteks | Output maks |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-ai/DeepSeek-V4.1-Flash` | $0.12 | $0.0024 | $0.48 | 1.048.576 | 384.000 |
| `zai-org/GLM-5.3-Flash` | $0.12 | $0.024 | $0.40 | 1.048.576 | 128K |

*Harga dalam USD per juta token. Keduanya mendukung teks + gambar, streaming, reasoning, dan pemanggilan fungsi.*

**Yang didapat akun baru:** saldo **$25** — alat ini membaca `balanceUsd` untuk setiap akun dan
menuliskannya ke ekspor JSON/CSV (`"balanceUsd": 25`), jadi kreditnya terlihat per key, bukan
diasumsikan.

**Cara menambah:** saldo melekat pada **akun** — satu akun per key, dan akun baru berarti saldo
baru. `--count N` membuat N akun, masing-masing dengan key `rv_…` sendiri.

Cek daftar model dan harga terbaru kapan saja: `GET https://api.river.ai/v1/models`.

```bash
curl https://api.river.ai/v1/chat/completions \
  -H "Authorization: Bearer $RIVER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"zai-org/GLM-5.3-Flash","messages":[{"role":"user","content":"hai"}]}'
```

## 🔌 Hubungkan ke 9Router

```bash
node src/connect-9router.js \
  --base http://localhost:20128 --password 123456 \
  --api-key rv_xxxxxxxx
```

Model di 9Router:

```
river/zai-org/GLM-5.3-Flash
river/deepseek-ai/DeepSeek-V4.1-Flash
```

## ⚠️ Penafian

Proyek ini untuk **tujuan edukasi dan riset**. Otomatisasi pembuatan akun dapat
melanggar Ketentuan Layanan penyedia. Anda bertanggung jawab atas penggunaannya.

## 📄 Lisensi

[MIT](../LICENSE) © 2026 river-bulk-apikey contributors
