"""SQLite 连接与 schema。

菜品状态全部持久化在 SQLite（:memory: 时每条连接独立，因此应用层
始终使用单一 Database 实例 + 单写者锁；文件库 WAL 模式供多连接并发读）。
"""
from __future__ import annotations

import os
import sqlite3
import threading
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS tables (
    id          INTEGER PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,          -- 桌号，如 A1
    seats       INTEGER NOT NULL DEFAULT 4
);

CREATE TABLE IF NOT EXISTS employees (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('waiter','chef','manager'))
);

CREATE TABLE IF NOT EXISTS orders (
    id          INTEGER PRIMARY KEY,
    table_id    INTEGER NOT NULL REFERENCES tables(id),
    waiter_id   INTEGER NOT NULL REFERENCES employees(id),
    created_at  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open'
                CHECK (status IN ('open','closed'))
);

-- 菜品字典
CREATE TABLE IF NOT EXISTS dishes (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    station     TEXT NOT NULL,                 -- 档口：热炒/凉菜/汤/主食
    price_cents INTEGER NOT NULL,
    allergen    TEXT,                          -- 过敏原标签，如 花生/海鲜
    photo       TEXT                           -- 本地演示照片路径
);

-- 原订单项（一行 = 一份客人点的菜）
CREATE TABLE IF NOT EXISTS order_items (
    id            INTEGER PRIMARY KEY,
    order_id      INTEGER NOT NULL REFERENCES orders(id),
    dish_id       INTEGER NOT NULL REFERENCES dishes(id),
    seat_no       INTEGER,                     -- 客位号
    qty           INTEGER NOT NULL DEFAULT 1,
    price_cents   INTEGER NOT NULL,            -- 下单时快照价
    note          TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN (
                      'queued',        -- 已入后厨队列，未备料
                      'prepping',      -- 后厨已备料
                      'cooking',       -- 正在烹制
                      'served',        -- 已出餐交付
                      'remaking',      -- 退/重做处理中，原项冻结，重做项在制
                      'wrong_delivered', -- 错上桌：菜已端出但上错桌/错菜
                      'cancelled',     -- 未出餐取消（无菜品成本）
                      'refunded'       -- 已出餐后退款（有菜品成本）
                  )),
    -- 重做链：重做产生的新 order_item 指向其原项；一个原项可连续被重做多次，
    -- 因此以 root_item_id 标记整条链，sequence 标记第几版（0=原件）
    root_item_id  INTEGER REFERENCES order_items(id),
    remake_seq    INTEGER NOT NULL DEFAULT 0,
    queued_at     TEXT NOT NULL,               -- 入队时间（等待时长基准）
    delivered_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_queue ON order_items(status, queued_at);
CREATE INDEX IF NOT EXISTS idx_items_root  ON order_items(root_item_id);

-- 催单/退菜/重做处理单（一条业务事件线）
CREATE TABLE IF NOT EXISTS tickets (
    id           INTEGER PRIMARY KEY,
    item_id      INTEGER NOT NULL REFERENCES order_items(id), -- 始终关联原订单项
    kind         TEXT NOT NULL CHECK (kind IN ('urge','return')),
    reason_code  TEXT NOT NULL CHECK (reason_code IN (
                     'slow','wrong_table','allergy_missed','temperature',
                     'guest_away','quality','wrong_item','other')),
    -- 责任判定：kitchen 后厨 / floor 前厅 / guest 客人 / split 双方分担
    liability    TEXT NOT NULL CHECK (liability IN ('kitchen','floor','guest','split')),
    note         TEXT DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open','acknowledged','rejected','resolved')),
    created_by   INTEGER NOT NULL REFERENCES employees(id),
    created_at   TEXT NOT NULL,
    resolved_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tickets_item ON tickets(item_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, kind);

-- 同一原项 + 后厨阶段的连续催单时间线；
-- open urge 唯一于 item_id：重复催单只追加事件，绝不重复入队
CREATE TABLE IF NOT EXISTS ticket_events (
    id          INTEGER PRIMARY KEY,
    ticket_id   INTEGER NOT NULL REFERENCES tickets(id),
    actor_id    INTEGER NOT NULL REFERENCES employees(id),
    type        TEXT NOT NULL CHECK (type IN (
                    'created','urge_again','kitchen_ack',
                    'stage_update','remake_started','served',
                    'wrong_delivered','reject','resolve')),
    payload     TEXT DEFAULT '{}',             -- JSON：阶段/说明等
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, id);

-- 经理审批（退款/重做费用）
CREATE TABLE IF NOT EXISTS approvals (
    id             INTEGER PRIMARY KEY,
    ticket_id      INTEGER REFERENCES tickets(id),
    item_id        INTEGER NOT NULL REFERENCES order_items(id),
    request_kind   TEXT NOT NULL CHECK (request_kind IN ('refund','remake','cancel')),
    amount_cents   INTEGER NOT NULL,           -- 申请金额（分）
    reason_code    TEXT NOT NULL,
    -- 幂等键：同一业务请求重试只产生一条审批/一笔退款
    idempotency_key TEXT NOT NULL UNIQUE,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','approved','rejected')),
    requested_by   INTEGER NOT NULL REFERENCES employees(id),
    decided_by     INTEGER REFERENCES employees(id),
    created_at     TEXT NOT NULL,
    decided_at     TEXT,
    manager_note   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- 费用调整（与原因紧邻；正=加收，负=减/退）
CREATE TABLE IF NOT EXISTS charges (
    id            INTEGER PRIMARY KEY,
    item_id       INTEGER NOT NULL REFERENCES order_items(id),
    approval_id   INTEGER REFERENCES approvals(id),
    kind          TEXT NOT NULL CHECK (kind IN (
                     'dish_charge',   -- 菜品费（错上桌等仍应收）
                     'dish_cost',     -- 后厨重做成本（内部核算，不向客人收）
                     'refund'         -- 退款
                  )),
    amount_cents  INTEGER NOT NULL,            -- 带符号：refund 为负
    reason_code   TEXT NOT NULL,
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_item ON charges(item_id);

-- 支付/打印模拟适配器回执
CREATE TABLE IF NOT EXISTS adapter_receipts (
    id           INTEGER PRIMARY KEY,
    provider     TEXT NOT NULL,                -- payment / printer
    external_ref TEXT NOT NULL,                -- 模拟外部单号
    approval_id  INTEGER REFERENCES approvals(id),
    amount_cents INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,      -- 外部调用幂等
    payload      TEXT DEFAULT '{}',
    created_at   TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class _LockedConnection:
    """连接代理：所有语句都在同一把 RLock 后串行执行。

    SQLite 单连接跨线程混用会在 CPython 层互锁；业务代码的事务块
    已持锁时代理可重入，未持锁的零散 SELECT 也因此被纳入同一串行队列。
    """

    def __init__(self, real: sqlite3.Connection, lock: threading.RLock):
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_lock", lock)

    def execute(self, sql, parameters=()):
        with self._lock:
            return self._real.execute(sql, parameters)

    def executemany(self, sql, parameters):
        with self._lock:
            return self._real.executemany(sql, parameters)

    def executescript(self, sql):
        with self._lock:
            return self._real.executescript(sql)

    def commit(self):
        with self._lock:
            return self._real.commit()

    def rollback(self):
        with self._lock:
            try:
                return self._real.rollback()
            except sqlite3.OperationalError as e:
                # 业务分支可能已自行回滚；重复回滚不应掩盖原始异常
                if "no transaction is active" in str(e):
                    return None
                raise

    def close(self):
        with self._lock:
            return self._real.close()

    @property
    def row_factory(self):
        return self._real.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._real.row_factory = value


class Database:
    """单库句柄。check_same_thread=False + 全语句串行锁，事务在锁内完成。"""

    def __init__(self, path: str | None = None):
        self.path = path or os.environ.get(
            "RESTAURANT_DB", os.path.join(os.path.dirname(__file__), "..", "restaurant.db")
        )
        self._lock = threading.RLock()
        real = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
        real.row_factory = sqlite3.Row
        real.execute("PRAGMA foreign_keys=ON")
        if self.path != ":memory:":
            real.execute("PRAGMA journal_mode=WAL")
            real.execute("PRAGMA busy_timeout=5000")
        real.executescript(SCHEMA)
        self.conn = _LockedConnection(real, self._lock)

    @property
    def lock(self) -> threading.RLock:
        return self._lock

    def close(self) -> None:
        with self._lock:
            self.conn.close()
