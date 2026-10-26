# Reproducible baseline

| Item | Value |
| --- | --- |
| Node.js | v24.19.0 (`.nvmrc`) |
| npm | 11.17.0 |
| TypeScript | 5.6.3 |
| uni-app | 3.0.0-5030320261023001 |
| Vue | 3.4.21 |
| SQLite | Node built-in `node:sqlite` |
| Schema | 12 (R5 pilot archive/event/workload) |
| R3 baseline commit | `1e94563d1ff4e9032d53311a19f9af534f73025a` |
| R3 baseline tag | `r3-baseline` |
| R4 commit/tag | `see git log` / `r4-engineering-ready` (local; no remote push) |
| R5 tag | `r5-real-data-pending` (local; no remote push) |
| R5.1 tag | `r5.1-field-ready` (local; no remote push) |
| R3 tests | 82/82 (`docs/r3-evidence/test-output-r3.txt`) |
| R4 tests | 85/85 (`docs/r4-evidence/test-output-r4.txt`) |
| R5 tests | 87/87 (`docs/r5-evidence/test-output-r5.txt`) |
| R5.1 tests | 91/91 (`docs/r5.1-evidence/test-output-r5.1.txt`) |
| Dependency locks | `apps/server/package-lock.json`, `apps/miniapp/package-lock.json` |

Reproduce:

```bash
cd apps/server
npm ci
npm test
npm run build
```
