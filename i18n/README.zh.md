<div align="center">

<img src="../brand/logo.svg" alt="river-bulk" width="140" />

# river-bulk-apikey

**批量创建 [River AI](https://console.river.ai) 账号，并为每个账号自动生成一个 API 密钥 —— 通过真实（云端）浏览器经 CDP 驱动。零依赖。**

[![License: MIT](https://img.shields.io/badge/License-MIT-3DA639.svg?style=for-the-badge)](../LICENSE)
[![Node](https://img.shields.io/badge/Node-%E2%89%A518-339933.svg?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-blue.svg?style=for-the-badge)](#)
[![OpenAI compatible](https://img.shields.io/badge/API-OpenAI--compatible-412991.svg?style=for-the-badge&logo=openai&logoColor=white)](https://docs.river.ai/guides/inference)
[![9Router](https://img.shields.io/badge/9Router-connector-8B5CF6.svg?style=for-the-badge)](#-连接到-9router)

[English](../README.md) · [Bahasa Indonesia](README.id.md) · [简体中文](README.zh.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Deutsch](README.de.md)

</div>

---

## ✨ 特性

- 🔑 **批量创建账号 + API 密钥** —— 每个账号同时得到一个 River 账号和一个 `rv_…` 密钥。
- 🧼 **完全隔离的会话** —— 每个账号运行在独立的 CDP 浏览器上下文中，cookie 与 `localStorage` 不会互相泄漏。
- 🪶 **零依赖** —— 手写的 RFC6455 WebSocket + CDP 客户端，无需 `npm install`。
- 🤖 **真实浏览器注册** —— 托管在 WorkOS AuthKit 的页面在你自己机器或 VPS 上的真实 Chrome/Chromium 中驱动。
- 📧 **一次性邮箱** —— 验证码直接读取自 [mail.tm](https://mail.tm)。
- 📦 **导出** —— 结果写入 JSON **和** CSV。
- 🔌 **9Router 连接器** —— 一条命令即可把 River 密钥注册为 [9Router](https://9router.com) 的 OpenAI 兼容提供商。
- 🌍 **6 种语言** —— EN、ID、ZH、JA、ES、DE。

## 🚀 快速开始

```bash
# 1. 在机器或 VPS 上启动带调试端口的 headless Chrome
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &

# 2. 创建 3 个账号，每个都有自己的 API 密钥
node src/cli.js --count 3 --cdp-url http://127.0.0.1:9222

# 结果位于 outputs/river-accounts.json（及 .csv）
```

## 🧭 工作原理

River 控制台通过**托管的浏览器流程**（WorkOS AuthKit）完成注册，其 REST API
使用 Bearer 令牌 —— 不存在可脚本化的 HTTP 注册。因此 `river-bulk` 在浏览器中
驱动真实的托管 UI，捕获会话令牌，然后调用控制台自身的 API：

> **提示：** River 的注册在看到若干次注册后会要求手机验证，工具会在该步骤停止 ——
> 请小批量注册。

```
mail.tm 邮箱 ──▶ 注册 UI ──▶ 邮件验证码 ──▶ 控制台（捕获令牌）
                                                │
                                    POST /api/keys { name }
                                                ▼
                                           rv_…  API 密钥
```

完整说明：[`docs/PROTOCOL.md`](../docs/PROTOCOL.md)。

## 🖥️ 要求 —— 一个可驱动的 Chrome

`river-bulk` 通过 **CDP 调试端口** 与任意 Chrome/Chromium 通信。
你自己的机器或一台 VPS 即可 —— 无需云服务。

```bash
google-chrome --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.river-chrome" --no-sandbox &
```

| 参数 / 环境变量 | 值 | 说明 |
| --- | --- | --- |
| `--cdp-url` / `CDP_URL` | `http://127.0.0.1:9222` | 自动解析 `/json/version`。**默认。** |
| `--cdp-ws` / `CDP_WS` | `ws://host:9222/devtools/browser/<id>` | 显式 WebSocket URL。 |

## 🧰 CLI 参考

```
node src/cli.js [选项]

  -n, --count <n>          要创建的账号数量                    [1]
  -c, --concurrency <n>    并发账号数（每浏览器 1 个）          [1]
      --cdp-url <url>      Chrome 调试 HTTP 端点     [http://127.0.0.1:9222]
      --cdp-ws <url>       显式 CDP WebSocket URL
      --out <file>         JSON 输出        [outputs/river-accounts.json]
      --csv <file>         CSV 输出         （默认与 --out 同目录）
      --key-prefix <name>  API 密钥名称前缀               [river-bulk]
      --quiet              静默每个账号的进度
  -h, --help               显示帮助
```

### 作为库使用

```js
const { CDP, provisionAccount, listModels } = require('./src/river');
const { MailTM } = require('./src/mailtm');

const cdp = new CDP('ws://127.0.0.1:9222/devtools/browser/<id>', {});
await cdp.connect();
await cdp.attachToPage();

const account = await provisionAccount(cdp, new MailTM(), { keyName: 'my-key' });
console.log(account.email, account.apiKey, account.balanceUsd);
cdp.close();
```

## 🤖 模型与免费额度

| 模型 ID | 输入 | 缓存输入 | 输出 | 上下文 | 最大输出 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `deepseek-ai/DeepSeek-V4.1-Flash` | $0.12 | $0.0024 | $0.48 | 1,048,576 | 384,000 |
| `zai-org/GLM-5.3-Flash` | $0.12 | $0.024 | $0.40 | 1,048,576 | 128K |

*价格为每百万 token 的美元数。两者均支持文本 + 图像输入、流式、推理与函数调用。*

**新账户能得到什么：** **$25** 余额 —— 工具会为每个账户读取 `balanceUsd` 并写入 JSON/CSV 导出
（`"balanceUsd": 25`），所以额度是按 key 可见的，而不是假设的。

**如何获得更多：** 余额属于**账户** —— 一个账户一个 key，新账户就是新余额。
`--count N` 会创建 N 个账户，每个都有自己的 `rv_…` key。

随时用 `GET https://api.river.ai/v1/models` 查看最新的模型与价格。

```bash
curl https://api.river.ai/v1/chat/completions \
  -H "Authorization: Bearer $RIVER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"zai-org/GLM-5.3-Flash","messages":[{"role":"user","content":"你好"}]}'
```

## 🔌 连接到 9Router

```bash
node src/connect-9router.js \
  --base http://localhost:20128 --password 123456 \
  --api-key rv_xxxxxxxx
```

9Router 中的模型：

```
river/zai-org/GLM-5.3-Flash
river/deepseek-ai/DeepSeek-V4.1-Flash
```

## ⚠️ 免责声明

本项目仅用于**教育与研究**。自动化创建账号可能违反服务商的《服务条款》。
使用风险自负。

## 📄 许可证

[MIT](../LICENSE) © 2026 river-bulk-apikey contributors
