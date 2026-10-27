# SaaS Account System — Step 1 Foundation

> Status: **ACCOUNT_ORG_READY / EMAIL_DELIVERY_BLOCKED**  
> Steps 1–2 of the SaaS account work are implemented; not the final account product.

## Step 2 — organization administration and tenant guards

Implemented tenant enforcement for manager routes: a manager session must have an active membership in the store organization, or be the store owner. Marketplace remains organization-scoped. Organization first-store creation now assigns the owner, owner membership store, and allows the owner to enter the store manager flow after re-login.

Session management is available at `GET /api/account/sessions` and `DELETE /api/account/sessions/:id`; the account dashboard lists sessions and can revoke other devices.


Schema v19 adds `org_invitations`.

Implemented:

- owner/admin can list members, stores and pending invitations;
- invite by email with role `admin/manager/staff` and optional store binding;
- accept invitation for a new or existing user;
- revoke pending invitation;
- change member role, suspend/reactivate, bind store;
- create a store inside the organization;
- organization console at `/admin/org.html`.

All endpoints are membership-authorised; staff cannot manage an organization.

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

- **119/119** passed.
- 5 account tests:
  - register → verify → login → account/me
  - duplicate email + weak password
  - password reset invalidates old sessions
  - forgot password does not disclose account existence
  - staff marketplace tenant isolation
- 3 organization tests:
  - invite → accept → member login
  - owner-only member/store management
  - role change and invitation revoke
- 2 tenant/session tests:
  - revoke one device while preserving current session
  - manager without active store membership is denied
- Existing 109 tests preserved.
- H5 and mini-program builds pass.

Evidence: `docs/r8-evidence/test-output-r8.txt`

Screenshots: `docs/screenshots/19-saas-account.png`, `20-saas-account-dashboard.png`, `21-saas-org-console.png`

## Known blockers / next steps

1. **Email delivery** — no SMTP/email provider. Dev returns verification/reset token; production cannot complete registration/reset until configured. Status: `EMAIL_DELIVERY_BLOCKED`.
2. **Tenant enforcement on every business route** — manager routes now checked; admin routes are platform-only; staff routes use staff profile; deeper cross-store invitation rules remain.
3. **Owner onboarding** — first store binding is done; full guided store setup and manager assignment remain.
4. **Remove member** — role/status supported; hard removal and ownership transfer need a policy.
6. **Session/device management** — list and revoke individual sessions.
7. **Account profile** — name/email change, resend verification, close account.
8. **Billing/plans** — organization plan exists, no billing integration.
9. **Email uniqueness migration** — old demo users have null email; invite/claim flow needed.

## Screenshots

- `docs/screenshots/19-saas-account.png`
- `docs/screenshots/20-saas-account-dashboard.png`
