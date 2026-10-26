# R3 安全与数据可靠性报告

> 结论：**本地工程 Gate 通过；生产 Gate 未通过**。  
> 测试：82/82 通过；生产构建扫描 `PASS`；真实外部依赖仍 BLOCKED。

## 1. 生产阻断项处理

| # | R2 阻断 | R3 处理 | 状态 |
| ---: | --- | --- | --- |
| 1 | Webhook Secret 明文存储 | AES-256-GCM 加密列 `webhook_secret_enc`；启动迁移旧明文；密钥 `SECRET_ENCRYPTION_KEY` 生产必填；开发用 0600 本地 key 文件；轮换接口只返回一次 | **IMPLEMENTED** |
| 2 | 单进程限流 | 新增 DB 共享限流 `rate_limit_buckets`；`RATE_LIMIT_BACKEND=db` 默认；memory 仅开发；多进程共享同一 DB 时状态一致 | **IMPLEMENTED（单 DB）**；跨主机 Postgres/Redis 仍待迁移 |
| 3 | PostgreSQL/备份恢复 | SQLite 在线 `VACUUM INTO` 备份、校验、恢复脚本 + 测试；PostgreSQL 映射/步骤/回滚方案 | **SQLite IMPLEMENTED；PG BLOCKED（无实例）** |
| 4 | 并发一致性 | 并发取消、超预算审批、重复 Webhook 测试；原有接单并发测试保留 | **IMPLEMENTED** |
| 5 | 管理员审计/会话失效 | 审计保留；新增管理员强制撤销用户全部会话接口；敏感操作近期登录 | **IMPLEMENTED** |
| 6 | 生产构建后门/硬编码凭据 | 移除 `admin123` 默认回退；生产启动校验；构建产物扫描无默认密码/演示开关/占位 Key | **PASS** |

## 2. Webhook Secret 加密

- 算法：AES-256-GCM，AAD `smartstaff:webhook-secret:v1`；随机 12-byte IV。
- 存储：`stores.webhook_secret_enc = v1:iv:tag:ciphertext`；旧 `webhook_secret` 迁移后置 NULL。
- 密钥：`SECRET_ENCRYPTION_KEY` 支持 32-byte hex/base64；生产缺失即启动失败；开发回退 `data/.secret-key`（0600，已 gitignore）。
- 轮换：`POST /api/admin/stores/:id/webhook-secret`，新密钥只返回一次，旧签名立即失效。
- 测试：密文不含明文、可服务端解密、旧明文自动迁移、轮换后旧签名 401。

**残留**：生产建议由 KMS/HSM 托管密钥；当前环境变量/本地文件不是 KMS。

## 3. 共享限流

- 表：`rate_limit_buckets(key, window_start, hits, blocked_until, updated_at)`。
- 原子事务读写；多个 API 进程使用同一数据库即共享窗口。
- 管理员登录 5/15min、Webhook 120/min 等沿用。
- `RATE_LIMIT_BACKEND=memory` 明确只适合单进程开发。
- 测试：3 次允许、第 4 次封禁、持久化桶可被第二个调用方读到。

**残留**：当前是 SQLite 单文件；跨主机多实例需 PostgreSQL/Redis，不能声称已验证。

## 4. 数据备份与恢复

- `scripts/r3-backup.ts backup|verify|restore`。
- `VACUUM INTO` 在线快照；`PRAGMA integrity_check` + SHA-256；恢复前自动保存 pre-restore 副本。
- `tests/r3-backup.test.ts` 验证备份、校验、恢复后门店数据一致。
- PostgreSQL 方案见 `docs/R3-POSTGRES-MIGRATION.md`（BLOCKED，无实例/凭据）。

**残留**：没有生产备份存储、保留策略、异地副本和恢复演练记录。

## 5. 并发与状态一致性

新增 3 项并发测试：

1. 同一班次两个并发自助取消：恰好 1 个 200、1 个 409；仅 1 个 backfill task；accepted 邀约不残留。
2. 同一超预算候补两个并发审批：恰好 1 个 200、1 个 409；仅 1 个有效邀约。
3. 同一 Webhook externalId 两个并发投递：一个 applied、一个 duplicate；状态只更新一次。

保留：并发接单唯一赢家、重叠班次拦截、offer 超时顺延、manager 取消/缺岗。

**残留**：单进程 SQLite/单机验证；多进程/网络分区未演练。

## 6. 审计与会话失效

- 管理动作写 `audit_logs`；审核、模拟器、校准、密钥轮换、试点暂停、影子确认、会话撤销均有 audit。
- `POST /api/admin/users/:id/revoke-sessions`：管理员强制撤销用户全部 access/refresh 会话；旧 token 立即 401。
- 敏感管理员操作 15 分钟内重新登录；管理员改密撤销自身全部会话。
- 管理员登录限流与密码错误不泄露密码。

**残留**：审计日志没有哈希链/WORM；数据库管理员可改写。生产建议导出到不可变日志存储。

## 7. 生产构建检查

脚本：`scripts/r3-production-audit.ts`  
产物：`docs/r3-evidence/production-audit.json`

扫描范围：

- `apps/server/dist`
- `apps/admin`
- `apps/miniapp/dist/build`

规则：

- `admin123` 默认凭据
- `ALLOW_DEMO_LOGIN=true`
- `test-admin`
- 占位 DeepSeek Key
- 形如 `sk-...` 的字面 Key
- dist 中的 `.env`

结果：**findings=[]，envLeaks=[]，productionGate=PASS，demoGate=PASS，status=PASS**。

说明：这不是完整 SAST/secret scan，不能替代人工代码审计和依赖漏洞扫描。

## 8. 仍未通过的生产 Gate

- 真实微信 / 短信 / POS / DeepSeek 未验证（BLOCKED）。
- 无 PostgreSQL 实例、无多实例故障演练。
- 无 KMS/HSM 密钥托管。
- 无不可变审计存储。
- 无真实门店数据校准与真实店长操作验收。
- 生产构建扫描通过，但不等于生产系统已通过安全认证。

**因此：安全 Gate 未通过，不允许真实用户使用生产系统。**
