<p align="center">
  <img src="docs/screenshots/12-plugin-api-setup.png" alt="SmartStaff AI DeepSeek plugin setup wizard" width="920" />
</p>

<h1 align="center">SmartStaff AI · DeepSeek Plugin</h1>

<p align="center">
  <b>A plugin-style restaurant staffing workspace with a first-run DeepSeek API setup wizard.</b><br />
  <code>deepseek</code> · <code>deepseek-api</code> · <code>deepseek-plugin</code> · <code>ai-plugin</code> · <code>multilingual</code>
</p>

<p align="center">
  <img alt="tests" src="https://img.shields.io/badge/tests-105%2F105-9be34b" />
  <img alt="status" src="https://img.shields.io/badge/status-test--framework-d9ff57" />
  <img alt="languages" src="https://img.shields.io/badge/languages-中文%20%7C%20EN%20%7C%20한국어%20%7C%20日本語-8cd6ff" />
  <img alt="DeepSeek" src="https://img.shields.io/badge/DeepSeek-api.deepseek.com-4d6bfe" />
</p>

> **中文一句话简介：** SmartStaff AI 是一个可安装的 DeepSeek 插件式门店人力预测与 API 设置框架，首次启用即引导配置并测试连接。

## What is this?

SmartStaff AI is a **test-framework plugin** for restaurant workforce planning. It combines a deterministic capacity engine, a DeepSeek-powered explanation layer, and a polished admin workspace.

The first admin login opens a **DeepSeek API setup wizard** when no credential is configured. Save a key, test the real connection, and the same runtime is used by the business AI path.

This is a **plugin framework**, intentionally not a finished commercial product. The goal is to make the DeepSeek integration, first-run UX, and staffing workflow easy to install, inspect, and extend.

### Four-language setup

The setup wizard is localized in:

| 中文 | English | 한국어 | 日本語 |
| --- | --- | --- | --- |
| 连接 DeepSeek | Connect DeepSeek | DeepSeek 연결 | DeepSeek に接続 |
| 保存并测试连接 | Save & test connection | 저장 후 연결 테스트 | 保存して接続テスト |
| 连接成功 | Connected | 연결 성공 | 接続成功 |

## Why it feels different

- **First-run, not hidden settings** — install, log in, configure DeepSeek immediately.
- **Real connection test** — a real HTTPS request with status, JSON, `finish_reason`, model, token and latency checks.
- **Write-only credentials** — the raw key never comes back to the browser or logs.
- **Deterministic core** — DeepSeek explains; it does not invent headcount or override hard constraints.
- **Multilingual onboarding** — Chinese, English, Korean and Japanese in one switch.
- **Shadow-safe** — no real invitations, shifts, notifications or labor costs are triggered by AI setup.

## UI

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/12-plugin-api-setup.png" alt="First-run API setup" /><br /><sub><b>First-run wizard</b> — opens automatically after login when unconfigured.</sub></td>
    <td width="50%"><img src="docs/r6-evidence/screenshots/r6-ai-settings-no-key.png" alt="AI settings" /><br /><sub><b>AI settings</b> — model, timeout, budgets, credential state, usage.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/09-admin-overview.png" alt="Admin overview" /><br /><sub><b>Operations workspace</b> — tables, queue, forecast and exceptions.</sub></td>
    <td><img src="docs/screenshots/04-ai-plans.png" alt="AI plans" /><br /><sub><b>AI explanation</b> — structured analysis, never raw headcount.</sub></td>
  </tr>
</table>

## Install

```bash
git clone https://github.com/YanKaFei/smartstaff-ai-deepseek-plugin.git
cd smartstaff-ai-deepseek-plugin
npm run setup
npm run build
npm run seed
npm start
```

Open <http://127.0.0.1:8787/admin/>.

> `npm run setup` installs the server and mini-program dependencies. Node.js 24+ is recommended.

### First run

1. Log in to the admin workspace.
2. The **DeepSeek setup wizard** opens automatically if no credential is configured.
3. Choose a model, paste a key, click **Save & test connection**.
4. If there is no key, close the wizard; deterministic forecasting still works.

Full install notes: [docs/PLUGIN-INSTALL.md](docs/PLUGIN-INSTALL.md)

## Configuration

| Setting | Default | Notes |
| --- | --- | --- |
| Provider | DeepSeek | First version only |
| Base URL | `https://api.deepseek.com` | Official endpoint only |
| Model | `deepseek-flash` | `deepseek-v4-pro` optional |
| Timeout | 20 s | 5–60 s |
| AI switch | Enabled | Can be disabled |
| Single-store daily budget | $5 | Estimated |
| Platform budget | $80 / 30 days | Estimated |
| Credential | Not configured | Write-only, encrypted at rest |

The runtime resolves one configuration snapshot per request. In-flight requests keep their snapshot; the next request sees updates.

## Architecture

```text
store data
   │
   ▼
deterministic capacity engine ── hard constraints / required headcount
   │
   ▼
unified AI service ──► DeepSeek API ──► JSON / Zod validation
   │                                      │
   ▼                                      ▼
structured analysis                 fallback on failure
   │
   ▼
admin workspace / manager UI
```

- DeepSeek only writes explanations, recommendations and risk notes.
- Headcount and matching constraints remain deterministic.
- AI failure, disablement or budget exhaustion falls back without stopping the manager flow.

## Security

- API key encrypted with AES-256-GCM (`smartstaff:ai-api-key:v1` AAD).
- Key never enters browser `localStorage`, mini-program storage, build artifacts or normal logs.
- Admin-only endpoints; sensitive changes require recent authentication.
- Credential revoke blocks both the saved key and environment fallback.
- Only official DeepSeek Base URL accepted; arbitrary URLs are rejected.
- Real API errors are mapped to stable codes: `AI_AUTH_FAILED`, `AI_TIMEOUT`, `AI_RESPONSE_INVALID`, `AI_NOT_CONFIGURED`.

## Test

```bash
npm test
```

Current: **105/105** tests. The original 95-test R5.2 baseline is preserved; 10 AI settings tests cover credential lifecycle, RBAC, 401, timeout, invalid JSON, schema failure, disabled AI, budget/usage and revocation.

Real API success requires a real key. Without one the project intentionally reports **REAL_API_BLOCKED** and never claims a mock connection.

## DeepSeek search tags

`deepseek` · `deepseek-api` · `deepseek-plugin` · `deepseek-tools` · `ai-plugin` · `ai-settings` · `llm-plugin` · `openai-compatible` · `restaurant-staffing` · `workforce-management` · `smartstaff` · `multilingual` · `typescript` · `vue3` · `nodejs`

## Roadmap / possibilities

- Plugin marketplace packaging and one-click install.
- More DeepSeek-compatible providers behind an explicit allowlist.
- Real-time streaming of analysis into the manager UI.
- Restaurant POS/queue adapters and deeper demand signals.
- 14-day shadow evaluation at real stores.
- Billing reconciliation with provider invoices.
- Role-based team workspaces and audit export.

## Project status

**Test-framework / pre-commercial.** The UI, API settings, credential lifecycle, DeepSeek probe and deterministic fallback are implemented and tested. Real-store data, real manager feedback and production-scale infrastructure remain future work.

## License

License TBD. This repository is published as a test framework for evaluation and extension.
