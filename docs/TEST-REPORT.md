> R2 增量测试与证据已更新：见 [`../R2-VALIDATION-REPORT.md`](../R2-VALIDATION-REPORT.md)。当前 66/66 通过。

# SmartStaff AI 1.0 · 测试报告

> R1 真实经营验收追加 8 项测试；当前全套 **37/37 通过**。R1 结果与证据见 [`R1-VALIDATION-REPORT.md`](../R1-VALIDATION-REPORT.md)。

- 日期：2026-10-26 01:20 CST
- 环境：macOS 15.7 / Node.js v24.19.0 / npm 11.17.0 / TypeScript 5.6.3 / uni-app 编译器 5.33（Vue 3）
- 数据库：Node 内置 `node:sqlite`（测试使用 `:memory:`，每项独立 seed）
- 测试框架：`node:test` + `tsx`，无外部测试依赖
- 执行命令：`cd SmartStaff-AI && npm test`
- 原始输出：[`test-output.txt`](test-output.txt)

## 1. 结果汇总

| 指标 | 结果 |
| --- | --- |
| 测试文件 | 4（capacity / matching / ai / flow+simulator） |
| 用例总数 | **29** |
| 通过 | **29** |
| 失败 | **0** |
| 跳过 | 0 |
| 总耗时 | 约 5.4 s（含 14 次独立内存库 seed 与 HTTP 集成） |
| 服务端编译 | ✅ `tsc -p apps/server/tsconfig.json` 退出码 0 |
| H5 构建 | ✅ `uni build` → `dist/build/h5` |
| 微信小程序构建 | ✅ `uni build -p mp-weixin` → `dist/build/mp-weixin` |
| H5/后台 UI 冒烟 | ✅ 无头 Chrome 走通，控制台 0 错误 |

## 2. 用例清单

### 2.1 容量预测引擎（5）

| # | 用例 | 验证点 |
| --- | --- | --- |
| 1 | sufficient staff produces no gap | 在岗充足时 `peakGap=0`、无增派时段 |
| 2 | understaffed full house yields contiguous gap | 缺口 > 0、人员瓶颈、连续时段合并为单一可执行班次 |
| 3 | queue pressure with enough staff → table bottleneck | 排队增长但人力足够时判定为桌位瓶颈，不机械加人 |
| 4 | checkout does not free a table | 结账后仍需离店 + 清台；预测占用正确 |
| 5 | history raises projected arrivals | 历史数据进入到达率且可靠性升级 |

### 2.2 匹配引擎（6）

| # | 用例 | 验证点 |
| --- | --- | --- |
| 6 | hard filters | 未审核、未培训、时间不覆盖、技能不符、距离超限、班次冲突全部淘汰 |
| 7 | notification & travel time | 通知不足或无法按时到店被淘汰 |
| 8 | overnight windows | 跨午夜可用时间正确覆盖 23:00–01:00 班次 |
| 9 | economic vs guarantee | 经济方案最低成本，保障方案优先准点/经验；成本差异可见 |
| 10 | shortage honest | 需 3 人仅 1 人时输出 `found:1`，不虚构 |
| 11 | no double-booking | 同一人不会进入重叠时段的两个班次 |

### 2.3 AI 层（5）

| # | 用例 | 验证点 |
| --- | --- | --- |
| 12 | no API key | 确定性摘要与建议可用 |
| 13 | valid DeepSeek JSON | 使用 `deepseek-flash`、`response_format=json_object`；AI 返回的 `headcount=99` 被忽略，人数/时段仍取引擎值 |
| 14 | malformed / HTTP 500 / network | 三种失败全部降级，不抛 500 |
| 15 | schema rejects invented ranges | `slotIndex=9`、非法 `riskLevel` 被 Zod 拒绝 |
| 16 | AI outage end-to-end | 配置错误 Key 时 `/manager/forecast` 仍 200，`aiStatus=fallback`，缺口与方案链路正常 |

### 2.4 闭环与异常（7）

| # | 用例 | 验证点 |
| --- | --- | --- |
| 17 | end-to-end | 确认营业 → 预测 → 双方案 → 确认 → 邀约 → 接单 → 签到 → 加速 60 分钟 → 签退 → 店长确认；工时/报酬/审计/预测刷新全部落库 |
| 18 | rejection fallback | 拒绝后同一班次自动换人，`attempt≥2`，不产生错误异常 |
| 19 | expiry fallback | 模拟时间推进 11 分钟，过期邀约自动顺延，新邀约 pending |
| 20 | no candidate | 其他候选全部暂停后拒单：班次取消 + `no_candidate` 异常 + 店长通知 |
| 21 | concurrent accept | 同一邀约两个并发接受，结果严格为 `[200, 409]`；同人重叠派单被拒 |
| 22 | replacement | 方案内替换候选人成功；不存在的人员返回 404；确认后邀约正常发出 |
| 23 | shortage plan | 全员暂停时方案 0 人、缺口明确，确认返回 409 |

### 2.5 权限、审核与门店（3）

| # | 用例 | 验证点 |
| --- | --- | --- |
| 24 | security | 兼职访问店长接口 403、店长访问后台 403、未登录 401、错误管理员密码 401、非法配置 400、跨用户操作他人邀约 403 |
| 25 | staff review | 未培训审核通过返回 409；标记培训合格后才可通过 |
| 26 | new store isolation | 创建 K900 → 保存配置 → 完成引导；`/manager/today` 返回新门店且队列为 0，看不到 K001 数据 |

### 2.6 模拟器与种子（3）

| # | 用例 | 验证点 |
| --- | --- | --- |
| 27 | 7-day history | 7 个 closed 营业日，>300 次历史入座、>300 次叫号、>1000 条事件 |
| 28 | simulation writes state | 推进 60 分钟产生入座/结账/离店/清台/叫号；预测按 30 分钟自动生成；不存在 `occurred_at > forecast.generated_at` 的未来事件泄露 |
| 29 | sim API validation | 0 分钟被 400 拒绝；15 分钟返回时钟与经营数据 |

## 3. 构建与运行验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 服务端类型检查/编译 | `npm --prefix apps/server run build` | 通过，产物 `apps/server/dist` |
| H5 | `npm --prefix apps/miniapp run build:h5` | 通过，产物 `apps/miniapp/dist/build/h5`（base `/app/`） |
| 微信小程序 | `npm --prefix apps/miniapp run build:mp-weixin` | 通过，产物含 `app.json`、`project.config.json`（`urlCheck:false`，`touristappid`） |
| API 健康检查 | `GET /health` | `200 {"ok":true}` |
| H5 托管 | `GET /app/` | 200，资源 `/app/assets/*` |
| 管理后台 | `GET /admin/` | 200，登录后数据接口正常 |

### UI 冒烟（无头 Chrome + Playwright Core）

在 390×844（小程序视口）与 1440×960（后台）下实际点击验证：

1. 店长 `K001` 登录 → 首页数据正确（3 人 / 14 组 / 38 号 / 24 桌）；
2. 确认今日营业；
3. 生成预测 + 双方案（经济 ¥450 / 保障 ¥510，缺口 5 人）；
4. 确认方案 → 5 条待接受邀约；
5. 兼职 `13800000001` 登录 → 接受邀约 → 班次确认；
6. 到店签到（签到码 K001）成功；
7. 后台登录 → 概览 / 模拟器 +30 分钟 → 新预测；
8. 后台人员审核页正常展示待审核人员。

控制台：**0 个错误**（已关闭 uni 统计与补齐 favicon）。截图见 [`screenshots/`](screenshots/)。

## 4. 未在本环境验证 / 已知限制

| 项 | 说明 |
| --- | --- |
| 真实 DeepSeek 网络调用 | 当前环境未提供 `DEEPSEEK_API_KEY`；已用 mock 验证请求体、`deepseek-flash`、JSON 校验与全部失败模式。配置真实 Key 即可启用 |
| 微信开发者工具导入 | 已生成可导入工程并校验 `app.json`/`project.config.json`；本环境无法启动微信开发者工具，需人工导入确认 |
| 微信登录/订阅消息 | 1.0 使用门店编码 + 手机号演示登录；`wx.login` 与订阅消息仅有预留接口（`domain/wechat.ts`） |
| 真机定位签到 | 支持可选经纬度校验；演示使用门店签到码 + 可选扫码 |
| 支付/结算 | 明确不包含真实支付、扣款、分账 |
| PostgreSQL | 当前 SQLite 单进程；DDL 与查询保持可迁移风格，上线前需迁移与压测 |
| 并发规模 | CAS + `BEGIN IMMEDIATE` 覆盖单节点；多实例需外部数据库与分布式锁/唯一约束策略 |
| 劳动合同/保险/个人信息 | 商用前需另行落实 |

## 5. 验收判定

| 验收场景 | 判定 | 证据 |
| --- | --- | --- |
| 创建烤肉店 → 首次配置 → 次日恢复 → 确认营业 | 通过 | 用例 26 + H5 流程 + `store_config` 持久化 |
| 模拟器产生叫号/入座/结账/离店/清台 | 通过 | 用例 27、28 |
| 未来 3 小时人力缺口 | 通过 | 用例 1–5，API 返回 6 个时段 |
| DeepSeek 解释建议 | 通过（mock + 降级） | 用例 12–16 |
| 自动匹配 + 双方案 | 通过 | 用例 9–11、22 |
| 店长确认 → 兼职接单 → 签到 → 完工 | 通过 | 用例 17 |
| 无可用兼职 | 通过 | 用例 20、23 |
| 多人抢单 | 通过 | 用例 21 |
| 拒单自动顺延 | 通过 | 用例 18、19 |
| API 失败降级 | 通过 | 用例 16 |
| 权限与门店隔离 | 通过 | 用例 24、26 |
| 小程序工程可导入 | 构建通过，待人工在微信开发者工具确认 | `dist/build/mp-weixin` |

**结论：29/29 自动化测试通过，构建通过，核心 UI 流程无错误；1.0 业务闭环可演示。**
