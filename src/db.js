'use strict';
// 数据层:SQLite(node:sqlite 内置驱动,零外部依赖)
// 关键约束:
//  - kitchen_queue.order_item_id 唯一      → 同一菜永远只占一个队列位,催单/重做不重复入队
//  - refunds.request_id 唯一               → 退菜申请幂等键
//  - payments.idempotency_key 唯一         → 支付幂等键
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 3000;

CREATE TABLE IF NOT EXISTS users (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  role  TEXT NOT NULL CHECK (role IN ('waiter','kitchen','manager'))
);

CREATE TABLE IF NOT EXISTS tables (
  id     INTEGER PRIMARY KEY,
  name   TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'free' CHECK (status IN ('free','dining'))
);

CREATE TABLE IF NOT EXISTS dishes (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  photo       TEXT NOT NULL,
  allergens   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY,
  table_id   INTEGER NOT NULL REFERENCES tables(id),
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','closed')),
  opened_by  INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  paid_at    TEXT
);

-- 订单项状态机:
--   pending(待处理) → preparing(已备料) → cooking(正在烹制) → served(已出餐) → delivered(已上桌)
--   旁路: remaking(重做中,回到 preparing) / return_requested(退菜审批中,冻结) / returned / cancelled
CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  dish_id          INTEGER NOT NULL REFERENCES dishes(id),
  qty              INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','preparing','cooking','served','delivered','remaking','return_requested','returned','cancelled')),
  prev_status      TEXT,
  allergy_note     TEXT NOT NULL DEFAULT '',
  version          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- 后厨队列:每个订单项终生一行,seq 即"原单位置";重做只改 kind 不改位置
CREATE TABLE IF NOT EXISTS kitchen_queue (
  id             INTEGER PRIMARY KEY,
  seq            INTEGER NOT NULL,
  order_item_id  INTEGER NOT NULL UNIQUE REFERENCES order_items(id),
  kind           TEXT NOT NULL DEFAULT 'cook' CHECK (kind IN ('cook','remake')),
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  remind_count   INTEGER NOT NULL DEFAULT 0,
  last_remind_at TEXT,
  created_at     TEXT NOT NULL
);

-- 催单时间线:每次催单一行,seq 为第 N 次
CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  seq           INTEGER NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_by    INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL
);

-- 重做单:原因 + 责任归属 + 成本
CREATE TABLE IF NOT EXISTS remakes (
  id             INTEGER PRIMARY KEY,
  order_item_id  INTEGER NOT NULL REFERENCES order_items(id),
  reason_code    TEXT NOT NULL CHECK (reason_code IN
    ('wrong_table','allergy_missed','temp_fail','guest_away','served_return','other')),
  responsibility TEXT NOT NULL CHECK (responsibility IN ('front','kitchen','guest','house')),
  cost_cents     INTEGER NOT NULL DEFAULT 0,
  note           TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL
);

-- 退款审批:服务员只能发起,值班经理审批;request_id 幂等
CREATE TABLE IF NOT EXISTS refunds (
  id                 INTEGER PRIMARY KEY,
  request_id         TEXT NOT NULL UNIQUE,
  order_item_id      INTEGER NOT NULL REFERENCES order_items(id),
  reason_code        TEXT NOT NULL,
  note               TEXT NOT NULL DEFAULT '',
  amount_cents       INTEGER NOT NULL,
  final_amount_cents INTEGER,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by       INTEGER NOT NULL REFERENCES users(id),
  decided_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL,
  decided_at         TEXT
);

-- 费用调整:refund/comp 影响账单;loss 为内部损耗(错上桌等),不影响客人账单
CREATE TABLE IF NOT EXISTS fee_adjustments (
  id             INTEGER PRIMARY KEY,
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  order_item_id  INTEGER REFERENCES order_items(id),
  kind           TEXT NOT NULL CHECK (kind IN ('refund','comp','loss')),
  amount_cents   INTEGER NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  responsibility TEXT,
  affects_bill   INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  amount_cents    INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'succeeded',
  created_at      TEXT NOT NULL
);

-- 事件流:时间线数据源(催单/阶段变更/退菜/重做/审批全部落此)
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  order_item_id INTEGER REFERENCES order_items(id),
  order_id      INTEGER,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_order   ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_events_item   ON events(order_item_id, id);
CREATE INDEX IF NOT EXISTS idx_queue_open    ON kitchen_queue(status, seq);
CREATE INDEX IF NOT EXISTS idx_reminders_item ON reminders(order_item_id, seq);
`;

function createDb(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

module.exports = { createDb };
