# R3 PostgreSQL 迁移与数据可靠性方案

> 状态：**方案已制定，迁移未执行（BLOCKED）**。当前代码使用 Node 内置 `node:sqlite`；本文件不是“已完成 PostgreSQL 迁移”的声明。

## 1. 为什么暂不直接切换

- 试点门店单店、单进程、低并发；SQLite 足够验证业务闭环。
- 多实例/高并发/在线备份需要 PostgreSQL；但当前没有可用的 PostgreSQL 环境和运维凭据。
- 生产安全 Gate 未通过前，不允许真实用户使用生产系统，因此不在本轮强行迁移。

## 2. 表映射

| SQLite | PostgreSQL | 说明 |
| --- | --- | --- |
| `TEXT PRIMARY KEY` | `TEXT PRIMARY KEY` | 继续使用应用侧 `id('...')` |
| `INTEGER` 时间戳（毫秒） | `BIGINT` | 保持毫秒整数，避免时区歧义 |
| `INTEGER` 布尔 | `BOOLEAN` | `phone_verified`、`shadow`、`dispatch_paused`、`is_backfill`、`cache_hit` |
| `TEXT` JSON | `JSONB` | `items_json`、`payload_json`、`parameters_json`、`recommendations_json`、`candidate_json` |
| `REAL` | `NUMERIC(12,4)` | 金额/时薪/成本，应用层按 2–4 位小数 |
| `AUTOINCREMENT` | `BIGSERIAL` | 仅审计/用量等 append-only 表可选 |

核心表：`users, sessions, stores, store_tables, dining_sessions, queue_entries, ops_events, business_days, staff_profiles, staff_availability, forecasts, assignment_plans, staffing_demands, backfill_tasks, shifts, job_offers, notifications, exceptions, phone_verifications, audit_logs, event_ingest, event_ingest_state, ai_usage, ai_cache, service_calibrations, rate_limit_buckets, shadow_runs, pilot_controls, pilot_feedback, pilot_ux_metrics`。

## 3. 迁移步骤

1. 冻结写入：试点暂停调配；应用进入维护模式（只读）。
2. 生成 SQLite 一致性快照：`npx tsx scripts/r3-backup.ts backup`。
3. 用迁移工具（建议 `pgloader` 或一次性 Node 脚本）按上述映射导入；先导入无 FK 的表，再导入依赖表。
4. 建立索引：
   - `(store_id, start_at)`、`(store_id, status)`、`(store_id, received_at)`
   - `event_ingest(store_id, source, external_id)` 唯一
   - `shifts(demand_id)`、`backfill_tasks(source_shift_id)` 唯一
   - `sessions(refresh_token_hash)` 唯一（只存哈希）
5. 校验：
   - 每表行数对比；
   - 外键孤儿检查；
   - 关键业务不变量：`shifts.status` 枚举、`job_offers` 不残留已取消班次的 accepted、`backfill_tasks` 一源一任务；
   - 抽样查询今日聚合/覆盖计数。
6. 应用切换：`DATABASE_URL` 新驱动 + 双写观察期（可选）；先只读回放，再切写。
7. 回滚：保留 SQLite 快照；若 PG 写入失败，停止写入、恢复 SQLite 快照、重启旧版本。

## 4. 备份与恢复（当前 SQLite）

已实现：

```bash
cd apps/server
npx tsx scripts/r3-backup.ts backup ./backups/pilot-$(date +%s).db
npx tsx scripts/r3-backup.ts verify ./backups/pilot-....db
npx tsx scripts/r3-backup.ts restore ./backups/pilot-....db
```

- 使用 `VACUUM INTO` 生成在线一致性快照；
- 校验 `PRAGMA integrity_check` 与 SHA-256；
- 恢复前自动保存 `*.pre-restore-*` 文件；
- 备份 manifest 记录表数量、字节数、校验和与时间；
- 测试：`tests/r3-backup.test.ts`。

生产 PostgreSQL：使用 `pg_dump -Fc` + WAL 归档（或云 RDS 自动快照），每日全量 + 至少 15 分钟 WAL；恢复演练每季度一次。

## 5. 共享限流

- `RATE_LIMIT_BACKEND=db`（默认）：`rate_limit_buckets` 表保存窗口与封禁截止时间；多个 API 进程共享同一数据库时状态一致。
- `RATE_LIMIT_BACKEND=memory`：仅单进程/开发，禁止多实例生产使用。
- 迁移 PostgreSQL 后，`rateLimitDb` 应改为 `pg` 事务/`ON CONFLICT`；或改用 Redis/网关限流。
- 当前测试验证 DB 桶持久化与封禁；未验证跨主机多实例。

## 6. 仍未完成（BLOCKED）

- 没有 PostgreSQL 实例与连接凭据；
- 没有 ORM/驱动替换；当前仓储层仍是 SQLite SQL；
- 没有真实多实例并发/故障切换演练；
- 没有生产备份存储与权限审计。

在完成以上事项前，生产可用性 Gate 不能通过。
