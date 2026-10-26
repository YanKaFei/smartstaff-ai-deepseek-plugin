# R5 首店影子试点决策

## 决策

# BLOCKED

原因：**REAL_DATA_PENDING**。  
当前只有 SIMULATED 数据；没有真实授权门店数据、真实店长反馈和真实工作量观察，不能进入真实经营影子结论，更不能进入真实派单。

## 工程状态

| 项目 | 状态 |
| --- | --- |
| Pilot 档案/授权 | IMPLEMENTED |
| 事件/工作量采集模板 | IMPLEMENTED（CSV/XLSX） |
| 事件/工作量导入与质量报告 | IMPLEMENTED |
| 14 天切分回放 | IMPLEMENTED |
| 无未来数据泄漏 | IMPLEMENTED + 测试 |
| 四模型指标 | IMPLEMENTED（SIMULATED） |
| 每日影子报告 | IMPLEMENTED |
| 店长反馈分类 | IMPLEMENTED；真实反馈 0 |
| R4 Shadow 隔离 | 保持；无真实邀约/班次/费用 |
| R4 85 项测试 | 全部保留 |
| R5 新增测试 | 2 项（授权/导入、14 天回放） |
| 当前测试 | **87/87** |

## 允许与禁止

允许：

- 用 SIMULATED 数据演练导入、14 天回放、指标和报告；
- 内部人员录入模拟/线下反馈；
- 不发送任何兼职邀约、通知、班次或费用。

禁止：

- 将 SIMULATED 标为 REAL；
- 用模拟结果宣称真实准确率；
- 真实邀约/班次/扣款；
- 绕过授权、身份、用工审核；
- 放宽 R4 Release Gate。

## 进入 CONTINUE_CALIBRATION 的条件

1. 取得门店书面授权与去标识化数据；
2. 有至少 14 天真实事件/工作量数据；
3. 前 7 天校准、后 7 天独立验证；
4. 真实店长反馈 ≥ 每日一条；
5. 数据质量报告无未解释 PII/严重时间错误；
6. 真实 DeepSeek 可选（无 Key 用确定性引擎并标注）。

## 进入 READY_FOR_CONTROLLED_LIVE_REVIEW 的条件

CONTINUE_CALIBRATION 完成后，仍需：

- 真实 MAE/偏差/缺岗/成本经店长与工程评审；
- 真实样本 ≥30 且人工复核；
- 微信/短信/POS/DeepSeek 关键路径验证；
- PostgreSQL/备份/多实例/KMS/审计；
- 影子期无 P0/P1 事故；
- 店长/管理员书面批准。

> `READY_FOR_CONTROLLED_LIVE_REVIEW` 只代表可以开始正式上线审批，不自动允许真实派单。

## 当前结论

**R5 工程工作包可用；真实首店影子试点尚未开始数据采集，决策 BLOCKED。**
