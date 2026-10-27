# Part-time Marketplace Workflow

## Why

Part-time staff are users, not data rows. A staff account can browse open shifts across stores, apply, withdraw and see the result. A store manager reviews applications for their own store and, on approval, a real confirmed shift is created through the same shift state machine used by the rest of the product.

## Roles

| Role | Can do |
| --- | --- |
| Staff | Browse cross-store openings, apply, withdraw, view application status, view resulting shift |
| Manager | Review applications for own store, approve/reject, see applicant profile summary |
| Admin | Existing staff approval and account controls |

## Flow

```text
manager publishes/creates a demand
        │
        ▼
staff sees open opportunities (all stores)
        │  apply
        ▼
application: pending
        │
        ├── manager rejects ──► rejected (no shift)
        │
        └── manager approves
                │
                ▼
        confirmed shift + notification
                │
                ▼
        demand count reconciled; full demand closes
```

## Rules

- Staff must be `approved`; target store's `requireQualified` is enforced.
- Availability windows, minimum notice and cross-store time conflicts are checked at apply and again at approval.
- One application per staff/demand; pending/approved cannot duplicate.
- Withdrawn/rejected can re-apply.
- Manager can only decide applications for their own store.
- Approval creates a `confirmed` shift, links `demand_id`, and calls `reconcileDemand`.
- When the demand becomes full, other pending applications are rejected and notified.
- All writes are audited; staff receives in-app notification.

## API

- `GET /api/staff/opportunities`
- `POST /api/staff/opportunities/:id/apply`
- `GET /api/staff/applications`
- `POST /api/staff/applications/:id/withdraw`
- `GET /api/manager/applications`
- `POST /api/manager/applications/:id/approve`
- `POST /api/manager/applications/:id/reject`

## Demo

```bash
cd apps/server
npm run demo:marketplace
```

Creates a second demo store and two open demands. Then log in as staff `13800000001` (K001) and open **缺位广场**.

## Limits

- Production notification/WeChat path remains disabled without credentials.
- Staff account creation still uses demo/phone login; a full registration/KYC system is separate future work.
- No real invites, shifts or labor costs are created by the AI setup; this marketplace does create shifts only after explicit manager approval.
