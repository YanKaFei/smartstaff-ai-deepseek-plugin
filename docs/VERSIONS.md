# Reproducible baseline (R3)

| Item | Value |
| --- | --- |
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| TypeScript | 5.6.3 (apps/server devDependency) |
| uni-app | 3.0.0-5030320261023001 (apps/miniapp) |
| Vue | 3.4.21 |
| SQLite | Node built-in `node:sqlite` |
| Schema | 10 |
| Tests at baseline | 82/82 (`docs/r3-evidence/test-output-r3.txt`) |
| Dependency locks | `apps/server/package-lock.json`, `apps/miniapp/package-lock.json` |
| Git baseline | tag `r3-baseline`; hash in `git log` (no remote push) |

Reproduce:

```bash
cd apps/server
npm ci
npm test
npm run build
```
