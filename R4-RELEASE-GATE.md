# R4 Release Gate

> 结论：**ENGINEERING_READY / REAL_PILOT_PENDING**  
> 不是“真实试点通过”，也不是“生产可用”。

## 1. 版本基线

| 项目 | 值 |
| --- | --- |
| R3 基线提交 | `1e94563d1ff4e9032d53311a19f9af534f73025a` |
| R3 基线标签 | `r3-baseline` |
| R4 标签 | `r4-engineering-ready`（本地；无远程推送） |
| 远程推送 | 未执行 |
| Node/npm | v24.19.0 / 11.17.0 |
| Schema | v11 |
| 测试 | R3 82 项 + R4 3 项 = **85 项** |

## 2. R4 功能 Gate

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Git 基线/标签/敏感文件检查 | **IMPLEMENTED** | `.env`、DB、备份、日志、密钥未入库 |
| Shadow 后端隔离 | **IMPLEMENTED** | 0 offers/shifts/demands/notifications/funds |
| 影子数据标识 | **IMPLEMENTED** | `plans.shadow`、`shadow_runs`、API `shadow:true` |
| CSV 导入 | **IMPLEMENTED** | 质量检查、缺失/重复/顺序异常 |
| XLSX 导入 | **IMPLEMENTED（基础）** | 字符串/数字/第一 sheet；无公式/样式 |
| REAL/SIMULATED 区分 | **IMPLEMENTED** | 导入请求显式声明，报告明确 |
| 历史回放/无未来泄漏 | **IMPLEMENTED** | 快照测试；未来只进入 actual |
| A/B/C 模型比较 | **IMPLEMENTED** | legacy + 分钟模型三种模式 |
| MAE/偏差/人时/高峰/桌型/提前量 | **IMPLEMENTED** | 模拟样本已验证框架 |
| 店长反馈分类 | **IMPLEMENTED** | 6 类 decision + reasons + correction |
| 真实数据导入 | **PENDING** | 0 真实样本 |
| 真实预测评估 | **PENDING** | 不报告真实 MAE |
| 真实校准 | **UNCALIBRATED** | 禁止自动升级 |
| 真实 DeepSeek | **BLOCKED** | 无 Key；R3 probe BLOCKED |
| 真实微信/短信/POS | **BLOCKED** | 无凭据/厂商文档 |
| PostgreSQL/多实例/KMS | **BLOCKED** | 方案/计划，未执行 |

## 3. 测试 Gate

```bash
cd apps/server && npm test
```

要求：

- 原 82 项全部通过；
- 新增 R4 import/replay 测试通过；
- 不删除/跳过原测试；
- 构建通过；
- 生产构建扫描仍 PASS。

最终原始输出：`docs/r4-evidence/test-output-r4.txt`。

## 4. 数据 Gate

### 可以进入影子实验

- 使用 `SIMULATED` 数据或已获授权且去标识化的 `REAL` 数据；
- 导入质量报告可见；
- 回放结果明确标注 `SIMULATED`；
- 不发送真实邀约；
- 店长反馈只线下收集，不要求登录生产系统。

### 不能进入真实派单

- 无真实门店数据；
- 无真实校准/人工复核；
- 无真实店长 UAT；
- 真实微信/短信/POS/DeepSeek 未验证；
- 生产安全架构（PG/KMS/多实例/不可变审计）未完成。

## 5. 真实试点准入条件

- [ ] 已获授权的真实数据 ≥7 天，覆盖三桌型/周末；
- [ ] 真实样本 ≥30 且人工复核，不只看数量；
- [ ] 回放 MAE/偏差/缺岗结果经店长与工程共同评审；
- [ ] 真实微信/短信/POS/DeepSeek 至少关键路径真实成功；
- [ ] PostgreSQL/备份恢复/多实例演练；
- [ ] KMS/不可变审计；
- [ ] 影子期无 P0/P1 事故；
- [ ] 店长/管理员书面批准。

未满足前：**只允许影子模式，不允许真实邀约。**

## 6. 最终状态

```text
ENGINEERING_READY
REAL_PILOT_PENDING
```

所有真实外部/真实数据结论保持 BLOCKED/PENDING，未用模拟数据伪造通过。
