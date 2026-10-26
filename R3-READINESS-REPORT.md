# R3 Pilot Readiness 验收报告

> 日期：2026-10-26  
> 结论：**影子试点可准备；真实派单未授权**。  
> 当前 82/82 自动化测试通过；生产安全 Gate 未通过（外部凭据/数据/PG/KMS 等仍缺失）。

---

## 1. 基线核对

| 项目 | 结果 |
| --- | --- |
| R2 报告 | 存在，69/69 通过；已列明真实微信/短信/POS/DeepSeek、Webhook 明文、单进程限流、PG/多进程等阻断 |
| 当前测试 | **82/82 通过**（69 R2/R1 基线 + 13 R3 新增） |
| Git 版本 | **不可用**：当前目录不是 Git 仓库（`git rev-parse` 返回 not a repository），不伪造 commit |
| Node/npm | v24.19.0 / 11.17.0 |
| 数据库 | SQLite `apps/server/data/smartstaff.db`，schema v10 |
| 真实外部成功 | 0 项（DeepSeek/微信/短信/POS 均未取得凭据或成功响应） |

R3 没有删除或跳过任何原有测试；新增 13 项测试。

---

## 2. 交付状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Webhook Secret 加密存储 + 轮换 | **IMPLEMENTED** | AES-256-GCM，旧明文启动迁移，生产强制 Key |
| 共享限流 | **IMPLEMENTED（单 DB）** | `rate_limit_buckets`；跨主机 PG/Redis **BLOCKED** |
| 备份/恢复 | **IMPLEMENTED（SQLite）** | `VACUUM INTO` + integrity_check + SHA-256 + restore 测试 |
| PostgreSQL 迁移方案 | **BLOCKED** | 方案已写，无 PG 实例/凭据，未迁移 |
| 并发取消/审批/Webhook | **IMPLEMENTED** | 3 项并发测试；单进程 SQLite |
| 管理员会话撤销 | **IMPLEMENTED** | 旧 token 立即 401 |
| 生产构建后门扫描 | **PASS** | 无默认密码/演示开关/占位 Key 发现 |
| POS 适配器标准接口 | **IMPLEMENTED** | 通用 HMAC adapter；厂商 adapter **BLOCKED** |
| 桌台状态事件 | **IMPLEMENTED** | `table_status` 映射 checkout/cleaning/available |
| 模拟器/事件状态机一致性 | **MOCK_VERIFIED** | 模拟器事件进入同一 event_ingest；非真实门店 |
| 服务分钟校准模板/分析 | **IMPLEMENTED** | CSV 模板、MAE/偏差分析、≥30 门槛、人工复核 |
| 真实校准 | **UNCALIBRATED** | 真实样本 0；禁止自动升级 |
| 影子模式 | **IMPLEMENTED** | 零邀约/零班次/零费用，隔离测试通过 |
| 紧急暂停/恢复 | **IMPLEMENTED** | 取消待回复邀约，保留已确认班次；审计 |
| 低干扰店长流程 | **IMPLEMENTED** | 首页三主操作、方案页确认、异常集中入口；操作指标已埋点 |
| 真实微信/短信/POS/DeepSeek | **BLOCKED** | 见 `R3-INTEGRATION-MATRIX.md` |

---

## 3. 本次实施内容

### R3.1 真实集成准备

- 新增 `scripts/r3-integration-check.ts`：只在有非占位 Key 时发真实请求；无 Key 直接 BLOCKED。
- DeepSeek：真实成功才 REAL_VERIFIED；校验 JSON schema、usage、latency；失败/无 Key 记录阻断。
- 微信：检查 AppID/Secret；无凭据 503；有配置也只做连通性探针，不伪造 code。
- 短信：无 Provider 适配器，BLOCKED。
- POS：只提供通用 HMAC adapter + 契约测试，不宣称厂商已接入。
- 证据：`docs/r3-evidence/integration-probe.json`。

### R3.2 生产安全与可靠性

1. Webhook Secret：
   - 新列 `webhook_secret_enc`；AES-256-GCM；
   - `SECRET_ENCRYPTION_KEY` 生产必填；开发使用 0600 本地 key 文件；
   - `migrateWebhookSecrets` 启动迁移旧明文；
   - 轮换只显示一次；旧签名立即失效。
2. 限流：
   - `rateLimitDb` + `rate_limit_buckets`；默认 `RATE_LIMIT_BACKEND=db`；
   - 测试验证持久桶与封禁；
   - 多主机共享仍依赖 PostgreSQL/Redis，未验证。
3. 备份：
   - `scripts/r3-backup.ts backup|verify|restore`；
   - `tests/r3-backup.test.ts` 恢复后门店 ID 一致。
4. 并发：
   - 并发取消 1 赢 1 冲突、单任务；
   - 并发超预算审批 1 赢 1 冲突、单邀约；
   - 并发重复 Webhook 1 applied/1 duplicate。
5. 审计/会话：
   - `POST /api/admin/users/:id/revoke-sessions`；
   - 关键动作写 audit；敏感操作近期登录。
6. 生产构建：
   - 删除 `admin123` 默认回退；
   - `scripts/r3-production-audit.ts` 扫描 dist/admin/H5：findings=[]，envLeaks=[]，PASS；
   - 注意：不是完整 SAST/secret scan。

### R3.3 门店数据自动接入

- `PosAdapterContract`：`parse(payload)->IngestEvent[]`，能力清单；
- `GET /api/ingest/adapters` 返回 generic capabilities；
- Webhook 支持 `x-pos-adapter`；未知 adapter 422；
- 支持 `queue_join/call/abandon/seat/checkout/leave/clean/clean_done/table_status/staff_checkin/out`；
- 保留 manual/simulator/generic webhook；
- `table_status` 只允许安全的 available/checkout/cleaning，dining 外部同步拒绝；
- 厂商适配器需凭据与文档，当前 **BLOCKED**；
- 模拟器事件类型已纳入 adapter 能力测试，避免词表漂移。

### R3.4 烤肉预测校准

- CSV 模板：`docs/R3-SERVICE-CALIBRATION-TEMPLATE.csv`；
- 分析接口：`POST /api/admin/stores/:id/service-calibration/analyze`；
- 指标：样本数、桌型覆盖、天数、平均服务分钟、MAE、偏差、缺岗/超载；
- ≥30/三桌型各≥5/≥7 天只是**人工复核门槛**；
- 真实样本 0 → 仍 `UNCALIBRATED`；没有自动升级；
- 前端不能自行标记 calibrated，必须有管理员证据记录。

### R3.5 低干扰店长体验

- 首页主操作仍为 3 个：更新营业 / AI 调配 / 处理异常；
- 新增试点控制卡：影子/真实状态、暂停/恢复；
- 方案页影子模式提示与“记录影子建议（不邀约）”；
- 店长反馈接口 + 操作次数/耗时接口；
- 履约状态：预计需求、待回复、已确认、已到岗、未填补；
- 取消/缺岗/候选/超预算统一异常入口；
- H5 影子流程实测：首页内联选择 + 记录 = **2 次操作、3128 ms**（同一页完成），不再跳转方案页；总计 2 次主操作。该数据是本机 H5 测量，不是真实门店 UAT。
- 截图：`docs/r3-evidence/screenshots/r3-02-shadow-plan.png`、`r3-01-shadow-home.png`。

### R3.6 影子与受控试点

- `StoreConfig.pilot.shadowMode`；
- 影子确认：`shadow_runs`，0 offers/shifts/demands/员工通知/费用；
- `pilot_controls` 紧急暂停：取消待回复邀约、阻止新确认、保留已确认；
- `pilot_feedback`：推荐 vs 店长实际 vs 在岗 vs 超载；
- `pilot_ux_metrics`：操作次数/耗时；
- 两步试点、回滚、停止条件见 `R3-PILOT-PLAN.md`。

---

## 4. 测试与证据

```bash
cd apps/server
npm test
# 82/82
```

R3 新增 13 项：

| 文件 | 数量 | 覆盖 |
| --- | ---: | --- |
| `tests/r3-security.test.ts` | 3 | 密钥加密/迁移、共享限流、会话撤销 |
| `tests/r3-pos-adapter.test.ts` | 2 | 适配器契约、签名 table_status、模拟器词表 |
| `tests/r3-calibration.test.ts` | 2 | MAE/偏差、<30 不合格 |
| `tests/r3-pilot.test.ts` | 2 | 影子零承诺、暂停/恢复 |
| `tests/r3-backup.test.ts` | 1 | 备份/校验/恢复 |
| `tests/r3-concurrency.test.ts` | 3 | 并发取消/审批/Webhook |

证据：

- `docs/r3-evidence/test-output-r3.txt`
- `docs/r3-evidence/production-audit.json`
- `docs/r3-evidence/integration-probe.json`
- `docs/r2-evidence/service-model-comparison.json`
- R2 真实 DeepSeek 401：`docs/r2-evidence/deepseek-real-request.json`

---

## 5. 生产 Gate 判定

### 本地工程 Gate：PASS

- 82/82 测试；
- 构建通过；
- 生产构建扫描；
- 82 测试包含安全/并发/备份/影子隔离。

### 生产使用 Gate：FAIL / 不允许真实用户使用

| 阻断项 | 当前 |
| --- | --- |
| 真实微信登录 | BLOCKED，无 AppID/Secret/有效 code |
| 真实短信 | BLOCKED，无 Provider |
| 真实 POS | BLOCKED，无厂商文档/凭据 |
| 真实 DeepSeek | BLOCKED，无 Key；R2 真实请求 401 |
| 真实服务工时校准 | UNCALIBRATED，0 样本 |
| PostgreSQL/多实例 | BLOCKED，无实例；仅方案 |
| 跨主机共享限流 | BLOCKED，未验证 |
| KMS/HSM | 未接入 |
| 不可变审计 | 未接入 |
| 真实店长 UAT | 未执行 |

**因此：只能进行影子试点准备；第二步真实邀约必须在前置 Gate 通过并获得店长/管理员书面确认后开启。**

---

## 6. 仍需完成

1. 配置真实微信 AppID/Secret，真机 wx.login。
2. 接入短信服务商。
3. 选 POS 厂商，按 adapter 契约实现并联调。
4. 配置 DeepSeek Key，真实成功并核对 token/成本。
5. 用真实样本校准，走管理员证据接口，人工复核。
6. 迁移 PostgreSQL + 跨实例限流 + 备份演练。
7. 接入 KMS/HSM 和不可变审计。
8. 影子期至少 7 天并完成店长 UAT。
9. 通过后再评审真实邀约。

---

## 7. 产物索引

- `R3-INTEGRATION-MATRIX.md`
- `R3-PILOT-PLAN.md`
- `R3-SECURITY-REPORT.md`
- `R3-CALIBRATION-REPORT.md`
- `docs/R3-POSTGRES-MIGRATION.md`
- `docs/R3-SERVICE-CALIBRATION-TEMPLATE.csv`
- `docs/r3-evidence/`
- `scripts/r3-integration-check.ts`
- `scripts/r3-production-audit.ts`
- `scripts/r3-backup.ts`
