# SaaS Account System — Step 1 Foundation

> Status: **ACCOUNT_FOUNDATION_READY / EMAIL_DELIVERY_BLOCKED**  
> This is step 1 of the SaaS account work, not the final account product.

## What is implemented

### Tenant model

Schema v18 adds:

- `organizations` — tenant/workspace, plan, status, unique slug.
- `memberships` — user ↔ organization, role `owner/admin/manager/staff`, optional store, status.
- `account_tokens` — hashed email verification / password reset tokens.
- `users.email`, `email_verified`, `users.status`.
- `stores.organization_id`.

Seeded demo data now creates one organization and memberships for the demo manager and staff. New demo stores inherit/create an organization through the auth flow.

### Account API

- `POST /api/auth/register-account` — email/password, owner membership, organization creation.
- `POST /api/auth/verify-email`
- `POST /api/auth/email-login`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/account/me` — user + organization memberships.
- Existing admin/mini-program logins remain compatible.

### Account UI

`/admin/account.html`:

- register organization
- dev verification token + verify
- email login
- forgot/reset password
- account dashboard with organization, role, store binding

The admin login page links to this SaaS account console.

### Tenant scoping

Part-time marketplace now filters open demands by the staff member's active organization. A staff account in org A cannot see org B stores. Manager/staff sessions remain bound to their store for existing business routes.

## Tests

- **114/114** passed.
- 5 new tests:
  - register → verify → login → account/me
  - duplicate email + weak password
  - password reset invalidates old sessions
  - forgot password does not disclose account existence
  - staff marketplace tenant isolation
- Existing 109 tests preserved.
- H5 and mini-program builds pass.

Evidence: `docs/r8-evidence/test-output-r8.txt`

## Known blockers / next steps

1. **Email delivery** — no SMTP/email provider. Dev returns verification/reset token; production cannot complete registration/reset until configured. Status: `EMAIL_DELIVERY_BLOCKED`.
2. **Invitations** — org owner cannot yet invite managers/staff by email.
3. **Membership management UI/API** — list/add/suspend/remove members and change roles.
4. **Tenant enforcement on every business route** — marketplace is scoped; manager/admin routes need membership-aware checks.
5. **Store onboarding inside a tenant** — owner account currently has no store until created; wire org → first store.
6. **Session/device management** — list and revoke individual sessions.
7. **Account profile** — name/email change, resend verification, close account.
8. **Billing/plans** — organization plan exists, no billing integration.
9. **Email uniqueness migration** — old demo users have null email; invite/claim flow needed.

## Screenshots

- `docs/screenshots/19-saas-account.png`
- `docs/screenshots/20-saas-account-dashboard.png`
