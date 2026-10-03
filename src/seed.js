'use strict';
// 种子数据:用户/菜品/桌台 + 演示场景(错上桌重做、催单时间线、待审批退菜)
// 同时把演示菜品"照片"(SVG)写入本地 photos/ 目录
const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('./db');

const ROOT = path.join(__dirname, '..');
const PHOTOS_DIR = path.join(ROOT, 'photos');

const DISHES = [
  { name: '清蒸鲈鱼',   price: 12800, allergens: '海鲜',     hue: '#c1573a', bg: '#f6e7e0' },
  { name: '宫保鸡丁',   price: 4800,  allergens: '花生',     hue: '#b3402f', bg: '#f7e9d8' },
  { name: '麻婆豆腐',   price: 3200,  allergens: '',         hue: '#a8442f', bg: '#f5e3d9' },
  { name: '蒜蓉西兰花', price: 2800,  allergens: '',         hue: '#4c6b46', bg: '#e9efe4' },
  { name: '红烧肉',     price: 6800,  allergens: '',         hue: '#8f3a2a', bg: '#f3e2d6' },
  { name: '酸辣汤',     price: 2200,  allergens: '',         hue: '#b26a2f', bg: '#f6ecdc' },
  { name: '扬州炒饭',   price: 2600,  allergens: '鸡蛋',     hue: '#c08a3e', bg: '#f7efdd' },
  { name: '杨枝甘露',   price: 1800,  allergens: '芒果',     hue: '#cf9a3f', bg: '#f8f0dc' },
];

const USERS = [
  { name: '小王', role: 'waiter' },
  { name: '小李', role: 'waiter' },
  { name: '阿强', role: 'kitchen' },
  { name: '陈姐', role: 'manager' },
];

function dishPhoto(dish, id) {
  const initial = dish.name[0];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">
  <rect width="400" height="300" fill="${dish.bg}"/>
  <circle cx="200" cy="150" r="98" fill="#fffdf9" stroke="#e3d9cf" stroke-width="3"/>
  <circle cx="200" cy="150" r="72" fill="${dish.hue}" opacity="0.88"/>
  <circle cx="172" cy="126" r="16" fill="#ffffff" opacity="0.25"/>
  <text x="200" y="172" font-size="56" text-anchor="middle" fill="#fffdf9" font-family="serif">${initial}</text>
  <text x="200" y="278" font-size="20" text-anchor="middle" fill="#6b5f55" font-family="sans-serif">${dish.name} · 演示照片</text>
</svg>`;
}

function writePhotos() {
  fs.mkdirSync(PHOTOS_DIR, { recursive: true });
  DISHES.forEach((d, i) => {
    fs.writeFileSync(path.join(PHOTOS_DIR, `dish-${i + 1}.svg`), dishPhoto(d, i + 1));
  });
}

const min = (n) => new Date(Date.now() - n * 60000).toISOString();

function seed(db) {
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM users').get();
  if (c > 0) return false; // 已有数据,不重复播种

  writePhotos();
  const at = new Date().toISOString();
  const insUser = db.prepare('INSERT INTO users (name, role) VALUES (?,?)');
  USERS.forEach((u) => insUser.run(u.name, u.role)); // 1小王 2小李 3阿强 4陈姐
  const insTable = db.prepare("INSERT INTO tables (name, status) VALUES (?, 'free')");
  ['1号桌', '2号桌', '3号桌', '4号桌', '5号桌', '6号桌'].forEach((n) => insTable.run(n));
  const insDish = db.prepare('INSERT INTO dishes (name, price_cents, photo, allergens) VALUES (?,?,?,?)');
  DISHES.forEach((d, i) => insDish.run(d.name, d.price, `/photos/dish-${i + 1}.svg`, d.allergens));

  const insOrder = db.prepare("INSERT INTO orders (table_id, status, opened_by, created_at) VALUES (?,'open',?,?)");
  const insItem = db.prepare(`INSERT INTO order_items
    (order_id, dish_id, qty, unit_price_cents, status, prev_status, allergy_note, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const insQueue = db.prepare(`INSERT INTO kitchen_queue
    (seq, order_item_id, kind, status, remind_count, last_remind_at, created_at) VALUES (?,?,?,?,?,?,?)`);
  const insEvent = db.prepare(`INSERT INTO events (order_item_id, order_id, actor, action, detail, created_at)
    VALUES (?,?,?,?,?,?)`);
  const insRemind = db.prepare(`INSERT INTO reminders (order_item_id, seq, note, created_by, created_at)
    VALUES (?,?,?,?,?)`);

  const dish = (i) => ({ id: i + 1, ...DISHES[i] });
  const mk = (orderId, dishIdx, status, createdMin, opts = {}) => {
    const d = dish(dishIdx);
    const r = insItem.run(orderId, d.id, opts.qty || 1, d.price, status, opts.prev || null,
      opts.allergy || '', min(createdMin), min(opts.updatedMin ?? createdMin));
    return Number(r.lastInsertRowid);
  };

  // ── 1号桌:三个不同阶段 + 宫保鸡丁过敏备注 + 已催单两次(时间线演示) ──
  const o1 = Number(insOrder.run(1, 1, min(35)).lastInsertRowid);
  const gongbao = mk(o1, 1, 'cooking', 35, { allergy: '花生过敏,免花生', updatedMin: 30 });
  insQueue.run(1, gongbao, 'cook', 'open', 2, min(8), min(35));
  insRemind.run(gongbao, 1, '客人赶时间', 1, min(20));
  insRemind.run(gongbao, 2, '再次催促', 1, min(8));
  insEvent.run(gongbao, o1, '小王', 'created', '下单 宫保鸡丁×1,过敏备注:花生过敏,免花生', min(35));
  insEvent.run(gongbao, o1, '阿强', 'stage', '后厨:已备料', min(32));
  insEvent.run(gongbao, o1, '阿强', 'stage', '后厨:正在烹制', min(30));
  insEvent.run(gongbao, o1, '小王', 'remind', '第1次催单:客人赶时间', min(20));
  insEvent.run(gongbao, o1, '小王', 'remind', '第2次催单:再次催促', min(8));
  const mapo = mk(o1, 2, 'served', 35, { updatedMin: 18 });
  insQueue.run(2, mapo, 'cook', 'closed', 0, null, min(35));
  insEvent.run(mapo, o1, '小王', 'created', '下单 麻婆豆腐×1', min(35));
  insEvent.run(mapo, o1, '阿强', 'stage', '后厨:已出餐', min(18));
  const soup = mk(o1, 5, 'delivered', 35, { updatedMin: 15 });
  insQueue.run(3, soup, 'cook', 'closed', 0, null, min(35));
  insEvent.run(soup, o1, '小王', 'created', '下单 酸辣汤×1', min(35));
  insEvent.run(soup, o1, '小李', 'deliver', '已上桌', min(15));
  db.prepare("UPDATE tables SET status='dining' WHERE id=1").run();

  // ── 3号桌:错上桌演示案例 —— 清蒸鲈鱼误送5号桌,重做中,损耗记前厅责任 ──
  const o3 = Number(insOrder.run(3, 1, min(25)).lastInsertRowid);
  const luyu = mk(o3, 0, 'remaking', 25, { updatedMin: 6 });
  insQueue.run(4, luyu, 'remake', 'open', 0, null, min(25));
  insEvent.run(luyu, o3, '小王', 'created', '下单 清蒸鲈鱼×1', min(25));
  insEvent.run(luyu, o3, '阿强', 'stage', '后厨:已出餐', min(12));
  insEvent.run(luyu, o3, '小李', 'deliver', '误送至5号桌(错上桌)', min(10));
  insEvent.run(luyu, o3, '小李', 'remake', '发起重做(错上桌,责任:front)', min(6));
  db.prepare(`INSERT INTO remakes (order_item_id, reason_code, responsibility, cost_cents, note, status, created_by, created_at)
    VALUES (?,?,?,?,?,'open',?,?)`).run(luyu, 'wrong_table', 'front', 12800, '清蒸鲈鱼误送5号桌,重新制作', 2, min(6));
  db.prepare(`INSERT INTO fee_adjustments (order_id, order_item_id, kind, amount_cents, reason, responsibility, affects_bill, created_by, created_at)
    VALUES (?,?, 'loss', ?, ?, 'front', 0, ?, ?)`).run(o3, luyu, -12800, '重做损耗(错上桌):清蒸鲈鱼误送5号桌', 2, min(6));
  const xilanhua = mk(o3, 3, 'delivered', 25, { updatedMin: 14 });
  insQueue.run(5, xilanhua, 'cook', 'closed', 0, null, min(25));
  insEvent.run(xilanhua, o3, '小王', 'created', '下单 蒜蓉西兰花×1', min(25));
  insEvent.run(xilanhua, o3, '小李', 'deliver', '已上桌', min(14));
  db.prepare("UPDATE tables SET status='dining' WHERE id=3").run();

  // ── 5号桌:扬州炒饭备料中 ──
  const o5 = Number(insOrder.run(5, 2, min(15)).lastInsertRowid);
  const chaofan = mk(o5, 6, 'preparing', 15, { updatedMin: 12 });
  insQueue.run(6, chaofan, 'cook', 'open', 0, null, min(15));
  insEvent.run(chaofan, o5, '小李', 'created', '下单 扬州炒饭×1', min(15));
  insEvent.run(chaofan, o5, '阿强', 'stage', '后厨:已备料', min(12));
  db.prepare("UPDATE tables SET status='dining' WHERE id=5").run();

  // ── 4号桌:红烧肉已出餐,客人要退 → 待经理审批(出餐后退菜) ──
  const o4 = Number(insOrder.run(4, 2, min(40)).lastInsertRowid);
  const hongshao = mk(o4, 4, 'return_requested', 40, { prev: 'served', updatedMin: 5 });
  insQueue.run(7, hongshao, 'cook', 'closed', 0, null, min(40));
  insEvent.run(hongshao, o4, '小李', 'created', '下单 红烧肉×1', min(40));
  insEvent.run(hongshao, o4, '阿强', 'stage', '后厨:已出餐', min(20));
  insEvent.run(hongshao, o4, '小李', 'return_request', '申请退菜(出餐后退菜)¥68.00:客人反映太腻', min(5));
  db.prepare(`INSERT INTO refunds (request_id, order_item_id, reason_code, note, amount_cents, status, requested_by, created_at)
    VALUES (?,?,?,?,?,'pending',?,?)`).run('seed-refund-hongshao', hongshao, 'served_return', '客人反映太腻', 6800, 2, min(5));
  const yangzhi = mk(o4, 7, 'delivered', 40, { updatedMin: 25 });
  insQueue.run(8, yangzhi, 'cook', 'closed', 0, null, min(40));
  insEvent.run(yangzhi, o4, '小李', 'created', '下单 杨枝甘露×1', min(40));
  insEvent.run(yangzhi, o4, '小李', 'deliver', '已上桌', min(25));
  db.prepare("UPDATE tables SET status='dining' WHERE id=4").run();

  return true;
}

if (require.main === module) {
  const db = createDb(path.join(ROOT, 'var', 'restaurant.db'));
  const done = seed(db);
  console.log(done ? '✓ 种子数据已写入(含错上桌演示案例)' : '· 数据库已有数据,跳过播种');
  db.close();
}

module.exports = { seed, writePhotos };
