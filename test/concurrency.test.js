'use strict';
// 并发状态:退菜与出餐互斥 —— 同一菜不能既交付又全额退款
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeWorld } = require('./helpers');
const { createDb } = require('../src/db');
const { RestaurantService } = require('../src/service');

test('退菜申请冻结菜品:后厨无法继续出餐,批准后不可上桌', () => {
  const w = makeWorld();
  const item = w.openItem();
  w.advanceTo(item, 'cooking');

  const { refund } = w.svc.requestReturn({
    itemId: item, reasonCode: 'temp_fail', requestId: 'r1', actor: w.waiter,
  });
  assert.equal(w.svc.getItem(item).status, 'return_requested');

  // 冻结期间后厨出餐 → 冲突
  assert.throws(() => w.svc.setStage({ itemId: item, stage: 'served', actor: w.kitchen }), /状态已变化/);

  w.svc.approveRefund({ refundId: refund.id, actor: w.manager });
  assert.equal(w.svc.getItem(item).status, 'returned');

  // 已退菜不可上桌
  assert.throws(() => w.svc.deliver({ itemId: item, actor: w.waiter }), /无法上桌/);
});

test('已交付的菜不能全额退款(可部分退款),不会"既交付又全额退款"', () => {
  const w = makeWorld();
  const item = w.openItem();
  w.advanceTo(item, 'delivered');

  const { refund } = w.svc.requestReturn({
    itemId: item, reasonCode: 'served_return', requestId: 'r2', actor: w.waiter,
  });
  // 已交付:全额退款被拒
  assert.throws(
    () => w.svc.approveRefund({ refundId: refund.id, amountCents: 5000, actor: w.manager }),
    /已上桌交付,不能全额退款/);
  // 部分退款允许,菜品保持已交付
  w.svc.approveRefund({ refundId: refund.id, amountCents: 2500, actor: w.manager });
  const it = w.svc.getItem(item);
  assert.equal(it.status, 'delivered');
  const adj = w.db.prepare("SELECT * FROM fee_adjustments WHERE order_item_id = ? AND kind='refund'").all(item);
  assert.equal(adj.length, 1);
  assert.equal(adj[0].amount_cents, -2500);
  assert.equal(adj[0].affects_bill, 1);
});

test('并发突发:交付与全额退款同刻竞争,最终只成立一个(20组交替顺序)', () => {
  for (let i = 0; i < 20; i++) {
    const w = makeWorld();
    const item = w.openItem();
    w.advanceTo(item, 'served'); // 已出餐未上桌 —— 竞争窗口
    const { refund } = w.svc.requestReturn({
      itemId: item, reasonCode: 'served_return', requestId: `race-${i}`, actor: w.waiter,
    });
    const approve = () => w.svc.approveRefund({ refundId: refund.id, actor: w.manager });
    const deliver = () => w.svc.deliver({ itemId: item, actor: w.waiter });
    const pair = i % 2 === 0 ? [approve, deliver] : [deliver, approve];
    const outcomes = pair.map((fn) => {
      try { fn(); return 'ok'; } catch { return 'conflict'; }
    });
    const it = w.svc.getItem(item);
    const rf = w.db.prepare('SELECT * FROM refunds WHERE id = ?').get(refund.id);
    // 不变量 1:不能既交付又全额退款
    assert.equal(it.status === 'delivered' && rf.status === 'approved', false,
      `第${i}组:菜品既交付又全额退款`);
    // 不变量 2:两个操作恰好一个成功
    assert.equal(outcomes.filter((o) => o === 'ok').length, 1,
      `第${i}组:应恰好一个操作成功,实际 ${outcomes}`);
  }
});

test('跨连接并发:一个连接退款后,另一个连接的出餐写入失败(文件库+WAL)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yw-race-'));
  const dbPath = path.join(dir, 'race.db');
  const mk = () => {
    const db = createDb(dbPath);
    return new RestaurantService(db, {
      printer: { print: () => ({ ok: true }) },
      payment: { charge: (k) => ({ transaction_id: k, status: 'succeeded' }), refund: (k) => ({ refund_id: k, status: 'succeeded' }) },
    });
  };
  const a = mk(); const b = mk();
  a.db.prepare("INSERT INTO users (id,name,role) VALUES (1,'w','waiter'),(2,'k','kitchen'),(3,'m','manager')").run();
  a.db.prepare("INSERT INTO tables (id,name) VALUES (1,'T1')").run();
  a.db.prepare("INSERT INTO dishes (id,name,price_cents,photo) VALUES (1,'D',5000,'/x')").run();
  const waiter = { id: 1, name: 'w', role: 'waiter' };
  const kitchen = { id: 2, name: 'k', role: 'kitchen' };
  const manager = { id: 3, name: 'm', role: 'manager' };

  const { itemIds } = a.createOrder({ tableId: 1, items: [{ dishId: 1 }], actor: waiter });
  const item = itemIds[0];
  a.setStage({ itemId: item, stage: 'preparing', actor: kitchen });
  a.setStage({ itemId: item, stage: 'cooking', actor: kitchen });

  // 连接 B 先读到 cooking(模拟并发窗口),随后 A 完成退菜,B 再尝试出餐
  assert.equal(b.getItem(item).status, 'cooking');
  const { refund } = a.requestReturn({ itemId: item, reasonCode: 'temp_fail', requestId: 'x1', actor: waiter });
  a.approveRefund({ refundId: refund.id, actor: manager });
  assert.throws(() => b.setStage({ itemId: item, stage: 'served', actor: kitchen }), /状态已变化/);
  assert.equal(b.getItem(item).status, 'returned');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('阶段机:不能跳跃或回退(pending→cooking / served→preparing)', () => {
  const w = makeWorld();
  const item = w.openItem();
  assert.throws(() => w.svc.setStage({ itemId: item, stage: 'cooking', actor: w.kitchen }), /状态已变化/);
  w.advanceTo(item, 'served');
  assert.throws(() => w.svc.setStage({ itemId: item, stage: 'preparing', actor: w.kitchen }), /状态已变化/);
});
