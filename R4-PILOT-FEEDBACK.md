# R4 店长建议评审记录

> 状态：**ENGINEERING_READY / REAL_PILOT_PENDING**  
> 当前没有真实店长反馈；不填充伪造评价。

## 1. 记录方式

接口：

`POST /api/manager/pilot/feedback`（店长）

或 `POST /api/admin/stores/:id/pilot/feedback`（内部测试人员代录）

字段：

| 字段 | 说明 |
| --- | --- |
| `shadowRunId` | 可关联影子建议 |
| `recommended` | AI 建议人数 |
| `managerActual` | 店长认为实际需要人数 |
| `onDuty` | 实际在岗人数 |
| `overloaded` | 是否忙不过来/缺人 |
| `noShow` | 缺岗人数（可选） |
| `decision` | `accepted / too_many / too_few / timing / no_candidates / other` |
| `reasons` | 原因列表 |
| `correction` | 修正意见 |
| `notes` | 补充说明 |

## 2. 决策分类

| decision | 中文 |
| --- | --- |
| accepted | 接受建议 |
| too_many | 认为人数偏多 |
| too_few | 认为人数偏少 |
| timing | 建议时间不合适 |
| no_candidates | 当前没有符合条件的兼职 |
| other | 其他原因 |

## 3. 当前状态

| 项目 | 值 |
| --- | --- |
| 真实店长反馈 | **0 条** |
| 真实影子建议评审 | **0 条** |
| 模拟/自动化测试反馈 | 仅用于验证接口，不作为真实评价 |
| 店长是否进入未批准生产系统 | **否**；只要求线下反馈，由内部人员代录 |

## 4. 评审流程

1. 影子模式每天生成建议，内部人员导出/查看建议摘要。
2. 店长在纸面/微信线下评审，不强制登录生产系统。
3. 内部测试人员把分类、原因、修正意见录入 `pilot_feedback`。
4. 每周汇总：
   - 接受率、偏多/偏少比例、时间不合适、无候选比例；
   - `recommended` vs `managerActual` 的 MAE/偏差；
   - 与回放预测指标交叉检查。
5. 达到影子期条件后，由管理员/店长人工复核，才讨论真实邀约。

## 5. 结论

评审接口已具备；真实评审数据为 0。R4 不宣称店长接受度或低干扰体验已经真实通过。
