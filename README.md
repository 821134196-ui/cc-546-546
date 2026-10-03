# 一味小馆 · 前厅后厨协同系统

餐厅前厅-后厨协同演示:催单时间线、退菜审批、重做责任与费用、并发安全。
**零外部依赖**(Node ≥ 22.5,使用内置 `node:http` / `node:sqlite` / `node:test`)。

## 一键启动

```bash
npm start          # 首次启动自动建库、播种演示数据(含错上桌案例)、生成菜品照片
```

| 页面 | 地址 | 角色 |
|---|---|---|
| 前厅 | http://localhost:3000/ | 小王 / 小李(服务员) |
| 后厨屏 | http://localhost:3000/kitchen | 阿强(后厨) |
| 经理审批 | http://localhost:3000/manager | 陈姐(值班经理) |

```bash
npm test           # 19 个测试:并发状态 / 退款幂等 / 重复催单 / 角色权限
npm run reset      # 清空 var/(数据库与打印池),下次启动重新播种
```

## 预置演示案例

- **3号桌 · 错上桌**:清蒸鲈鱼误送 5 号桌 → 重做中,后厨屏在**原单位置 #4** 显示红色「重做」标记;¥128 记为前厅责任的内部损耗(不进客人账单),经理页可见。
- **1号桌 · 催单时间线**:宫保鸡丁(⚠花生过敏备注)已被催单 2 次,点「时间线」看连续记录;后厨队列仍只占 1 行,仅累计「催×2」。
- **4号桌 · 出餐后退菜**:红烧肉已出餐,客人要退 → 待经理审批;已交付菜品**不能全额退款**,经理可核定部分退款。
- **5号桌**:扬州炒饭备料中;2/6 号桌空闲可开单。

## 核心机制

**订单项状态机**(条件 UPDATE + 影响行数校验,并发下只有一个写入者成功):

```
pending待处理 → preparing已备料 → cooking正在烹制 → served已出餐 → delivered已上桌
  ↘ return_requested退菜审批中(冻结,拒绝后解冻回原状态) → returned已退菜
  ↘ remaking重做中 → 重新备料(回到 preparing)
```

**三条不变量**

1. **催单不重复入队** — `kitchen_queue.order_item_id` 唯一;催单只追加 `reminders` 时间线并累加队列行的 `remind_count`。
2. **退菜与出餐互斥** — 退菜申请冻结未交付菜品;已交付菜品全额退款被 409 拒绝(可部分退款)。`UPDATE ... WHERE status=?` 条件写保证并发竞争只有一个赢家,同一菜不会既交付又全额退款。
3. **退款/支付幂等** — `refunds.request_id`、`payments.idempotency_key` 唯一约束;重复提交返回原记录,费用调整与支付网关调用只发生一次。服务员只能发起申请,退款必须经理审批(接口级 403)。

**责任与费用模型**(`fee_adjustments`)

| 原因 | 责任方 | 费用 |
|---|---|---|
| 错上桌 | 前厅 | 重做成本记门店损耗,不影响账单 |
| 过敏提醒漏看 | 前厅 | 同上 |
| 温度不合格 | 后厨 | 同上 |
| 客人临时离席 | 客人 | 不产生费用 |
| 出餐后退菜 | 门店/协商 | 经理核定退款金额,冲减账单 |

账单 = 未退菜品合计 + 影响账单的费用调整;损耗类调整与原因紧邻展示但不计入应付。

## 目录

```
server.js            HTTP 服务:路由 + 角色鉴权(X-User-Id) + 静态资源
src/db.js            SQLite schema(唯一约束承载幂等与队列不变量)
src/service.js       业务服务:状态机 / 事务 / 并发控制 / 账单
src/seed.js          演示数据 + 本地菜品照片(photos/*.svg)
src/adapters/        模拟打印(var/print-spool.log)与模拟支付(幂等网关)
public/              前厅 / 后厨屏 / 经理审批(白·墨黑·暖红,忙碌场景可扫读)
test/                node:test:并发状态、退款幂等、重复催单、角色权限
```

## API 摘要

```
POST /api/orders                  开台/加菜(服务员)          → 打印厨单
POST /api/items/:id/remind        催单(追加时间线,不重复入队)
POST /api/items/:id/stage         后厨推进阶段(条件更新防并发)
POST /api/items/:id/deliver       上桌
POST /api/items/:id/return        申请退菜(request_id 幂等,202 待审批)
POST /api/items/:id/remake        申请重做(原单位置回队列)
POST /api/refunds/:id/approve     经理批准(可改金额;已交付拒全额)
POST /api/refunds/:id/reject      经理拒绝(菜品解冻)
POST /api/orders/:id/pay          买单(idempotency_key 幂等)
GET  /api/board|kitchen/queue|manager/refunds|items/:id/timeline|tables/:id/order
```
