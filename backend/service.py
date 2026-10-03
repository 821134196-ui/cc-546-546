"""领域服务：催单 / 退菜 / 重做 / 审批 / 费用调整。

所有写操作都在 Database.lock 内以单事务完成，关键状态迁移使用
带 WHERE status IN (...) 的条件 UPDATE —— 并发出餐与退款竞争时，
先提交者胜出，后者拿到 ConflictError（HTTP 409），由界面重新裁决。
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone

from .adapters import PaymentAdapter, PrinterAdapter
from .db import Database, now

# ---------------------------------------------------------------- 常量

# 后厨阶段 -> 订单项状态
STAGE_STATUS = {"prepping": "prepping", "cooking": "cooking", "plated": "served"}
STAGE_LABEL = {"queued": "待备料", "prepping": "已备料", "cooking": "烹制中",
               "plated": "已出餐", "served": "已交付", "remaking": "重做中",
               "wrong_delivered": "错上桌", "cancelled": "已取消",
               "refunded": "已退款"}

# 费用/责任规则。每种原因对应：默认责任、能否在出餐前取消、出餐后处理方式
# served_policy: refund=可退款 / remake=重做 / charge=保留收费（经理可裁量减免）
REASON_RULES = {
    "slow":           {"liability": "kitchen", "served_policy": "remake"},
    "wrong_table":    {"liability": "floor",   "served_policy": "remake"},
    "wrong_item":     {"liability": "floor",   "served_policy": "remake"},
    "allergy_missed": {"liability": "kitchen", "served_policy": "refund"},
    "temperature":    {"liability": "kitchen", "served_policy": "remake"},
    "quality":        {"liability": "kitchen", "served_policy": "remake"},
    "guest_away":     {"liability": "guest",   "served_policy": "charge"},
    "other":          {"liability": "split",   "served_policy": "remake"},
}
REASON_LABEL = {
    "slow": "出餐慢/催菜", "wrong_table": "错上桌", "wrong_item": "上错菜",
    "allergy_missed": "过敏提醒漏看", "temperature": "温度不合格",
    "quality": "菜品质量", "guest_away": "客人临时离席", "other": "其他",
}
LIABILITY_LABEL = {"kitchen": "后厨", "floor": "前厅", "guest": "客人", "split": "双方分担"}

ACTIVE_KITCHEN = ("queued", "prepping", "cooking")
DELIVERED = ("served", "wrong_delivered")


class ServiceError(RuntimeError):
    """4xx 类业务错误。"""
    status = 400


class AuthError(ServiceError):
    status = 403


class ConflictError(ServiceError):
    status = 409


class NotFound(ServiceError):
    status = 404


def _parse_ts(s: str) -> datetime:
    return datetime.fromisoformat(s)


def wait_seconds(queued_at: str, ref: datetime | None = None) -> int:
    ref = ref or datetime.now(timezone.utc)
    return max(0, int((ref - _parse_ts(queued_at)).total_seconds()))


class Service:
    def __init__(self, db: Database):
        self.db = db
        self.pay = PaymentAdapter(db)
        self.printer = PrinterAdapter(db)

    # ================================================================ 基础

    def _employee(self, employee_id: int) -> sqlite3.Row:
        row = self.db.conn.execute(
            "SELECT * FROM employees WHERE id=?", (employee_id,)
        ).fetchone()
        if not row:
            raise AuthError("员工不存在")
        return row

    def _require_role(self, employee_id: int, *roles: str) -> sqlite3.Row:
        emp = self._employee(employee_id)
        if emp["role"] not in roles:
            raise AuthError(f"需要角色 {'/'.join(roles)}，当前为 {emp['role']}")
        return emp

    def _item(self, item_id: int) -> sqlite3.Row:
        row = self.db.conn.execute(
            """SELECT i.*, d.name dish_name, d.station, d.allergen, d.photo,
                      o.table_id, t.code table_code, o.id order_id
               FROM order_items i
               JOIN dishes d ON d.id=i.dish_id
               JOIN orders o ON o.id=i.order_id
               JOIN tables t ON t.id=o.table_id
               WHERE i.id=?""", (item_id,)).fetchone()
        if not row:
            raise NotFound("订单项不存在")
        return row

    def _root(self, item: sqlite3.Row) -> int:
        return item["root_item_id"] or item["id"]

    def _add_event(self, ticket_id: int, actor_id: int, etype: str,
                   payload: dict | None = None, ts: str | None = None) -> None:
        self.db.conn.execute(
            """INSERT INTO ticket_events (ticket_id,actor_id,type,payload,created_at)
               VALUES (?,?,?,?,?)""",
            (ticket_id, actor_id, etype,
             json.dumps(payload or {}, ensure_ascii=False), ts or now()),
        )

    # ================================================================ 催单

    def urge(self, item_id: int, employee_id: int, note: str = "") -> dict:
        """服务员催菜。同一原项只允许一条 open 催单；重复催单追加时间线事件，
        绝不向后厨队列重复插入。"""
        self._require_role(employee_id, "waiter", "manager")
        item = self._item(item_id)
        root = self._root(item)
        with self.db.lock:
            self.db.conn.execute("BEGIN IMMEDIATE")
            try:
                existing = self.db.conn.execute(
                    """SELECT * FROM tickets
                       WHERE item_id=? AND kind='urge' AND status IN ('open','acknowledged')
                       ORDER BY id DESC LIMIT 1""", (root,)).fetchone()
                if existing:
                    # 连续催单：同一时间线追加事件，队列里依然只有那一份菜
                    self._add_event(existing["id"], employee_id, "urge_again",
                                    {"note": note, "stage": item["status"]})
                    self.db.conn.execute(
                        "UPDATE tickets SET status='open' WHERE id=?",
                        (existing["id"],))
                    self.db.conn.execute("COMMIT")
                    return {"ticket_id": existing["id"], "duplicate": True}

                cur = self.db.conn.execute(
                    """INSERT INTO tickets (item_id,kind,reason_code,liability,
                          note,status,created_by,created_at)
                       VALUES (?,?,?,?,?,?,?,?)""",
                    (root, "urge", "slow", "kitchen", note, "open",
                     employee_id, now()))
                ticket_id = cur.lastrowid
                self._add_event(ticket_id, employee_id, "created",
                                {"stage": item["status"]})
                self.db.conn.execute("COMMIT")
                return {"ticket_id": ticket_id, "duplicate": False}
            except Exception:
                self.db.conn.execute("ROLLBACK")
                raise

    def kitchen_ack(self, ticket_id: int, employee_id: int, stage: str,
                    message: str = "") -> dict:
        """后厨响应处理单：已备料 / 正在烹制 / 已出餐。"""
        self._require_role(employee_id, "chef", "manager")
        if stage not in STAGE_STATUS:
            raise ServiceError("stage 必须是 prepping/cooking/plated")
        with self.db.lock:
            self.db.conn.execute("BEGIN IMMEDIATE")
            try:
                ticket = self.db.conn.execute(
                    "SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
                if not ticket:
                    raise NotFound("处理单不存在")
                if ticket["status"] == "resolved":
                    raise ConflictError("处理单已结束")
                # 催单可能发生在重做期间：要推进的是链上当前在制的那份，
                # 不是已冻结的原项
                target_item = self._live_item(ticket["item_id"]) or self._item(ticket["item_id"])
                self._advance_stage(target_item, STAGE_STATUS[stage], employee_id,
                                    ticket_id=ticket_id, message=message)
                if stage == "plated":
                    self.db.conn.execute(
                        "UPDATE tickets SET status='resolved', resolved_at=? WHERE id=?",
                        (now(), ticket_id))
                else:
                    self.db.conn.execute(
                        "UPDATE tickets SET status='acknowledged' WHERE id=?",
                        (ticket_id,))
                self.db.conn.execute("COMMIT")
                return {"ok": True, "item_status": STAGE_STATUS[stage]}
            except Exception:
                self.db.conn.execute("ROLLBACK")
                raise

    def advance_stage(self, item_id: int, employee_id: int, stage: str) -> dict:
        """后厨日常推进（无处理单时）。"""
        self._require_role(employee_id, "chef", "manager")
        if stage not in STAGE_STATUS:
            raise ServiceError("stage 必须是 prepping/cooking/plated")
        with self.db.lock:
            self.db.conn.execute("BEGIN IMMEDIATE")
            try:
                item = self._item(item_id)
                self._advance_stage(item, STAGE_STATUS[stage], employee_id)
                self.db.conn.execute("COMMIT")
                return {"ok": True}
            except Exception:
                self.db.conn.execute("ROLLBACK")
                raise

    def _advance_stage(self, item: sqlite3.Row, target: str, actor_id: int,
                       ticket_id: int | None = None, message: str = "") -> None:
        """条件迁移；已出餐/退款/取消的菜不能被回退。"""
        order = {"queued": 0, "prepping": 1, "cooking": 2, "served": 3}
        if item["status"] in ("served", "refunded", "cancelled",
                              "wrong_delivered", "remaking"):
            raise ConflictError(f"菜已「{STAGE_LABEL.get(item['status'], item['status'])}」，不能再进入制作流程")
        if target != "served" and order[target] == order[item["status"]]:
            # 同阶段重复响应：视为再次确认（更新说明），不改变状态、不重复入队
            if ticket_id:
                self._add_event(ticket_id, actor_id, "stage_update",
                                {"stage": target, "message": message,
                                 "reaffirm": True})
            return
        if target != "served" and order[target] < order[item["status"]]:
            raise ConflictError(f"菜已处于「{STAGE_LABEL.get(item['status'], item['status'])}」，不能回退")
        if target == "served":
            cur = self.db.conn.execute(
                """UPDATE order_items SET status='served', delivered_at=?
                   WHERE id=? AND status IN ('queued','prepping','cooking','remaking')""",
                (now(), item["id"]))
            if cur.rowcount == 0:
                raise ConflictError("出餐竞争失败：该菜已不在可出餐状态（可能已退款/取消）")
        else:
            cur = self.db.conn.execute(
                "UPDATE order_items SET status=? WHERE id=? AND status IN ('queued','prepping','cooking')",
                (target, item["id"]))
            if cur.rowcount == 0:
                raise ConflictError(f"无法推进到 {target}：当前状态 {item['status']}")
        if ticket_id:
            self._add_event(ticket_id, actor_id, "stage_update",
                            {"stage": target, "message": message})

    # ================================================================ 退菜/重做

    def open_return(self, item_id: int, employee_id: int, reason_code: str,
                    note: str = "", liability: str | None = None) -> dict:
        """前厅记录退菜/问题单，必须关联原订单项与当前制作阶段。
        责任默认按原因规则，经理可在请求中改判；服务员无权改判。"""
        self._require_role(employee_id, "waiter", "manager")
        if reason_code not in REASON_RULES:
            raise ServiceError("未知原因")
        rule = REASON_RULES[reason_code]
        liab = liability or rule["liability"]
        emp = self._employee(employee_id)
        if emp["role"] != "manager" and liability and liability != rule["liability"]:
            raise AuthError("只有值班经理可以改判责任")
        with self.db.lock:
            self.db.conn.execute("BEGIN IMMEDIATE")
            try:
                result = self._insert_return(item_id, employee_id, reason_code,
                                             note, liab)
                self.db.conn.execute("COMMIT")
                return result
            except Exception:
                self.db.conn.execute("ROLLBACK")
                raise

    def _insert_return(self, item_id: int, employee_id: int, reason_code: str,
                       note: str, liab: str) -> dict:
        """调用方必须已持锁并开启事务。"""
        item = self._item(item_id)
        root = self._root(item)
        dup = self.db.conn.execute(
            """SELECT id FROM tickets
               WHERE item_id=? AND kind='return' AND status IN ('open','acknowledged')""",
            (root,)).fetchone()
        if dup:
            raise ConflictError("该菜已有未处理的退菜单")
        # 过敏：下单时备注已写明过敏原而厨房仍出餐 -> 后厨；
        # 服务员压根没记录 -> 前厅
        if reason_code == "allergy_missed":
            liab = "kitchen" if item["note"] else "floor"
        cur = self.db.conn.execute(
            """INSERT INTO tickets (item_id,kind,reason_code,liability,
                  note,status,created_by,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (root, "return", reason_code, liab, note, "open", employee_id, now()))
        ticket_id = cur.lastrowid
        self._add_event(ticket_id, employee_id, "created",
                        {"stage": item["status"], "note": note})
        return {"ticket_id": ticket_id, "liability": liab,
                "stage": item["status"]}

    def mark_wrong_delivery(self, item_id: int, employee_id: int,
                            note: str = "") -> dict:
        """错上桌：菜已端出但上错桌/上错菜。前厅责任，客人不为错菜买单，
        错菜成本计入内部损耗（前厅责任）。"""
        self._require_role(employee_id, "waiter", "manager")
        with self.db.lock:
            self.db.conn.execute("BEGIN IMMEDIATE")
            try:
                item = self._item(item_id)
                cur = self.db.conn.execute(
                    """UPDATE order_items SET status='wrong_delivered', delivered_at=COALESCE(delivered_at,?)
                       WHERE id=? AND status IN ('cooking','prepping','queued','served')""",
                    (now(), item_id))
                if cur.rowcount == 0:
                    raise ConflictError(f"当前状态 {item['status']} 不能标记错上桌")
                self.db.conn.execute(
                    """INSERT INTO charges (item_id,approval_id,kind,amount_cents,
                          reason_code,created_at)
                       VALUES (?,NULL,'dish_cost',?,'wrong_table',?)""",
                    (item_id, item["price_cents"], now()))
                result = self._insert_return(item_id, employee_id, "wrong_table",
                                             note, "floor")
                self.db.conn.execute("COMMIT")
                return result
            except Exception:
                self.db.conn.execute("ROLLBACK")
                raise

    def start_remake(self, ticket_id: int, employee_id: int,
                     message: str = "") -> dict:
        """发起重做：原项冻结为 remaking，生成一份新菜入队（仅一次）。
        重做菜按原单位置（桌号/客位/顺序）展示，带重做标记。"""
        self._require_role(employee_id, "waiter", "chef", "manager")
        with self.db.lock:
            self.db.conn.execute("BEGIN IMMEDIATE")
            try:
                result = self._start_remake_tx(ticket_id, employee_id, message)
                self.db.conn.execute("COMMIT")
                return result
            except Exception:
                self.db.conn.execute("ROLLBACK")
                raise

    def _start_remake_tx(self, ticket_id: int, employee_id: int,
                         message: str = "") -> dict:
        """调用方必须已持锁并开启事务。"""
        ticket = self.db.conn.execute(
            "SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
        if not ticket:
            raise NotFound("处理单不存在")
        if ticket["kind"] != "return":
            raise ServiceError("只有退菜单可以重做")
        item = self._item(ticket["item_id"])
        root_id = self._root(item)

        max_seq = self.db.conn.execute(
            "SELECT COALESCE(MAX(remake_seq),0) s FROM order_items WHERE id=? OR root_item_id=?",
            (root_id, root_id)).fetchone()["s"]
        next_seq = max_seq + 1
        already = self.db.conn.execute(
            """SELECT 1 FROM ticket_events
               WHERE ticket_id=? AND type='remake_started' LIMIT 1""",
            (ticket_id,)).fetchone()
        if already:
            raise ConflictError("该处理单已发起重做，后厨队列中已有重做菜")

        if item["status"] not in ACTIVE_KITCHEN + DELIVERED + ("remaking",):
            raise ConflictError(f"状态 {item['status']} 不可重做")

        cur = self.db.conn.execute(
            """INSERT INTO order_items (order_id,dish_id,seat_no,qty,
                  price_cents,note,status,root_item_id,remake_seq,queued_at)
               SELECT order_id,dish_id,seat_no,qty,price_cents,note,
                      'queued', ?, ?, ?
               FROM order_items WHERE id=?""",
            (root_id, next_seq, now(), item["id"]))
        new_id = cur.lastrowid
        self.db.conn.execute(
            """UPDATE order_items SET status='remaking'
               WHERE id=? AND status!='refunded'""", (item["id"],))
        self.db.conn.execute(
            """INSERT INTO charges (item_id,approval_id,kind,amount_cents,
                  reason_code,created_at)
               VALUES (?,NULL,'dish_cost',?,?,?)""",
            (item["id"], item["price_cents"], ticket["reason_code"], now()))
        self._add_event(ticket_id, employee_id, "remake_started",
                        {"new_item_id": new_id, "seq": next_seq,
                         "liability": ticket["liability"], "message": message})
        self.db.conn.execute(
            "UPDATE tickets SET status='acknowledged' WHERE id=?", (ticket_id,))
        return {"new_item_id": new_id, "remake_seq": next_seq}

    def _live_item(self, root_id: int) -> sqlite3.Row | None:
        """重做链上当前真正在制的那份（原项可能已冻结为 remaking）。"""
        row = self.db.conn.execute(
            """SELECT id FROM order_items
               WHERE (id=? OR root_item_id=?)
                 AND status IN ('queued','prepping','cooking')
               ORDER BY remake_seq DESC, id DESC LIMIT 1""",
            (root_id, root_id)).fetchone()
        return self._item(row["id"]) if row else None

    def last_ticket(self, item_id: int, kind: str) -> int | None:
        """某订单项最新一条某类处理单（测试/播种辅助）。"""
        row = self.db.conn.execute(
            "SELECT id FROM tickets WHERE item_id=? AND kind=? ORDER BY id DESC LIMIT 1",
            (item_id, kind)).fetchone()
        return row["id"] if row else None

    # ================================================================ 读模型

    # ------------------------------------------------------- 取消（未出餐）

    def cancel_before_serve(self, ticket_id: int, employee_id: int) -> dict:
        """未出餐取消。已开火（cooking 起）因客人原因取消时是否保留收费，
        必须经理审批；非客人责任直接免单。"""
        self._require_role(employee_id, "waiter", "manager")
        with self.db.lock:
            self.db.conn.execute("BEGIN IMMEDIATE")
            try:
                ticket = self.db.conn.execute(
                    "SELECT * FROM tickets WHERE id=?", (ticket_id,)).fetchone()
                if not ticket:
                    raise NotFound("处理单不存在")
                item = self._item(ticket["item_id"])
                if item["status"] not in ACTIVE_KITCHEN:
                    raise ConflictError(f"状态 {item['status']} 不适用出餐前取消")
                rule = REASON_RULES[ticket["reason_code"]]
                cooked = item["status"] in ("cooking",)
                # 客人离席且已开火 -> 菜品费用需经理裁量，服务员不能直接免
                if cooked and (ticket["liability"] == "guest" or rule["served_policy"] == "charge"):
                    raise ServiceError("已烹制且客人责任：请提交经理审批收费/减免")
                cur = self.db.conn.execute(
                    "UPDATE order_items SET status='cancelled' WHERE id=? AND status IN ('queued','prepping','cooking')",
                    (item["id"],))
                if cur.rowcount == 0:
                    raise ConflictError("取消竞争失败：菜可能已出餐")
                self._add_event(ticket_id, employee_id, "resolve",
                                {"outcome": "cancel_no_charge"})
                self.db.conn.execute(
                    "UPDATE tickets SET status='resolved', resolved_at=? WHERE id=?",
                    (now(), ticket_id))
                self.db.conn.execute("COMMIT")
                return {"ok": True, "charged": False}
            except Exception:
                self.db.conn.execute("ROLLBACK")
                raise

    # ================================================================ 审批

    def request_approval(self, item_id: int, employee_id: int, request_kind: str,
                         reason_code: str, amount_cents: int,
                         idempotency_key: str | None = None,
                         note: str = "") -> dict:
        """提交退款/减免/收费审批。服务员可以发起，绝不能自行批准。"""
        emp = self._require_role(employee_id, "waiter", "manager")
        if request_kind not in ("refund", "remake", "cancel"):
            raise ServiceError("request_kind 必须是 refund/remake/cancel")
        if amount_cents < 0:
            raise ServiceError("金额不能为负")
        item = self._item(item_id)
        if amount_cents > item["price_cents"]:
            raise ServiceError("调整金额不能超过菜价")
        key = idempotency_key or f"req:{item_id}:{request_kind}:{amount_cents}:{uuid.uuid4().hex[:8]}"
        with self.db.lock:
            try:
                cur = self.db.conn.execute(
                    """INSERT INTO approvals (ticket_id,item_id,request_kind,
                          amount_cents,reason_code,idempotency_key,status,
                          requested_by,created_at,manager_note)
                       VALUES (NULL,?,?,?,?,?, 'pending', ?,?,?)""",
                    (item_id, request_kind, amount_cents, reason_code, key,
                     employee_id, now(), note))
                return {"approval_id": cur.lastrowid, "idempotency_key": key}
            except sqlite3.IntegrityError:
                row = self.db.conn.execute(
                    "SELECT * FROM approvals WHERE idempotency_key=?", (key,)).fetchone()
                return {"approval_id": row["id"], "idempotency_key": key, "replayed": True}

    def list_pending_approvals(self, employee_id: int) -> list[dict]:
        self._require_role(employee_id, "manager")
        rows = self.db.conn.execute(
            """SELECT a.*, i.price_cents item_price, d.name dish_name,
                      t.code table_code, e.name requester
               FROM approvals a
               JOIN order_items i ON i.id=a.item_id
               JOIN dishes d ON d.id=i.dish_id
               JOIN orders o ON o.id=i.order_id
               JOIN tables t ON t.id=o.table_id
               JOIN employees e ON e.id=a.requested_by
               WHERE a.status='pending' ORDER BY a.id""").fetchall()
        return [dict(r) for r in rows]

    def decide_approval(self, approval_id: int, manager_id: int, approve: bool,
                        manager_note: str = "") -> dict:
        """经理审批。批准退款时原子执行：条件状态迁移 + 退款 + 打印，全幂等。"""
        self._require_role(manager_id, "manager")
        with self.db.lock:
            self.db.conn.execute("BEGIN IMMEDIATE")
            try:
                ap = self.db.conn.execute(
                    "SELECT * FROM approvals WHERE id=?", (approval_id,)).fetchone()
                if not ap:
                    raise NotFound("审批单不存在")
                if ap["status"] != "pending":
                    # 幂等：重复审批直接回放原结果，绝不二次退款
                    return {"approval_id": approval_id, "status": ap["status"],
                            "replayed": True}
                if not approve:
                    self.db.conn.execute(
                        """UPDATE approvals SET status='rejected', decided_by=?,
                           decided_at=?, manager_note=? WHERE id=?""",
                        (manager_id, now(), manager_note, approval_id))
                    self.db.conn.execute("COMMIT")
                    return {"approval_id": approval_id, "status": "rejected"}

                item = self._item(ap["item_id"])
                kind = ap["request_kind"]
                amount = ap["amount_cents"]

                if kind == "refund":
                    # 核心并发守卫：只有已出餐的菜才能退款；
                    # 与出餐竞争时条件 UPDATE 失败 -> 409，不会既交付又全退
                    cur = self.db.conn.execute(
                        """UPDATE order_items SET status='refunded'
                           WHERE id=? AND status='served'""", (item["id"],))
                    if cur.rowcount == 0:
                        if item["status"] in ACTIVE_KITCHEN:
                            raise ConflictError(
                                "菜尚未出餐：应走「出餐前取消」而非全额退款；"
                                "若出餐与退款并发，请刷新后重新裁决")
                        raise ConflictError(
                            f"菜当前为 {item['status']}，不能全额退款")
                    refund_key = f"refund:{approval_id}"
                    receipt = self.pay.refund(amount, approval_id, refund_key,
                                              memo=ap["reason_code"])
                    self.db.conn.execute(
                        """INSERT INTO charges (item_id,approval_id,kind,
                              amount_cents,reason_code,created_at)
                           VALUES (?,?, 'refund', ?,?,?)""",
                        (item["id"], approval_id, -amount, ap["reason_code"], now()))
                    self.printer.print_slip(
                        "退款凭证",
                        [f"桌号 {item['table_code']}", f"菜品 {item['dish_name']}",
                         f"原因 {REASON_LABEL[ap['reason_code']]}",
                         f"退款 {-amount/100:.2f} 元",
                         f"支付单号 {receipt['external_ref']}"],
                        approval_id, f"print:{approval_id}")
                    self._close_tickets_for_item(item["id"], manager_id, "refunded")

                elif kind == "cancel":
                    # 已开火客人责任取消：按经理批准金额保留收费（正调整）
                    cur = self.db.conn.execute(
                        """UPDATE order_items SET status='cancelled'
                           WHERE id=? AND status IN ('queued','prepping','cooking')""",
                        (item["id"],))
                    if cur.rowcount == 0:
                        raise ConflictError("菜已出餐，取消不成立，请改走退款流程")
                    if amount > 0:
                        self.db.conn.execute(
                            """INSERT INTO charges (item_id,approval_id,kind,
                                  amount_cents,reason_code,created_at)
                               VALUES (?,?,'dish_charge',?,?,?)""",
                            (item["id"], approval_id, amount, ap["reason_code"], now()))
                    self._close_tickets_for_item(item["id"], manager_id, "cancel")

                else:  # remake：经理批准的重做（如责任分摊时）
                    ticket = self.db.conn.execute(
                        """SELECT id FROM tickets WHERE item_id=? AND kind='return'
                           ORDER BY id DESC LIMIT 1""", (item["id"],)).fetchone()
                    if not ticket:
                        raise ServiceError("缺少退菜处理单")
                    self._start_remake_tx(ticket["id"], manager_id,
                                          message=manager_note)

                self.db.conn.execute(
                    """UPDATE approvals SET status='approved', decided_by=?,
                       decided_at=?, manager_note=? WHERE id=?""",
                    (manager_id, now(), manager_note, approval_id))
                self.db.conn.execute("COMMIT")
                return {"approval_id": approval_id, "status": "approved",
                        "kind": kind, "amount_cents": amount}
            except Exception:
                self.db.conn.execute("ROLLBACK")
                raise

    def _close_tickets_for_item(self, item_id: int, actor_id: int, outcome: str) -> None:
        root = self._root(self._item(item_id))
        ids = [r["id"] for r in self.db.conn.execute(
            "SELECT id FROM tickets WHERE item_id=? AND status IN ('open','acknowledged')",
            (root,))]
        for tid in ids:
            self._add_event(tid, actor_id, "resolve", {"outcome": outcome})
            self.db.conn.execute(
                "UPDATE tickets SET status='resolved', resolved_at=? WHERE id=?",
                (now(), tid))

    def ticket_timeline(self, ticket_id: int) -> list[dict]:
        rows = self.db.conn.execute(
            """SELECT e.*, emp.name actor, emp.role
               FROM ticket_events e JOIN employees emp ON emp.id=e.actor_id
               WHERE e.ticket_id=? ORDER BY e.id""", (ticket_id,)).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["payload"] = json.loads(d["payload"] or "{}")
            out.append(d)
        return out

    def floor_view(self) -> dict:
        """前厅：按桌号聚合，突出等待时长、催单时间线与费用。"""
        tables = {}
        for t in self.db.conn.execute(
                "SELECT * FROM tables ORDER BY code"):
            tables[t["id"]] = {"table_id": t["id"], "table_code": t["code"],
                               "items": [], "open_tickets": []}
        items = self.db.conn.execute(
            """SELECT i.*, d.name dish_name, d.allergen, t.id table_id, t.code table_code
               FROM order_items i
               JOIN dishes d ON d.id=i.dish_id
               JOIN orders o ON o.id=i.order_id
               JOIN tables t ON t.id=o.table_id
               WHERE i.root_item_id IS NULL
               ORDER BY o.table_id, i.id""").fetchall()
        for it in items:
            d = self._item_chain(it["id"])
            tables[it["table_id"]]["items"].append(d)
        tickets = self.db.conn.execute(
            """SELECT tk.*, e.name creator, t.id table_id, t.code table_code,
                      i.id link_item, d.name dish_name
               FROM tickets tk
               JOIN employees e ON e.id=tk.created_by
               JOIN order_items i ON i.id=tk.item_id
               JOIN dishes d ON d.id=i.dish_id
               JOIN orders o ON o.id=i.order_id
               JOIN tables t ON t.id=o.table_id
               WHERE tk.status IN ('open','acknowledged')
               ORDER BY tk.created_at""").fetchall()
        for tk in tickets:
            d = dict(tk)
            d["events"] = self.ticket_timeline(tk["id"])
            d["reason_label"] = REASON_LABEL[tk["reason_code"]]
            d["liability_label"] = LIABILITY_LABEL[tk["liability"]]
            tables[tk["table_id"]]["open_tickets"].append(d)
        out = []
        for tbl in tables.values():
            waits = [x["wait_seconds"] for x in tbl["items"]
                     if x["live_status"] in ACTIVE_KITCHEN or x["has_open_urge"]]
            tbl["max_wait_seconds"] = max(waits, default=0)
            tbl["bill_cents"] = self._table_bill(tbl["table_id"])
            out.append(tbl)
        return {"tables": sorted(out, key=lambda x: x["table_code"])}

    def _item_chain(self, root_id: int) -> dict:
        """把一条重做链压成一张前厅卡片：当前在制那份 + 时间线版本号。"""
        root = self._item(root_id)
        chain = self.db.conn.execute(
            "SELECT * FROM order_items WHERE root_item_id=? OR id=? ORDER BY remake_seq, id",
            (root_id, root_id)).fetchall()
        current = chain[-1]
        cur_full = self._item(current["id"])
        d = dict(cur_full)
        d["root_item_id"] = root_id
        d["remake_total"] = len(chain) - 1
        d["wait_seconds"] = (wait_seconds(current["queued_at"])
                             if current["status"] in ACTIVE_KITCHEN else 0)
        d["status_label"] = STAGE_LABEL.get(current["status"], current["status"])
        d["has_open_urge"] = bool(self.db.conn.execute(
            """SELECT 1 FROM tickets WHERE item_id=? AND kind='urge'
               AND status IN ('open','acknowledged') LIMIT 1""",
            (root_id,)).fetchone())
        d["live_status"] = current["status"]
        return d

    def _table_bill(self, table_id: int) -> int:
        """客人账单：已出餐菜价（含已退款的，其在退款行冲抵）+ 保留收费 + 退款，
        内部重做成本(dish_cost)不计入向客人收取。"""
        row = self.db.conn.execute(
            """SELECT COALESCE(SUM(
                 CASE WHEN i.status IN ('served','refunded') THEN i.price_cents ELSE 0 END),0) items_sum
               FROM order_items i JOIN orders o ON o.id=i.order_id
               WHERE o.table_id=? AND i.root_item_id IS NULL""", (table_id,)).fetchone()
        adj = self.db.conn.execute(
            """SELECT COALESCE(SUM(
                 CASE WHEN c.kind!='dish_cost' THEN c.amount_cents ELSE 0 END),0) s
               FROM charges c JOIN order_items i ON i.id=c.item_id
               JOIN orders o ON o.id=i.order_id
               WHERE o.table_id=?""", (table_id,)).fetchone()
        return row["items_sum"] + adj["s"]

    def kitchen_view(self) -> dict:
        """后厨屏：在制菜按档口排列；重做菜按原单位置显示重做标记。"""
        stations = {}
        rows = self.db.conn.execute(
            """SELECT i.*, d.name dish_name, d.station, d.allergen,
                      t.code table_code, e.name waiter_name
               FROM order_items i
               JOIN dishes d ON d.id=i.dish_id
               JOIN orders o ON o.id=i.order_id
               JOIN tables t ON t.id=o.table_id
               JOIN employees e ON e.id=o.waiter_id
               WHERE i.status IN ('queued','prepping','cooking')
               ORDER BY i.queued_at""").fetchall()
        for r in rows:
            i = dict(r)
            root = self._item(i["root_item_id"] or i["id"])
            i["wait_seconds"] = wait_seconds(i["queued_at"])
            i["status_label"] = STAGE_LABEL[i["status"]]
            i["is_remake"] = bool(i["root_item_id"])
            i["origin"] = {
                "table_code": root["table_code"], "seat_no": root["seat_no"],
                "root_item_id": root["root_item_id"] or root["id"],
                "remake_seq": i["remake_seq"],
            }
            i["allergen_alert"] = i["allergen"] or (i["note"] if "过敏" in (i["note"] or "") else "")
            tickets = self.db.conn.execute(
                """SELECT tk.* FROM tickets tk
                   WHERE tk.item_id=? AND tk.status IN ('open','acknowledged')
                   ORDER BY tk.id""",
                (i["root_item_id"] or i["id"],)).fetchall()
            i["tickets"] = []
            for tk in tickets:
                t = dict(tk)
                t["reason_label"] = REASON_LABEL[tk["reason_code"]]
                t["events"] = self.ticket_timeline(tk["id"])
                i["tickets"].append(t)
            stations.setdefault(i["station"], []).append(i)
        return {"stations": [{"station": s, "items": v}
                             for s, v in sorted(stations.items())]}

    def charges_view(self) -> list[dict]:
        """费用调整与原因紧邻（经理屏）。"""
        rows = self.db.conn.execute(
            """SELECT c.*, d.name dish_name, t.code table_code,
                      a.status approval_status
               FROM charges c
               JOIN order_items i ON i.id=c.item_id
               JOIN dishes d ON d.id=i.dish_id
               JOIN orders o ON o.id=i.order_id
               JOIN tables t ON t.id=o.table_id
               LEFT JOIN approvals a ON a.id=c.approval_id
               ORDER BY c.id""").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["reason_label"] = REASON_LABEL[r["reason_code"]]
            d["kind_label"] = {"dish_charge": "保留收费", "dish_cost": "重做成本(内部)",
                               "refund": "退款"}[r["kind"]]
            out.append(d)
        return out
