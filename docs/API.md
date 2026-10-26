# SmartStaff AI · API（R3）

Base URL：`http://127.0.0.1:8787/api`
认证：Access Token 放在 `Authorization: Bearer <token>`；登录同时返回 `refreshToken`。Access Token 过期后调用 `/auth/refresh` 轮换，退出调用 `/auth/logout`。响应统一为 `{ ok: true, data }` 或 `{ ok: false, error: { code, message, details? } }`。

角色：`manager`（店长）、`staff`（兼职）、`admin`（管理员）。店长接口自动限定登录门店；兼职接口只允许操作本人数据。

---

## 认证

| 方法 | 路径 | 说明 | Body |
| --- | --- | --- | --- |
| GET | `/auth/config` | 返回当前环境是否允许演示登录、微信/SMS 是否配置，不泄露密钥 | — |
| POST | `/auth/mini-login` | 演示登录；仅开发/回环且显式开启，生产默认禁用 | `{ role, storeCode, name?, phone? }` |
| POST | `/auth/wx-login` | 真实微信登录：`code2Session` → OpenID 绑定；未配置 AppID/Secret 返回 503 | `{ role, code, storeCode, phone?, name?, claimCode? }` |
| POST | `/auth/staff/register` | 兼职自助登记；只创建待审核资料，不发放会话 | `{ storeCode, name, phone, area? }` |
| POST | `/auth/register-store` | 演示态创建门店并成为店长；生产请走微信+店长授权码 | `{ storeName, managerCode, managerName? }` |
| POST | `/auth/admin-login` | 管理员密码登录，5 次/15 分钟限流 | `{ password }` |
| POST | `/auth/admin/change-password` | 修改管理员密码；要求近期登录并校验强度 | `{ currentPassword, newPassword }` |
| POST | `/auth/refresh` | 用 refreshToken 轮换 access/refresh；旧 refresh 立即失效 | `{ refreshToken }` |
| POST | `/auth/logout` | 注销当前会话 | — |
| POST | `/auth/logout-all` | 注销该用户全部会话 | — |
| GET | `/auth/session` | 当前会话角色/门店/过期时间 | — |
| POST | `/auth/phone/code` | 发送手机号验证码；未配置 SMS 返回 503，不伪造 | `{ phone }` |
| POST | `/auth/phone/verify` | 校验手机号验证码 | `{ phone, code }` |
| POST | `/auth/manager/claim-code` | 店长生成一次性门店授权码（仅已绑定店长） | — |
| GET | `/me` | 当前用户 + 门店/兼职资料；不返回会话哈希 | — |

示例：

```bash
curl -s -X POST http://127.0.0.1:8787/api/auth/mini-login \
  -H 'content-type: application/json' \
  -d '{"role":"manager","storeCode":"K001"}'
```

---

## 店长（manager）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/manager/store` | 门店配置 |
| PATCH | `/manager/store/config` | 保存配置 `{ config, step? }`；校验完整结构并同步桌位 |
| POST | `/manager/onboarding/finish` | 完成首次配置 |
| GET | `/manager/today` | 今日经营聚合：桌位、排队、叫号、动态、最新预测、班次统计 |
| POST | `/manager/today/confirm` | 确认营业 `{ onDutyStaff?, queueGroups?, latestCallNo? }`，可空 Body |
| POST | `/manager/ops` | 经营快捷操作，见下 |
| POST | `/manager/forecast` | 生成预测 `{ useAi?: boolean }`（默认调用 AI） |
| GET | `/manager/forecast/latest` | 最新预测 |
| GET | `/manager/forecast/history` | 最近 20 次预测 |
| POST | `/manager/plans` | 基于最新/指定预测生成经济与保障方案 `{ forecastId? }` |
| GET | `/manager/plans` | 方案列表 |
| GET | `/manager/plans/:id` | 方案详情 |
| POST | `/manager/plans/:id/confirm` | 确认方案并创建邀约 |
| POST | `/manager/plans/:id/replace` | 替换候选 `{ staffId, startAt, replacementStaffId }` |
| GET | `/manager/assignments` | 邀约/班次分组（待接受、已确认、服务中、已完成、异常） |
| POST | `/manager/assignments/:id/confirm-completion` | 确认完工 |
| POST | `/manager/assignments/:id/cancel` | 取消 `{ reason?, scope?: 'person' \| 'demand' }`；`person` 默认自动候补，`demand` 取消整个需求且不补人 |
| POST | `/manager/assignments/:id/no-show` | 标记缺席 `{ note? }`；按剩余时间自动候补 |
| POST | `/manager/backfill/:id/approve` | 店长确认超出原预算的候补，随后发出邀约（仍需本人接受） |
| GET | `/manager/pilot/summary` | 试点控制、影子记录、反馈 MAE/偏差 |
| POST | `/manager/pilot/pause` | 紧急暂停：停止新调配并取消待回复邀约 `{ reason?, cancelPending? }` |
| POST | `/manager/pilot/resume` | 恢复调配 |
| POST | `/manager/pilot/feedback` | 店长实际需求/在岗/超载反馈 `{ recommended, managerActual, onDuty, overloaded, noShow?, decision?, reasons?, correction?, notes? }` |
| POST | `/manager/pilot/ux-metric` | 记录操作次数/耗时 `{ flow, actionCount, elapsedMs, planId?, shadow? }` |
| GET | `/manager/ingest/status` | 数据源、最近事件、陈旧状态、已应用/异常计数 |
| GET | `/manager/ingest/events` | 最近 100 条摄取事件 |
| POST | `/manager/ingest/:id/correct` | 追加修正事件（不修改历史），记录 correction_of 与审计 |
| GET | `/manager/exceptions` | 异常列表 |
| POST | `/manager/exceptions/:id/resolve` | 标记异常已处理 |
| GET | `/manager/notifications` | 站内消息 |
| POST | `/manager/notifications/read` | 全部或指定已读 `{ ids? }` |
| GET | `/manager/staff` | 门店人员库（只读） |
| GET | `/manager/sim/status` | 模拟器状态 |
| POST | `/manager/sim/advance` | 推进模拟 `{ minutes: 1..240 }` |

### `/manager/ops` 指令

```jsonc
{ "type": "join_queue", "partySize": 3 }
{ "type": "abandon_queue", "queueId": "..." }          // 省略则移除最近一组
{ "type": "call_next", "callNo": 39 }                   // 省略则自动 +1
{ "type": "seat", "queueId": "...", "tableId": "..." }  // tableId 可省略自动选桌
{ "type": "checkout", "tableId": "..." }
{ "type": "leave",    "tableId": "..." }
{ "type": "clean",    "tableId": "..." }
{ "type": "set_on_duty", "onDutyStaff": 4 }
```

状态校验：只有 `dining` 能结账；`checkout` 才能离店；`cleaning`（或已结账直接清台）才能完成清台。返回 `{ ...result, today }`。

---

## 兼职（staff）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/staff/me` | 资料、可用时间、待回应邀约数、待执行班次 |
| PATCH | `/staff/me` | 修改资料 `{ nickname, area, distanceKm, expectedRate, experienceYears, skills, bio? }` |
| PUT | `/staff/me/availability` | 覆盖可用时间 `{ windows: [{ weekday, startMin, endMin }] }` |
| GET | `/staff/offers` | 邀约列表（含门店、时间、报酬、超时时间） |
| POST | `/staff/offers/:id/accept` | 接受邀约（CAS，仅一次成功） |
| POST | `/staff/offers/:id/reject` | 拒绝 `{ reason? }`，自动顺延 |
| GET | `/staff/shifts` | 班次与统计 |
| POST | `/staff/shifts/:id/checkin` | 签到 `{ storeCode, lat?, lng? }` |
| POST | `/staff/shifts/:id/cancel` | 本人在开始前取消已确认班次 `{ reason }`；触发自动候补/异常 |
| POST | `/staff/shifts/:id/checkout` | 签退并计算实际工时/报酬 |
| GET | `/staff/notifications` | 站内消息 |
| POST | `/staff/notifications/read` | 全部已读 |

可用时间 `startMin/endMin` 为一天内的分钟数（0–1440）；`endMin < startMin` 表示跨午夜，例如 `22:00 → 02:00` 写成 `{ startMin: 1320, endMin: 120 }`。

---

## 管理员（admin）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/admin/overview?storeId=` | 经营总览、最新预测、模拟器、异常、最近班次、日志 |
| GET | `/admin/stores` | 门店列表 |
| GET | `/admin/staff?storeId=` | 人员库 |
| POST | `/admin/staff/:id/review` | 审核 `{ status?, qualified? }`；未培训不可通过 |
| GET | `/admin/shifts?storeId=&status=` | 班次/邀约 |
| GET | `/admin/plans?storeId=` | 调配方案 |
| GET | `/admin/forecasts?storeId=` | 预测历史 |
| GET | `/admin/exceptions?storeId=` | 异常 |
| POST | `/admin/exceptions/:id/resolve` | 处理异常 |
| GET | `/admin/logs?limit=` | 审计日志 |
| GET | `/admin/ingest/status?storeId=` | 摄取状态与陈旧提示 |
| GET | `/admin/ingest/events?storeId=&status=` | 摄取事件（可筛选 error/stale） |
| POST | `/admin/ingest/:id/replay` | 重放异常事件；追加新记录并保留原记录 |
| POST | `/admin/stores/:id/webhook-secret` | 轮换 Webhook 密钥；仅返回一次 |
| GET | `/admin/ai-usage?storeId=` | 模型、tokens、延迟、估算成本、预算与缓存命中 |
| GET | `/admin/stores/:id/service-calibrations` | 服务分钟模型真实样本校准记录 |
| POST | `/admin/stores/:id/service-calibration` | 提交 ≥30 个真实样本/证据后校准参数；不得用模拟数据 |
| POST | `/admin/stores/:id/service-calibration/analyze` | 仅做描述性 MAE/偏差分析，不改变校准状态 |
| POST | `/admin/stores/:id/data/import` | 导入 CSV/XLSX 经营观察；必须声明 `REAL`/`SIMULATED` |
| GET | `/admin/stores/:id/data/imports` | 导入批次与质量摘要 |
| GET | `/admin/data/imports/:id/quality` | 单批次质量报告 |
| POST | `/admin/stores/:id/data/replay` | 历史回放 `{ importId }`；运行 4 个模型变体 |
| GET | `/admin/stores/:id/data/replays?importId=` | 回放运行与指标 |
| POST | `/admin/stores/:id/pilot/feedback` | 内部人员代录店长线下反馈 |
| POST | `/admin/users/:id/revoke-sessions` | 强制撤销用户全部会话 |
| GET | `/admin/sim/status?storeId=` | 模拟器状态 |
| POST | `/admin/sim/control` | `{ storeId?, running?, speed? }`，speed 1–600 |
| POST | `/admin/sim/advance` | `{ storeId?, minutes: 1..240 }` |

---

## 主要数据结构（节选）

`TodayView`：

```jsonc
{
  "store": { "name": "...", "managerCode": "K001", "jobType": "烤肉辅助" },
  "now": 1793008800000,
  "businessDate": "2026-10-26",
  "businessDay": { "status": "confirmed", "onDutyStaff": 3, "latestCallNo": 38 },
  "queue": { "groups": 14, "customers": 57, "latestCallNo": 38, "entries": [] },
  "tables": {
    "total": 24,
    "occupied": 21,
    "byType": [{ "type": "small", "total": 8, "available": 1, "dining": 5, "checkout": 1, "cleaning": 1 }],
    "list": [{ "label": "S1", "status": "dining", "elapsedMin": 56 }]
  },
  "forecast": { "gap": 5, "requiredStaff": 8, "reliability": "high", "bottleneck": "staff" },
  "proposedPlans": 2
}
```

`Forecast` 核心字段：

```jsonc
{
  "id": "fc_...",
  "horizonStart": 1793010600000,
  "slots": [{
    "label": "18:30-19:00",
    "projectedOccupied": { "small": 8, "medium": 12, "large": 4 },
    "projectedQueueGroups": 12,
    "projectedActiveTables": 24,
    "weightedLoad": 34.2,
    "requiredStaff": 8,
    "onDutyStaff": 3,
    "gap": 5,
    "bottleneck": "staff"
  }],
  "peakGap": 5,
  "gapRanges": [{ "startAt": 1793010600000, "endAt": 1793021400000, "headcount": 5 }],
  "aiStatus": "ok",
  "ai": { "summary": "...", "riskLevel": "high", "recommendations": [] }
}
```

`PlanItem`：

```jsonc
{
  "staffId": "staff_...",
  "nickname": "林小雨",
  "startAt": 1793010600000,
  "endAt": 1793021400000,
  "hourlyRate": 30,
  "estimatedCost": 90,
  "distanceKm": 0.6,
  "arriveAt": 1793009700000,
  "reason": "可用时间覆盖，距门店 0.6km（约 5 分钟到店）…",
  "alternatives": [{ "staffId": "staff_...", "nickname": "周佳怡", "hourlyRate": 34 }]
}
```

---

## 错误码（节选）

| HTTP | code | 场景 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Zod 校验失败 |
| 401 | `UNAUTHORIZED` | 未登录/过期 |
| 403 | `FORBIDDEN` | 角色或归属不匹配 |
| 404 | `ROUTE_NOT_FOUND` / `*_NOT_FOUND` | 资源不存在 |
| 409 | `CONFLICT` / `NO_CANDIDATE` / `BAD_TABLE_STATE` | 状态机冲突、重复接单、无候选 |
| 409 | `NOT_TRAINED` | 未培训就尝试通过审核 |
| 422 | `UNPROCESSABLE` | 业务不可执行 |
| 500 | `INTERNAL_ERROR` | 未捕获异常（已写日志与堆栈） |


---

## R2 事件摄取（Webhook）

`POST /api/ingest/webhook/:storeCode`，无需登录但不接受匿名业务写入。请求头：

```text
content-type: application/json
x-signature: sha256=<hex hmac>
```

签名：`HMAC-SHA256(rawBody, store.webhook_secret)`。密钥由管理员通过 `/api/admin/stores/:id/webhook-secret` 生成，数据库保存后可再次读取用于校验；界面只展示一次。未配置密钥返回 `503 WEBHOOK_NOT_CONFIGURED`，签名错误返回 `401 SIGNATURE_INVALID`。

单条事件：

```json
{
  "externalId": "pos-evt-1001",
  "type": "checkout",
  "occurredAt": 1793008800000,
  "tableLabel": "S1"
}
```

支持类型：`queue_join`、`queue_call`、`queue_abandon`、`seat`、`checkout`、`leave`、`clean`、`clean_done`、`table_status`、`staff_checkin`、`staff_checkout`。`table_status` 需 `tableStatus=available|checkout|cleaning`；`dining` 外部同步会被拒绝。支持 `events: [...]` 批量。

语义保证：

- `(store_id, source, external_id)` 唯一，重复请求返回 `duplicate`，不重复改状态；
- 早于最近已应用事件 5 分钟以上的事件标记 `stale`，保留记录但不应用；
- 事件时间超前门店时钟 10 分钟以上拒绝；
- 应用失败写入 `error` 并创建 `ingest_error` 异常，可由管理员重放；
- 修正/重放追加新事件，原事件保留（`correction_of`），不提供修改历史事件的接口；
- 无 POS 时使用 `manual`/`simulator` 适配器，不声称已接入真实 POS。

> 适配器契约：`GET /api/ingest/adapters` 返回 `generic` 能力清单。具体厂商 adapter 必须先有 API 文档、签名/测试凭据，未接入前状态为 BLOCKED，不冒充成功。
>
> `simulator` 是内置确定性适配器，事件也会写入同一 `event_ingest` 账本；其内部状态转换与摄取记录在同一同步路径完成，不经过外部签名校验。

---

## R2 服务模式与预测模型

`StoreConfig.staffing` 新增：

```jsonc
{
  "capacityModel": "legacy",                 // legacy | service_minutes
  "capacityBasis": "standard_equivalent",    // standard_equivalent | physical_tables
  "serviceMode": "partial",                  // full | partial | self
  "serviceMinutes": { "small": 14, "medium": 26, "large": 44 },
  "effectiveServiceMinutesPerSlot": 24,
  "calibrationStatus": "unverified"          // unverified | calibrated
}
```

- `legacy + standard_equivalent`：保留 R1 加权桌当量基线；`legacy + physical_tables` 改按真实桌数，避免把“桌数”误读为标准当量。
- `service_minutes`：按桌型服务分钟、服务模式强度、叫号、结清/清台、有效工作分钟与峰值 buffer 计算；输出 `workloadMinutes` 与 `capacityMinutes`。
- 未校准的分钟模型可靠性被降级并返回 `modelWarning`；不得把模拟参数称为真实门店校准。
- 只有管理员通过 `/admin/stores/:id/service-calibration` 提交真实样本、证据说明与参数后，才允许 `calibrationStatus=calibrated`；店长配置接口会校验当前参数与校准证据一致，模型回退 `legacy` 或无证据时返回 `CALIBRATION_EVIDENCE_REQUIRED`。

---

## R2 AI 用量与预算

`/manager/forecast` 与 `/manager/plans` 的响应新增 `aiCached`、`model`、`capacityBasis`、`serviceMode`、`calibrationStatus`、`modelWarning`。AI 调用记录在 `ai_usage`：

- 模型名、prompt/completion/total tokens、延迟、估算成本、成本口径、状态、错误码、缓存命中；
- 同一经营事实 + 模型在 `DEEPSEEK_CACHE_TTL_MINUTES` 内复用缓存，避免重复推理；
- 单店日预算与全平台 30 日预算由环境变量配置；超预算返回确定性降级并记录 `budget_blocked`；
- 未配置 Key 返回 `AI_NOT_CONFIGURED`，不调用、不伪造成功；
- 上游错误只返回稳定错误码（`AI_AUTH_FAILED` / `AI_TIMEOUT` / `AI_UPSTREAM_ERROR` / `AI_RESPONSE_INVALID`），详细信息只写服务端日志。

## R2 鉴权与安全

- 演示登录默认关闭；仅在 `NODE_ENV !== production` 且 `ALLOW_DEMO_LOGIN=true`、请求来自回环地址时可用。
- 生产启动校验：禁止演示登录、禁止弱/默认管理员密码、禁止通配 CORS、强制 HTTPS（反代需 `TRUST_PROXY`）。
- 管理员登录 5 次/15 分钟；敏感管理员操作要求 15 分钟内重新登录。
- Access Token 默认 120 分钟，Refresh Token 30 天；服务端只保存 token 哈希。
- 微信登录未配置 AppID/Secret 时返回 `503 WECHAT_NOT_CONFIGURED`；短信未配置返回 `503 SMS_NOT_CONFIGURED`。


---

## R3 试点模式、影子模式与紧急停止

`StoreConfig.pilot`：

```jsonc
{ "shadowMode": true }
```

- `shadowMode=true`：`/manager/plans/:id/confirm` 只记录 `shadow_runs` 与推荐人员，返回 `{ shadow:true, offersCreated:0, shifts:[], shadowRunId }`；不创建 `job_offers`/`shifts`/`staffing_demands`，不通知兼职，不产生费用。
- 影子模式与真实邀约完全隔离：同一方案不会既写影子又发邀约。
- `pilot_controls` 独立于门店配置；`pause` 立即停止新确认与自动候补，并取消待回复邀约；已确认班次保留。
- 店长反馈与操作指标写入 `pilot_feedback` / `pilot_ux_metrics`；管理员/店长可计算 MAE 与偏差。
- 当前外部门店数据/POS/微信等仍为 BLOCKED，不因影子模式测试通过而升级为生产。

---

## R3 密钥与限流

- `SECRET_ENCRYPTION_KEY`：32 字节 hex/base64；生产必填；Webhook Secret 使用 AES-256-GCM 加密存储。开发无环境变量时使用 `data/.secret-key`（0600，gitignore）。
- Webhook 密钥轮换：`POST /api/admin/stores/:id/webhook-secret`，返回一次明文；旧签名立即失效。
- `RATE_LIMIT_BACKEND=db`（默认）：共享 `rate_limit_buckets` 表；`memory` 仅单进程开发。
- 生产启动检查拒绝缺 Key、演示登录、弱管理员密码、通配 CORS 与非 HTTPS。


---

## R4 影子数据导入与历史回放

### 导入

`POST /api/admin/stores/:id/data/import`（管理员近期登录）

```jsonc
{
  "filename": "2026-10-26.csv",
  "format": "csv",              // csv | xlsx
  "content": "...",             // CSV 原始文本
  "contentBase64": "...",       // 或 XLSX base64（二选一）
  "dataOrigin": "SIMULATED"     // REAL | SIMULATED，必须显式声明
}
```

CSV/XLSX 表头至少包含：`store_code, business_date, table_type, party_size, seat_at, leave_at（数值标签另有 `manager_required`）`。可选：`queue_at, checkout_at, clean_at, on_duty_staff, service_mode, actual_work_minutes, manager_sufficiency`。支持中文表头别名。

质量结果写 `data_imports.quality_json` 与 `import_observations`：

- `valid/invalid/duplicate`；
- 缺失字段计数；
- 时间顺序异常；
- 重复键：门店+日期+桌型+入座时间+人数；
- 不插值、不伪造缺失测量。

### 回放

`POST /api/admin/stores/:id/data/replay` `{ "importId": "..." }`

- 从最早入座后下一个 30 分钟开始，每 30 分钟预测未来 3 小时；
- 输入快照只含截至预测时点已发生的桌台/排队/在岗；
- 未来观测只写 `actual_json`；
- 运行 A/B/C1/C2：legacy partial、minutes partial、minutes full、minutes self；
- 输出 MAE、偏差、过度/不足人时、高峰缺人、桌型表现、平均提前量、数据质量；
- 只支持 SIMULATED 或已授权 REAL；不会自动改 `calibrationStatus`。

### 店长反馈

`decision`：`accepted | too_many | too_few | timing | no_candidates | other`；可附 `reasons`、`correction`、`noShow`。内部人员可通过管理员接口代录，店长不必进入未批准的生产系统。

### 影子标识

- `assignment_plans.shadow=1`；
- `shadow_runs` 独立记录；
- 影子确认返回 `{ shadow:true, offersCreated:0, shifts:[], shadowRunId }`；
- 不创建 `job_offers/shifts/staffing_demands/notifications`，无支付路径。


---

## R5 首店影子试点

### 试点档案

- `POST /api/admin/stores/:id/pilots` `{ anonymousCode, serviceMode, hoursStart, hoursEnd, tableConfig?, staffing?, roles?, dataSources?, coverageStart?, coverageEnd?, owner?, startDate?, endDate? }`
- `GET /api/admin/stores/:id/pilots`
- `GET /api/admin/pilots/:id`
- `PATCH /api/admin/pilots/:id`
- `POST /api/admin/pilots/:id/authorize` `{ owner?, coverageStart?, coverageEnd? }`

只有 `authorizationStatus=authorized` 才允许导入；否则 `403 PILOT_NOT_AUTHORIZED`。档案/数据行出现手机号/邮箱会被拒绝或标记 invalid。

### 事件与工作量导入

- `POST /api/admin/pilots/:id/events/import` `{ filename, format: csv|xlsx, content|contentBase64, dataOrigin: REAL|SIMULATED }`
- `POST /api/admin/pilots/:id/workload/import` 同上
- `GET /api/admin/pilots/:id/data-quality`
- `GET /api/admin/pilots/:id/workload-analysis`

事件类型：queue_join、queue_call、seat、checkout、leave、clean、staff_checkin、staff_checkout、table_status。  
工作量一行一个动作，`observation_id` 唯一；重复不计分钟；缺失不补写。

### 回放与日报

- `POST /api/admin/pilots/:id/replay` `{ importId? }`：从事件派生的会话运行 4 个模型变体；前 7 天 calibration、后 7 天 validation；不足 14 天 `insufficientData=true`。
- `GET /api/admin/pilots/:id/replays`
- `GET /api/admin/pilots/:id/daily-report?date=YYYY-MM-DD`：AI 建议、实际在岗、店长评价、压力、过度增派可能、反馈。
- `POST /api/admin/stores/:id/pilot/feedback`：内部人员代录店长反馈。
- `POST /api/manager/pilot/feedback`：店长本人录入。

真实数据缺失时返回 `REAL_DATA_PENDING` 或 `SIMULATED_ONLY`。
