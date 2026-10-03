'use strict';
// 退款幂等:同一申请重复提交/重复审批/重复支付,都只生效一次
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld } = require('./helpers');

test('退菜申请幂等:同一 request_id 重复提交只生成一条申请', () => {
  const w = makeWorld();
  const item = w.openItem();
  w.advanceTo(item, 'cooking');

  const a = w.svc.requestReturn({ itemId: item, reasonCode: 'temp_fail', requestId: 'req-1', actor: w.waiter });
  const b = w.svc.requestReturn({ itemId: item, reasonCode: 'temp_fail', requestId: 'req-1', actor: w.waiter });
  assert.equal(a.duplicated, false);
  assert.equal(b.duplicated, true);
  assert.equal(a.refund.id, b.refund.id);
  assert.equal(w.db.prepare('SELECT COUNT(*) c FROM refunds').get().c, 1);
  // 时间线只记录一次申请事件
  const evts = w.db.prepare("SELECT COUNT(*) c FROM events WHERE action='return_request'").get().c;
  assert.equal(evts, 1);
});

test('退款审批幂等:重复批准不产生第二笔费用调整,支付网关只退一次', () => {
  const w = makeWorld();
  const item = w.openItem();
  w.advanceTo(item, 'cooking');
  const { refund } = w.svc.requestReturn({ itemId: item, reasonCode: 'allergy_missed', requestId: 'req-2', actor: w.waiter });

  const first = w.svc.approveRefund({ refundId: refund.id, actor: w.manager });
  const second = w.svc.approveRefund({ refundId: refund.id, actor: w.manager });
  assert.equal(first.duplicated, false);
  assert.equal(second.duplicated, true);

  assert.equal(w.db.prepare("SELECT COUNT(*) c FROM fee_adjustments WHERE kind='refund'").get().c, 1);
  assert.equal(w.calls.refund.length, 1, '支付网关退款只调用一次');
  assert.equal(w.svc.getItem(item).status, 'returned');
});

test('拒绝幂等 + 拒绝后菜品解冻回到原状态', () => {
  const w = makeWorld();
  const item = w.openItem();
  w.advanceTo(item, 'preparing');
  const { refund } = w.svc.requestReturn({ itemId: item, reasonCode: 'other', requestId: 'req-3', actor: w.waiter });
  assert.equal(w.svc.getItem(item).status, 'return_requested');

  w.svc.rejectRefund({ refundId: refund.id, actor: w.manager });
  const again = w.svc.rejectRefund({ refundId: refund.id, actor: w.manager });
  assert.equal(again.duplicated, true);
  assert.equal(w.svc.getItem(item).status, 'preparing');
  // 解冻后后厨可继续制作
  w.svc.setStage({ itemId: item, stage: 'cooking', actor: w.kitchen });
  assert.equal(w.svc.getItem(item).status, 'cooking');
});

test('买单幂等:同一 idempotency_key 重复支付只扣款一次', () => {
  const w = makeWorld();
  const item = w.openItem();
  w.advanceTo(item, 'delivered');
  const orderId = w.db.prepare('SELECT order_id FROM order_items WHERE id = ?').get(item).order_id;

  const p1 = w.svc.pay({ orderId, idempotencyKey: 'bill-1', actor: w.waiter });
  const p2 = w.svc.pay({ orderId, idempotencyKey: 'bill-1', actor: w.waiter });
  assert.equal(p1.duplicated, false);
  assert.equal(p2.duplicated, true);
  assert.equal(w.calls.charge.length, 1, '支付网关只扣款一次');
  assert.equal(w.db.prepare('SELECT COUNT(*) c FROM payments').get().c, 1);
  // 已结账订单再次支付(不同键)→ 冲突
  assert.throws(() => w.svc.pay({ orderId, idempotencyKey: 'bill-2', actor: w.waiter }), /已结账/);
});

test('账单:全额退菜从账单移除,部分退款冲减账单,损耗不进账单', () => {
  const w = makeWorld();
  const i1 = w.openItem(); // 将全额退
  const i2 = w.openItem(); // 将部分退(先交付)
  const i3 = w.openItem(); // 错上桌重做 → 内部损耗
  const orderId = w.db.prepare('SELECT order_id FROM order_items WHERE id = ?').get(i1).order_id;

  w.advanceTo(i1, 'cooking');
  const r1 = w.svc.requestReturn({ itemId: i1, reasonCode: 'temp_fail', requestId: 'b1', actor: w.waiter });
  w.svc.approveRefund({ refundId: r1.refund.id, actor: w.manager }); // 全额 5000

  w.advanceTo(i2, 'delivered');
  const r2 = w.svc.requestReturn({ itemId: i2, reasonCode: 'served_return', requestId: 'b2', actor: w.waiter });
  w.svc.approveRefund({ refundId: r2.refund.id, amountCents: 2000, actor: w.manager }); // 部分 2000

  w.advanceTo(i3, 'served');
  w.svc.requestRemake({ itemId: i3, reasonCode: 'wrong_table', actor: w.waiter }); // 损耗 5000

  const bill = w.svc.getBill(orderId);
  assert.equal(bill.itemsTotal, 10000, '全额退的菜不计入菜品合计');
  assert.equal(bill.adjustmentsTotal, -2000, '只有部分退款冲减账单');
  assert.equal(bill.total, 8000);
  const loss = w.db.prepare("SELECT * FROM fee_adjustments WHERE kind='loss'").all();
  assert.equal(loss.length, 1);
  assert.equal(loss[0].affects_bill, 0, '损耗不影响客人账单');
});
