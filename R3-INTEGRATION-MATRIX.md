# R3 集成矩阵

> 基线：R2 报告 69/69；R3 当前 82/82（37 R1 + 45 R2/R3）。  
> Git：当前目录不是 Git 仓库，无法给出 commit；本文件不伪造版本号。  
> 未取得外部凭据的模块保持 BLOCKED；Mock/契约测试不冒充真实成功。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| IMPLEMENTED | 代码路径完成，内部行为有测试 |
| MOCK_VERIFIED | 只在 Mock/契约/内存环境验证，不代表真实第三方 |
| REAL_VERIFIED | 使用真实服务、真实凭据、真实数据验证成功 |
| BLOCKED | 缺少凭据/文档/环境/数据，未验证 |
| FAILED | 已验证但结果失败 |

## 1. 模块矩阵

| 模块 | 当前状态 | 已验证内容 | 阻断原因 | 真实连通性测试 | 下一步 |
| --- | --- | --- | --- | --- | --- |
| DeepSeek 解释 | **BLOCKED** | JSON schema、数值不被 AI 覆盖、失败降级、token/usage/成本/缓存/预算代码与 Mock 测试 | 无 `DEEPSEEK_API_KEY`；无法取得真实成功响应 | `scripts/r3-integration-check.ts`（无 Key 直接 BLOCKED） | 本地配置 Key 后重跑；核对 usage/latency/cost/JSON |
| 微信登录 | **BLOCKED** | `code2Session` 调用链、OpenID 绑定、手机号核验、店长授权码；Mock 传输测试 | 无 AppID/AppSecret；无有效 `wx.login` code | 探针仅在配置存在时调用；当前未配置 | 真机 `wx.login` + 合法 code 验证 |
| 短信验证 | **BLOCKED** | 发送/校验接口、未配置 503、限流占位 | 无 SMS Provider/API Key；无厂商 SDK/API 契约 | 无 | 选定服务商，接真实发送与回执 |
| 门店数据（通用 HMAC Webhook） | **MOCK_VERIFIED** | 签名、幂等、陈旧/乱序、修正/重放、适配器契约、表状态更新、并发重复投递 | 无真实 POS/叫号厂商投递 | 内部 signed webhook 测试；非真实 POS | 选定厂商后做字段映射、联调、回放 |
| POS 厂商适配器 | **BLOCKED** | `PosAdapterContract`、`generic` 适配器、能力清单、厂商注册点 | 无厂商 API 文档/测试凭据 | 契约测试 | 按厂商文档实现 adapter + fixture |
| 模拟器 | **MOCK_VERIFIED** | 与真实事件状态机同构的 ops/ingest 账本；事件词表纳入适配器能力 | 不是真实门店数据 | `tests/r3-pos-adapter.test.ts` | 试运营只用于演练/回归 |
| 管理后台 | **IMPLEMENTED** | 审核、异常、数据接入、AI 用量、校准、会话撤销 | 无真实运营人员验收 | 浏览器走查 | 试点店长/管理员培训 |
| 试点控制/影子模式 | **IMPLEMENTED** | 影子确认零邀约/零班次/零费用；暂停取消待回复；恢复；反馈与操作指标 | 需真实门店流程验证 | 自动化 + H5 页面 | 影子期收集反馈 |

## 2. 调用链核对

### DeepSeek
`routes/manager.ts` → `domain/forecast.ts` → `ai/deepseek.ts` → 官方 `/chat/completions`
→ JSON mode → `ai/analysis` schema → `ai_usage`（tokens/latency/cost/cache/budget）→ 失败码降级。
未配置 Key：`AI_NOT_CONFIGURED`，不调用、不伪造。真实成功：**未取得**。

### 微信
`pages/login` → `wx.login` → `POST /auth/wx-login` → `lib/wechat.code2Session` → 官方 `jscode2session`
→ OpenID/手机号/授权码校验 → session tokens。
未配置：`503 WECHAT_NOT_CONFIGURED`。真实登录：**未验证**。

### 短信
`/auth/phone/code` → 未配置返回 `503 SMS_NOT_CONFIGURED`；无厂商发送实现。真实发送：**未验证**。

### 门店数据
`POST /api/ingest/webhook/:code` → HMAC 校验 → `PosAdapter.parse` → `event_ingest`
→ 幂等/顺序/应用 → ops state → exceptions/replay。
真实厂商：**未接入**；通用契约：**MOCK_VERIFIED**。

## 3. 证据

- `docs/r3-evidence/integration-probe.json`
- `docs/r3-evidence/production-audit.json`
- `docs/r3-evidence/test-output-r3.txt`
- R2 真实 DeepSeek 401：`docs/r2-evidence/deepseek-real-request.json`

## 4. 环境密钥要求（不输出值）

```bash
DEEPSEEK_API_KEY=
WECHAT_APPID=
WECHAT_SECRET=
SMS_PROVIDER=
SMS_API_KEY=
SECRET_ENCRYPTION_KEY=   # 32-byte hex/base64，生产必填
```

所有真实密钥只允许在本地/密钥管理系统中配置；不写入报告、日志或前端。
