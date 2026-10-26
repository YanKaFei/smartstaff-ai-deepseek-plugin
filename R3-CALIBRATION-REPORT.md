# R3 烤肉店预测校准报告

> 当前状态：**UNCALIBRATED**。  
> 已实现采集模板、描述性误差分析、真实样本校准准入与管理员证据接口；**没有真实门店样本**，因此没有升级为 CALIBRATED，也没有把模拟数据称为校准。

## 1. 现有模型

保留三种服务模式：

| 模式 | 服务强度（分钟模型） | 旧算法容量系数 |
| --- | ---: | ---: |
| 全程代烤 | 1.55 | 0.8 |
| 部分代烤 | 1.00 | 1.0 |
| 自主烤制 | 0.55 | 1.4 |

分钟模型：

```text
attention = Σ occupied[type] × serviceMinutes[type] × intensity × (30 / (avgDining + checkout + clean))
queue     = queueGroups × 2 min
cleaning  = freeingTables × (checkout + clean) × intensity × 0.5
workload  = attention + queue + cleaning
required  = ceil(workload / effectiveMinutesPerSlot × (1 + buffer%))
```

旧算法保留为可比较基线；`capacityBasis` 明确区分物理桌与标准桌当量。

## 2. 现有对比（模拟场景，不是真实校准）

场景：24 桌 / 3 在岗 / 14 组排队 / 7 天历史。证据：`docs/r2-evidence/service-model-comparison.json`。

| 模式 | 峰值需求 | 峰值缺口 | 每 30 分钟需求 |
| --- | ---: | ---: | --- |
| 旧算法·标准桌当量 | 8 | 5 | 8,8,7,8,8,7 |
| 旧算法·物理桌 | 6 | 3 | 6,5,4,5,5,5 |
| 分钟模型·全程 | 18 | 15 | 18,15,11,15,14,15 |
| 分钟模型·部分 | 12 | 9 | 12,10,7,10,9,10 |
| 分钟模型·自主 | 7 | 4 | 7,6,4,6,5,6 |

> 这只是**模拟参数下的模型输出**，不能作为真实门店需求或校准结论。分钟模型部分模式比旧算法高 4 人，说明参数对结果影响很大，必须用真实工时校准。

## 3. 数据采集模板

文件：`docs/R3-SERVICE-CALIBRATION-TEMPLATE.csv`

字段：

| 字段 | 含义 |
| --- | --- |
| `date` | 经营日期（YYYY-MM-DD） |
| `table_type` | small / medium / large |
| `party_size` | 就餐人数 |
| `seated_at`, `left_at` | 开始/结束时间（毫秒或 ISO，导入前统一） |
| `server_interventions` | 服务员实际介入次数 |
| `grill_minutes` | 代烤工作分钟 |
| `serve_minutes` | 上菜分钟 |
| `plate_change_minutes` | 换盘分钟 |
| `checkout_minutes` | 结账分钟 |
| `cleaning_minutes` | 清台分钟 |
| `on_duty_staff` | 同时在岗员工数 |
| `predicted_required` | 系统建议人数 |
| `actual_required` | 店长实际认为需要/实际在岗人数 |
| `overloaded` | 该时段是否忙不过来/缺岗 |
| `notes` | 异常、缺岗、活动等 |

模板只提供表头，不预填伪造样本。

## 4. 分析接口与指标

`POST /api/admin/stores/:id/service-calibration/analyze`（管理员近期登录）

输出：

- `sampleCount`、`distinctDays`、`byTableType`
- `averageServiceMinutes`：样本实际服务分钟均值
- `mae`：`mean(|predicted_required - actual_required|)`
- `bias`：`mean(predicted_required - actual_required)`；正=高估，负=低估
- `understaffedSamples`：`actual > predicted`
- `overloadedSamples`
- `eligibility`：≥30 样本、三种桌型各≥5、≥7 天
- `autoCalibrate: false`、`status: UNCALIBRATED`

**≥30 只是最低门槛，不代表统计准确性。** 还要检查样本代表性、异常日、活动日、班次偏差、置信区间和人工复核结论。

## 5. 校准准入

只有管理员 `POST /api/admin/stores/:id/service-calibration` 提交：

- ≥30 个真实样本；
- 真实观测证据说明（≥10 字）；
- 参数（服务分钟、模式、有效分钟）；
- 管理员近期登录与审计

才写入 `service_calibrations` 并把 `calibrationStatus` 置为 `calibrated`。店长配置接口若：

- 没有匹配证据；
- 参数变化；
- 把模型改回 `legacy`

都会返回 `CALIBRATION_EVIDENCE_REQUIRED`。因此前端不能自行“宣布已校准”。

## 6. 当前真实样本

- 真实样本数量：**0**
- 真实门店工时：**未采集**
- 真实人工复核：**无**
- 当前状态：**UNCALIBRATED**
- 预测误差/系统偏差/人工复核：**无可报告的真实数值**（不编造）

已有测试使用 35 条合成样本验证分析器能计算 MAE/bias，但报告将其标记为**模拟测试数据**，不进入真实校准。

## 7. 试点采集计划

1. 影子模式运行至少 7 天，每天至少覆盖午/晚市与三种桌型。
2. 记录模板每桌每次服务一行；异常时段单独标记。
3. 第 7 天用分析接口计算 MAE/bias/understaffed；人工复核 10% 原始样本。
4. 若样本≥30、三类桌型≥5、≥7 天且 MAE/偏差可接受，提交管理员校准；否则继续采集。
5. 校准后仍需每周回测；活动日/节假日不得直接套用平日参数。

## 8. 证据

- `docs/R3-SERVICE-CALIBRATION-TEMPLATE.csv`
- `tests/r3-calibration.test.ts`
- `tests/r2-service.test.ts`
- `docs/r2-evidence/service-model-comparison.json`
