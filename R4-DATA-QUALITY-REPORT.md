# R4 数据质量报告

> 状态：**SIMULATED framework verified；REAL data pending**。没有真实门店数据，未伪造测量结果。

## 1. 导入格式

| 格式 | 支持 | 说明 |
| --- | --- | --- |
| CSV | 是 | RFC4180 风格引号/逗号/CRLF/BOM；UTF-8 |
| XLSX | 是（基础） | OOXML 第一个 worksheet；字符串/数字；无公式/样式/合并单元格 |

API：`POST /api/admin/stores/:id/data/import`  
字段（CSV 表头或 XLSX 第一行）：

`store_code, business_date, table_type, party_size, queue_at, seat_at, checkout_at, leave_at, clean_at, on_duty_staff, service_mode, actual_work_minutes, manager_sufficiency`

也支持中文表头：门店匿名编号、营业日期、桌型、入座人数、叫号时间、入座时间、结账时间、离店时间、清台完成时间、实际在岗员工人数、服务模式、服务员实际工作分钟数、店长评价。

## 2. 校验规则

| 规则 | 处理 |
| --- | --- |
| 必填字段 | `store_code, business_date, table_type, party_size, seat_at, leave_at` 缺失 → invalid |
| 门店匹配 | 门店编码必须等于目标门店 `manager_code`，否则 invalid |
| 时间顺序 | 叫号≤入座≤结账≤离店≤清台；违反 → invalid + `timeOrderIssues` |
| 桌型 | small/medium/large（含中文小桌/中桌/大桌） |
| 服务模式 | full/partial/self（含全程/部分/自主） |
| 在岗人数 | 非负整数；缺失 → invalid |
| 缺失可选值 | queue/checkout/clean/work_minutes/sufficiency 缺失仅计数，不伪造 |
| 重复 | 同门店+日期+桌型+入座时间+人数 → duplicate，不进入回放 |
| 来源 | 导入请求必须显式 `REAL` 或 `SIMULATED`，不根据内容猜测 |

## 3. SIMULATED 实测结果

文件：`docs/R4-SIMULATED-IMPORT.csv`（明确标注为模拟演示，不是真实样本）

证据：`docs/r4-evidence/simulated-import-quality.json`

| 指标 | 结果 |
| --- | ---: |
| 总行数 | 8 |
| 有效 | 6 |
| 重复 | 1 |
| 无效 | 1 |
| 时间顺序异常 | 1 |
| 缺失 queue_at | 1 |
| 桌型覆盖 | small/medium/large |
| 数据来源 | **SIMULATED** |

说明：该批数据只用于验证导入/质量/回放框架，**不能用于真实校准或真实经营结论**。

## 4. 真实数据

- 已取得授权并去标识化的真实数据：**0 份**
- 真实样本：**0**
- 真实缺失率/异常率：**无可报告值**
- 当前状态：**REAL_PILOT_PENDING**

没有把模拟行数、模拟错误率或演示门店数据写成真实数据质量结论。

## 5. 数据安全

- 真实数据导入前必须去标识化：门店匿名编号、无顾客姓名/手机号/支付信息。
- `data_origin=REAL` 仅表示来源声明；仍需人工确认授权和去标识化。
- 导入记录保留原始行号、质量状态与问题列表，便于审计；不自动改写原始值。
- 当前导入由管理员近期登录执行；没有公开上传入口。

## 6. 已知限制

- XLSX 解析器是基础实现，不支持公式、样式日期推断、合并单元格、多 sheet 选择；生产接入具体 POS 导出时需补 fixture 和映射。
- CSV 以逗号分隔；分号/制表符需先转换。
- Excel 日期/时间建议使用文本 `YYYY-MM-DD` / `HH:MM`，避免样式歧义。
- 缺失值不会插值；回放时缺失字段会降低质量标记。
