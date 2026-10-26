# AI 模型与 API 设置模块报告

> 状态：**AI_SETTINGS_READY / REAL_API_BLOCKED**  
> 未配置真实 DEEPSEEK_API_KEY；不声称真实连接成功。  
> Shadow Mode 保持；AI 设置不触发放单、班次、通知或费用。

## 1. 边界：Harness 与业务 API

- DeepSeek Harness 是开发智能体，其模型由官方 Settings → Models 管理；本模块**不修改** Harness 源码、配置或凭据。
- SmartStaff AI 正式 AI 推理由后端统一 AI Service 直接调用 DeepSeek 官方 API。
- 微信小程序/H5 不直接请求 DeepSeek；管理后台只调用本项目管理接口。
- 第一版只允许 `https://api.deepseek.com`；后端拒绝其他 Base URL（`AI_BASE_URL_NOT_ALLOWED`）。

## 2. 实现内容

### 管理页面

管理后台新增 **系统设置 → AI 模型与 API**：

- 服务提供商：DeepSeek
- API Base URL：只读，默认 `https://api.deepseek.com`
- 默认模型：`deepseek-flash`；可选 `deepseek-v4-pro`
- 请求超时：默认 20 秒（可调 5–60 秒）
- AI 功能启用/停用
- 单店每日预算 / 全平台 30 日预算
- API Key：只写输入框，保存后只显示“已配置”；不可回读
- 连接测试、最后成功时间、当前状态、最近调用与用量

截图：[AI 设置页面](docs/r6-evidence/screenshots/r6-ai-settings-no-key.png)

### 存储与密钥

Schema v16 新增 `ai_settings`：

- `api_key_enc`：AES-256-GCM 加密后的 Key，AAD `smartstaff:ai-api-key:v1`；
- `credential_revoked`：撤销后阻止环境变量 Key 回退；
- 只保存模型、超时、启用、预算、状态时间等非敏感配置；
- Key 不进入前端、localStorage、小程序存储、构建产物、普通日志或审计详情；
- 支持写入、替换、撤销；撤销同时阻断 DB Key 和环境变量 Key。

### 真实连接测试

`POST /api/admin/ai/test` 使用服务端凭据发送真实 HTTPS 请求至：

`POST https://api.deepseek.com/chat/completions`

检查：

- HTTP 状态码（401/403 → `AI_AUTH_FAILED`）
- JSON 解析
- Zod `aiAnalysisSchema` 结构
- `finish_reason = stop`
- 实际响应模型
- input/output/total tokens
- 请求延迟
- 超时 → `AI_TIMEOUT`；无 Key → `AI_NOT_CONFIGURED`；未通过结构 → `AI_RESPONSE_INVALID`

只有真实成功并通过结构校验才显示“连接成功”。Mock 仅用于失败分支测试，不用于真实成功声明。

### 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/admin/ai/settings` | 安全配置摘要（无 Key） |
| PUT | `/api/admin/ai/settings` | 保存非敏感配置 |
| PUT | `/api/admin/ai/credential` | 加密保存/替换 Key |
| DELETE | `/api/admin/ai/credential` | 撤销 Key（含环境变量回退） |
| POST | `/api/admin/ai/test` | 真实连接测试 |
| GET | `/api/admin/ai/status` | 当前状态/最近成功/`realApiBlocked` |
| GET | `/api/admin/ai/usage?storeId=` | 次数、成功率、延迟、tokens、费用、预算、最近调用 |
| GET | `/api/admin/ai-usage` | 旧接口兼容保留 |

所有修改/凭据/测试接口要求管理员权限和最近登录复验；审计记录操作人、动作、状态、延迟，不记录 Key。

## 3. 与业务 AI 的对接

业务流程保持：

`门店数据 → 确定性预测引擎 → 统一 AI Service → 结构化经营分析 → 店长端`

- `generateForecast` 通过 `resolveAiRuntime(db, cfg)` 在请求开始时解析一次配置；
- 在用请求使用旧快照，下一次请求才使用新配置；
- 模型、预算、启用开关、Key 从同一运行时快照读取；
- AI 失败/停用/预算超限时返回确定性分析，不中断店长调配；
- 人力需求数值仍由确定性引擎控制；DeepSeek 只解释。

## 4. 用量与计价

页面显示：

- 当前模型
- 调用次数、成功率、平均响应时间
- input/output tokens
- 估算费用
- 最近失败原因
- 单店每日预算 / 全平台 30 日预算

计价标注：

- 规则：配置的 input/output 每百万 token 单价；
- 金额为**估算**，不是供应商账单；
- `DEEPSEEK_PRICE_UPDATED_AT` 未配置时显示“未标注更新日期”；
- 预算用尽时阻止非必要 AI 请求，确定性预测仍运行。

## 5. 验收结果

| 项目 | 结果 |
| --- | --- |
| 总测试 | **105/105** |
| 原 R5.2 基线 | 95/95 全部保留 |
| 新增 AI 测试 | 10 项 |
| 无 Key 状态 | PASS（NOT_CONFIGURED / REAL_API_BLOCKED） |
| 保存/替换/撤销 Key | PASS（加密、不可回读、审计） |
| 非管理员访问 | PASS（403） |
| 401/超时/非法 JSON/结构失败 | PASS（Mock） |
| 配置停用后确定性引擎 | PASS |
| 预算/用量 | PASS（旧 R2 预算测试 + 新统计接口） |
| 真实 API 成功 | **REAL_API_BLOCKED（无真实 Key）** |
| 生产构建扫描 | PASS（0 findings / 0 env leaks） |
| Shadow 隔离 | PASS（无邀约/班次/通知/费用） |

证据：

- [test-output-r6.txt](docs/r6-evidence/test-output-r6.txt)
- [admin-ai-browser.json](docs/r6-evidence/admin-ai-browser.json)
- [production-audit-r6.json](docs/r6-evidence/production-audit-r6.json)

## 6. 已知限制

- 无真实 DeepSeek Key，无法完成真实 HTTPS 成功验收；当前必须标记 `REAL_API_BLOCKED`。
- 管理后台只支持官方地址；自定义网关未实现，未来需地址白名单与安全评审。
- 预算/价格是配置估算；未接供应商账单对账。
- `deepseek-v4-pro` 是否对当前账号开放由真实测试决定；未验证前不宣称可用。
- 环境变量 Key 只能通过本页面撤销标记阻断，不能删除部署环境变量本身。

## 7. 手动验收

1. 打开 `/admin/`，进入「系统设置 → AI 模型与 API」。
2. 未配置 Key 应显示“未配置”，点击测试应明确提示 `REAL_API_BLOCKED`。
3. 输入真实 Key 保存，确认页面只显示“已配置”，网络响应不含 Key。
4. 点击测试：只有真实成功且结构校验通过才显示“连接成功”；401/超时/结构错误显示明确失败。
5. 检查审计日志，确认无 Key/Authorization。
6. 撤销 Key 后再次测试应为未配置/已撤销。
7. 确认没有真实邀约、班次、通知或费用产生。
