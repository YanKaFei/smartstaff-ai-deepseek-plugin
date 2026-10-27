<p align="center">
  <img src="docs/screenshots/20-saas-account-dashboard.png" alt="SmartStaff AI SaaS account console" width="920" />
</p>

<h1 align="center">SmartStaff AI</h1>

<p align="center">
  <b>Multi-tenant restaurant workforce SaaS with a DeepSeek-powered planning layer.</b><br />
  <code>deepseek</code> · <code>restaurant-staffing</code> · <code>multi-tenant</code> · <code>saas</code> · <code>part-time-marketplace</code>
</p>

<p align="center">
  <img alt="tests" src="https://img.shields.io/badge/tests-124%2F124-9be34b" />
  <img alt="schema" src="https://img.shields.io/badge/schema-v21-8cd6ff" />
  <img alt="status" src="https://img.shields.io/badge/status-test--framework-d9ff57" />
  <img alt="languages" src="https://img.shields.io/badge/languages-EN%20%7C%20ZH%20%7C%20KO%20%7C%20JA-8cd6ff" />
</p>

<p align="center">
  <b>Languages:</b> <a href="README.md">EN</a> · <a href="README.zh-CN.md">ZH</a> · <a href="README.ko.md">KO</a> · <a href="README.ja.md">JA</a>
</p>

## What is this?

SmartStaff AI is a **test-framework restaurant workforce SaaS**. It connects:

- organizations, stores, managers and part-time staff in one account system;
- a cross-store part-time marketplace for open shifts and applications;
- a deterministic capacity engine that forecasts staffing needs;
- a DeepSeek layer that explains the plan without changing hard headcount constraints;
- an admin console with first-run DeepSeek API configuration.

It is intentionally a **test framework**, not a finished commercial product. The repository is meant to be installed, inspected, evaluated and extended.

## Product modules

| Module | What it does |
| --- | --- |
| **SaaS accounts** | Email registration, verification, login, password reset, organizations, memberships, roles and invitations. |
| **Organization console** | Owner/admin manage members, roles, stores, invitations, ownership transfer and first-store onboarding. |
| **Part-time marketplace** | Staff browse open shifts across stores in their organization, apply, withdraw and see manager decisions. |
| **Manager approval** | Managers review applicants, approve/reject, and approval creates a confirmed shift and reconciles demand. |
| **AI staffing** | Deterministic forecast + DeepSeek explanation + structured JSON validation. |
| **DeepSeek setup** | First-run API wizard, encrypted write-only key, model/timeout/budget settings, real connection test and usage. |
| **Shadow-safe operations** | AI configuration and marketplace applications never bypass shadow/pause gates for real shifts. |

## UI

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/20-saas-account-dashboard.png" alt="SaaS account dashboard" /><br /><sub><b>Account console</b> — organizations, memberships, sessions.</sub></td>
    <td width="50%"><img src="docs/screenshots/21-saas-org-console.png" alt="Organization console" /><br /><sub><b>Organization</b> — members, invitations, stores.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/16-staff-marketplace.png" alt="Part-time marketplace" /><br /><sub><b>Part-time marketplace</b> — cross-store open shifts and applications.</sub></td>
    <td><img src="docs/screenshots/12-plugin-api-setup.png" alt="DeepSeek first-run setup" /><br /><sub><b>DeepSeek first run</b> — configure and test a real API connection.</sub></td>
  </tr>
</table>

## Quick start

```bash
git clone https://github.com/YanKaFei/smartstaff-ai-deepseek-plugin.git
cd smartstaff-ai-deepseek-plugin
npm run setup
npm run build
npm run seed
npm start
```

- Admin: <http://127.0.0.1:8787/admin/>
- SaaS account console: <http://127.0.0.1:8787/admin/account.html>
- Organization console: <http://127.0.0.1:8787/admin/org.html>
- H5: <http://127.0.0.1:8787/app/>

Node.js 24+ recommended. Full install notes: [docs/PLUGIN-INSTALL.md](docs/PLUGIN-INSTALL.md).

## SaaS account flow

1. Register with email + organization name.
2. Verify email (dev token or configured email provider).
3. Log in and open the account/org console.
4. Invite an `admin`, `manager` or `staff` member.
5. Create a store inside the organization.
6. Enter the store as owner, or assign a manager.
7. Manager publishes demand; staff apply through the marketplace.

Email delivery is implemented through an outbox + Resend adapter. Without `RESEND_API_KEY`, `EMAIL_FROM` and a verified sender domain, the system reports `PROVIDER_NOT_CONFIGURED` and does not claim delivery.

## DeepSeek setup

The first admin login opens the API wizard when no credential exists.

- Base URL: `https://api.deepseek.com`
- Models: `deepseek-flash`, `deepseek-v4-pro`
- API key: AES-256-GCM encrypted at rest, write-only
- Real HTTPS connection test with status, JSON, `finish_reason`, model, tokens and latency
- Stable errors: `AI_AUTH_FAILED`, `AI_TIMEOUT`, `AI_RESPONSE_INVALID`, `AI_NOT_CONFIGURED`
- AI failure, disablement or budget exhaustion falls back to deterministic planning

## Architecture

```text
organization / members / stores
        │
        ▼
part-time marketplace ── apply ──► manager approval ──► confirmed shift
        │
        ▼
deterministic capacity engine ── hard headcount constraints
        │
        ▼
unified AI service ──► DeepSeek API ──► JSON + Zod validation
        │
        ▼
structured explanation / manager UI
```

## Tenant and security model

- Every manager route checks an active membership in the store organization.
- Staff routes require an active staff membership.
- The marketplace filters open shifts by the staff member's organization.
- Organization owner/admin can invite, suspend, transfer ownership and create stores.
- Sessions store device metadata (UA/IP); users can revoke other sessions.
- Account, organization, invitation, session and AI changes are audited.
- Shadow mode and paused stores cannot create real shifts from marketplace approval.

## Tests

```bash
npm test
```

Current: **124/124** tests.

The original 109-test baseline is preserved; added tests cover account registration/verification/reset, invitations, organization roles, tenant isolation, ownership transfer, session management, email outbox and marketplace workflows.

Evidence: [docs/r8-evidence/test-output-r8.txt](docs/r8-evidence/test-output-r8.txt)

## Current limits

- **Email provider credentials are not configured**; real production verification/invite/reset delivery is blocked. Dev tokens work.
- Existing phone-based demo users need an explicit account merge/link operation; a migration script exists but has not been run against a real store.
- Billing/plans are not implemented; `plan` is a data field only.
- Production PostgreSQL/KMS/multi-instance/monitoring are future work.
- Real-store pilot data and real manager feedback remain pending.

## DeepSeek / search tags

`deepseek` · `deepseek-api` · `deepseek-plugin` · `ai-plugin` · `restaurant-staffing` · `workforce-management` · `multi-tenant-saas` · `part-time-marketplace` · `shift-scheduling` · `nodejs` · `typescript` · `vue3` · `multilingual`

## Roadmap

- Configure a real transactional email provider and verify SPF/DKIM.
- Link legacy phone accounts to email accounts.
- Complete the owner first-store setup wizard.
- Member removal/data-retention policy.
- Billing and subscription plans.
- Production deployment hardening and real-store pilot.

## License

License TBD. Published as a test framework for evaluation and extension.
