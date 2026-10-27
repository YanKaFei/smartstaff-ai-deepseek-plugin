# R7 兼职用户系统与缺位工作流

> 状态：**MARKETPLACE_READY / SIMULATED_DEMO**  
> 真实门店数据、真实兼职邀约、真实班次与费用仍受 Shadow/生产门禁约束；本模块只在管理员/店长明确操作时创建业务班次。

## 1. 兼职账号即用户系统

- 兼职通过手机号首次登录自动创建/绑定账号；管理员审核后成为 `approved`。
- 兼职资料、可用时间、邀约、班次、申请都属于同一个 staff 账号。
- 现有资料/审核/可用时间页面保留；本次新增跨店缺位广场。

当前没有独立的邮箱注册、KYC、找回密码和多租户组织管理；这些仍属于后续用户系统工作。

## 2. 跨店缺位广场

兼职可看到所有门店的开放缺位：

- 门店名称、地址、本店/跨店标识；
- 日期、时间、岗位、时薪、预计报酬；
- 需求人数、剩余缺口；
- 是否可申请及原因；
- 已申请状态。

申请前校验：

- staff 必须 `approved`；
- 目标门店 `requireQualified`；
- 可用时间覆盖；
- 最短通知时间；
- 跨店/本店时间冲突；
- 岗位未满、未重复申请。

## 3. 店长审核

- 店长只能看到本店申请；
- 显示申请人昵称、区域、准时率、完成班次数、备注；
- 拒绝：只更新状态，不创建班次；
- 通过：重新校验硬约束，创建 `confirmed` 班次，写 `demand_id`，调用 `reconcileDemand`；影子模式或已暂停门店会拒绝创建真实班次。
- 满员后关闭缺位，并自动拒绝其他 pending 申请、发送通知；
- 所有操作写审计。

## 4. API

| 方法 | 路径 |
| --- | --- |
| GET | `/api/staff/opportunities` |
| POST | `/api/staff/opportunities/:id/apply` |
| GET | `/api/staff/applications` |
| POST | `/api/staff/applications/:id/withdraw` |
| GET | `/api/manager/applications` |
| POST | `/api/manager/applications/:id/approve` |
| POST | `/api/manager/applications/:id/reject` |

## 5. 数据模型

Schema v17 新增 `shift_applications`：

- `demand_id + staff_id` 唯一；
- 状态 `pending / approved / rejected / withdrawn`；
- 记录备注、审批人、审批时间、生成的 `shift_id`；
- 保留原始申请，不覆盖历史。

## 6. UI

- 兼职底部导航新增 **缺位广场**；
- 兼职页面含「缺位广场 / 我的申请」；
- 店长底部导航新增 **兼职申请**；
- 店长页可直接通过/拒绝并生成班次。

截图：

- `docs/screenshots/16-staff-marketplace.png`
- `docs/screenshots/17-manager-applications.png`

## 7. 验证

- 109/109 测试通过（原 105 项 + 4 项缺位流程）。
- 测试覆盖：跨店可见/申请、重复申请拒绝、pending 兼职拒绝、店长通过生成 shift、店长拒绝不生成 shift、撤回后重新申请。
- H5 与微信小程序构建通过。

## 8. 演示

```bash
cd apps/server
npm run demo:marketplace
```

创建第二个演示门店和两条开放缺位；然后用兼职 `13800000001`（K001）登录，打开「缺位广场」。

## 9. 限制

- 当前运营数据是演示/模拟；不声称真实门店效果。
- 微信通知/真实邀约仍未启用；通知写入站内表。
- 完整用户注册、密码找回、KYC、多租户权限仍待后续。
- 审批生成班次是真实业务写入；影子模式/暂停门店会被 `SHADOW_MODE_NO_REAL_SHIFT` / `PILOT_DISPATCH_PAUSED` 拒绝，演示后应 reset 数据库。
