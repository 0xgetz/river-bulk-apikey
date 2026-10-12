<div align="center">

<img src="../brand/logo.svg" alt="river-bulk" width="140" />

# river-bulk-apikey

**[River AI](https://console.river.ai) のアカウントを一括作成し、それぞれに API キーを自動生成 — 実（クラウド）ブラウザを CDP 経由で操作。依存関係ゼロ。**

[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg?style=for-the-badge)](../LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg?style=for-the-badge)](#)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI--compatible-412991.svg?style=for-the-badge&logo=openai&logoColor=white)](https://docs.river.ai/guides/inference)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6.svg?style=for-the-badge)](#-9router-への接続)

[English](../README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Deutsch](README.de.md)

</div>

---

## ✨ 特徴

- 🔑 **アカウント＋API キーの一括作成** — 1 実行で River アカウント *と* `rv_…` キーを 1 つずつ。
- 🧼 **完全に分離されたセッション** — 各アカウントは独自の CDP ブラウザコンテキストで動作し、cookie や `localStorage` が漏れません。
- 🪶 **依存関係ゼロ** — 自作の RFC6455 WebSocket + CDP クライアント。`npm install` 不要。
- 🤖 **Turnstile 対応** — 実ブラウザで登録するため、Cloudflare Turnstile と WorkOS Radar は Browser Use クラウドブラウザが自動で解決します。
- 📧 **使い捨て受信箱** — 認証コードは [mail.tm](https://mail.tm) から直接取得。
- 📦 **エクスポート** — JSON **と** CSV に出力。
- 🔌 **9Router コネクタ** — 1 コマンドで River キーを [9Router](https://9router.com) の OpenAI 互換プロバイダに。
- 🌍 **6 言語** — EN、ID、ZH、JA、ES、DE。

## 🚀 クイックスタート

```bash
# 1. 操作するブラウザを用意（Browser Use クラウド、またはローカル Chrome のデバッグポート）
export BU_CDP_WS="wss://<your-browser>.cdp.browser-use.com/devtools/browser/<id>"

# 2. 3 アカウントを作成（それぞれに API キー）
node src/cli.js --count 3

# 結果: outputs/river-accounts.json（+ .csv）
```

## 🧭 仕組み

River コンソールは **WorkOS AuthKit** と **Cloudflare Turnstile** で認証する
ため、スクリプト可能な登録 HTTP エンドポイントはありません
（`POST /api/auth/signup` → `404 Password signup is disabled`）。そこで
`river-bulk` はブラウザで実際の UI を操作し、取得したセッショントークンで
コンソールの REST API を呼び出します：

```
mail.tm 受信箱 ──▶ 登録 UI ──▶ 認証コード ──▶ コンソール（トークン取得）
                                                  │
                                      POST /api/keys { name }
                                                  ▼
                                             rv_…  API キー
```

詳細: [`docs/PROTOCOL.md`](../docs/PROTOCOL.md)。

## 🖥️ ブラウザの用意

| 方法 | 環境変数 | 備考 |
| --- | --- | --- |
| **Browser Use クラウド**（推奨） | `BU_CDP_WS` | Turnstile を自動解決、レジデンシャルプロキシ。 |
| ローカル Chrome デバッグポート | `CDP_WS` | `google-chrome --remote-debugging-port=9222 --user-data-dir=./.bcode/chrome-data-dir` |
| HTTP から解決 | `CDP_URL` | 例 `CDP_URL=http://127.0.0.1:9222` |

## 🧰 CLI リファレンス

```
node src/cli.js [オプション]

  -n, --count <n>          作成するアカウント数                [1]
  -c, --concurrency <n>    並列数（ブラウザ 1 台につき 1）      [1]
      --out <file>         JSON 出力       [outputs/river-accounts.json]
      --csv <file>         CSV 出力        （既定は --out と同じ場所）
      --key-prefix <name>  API キー名の接頭辞                [river-bulk]
      --quiet              進捗を抑制
  -h, --help               ヘルプを表示
```

### ライブラリとして

```js
const { CDP, provisionAccount, listModels } = require('./src/river');
const { MailTM } = require('./src/mailtm');

const cdp = new CDP(process.env.BU_CDP_WS, {});
await cdp.connect();
await cdp.attachToPage();

const account = await provisionAccount(cdp, new MailTM(), { keyName: 'my-key' });
console.log(account.email, account.apiKey, account.balanceUsd);
cdp.close();
```

## 🤖 利用可能なモデル

| モデル ID | 入力 | キャッシュ入力 | 出力 | コンテキスト | 最大出力 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-ai/DeepSeek-V4.1-Flash` | $0.12 | $0.0024 | $0.48 | 1,048,576 | 384,000 |
| `zai-org/GLM-5.3-Flash` | $0.12 | $0.024 | $0.40 | 1,048,576 | 128K |

*価格は 100 万トークンあたりの USD。両方ともテキスト＋画像入力、ストリーミング、推論、関数呼び出しに対応。*

```bash
curl https://api.river.ai/v1/chat/completions \
  -H "Authorization: Bearer $RIVER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"zai-org/GLM-5.3-Flash","messages":[{"role":"user","content":"こんにちは"}]}'
```

## 🔌 9Router への接続

```bash
node src/connect-9router.js \
  --base http://localhost:20128 --password 123456 \
  --api-key rv_xxxxxxxx
```

9Router のモデル:

```
river/zai-org/GLM-5.3-Flash
river/deepseek-ai/DeepSeek-V4.1-Flash
```

## ⚠️ 免責事項

本プロジェクトは**教育・研究目的**です。アカウントの自動生成はプロバイダの
利用規約に違反する可能性があります。利用は自己責任で。

## 📄 ライセンス

[MIT](../LICENSE) © 2026 river-bulk-apikey contributors
