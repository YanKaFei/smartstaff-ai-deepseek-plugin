# R5 真实工作量分析

> 状态：**SIMULATED_ONLY / REAL_DATA_PENDING**  
> 当前没有真实员工工作量观察，不能报告真实门店工作负荷。

## 1. 采集字段

`staff_role, service_mode, table_type, action, start_at, end_at, minutes`

一行 = 一个具体动作（迎宾、代烤、上菜、换盘、结账、清台等），不是一整班。

## 2. SIMULATED 分析结果

数据：3 条动作观察，全部为 SIMULATED。

| 指标 | 结果 |
| --- | ---: |
| 有效观察 | 3 |
| 总服务分钟 | 35 |
| 平均每条动作 | 11.67 分钟 |
| 按岗位 | server: 35 |
| 按桌型 | small: 25；medium: 10 |
| 按动作 | greet:1；grill:1；serve:1 |
| 状态 | ENGINEERING_VERIFIED（框架） |

证据：`docs/r5-evidence/simulated-pilot-quality.json` 的 `workload` 字段。

> 这 3 条是模拟数据，不能代表真实门店工作强度，也不能用于校准。

## 3. 真实工作量

| 项目 | 状态 |
| --- | --- |
| 真实观察条数 | 0 |
| 真实总分钟 | 不可报告 |
| 岗位/桌型/动作分布 | 不可报告 |
| 服务员实际介入次数 | 未采集 |
| 代烤工作分钟 | 未采集 |
| 上菜/换盘/清台分钟 | 未采集 |
| 店长人工复核 | 未执行 |

## 4. 缺失与异常规则

- 缺 `minutes` 时不按平均补写；可由 start/end 计算，但计算值标记为派生；
- `end <= start` → invalid；
- 提供 minutes 与时间差相差 >2 分钟 → invalid（避免手工凑数）；
- 手机号/邮箱出现在动作/岗位 → invalid；
- 同一 observation_id 重复 → duplicate。

## 5. 结论

工作量分析框架已可用，但**真实工作负荷数据为 0**。在真实门店采集至少 7 天、覆盖三种桌型和实际服务模式后，才能讨论真实工作量、服务分钟和模型校准。
