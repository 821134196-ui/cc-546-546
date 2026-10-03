'use strict';
// 测试夹具:内存库 + 最小数据 + 可计数的模拟适配器
const { createDb } = require('../src/db');
const { RestaurantService } = require('../src/service');

function makeWorld() {
  const db = createDb(':memory:');
  const at = new Date().toISOString();
  db.prepare("INSERT INTO users (id, name, role) VALUES (1,'小王','waiter'),(2,'阿强','kitchen'),(3,'陈姐','manager')").run();
  db.prepare("INSERT INTO tables (id, name, status) VALUES (1,'1号桌','free')").run();
  db.prepare("INSERT INTO dishes (id, name, price_cents, photo, allergens) VALUES (1,'测试菜',5000,'/photos/dish-1.svg','')").run();

  const calls = { print: [], charge: [], refund: [] };
  const svc = new RestaurantService(db, {
    printer: { print: (j) => { calls.print.push(j); return { ok: true, job_id: `T${calls.print.length}` }; } },
    payment: {
      charge: (k, a) => { calls.charge.push({ k, a }); return { transaction_id: `tx_${k}`, status: 'succeeded' }; },
      refund: (k, a) => { calls.refund.push({ k, a }); return { refund_id: `rf_${k}`, status: 'succeeded' }; },
    },
  });

  const waiter = { id: 1, name: '小王', role: 'waiter' };
  const kitchen = { id: 2, name: '阿强', role: 'kitchen' };
  const manager = { id: 3, name: '陈姐', role: 'manager' };

  /** 开一单(1个菜),返回 itemId */
  function openItem() {
    const { itemIds } = svc.createOrder({ tableId: 1, items: [{ dishId: 1 }], actor: waiter });
    return itemIds[0];
  }
  /** 把菜品推进到指定状态 */
  function advanceTo(itemId, target) {
    const chain = ['pending', 'preparing', 'cooking', 'served', 'delivered'];
    const cur = svc.getItem(itemId).status;
    let idx = chain.indexOf(cur);
    const want = chain.indexOf(target);
    while (idx < want) {
      const next = chain[idx + 1];
      if (next === 'delivered') svc.deliver({ itemId, actor: waiter });
      else svc.setStage({ itemId, stage: next, actor: kitchen });
      idx++;
    }
  }
  return { db, svc, calls, waiter, kitchen, manager, openItem, advanceTo };
}

module.exports = { makeWorld };
