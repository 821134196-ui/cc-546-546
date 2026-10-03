'use strict';
// 重复催单:形成连续时间线,后厨队列不重复插入
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeWorld } = require('./helpers');

test('同一菜催单 3 次:时间线 3 条连续记录,后厨队列始终只有 1 行', () => {
  const w = makeWorld();
  const item = w.openItem();

  w.svc.remind({ itemId: item, note: '客人赶时间', actor: w.waiter });
  w.svc.remind({ itemId: item, note: '', actor: w.waiter });
  w.svc.remind({ itemId: item, note: '再次催促', actor: w.waiter });

  const reminders = w.db.prepare('SELECT * FROM reminders WHERE order_item_id = ? ORDER BY seq').all(item);
  assert.deepEqual(reminders.map((r) => r.seq), [1, 2, 3]);

  const queueRows = w.db.prepare('SELECT * FROM kitchen_queue WHERE order_item_id = ?').all(item);
  assert.equal(queueRows.length, 1, '队列不重复插入');
  assert.equal(queueRows[0].remind_count, 3, '队列行累计催单次数');

  const queueView = w.svc.kitchenQueue().filter((q) => q.item_id === item);
  assert.equal(queueView.length, 1);
  assert.equal(queueView[0].remind_count, 3);

  const tl = w.svc.timeline(item);
  const reminds = tl.filter((e) => e.action === 'remind');
  assert.equal(reminds.length, 3);
  assert.deepEqual(
    reminds.map((e) => e.detail),
    ['第1次催单:客人赶时间', '第2次催单', '第3次催单:再次催促']);
  // 时间线整体按时间正序
  const stamps = tl.map((e) => e.created_at);
  assert.deepEqual(stamps, [...stamps].sort());
});

test('催单后阶段推进,队列行仍唯一;出餐后再催单只记时间线', () => {
  const w = makeWorld();
  const item = w.openItem();
  w.svc.remind({ itemId: item, actor: w.waiter });
  w.advanceTo(item, 'served'); // 出餐 → 队列行关闭
  w.svc.remind({ itemId: item, actor: w.waiter }); // 已出餐:只追加时间线

  const rows = w.db.prepare('SELECT * FROM kitchen_queue WHERE order_item_id = ?').all(item);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'closed');
  assert.equal(rows[0].remind_count, 1, '已出餐后不再累计到队列');
  assert.equal(w.db.prepare('SELECT COUNT(*) c FROM reminders WHERE order_item_id = ?').get(item).c, 2);
});

test('已上桌/已退菜的菜不可催单', () => {
  const w = makeWorld();
  const item = w.openItem();
  w.advanceTo(item, 'delivered');
  assert.throws(() => w.svc.remind({ itemId: item, actor: w.waiter }), /不可催单/);
});

test('重做回原单位置:队列行不变,seq 不变,kind 变为 remake', () => {
  const w = makeWorld();
  const i1 = w.openItem();
  const i2 = w.openItem();
  w.advanceTo(i1, 'served');
  const before = w.db.prepare('SELECT * FROM kitchen_queue WHERE order_item_id = ?').get(i1);
  assert.equal(before.status, 'closed');

  w.svc.requestRemake({ itemId: i1, reasonCode: 'wrong_table', actor: w.waiter });
  const after = w.db.prepare('SELECT * FROM kitchen_queue WHERE order_item_id = ?').get(i1);
  assert.equal(after.id, before.id, '同一队列行,不新增');
  assert.equal(after.seq, before.seq, '保持原单位置');
  assert.equal(after.kind, 'remake');
  assert.equal(after.status, 'open');

  const queue = w.svc.kitchenQueue();
  const pos1 = queue.findIndex((q) => q.item_id === i1);
  const pos2 = queue.findIndex((q) => q.item_id === i2);
  assert.ok(pos1 < pos2, '重做的菜排在原单位置(先于后下的菜)');
  assert.equal(queue[pos1].remake_reason, 'wrong_table');
});
