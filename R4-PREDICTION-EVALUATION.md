# R4 影子预测评估

> 状态：**ENGINEERING_READY / REAL_PILOT_PENDING**  
> 本轮评估使用 **SIMULATED** 数据，仅验证回放与指标框架；没有真实门店样本，不把模拟结果当作真实模型准确率。

## 1. 回放方法

- 输入：一次导入批次的 `valid` 观测（重复/无效行不参与）。
- 预测时点：从最早入座后下一个 30 分钟开始，每 30 分钟一个点；要求未来 3 小时完整落在数据范围内。
- 每个时点只读取：
  - `seat_at <= t < leave_at` 的桌台；
  - `queue_at <= t < seat_at` 的排队；
  - `seat_at <= t` 的历史入座；
  - 当时可用的在岗人数；
  - `input_snapshot_json` 只保存这些事件的 ID/时间/状态。
- 未来观测只写入 `actual_json`，不进入输入快照。
- 质量检查测试：`tests/r4-import-replay.test.ts` 断言快照中的 `seatedAt/joinedAt <= prediction_time`。

## 2. 模型对比

| 变体 | 模型 | 服务模式 |
| --- | --- | --- |
| A | legacy 标准桌当量 | partial |
| B | service_minutes | partial |
| C1 | service_minutes | full |
| C2 | service_minutes | self |

每个变体写独立 `replay_runs`，预测写 `replay_predictions`。

## 3. 指标定义

- **MAE**：`mean(|recommended - actualRequired|)`
- **平均偏差**：`mean(recommended - actualRequired)`，正=高估，负=低估
- **过度增派总人时**：`Σ max(0, recommended - actualRequired) × 0.5h`
- **人手不足总人时**：`Σ max(0, actualRequired - recommended) × 0.5h`
- **高峰缺人识别**：`actualRequired > recommended` 的预测点数
- **桌型表现**：按该预测点活跃桌型中占比最高者分组
- **预测提前量**：`horizon_start - prediction_time`
- **数据质量**：缺失字段、重复/无效、时间顺序、可靠性

### 实际结果标签

`actualRequired` 不是简单等于实际在岗：

1. 有店长 `manager_sufficiency`（short/adequate/over）时：在岗人数 + 1（short）/ 0 / −1（over）。
2. 无店长评价但有 `actual_work_minutes` 时：按有效服务分钟估算。
3. 两者都没有：标记 `unlabeled`，不计入 MAE。

该标签仍需人工复核，不能把“实际在岗”当作唯一真相。

## 4. SIMULATED 结果

数据：`docs/R4-SIMULATED-IMPORT.csv`（6 个有效行，2 个可评估预测时点）  
证据：`docs/r4-evidence/simulated-replay-evaluation.json`

| 变体 | 评估数 | MAE | 偏差 | 过度人时 | 不足人时 | 高峰缺人 | 提前量 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A legacy/partial | 2 | 2.0 | -2.0 | 0 | 2.0 | 2 | 30 min |
| B minutes/partial | 2 | 1.0 | -1.0 | 0 | 1.0 | 2 | 30 min |
| C1 minutes/full | 2 | 0.0 | 0.0 | 0 | 0 | 0 | 30 min |
| C2 minutes/self | 2 | 2.0 | -2.0 | 0 | 2.0 | 2 | 30 min |

按桌型：仅 small 有 2 个评估点，其他桌型 `count=0`；不能据此得出桌型结论。

## 5. 解读限制

- 只有 **2 个可评估时点**、1 个模拟日、6 行有效数据；不满足统计要求。
- C1 的 0 MAE 是极小样本/标签定义下的结果，**不是模型准确率**，不能升级为 CALIBRATED。
- 旧算法与分钟模型的差异受服务分钟参数影响；参数未用真实工时校准。
- 缺少真实店长人工复核，缺少真实缺岗/服务质量结果。
- 未计算置信区间、显著性、活动日偏差。

## 6. 真实数据缺失分析

| 项目 | 状态 |
| --- | --- |
| 真实样本 | 0 |
| 真实 MAE/偏差 | 不可报告 |
| 真实桌型表现 | 不可报告 |
| 人工复核 | 未执行 |
| 当前校准状态 | UNCALIBRATED |

## 7. 下一步

1. 影子期至少 7 天、覆盖三种桌型与周末。
2. 每 30 分钟保存输入快照与 3 小时实际结果。
3. 对每个预测点由店长线下评价 `short/adequate/over`，内部人员录入。
4. 样本达到最低门槛后先做描述统计与人工复核，再由管理员提交校准证据。
5. 真实模型结论只能在真实样本评估后写入，不能复用本报告的 SIMULATED 表格。
