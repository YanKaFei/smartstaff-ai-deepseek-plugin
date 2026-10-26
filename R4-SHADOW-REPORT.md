# R4 影子验证报告

> 状态：**ENGINEERING_READY / REAL_PILOT_PENDING**  
> 本轮只建立可重复的影子实验与数据回放；没有真实门店数据，不宣称真实试点通过。

## 1. 版本与仓库基线

| 项目 | 值 |
| --- | --- |
| R3 基线提交 | `1e94563d1ff4e9032d53311a19f9af534f73025a` |
| R3 基线标签 | `r3-baseline` |
| R4 工程标签 | `r4-engineering-ready` |
| 基线测试 | 82/82，`docs/r3-evidence/test-output-r3.txt` |
| Node.js | v24.19.0 |
| npm | 11.17.0 |
| Schema | v11（R4 数据导入/回放） |
| 远程推送 | 未执行；未配置公开远程 |

### Git 敏感文件检查

已检查并加入 `.gitignore`：

- `apps/server/.env`（含本地管理员密码/演示开关）
- `apps/server/data/`（SQLite、WAL/SHM、`.secret-key`）
- `backups/`、`*.db`、`*.sqlite`、`*.db-shm`、`*.db-wal`
- `*.log`、`node_modules/`、`dist/`、`*.pem`、`*.key`

R3 基线提交前用 `git add -n` 检查了待提交列表；`git ls-files` 确认没有 `.env`、数据库、备份或密钥。`.env.example` 只含空占位。

## 2. Shadow Mode 隔离验证

影子确认链路：`POST /manager/plans/:id/confirm` → `confirmPlan` → `shadow_runs`。

后端/事务约束：

| 副作用 | 影子结果 | 证据 |
| --- | --- | --- |
| 真实兼职邀约 `job_offers` | 0 条 | `tests/r3-pilot.test.ts` |
| 待履约班次 `shifts` | 0 条 | 同上 |
| 用工需求 `staffing_demands` | 0 条 | 同上 |
| 人员/店长通知 `notifications` | 0 条（R4 已移除影子内部通知） | 同上 |
| 资金/支付 | 无任何支付代码路径 | 代码无支付模块 |
| 外部调度/Webhook | 不调用 | 影子只写本地 `shadow_runs` + audit |

数据标识：

- `assignment_plans.shadow = 1`
- `shadow_runs` 独立表，含 `plan_id / forecast_id / recommendations_json / total_cost`
- API 返回 `{ shadow: true, offersCreated: 0, shifts: [], shadowRunId }`
- 生产/真实邀约仍要求 `shadow=false`；影子数据不会进入 `shifts/job_offers`。

## 3. 影子流程与操作负担

H5 本机实测（SIMULATED/演示）：

- 首页内联“影子建议”选择 + 记录 = **2 次操作 / 3128 ms**
- 不跳转方案页，不发送邀约
- 证据：`docs/r3-evidence/shadow-browser.json`、`docs/r3-evidence/screenshots/r3-02-shadow-plan.png`

这是本机测量，不是真实门店 UAT。

## 4. R4 新增数据/回放能力

- 影子`shadow_runs`与导入批次/回放运行通过 `data_origin` 明确区分 `REAL`/`SIMULATED`。
- 回放输入快照只存截至预测时点已发生的事件；未来观测只进入 `actual_json`，不进入 `input_snapshot_json`。
- 测试：`tests/r4-import-replay.test.ts` 检查快照无未来 `seatedAt`。
- 导入/回放阶段不改变 `calibrationStatus`，不会自动升级为 CALIBRATED。

## 5. 当前测试

- R3 基线 82 项保留；
- R4 新增 3 项（CSV 质量、XLSX 导入、四模型回放无未来泄漏）；
- R4 新增 3 项后合计 **85/85**；原始输出 `docs/r4-evidence/test-output-r4.txt`。

## 6. 结论

影子模式的**后端隔离成立**；可以用于 SIMULATED/已授权数据的影子实验。真实门店数据尚未导入，真实试点状态保持 `REAL_PILOT_PENDING`。
