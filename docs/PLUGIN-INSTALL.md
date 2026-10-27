# Plugin Install & First Run

This repository is a **test-framework plugin package**, not a marketplace binary. It runs as the SmartStaff AI admin workspace.

## Requirements

- Node.js 24+
- npm
- macOS / Linux / Windows (SQLite is bundled through Node's built-in `node:sqlite`)

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

## First-run API setup

After the first admin login:

1. The setup wizard opens automatically when no business credential exists.
2. Paste a DeepSeek API key, choose `deepseek-flash` or `deepseek-v4-pro`, then **Save & test connection**.
3. The server encrypts the key at rest and sends a real HTTPS request. A mock is never used for success.
4. Without a key, the wizard stays available and deterministic forecasting continues.

The wizard is available in **中文 / English / 한국어 / 日本語**.

## Configure server

Create `apps/server/.env` from `apps/server/.env.example` and set at least:

```dotenv
PORT=8787
ADMIN_PASSWORD=replace-with-a-strong-password
SECRET_ENCRYPTION_KEY=<32-byte-hex-or-base64>
```

Never commit `.env` or API keys. The admin password is not the DeepSeek key.

## Test

```bash
npm test
# 105/105 expected
```

Real API success requires a valid DeepSeek key. With no key the status is intentionally **REAL_API_BLOCKED**.
