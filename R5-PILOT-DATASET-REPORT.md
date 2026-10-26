# R5 首店影子试点数据集报告

> 状态：**REAL_DATA_PENDING / SIMULATED_ONLY**  
> 当前只有明确标注的模拟数据；没有真实授权门店数据，不能作为真实试点结论。

## 1. 基线

| 项目 | 值 |
| --- | --- |
| R4 标签 | `r4-engineering-ready` |
| R4 测试 | 85/85 |
| R5 新增测试 | 2（试点授权/导入、14 天回放与快照隔离） |
| 当前测试 | 87/87 |
| Git | 本地仓库，无远程推送；R5 变更见工作区/后续提交 |

## 2. Pilot 档案

档案字段（`pilot_profiles`）：

- Pilot ID / 匿名门店编号
- 门店桌型配置
- 烤肉服务模式
- 营业时间
- 员工排班/岗位职责
- 数据来源及覆盖日期
- 数据授权状态
- 试点负责人
- 试点开始/结束日期

API：

- `POST /api/admin/stores/:id/pilots`
- `GET /api/admin/stores/:id/pilots`
- `POST /api/admin/pilots/:id/authorize`
- `PATCH /api/admin/pilots/:id`

只有 `authorizationStatus=authorized` 才允许导入；未授权返回 `403 PILOT_NOT_AUTHORIZED`。`owner` 等字段做手机号/邮箱检测，不允许把 PII 写入档案。

本报告模拟档案：`R5-PILOT-001`，服务模式 partial，营业 16:00–02:00，8/12/4 桌，3 人在岗，覆盖 2026-10-01 至 2026-10-14，数据来源 SIMULATED。

## 3. 采集工具

- 经营事件模板：`docs/R5-PILOT-EVENTS-TEMPLATE.csv` / `.xlsx`
- 员工工作量模板：`docs/R5-WORKLOAD-TEMPLATE.csv` / `.xlsx`
- 采集说明：`docs/R5-DATA-COLLECTION-GUIDE.md`

事件类型：queue_join、queue_call、seat、checkout、leave、clean、staff_checkin、staff_checkout、table_status。  
工作量一行一个动作，按 `observation_id` 去重；重复服务动作不会重复计入分钟。

## 4. SIMULATED 导入质量

| 项目 | 结果 |
| --- | ---: |
| 事件行数 | 140 |
| 有效事件 | 140 |
| 无效事件 | 0 |
| 重复事件 | 0 |
| 派生会话 | 28 |
| 工作量观察 | 3 |
| 工作量分钟 | 35 |
| PII 行 | 0 |
| 覆盖天数 | 14 |
| 数据来源 | **SIMULATED** |

事件质量：缺失字段 0；日期 2026-10-01～2026-10-14；事件类型 queue_join/seat/checkout/leave/clean。

证据：`docs/r5-evidence/simulated-pilot-quality.json`

## 5. 真实数据状态

| 项目 | 状态 |
| --- | --- |
| 已授权真实门店数据 | **0** |
| 真实事件行 | 0 |
| 真实工作量观察 | 0 |
| 真实店长反馈 | 0 |
| 真实数据覆盖天数 | 0 |
| 状态 | **REAL_DATA_PENDING** |

没有把 SIMULATED 数据转换为 REAL，也没有用模拟数据填写真实质量结论。

## 6. 样本定义与去重

- 事件以 `event_id` 唯一；
- 工作量以 `observation_id` 唯一；
- 一个服务过程可拆多个动作，但每个动作独立 ID；
- 同一动作重复抄写 → duplicate，不重复计分钟；
- 缺失时间/桌型/人数 → invalid，不补写；
- 店长评价 `short/adequate/over/unknown` 作为人工标签的一部分。

## 7. 现场建议

1. 先由门店负责人确认授权、匿名编号、覆盖日期；
2. 每天导出事件/工作量表，次日导入；
3. 14 天结束后运行 `/api/admin/pilots/:id/replay`；
4. 内部人员录入店长线下反馈；
5. 未经授权不得导入，不发送任何真实邀约。
