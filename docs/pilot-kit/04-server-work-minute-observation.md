# 服务员工作分钟观察表

> 一行 = 一个具体服务动作；不是一整班。由试点观察人员填写，不要求店长逐桌录入。

## 字段

| 字段 | 说明 |
| --- | --- |
| pilot_id | 试点编号 |
| store_code | 匿名门店编号 |
| observation_id | 动作唯一 ID（如 D1-S01-001） |
| staff_role | 岗位（server/grill/…） |
| service_mode | full/partial/self |
| table_type | small/medium/large |
| action | 迎宾/代烤/上菜/换盘/结账/清台/其他 |
| start_at / end_at | 开始/结束时间 |
| minutes | 分钟数（可由起止时间计算） |
| business_date | 营业日期 |

模板：`docs/R5-WORKLOAD-TEMPLATE.csv` / `.xlsx`

## 观察方法

- 每个时段选 2–3 桌，覆盖不同桌型；
- 观察员使用手机计时/纸表，不打断服务；
- 同一动作跨桌时分别记录 observation_id；
- 无法确认的分钟留空，不猜；
- 一个服务过程可拆多个动作，但不要重复抄同一动作。

## 最小样本

- 14 天；每天至少 2 个时段；
- 覆盖小/中/大桌；
- 覆盖门店实际使用的服务模式；
- 真实工作量不足时报告写 `INSUFFICIENT_DATA`，不补写。
