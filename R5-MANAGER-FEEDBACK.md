# R5 店长反馈与每日影子报告

> 状态：**REAL_FEEDBACK_PENDING**  
> 当前没有真实店长反馈；不伪造接受率或满意率。

## 1. 每日影子报告接口

`GET /api/admin/pilots/:id/daily-report?date=YYYY-MM-DD`

输出：

- AI 建议人数及时间（关联影子 `shadow_runs`/预测）
- 门店实际在岗人数
- 店长认为是否缺人（`short / adequate / over / unknown`）
- 实际服务压力
- 是否可能过度增派
- 店长修改建议原因
- 数据来源（REAL/SIMULATED）与数据质量
- 无数据时返回 `REAL_DATA_PENDING` / `SIMULATED_ONLY`

本机模拟日 `2026-10-01` 的每日报告返回 `status=SIMULATED_ONLY`、`actualOnDuty=3`；这是模拟数据，不是真实店长结论。

## 2. 反馈录入

店长接口：

`POST /api/manager/pilot/feedback`

内部代录：

`POST /api/admin/stores/:id/pilot/feedback`

字段：

| 字段 | 说明 |
| --- | --- |
| `recommended` | AI 建议人数 |
| `managerActual` | 店长认为需要人数 |
| `onDuty` | 实际在岗 |
| `overloaded` | 是否忙不过来 |
| `noShow` | 缺岗人数 |
| `decision` | accepted / too_many / too_few / timing / no_candidates / other |
| `reasons` | 原因列表 |
| `correction` | 修正意见 |
| `notes` | 补充 |

## 3. 当前反馈

| 指标 | 值 |
| --- | ---: |
| 真实反馈条数 | 0 |
| 店长建议接受率 | 不可计算 |
| 偏多/偏少/时间不合适/无候选 | 不可计算 |
| 真实服务压力 | 未采集 |
| 真实缺岗结果 | 未采集 |

自动化测试只验证反馈结构和查询，不作为真实店长评价。

## 4. 线下操作建议

- 每天生成一页摘要，内部人员打印/微信发给店长；
- 店长只做线下勾选和一句话原因；
- 内部人员代录，不要求店长登录未验收生产系统；
- 每周汇总接受率与 MAE，不惩罚店长判断；
- 涉及个人信息不进入反馈。

## 5. 结论

反馈/日报框架已可用；真实反馈为 0，不能宣称店长接受度或低干扰体验已验证。
