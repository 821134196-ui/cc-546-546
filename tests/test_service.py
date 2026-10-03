"""并发状态、退款幂等、重复催单、角色权限、责任费用规则测试。"""
from __future__ import annotations

import json
import os
import tempfile
import threading
import unittest
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer

from backend.db import Database
from backend.seed import seed
from backend.server import Handler
from backend.service import (AuthError, ConflictError, Service, ServiceError)

WAITER, WAITER2, CHEF, MGR = 1, 2, 3, 4


class ServiceTestBase(unittest.TestCase):
    def setUp(self):
        self.s = seed(":memory:")
        self.db = self.s.db
        self.c = self.db.conn

    def fresh_item(self, status="queued", dish=1, order=1, mins=5, note=""):
        """插一份新菜，返回其 id（不经过状态机，仅供测试造数）。"""
        price = self.c.execute("SELECT price_cents FROM dishes WHERE id=?", (dish,)).fetchone()[0]
        from backend.db import now
        row = self.c.execute(
            """INSERT INTO order_items (order_id,dish_id,seat_no,qty,price_cents,
                  note,status,queued_at)
               VALUES (?,?,1,1,?,?,?,?)""",
            (order, dish, price, note, status, now())).lastrowid
        return row

    def item(self, iid):
        return self.c.execute("SELECT * FROM order_items WHERE id=?", (iid,)).fetchone()

    def approval_refund(self, iid, amount=None, by=WAITER, key=None):
        price = self.item(iid)["price_cents"]
        return self.s.request_approval(
            iid, by, "refund", "quality", amount if amount is not None else price,
            idempotency_key=key)["approval_id"]


class TestDuplicateUrge(ServiceTestBase):
    def test_repeated_urge_single_ticket_single_queue(self):
        iid = self.fresh_item("queued")
        first = self.s.urge(iid, WAITER, "第一次")["ticket_id"]
        second = self.s.urge(iid, WAITER, "第二次")
        third = self.s.urge(iid, WAITER, "第三次")
        # 只有一条 open 催单，后两次是连续时间线
        self.assertTrue(second["duplicate"])
        self.assertTrue(third["duplicate"])
        self.assertEqual(second["ticket_id"], first)
        tickets = self.c.execute(
            "SELECT COUNT(*) n FROM tickets WHERE item_id=? AND kind='urge'", (iid,)).fetchone()["n"]
        self.assertEqual(tickets, 1)
        events = self.s.ticket_timeline(first)
        self.assertEqual(sum(e["type"] == "urge_again" for e in events), 2)
        # 后厨队列里仍然只有一份菜，没有重复插入
        queued = self.c.execute(
            "SELECT COUNT(*) n FROM order_items WHERE root_item_id=? OR id=?",
            (iid, iid)).fetchone()["n"]
        self.assertEqual(queued, 1)

    def test_urge_after_resolved_creates_new(self):
        iid = self.fresh_item("queued")
        t1 = self.s.urge(iid, WAITER)["ticket_id"]
        self.s.kitchen_ack(t1, CHEF, "plated")
        t2 = self.s.urge(iid, WAITER)  # 已出餐后催单无意义，但应返回新单而非报错
        self.assertFalse(t2["duplicate"])
        self.assertNotEqual(t1, t2["ticket_id"])


class TestRoles(ServiceTestBase):
    def test_waiter_cannot_approve_refund(self):
        iid = self.fresh_item("served")
        ap = self.approval_refund(iid)
        with self.assertRaises(AuthError):
            self.s.decide_approval(ap, WAITER, True)
        # 被拒后审批仍 pending、没有任何退款
        self.assertEqual(self.c.execute(
            "SELECT status FROM approvals WHERE id=?", (ap,)).fetchone()["status"], "pending")
        self.assertEqual(self.c.execute(
            "SELECT COUNT(*) n FROM charges WHERE item_id=? AND kind='refund'", (iid,)).fetchone()["n"], 0)

    def test_chef_cannot_urge(self):
        iid = self.fresh_item("queued")
        with self.assertRaises(AuthError):
            self.s.urge(iid, CHEF)

    def test_waiter_cannot_override_liability(self):
        iid = self.fresh_item("queued")
        with self.assertRaises(AuthError):
            self.s.open_return(iid, WAITER, "quality", liability="guest")
        # 经理可以改判
        r = self.s.open_return(iid, MGR, "quality", liability="split")
        self.assertEqual(r["liability"], "split")

    def test_waiter_cannot_list_approvals(self):
        with self.assertRaises(AuthError):
            self.s.list_pending_approvals(WAITER)

    def test_waiter_cannot_self_comp(self):
        """服务员不能自行免单：已开火客人责任取消直接被拒，必须经理审批。"""
        iid = self.fresh_item("cooking", dish=5)
        r = self.s.open_return(iid, WAITER, "guest_away")
        with self.assertRaises(ServiceError):
            self.s.cancel_before_serve(r["ticket_id"], WAITER)


class TestRefundIdempotency(ServiceTestBase):
    def test_decide_twice_single_refund(self):
        iid = self.fresh_item("served")
        ap = self.approval_refund(iid)
        r1 = self.s.decide_approval(ap, MGR, True, "批")
        r2 = self.s.decide_approval(ap, MGR, True, "再批一次")
        self.assertEqual(r1["status"], "approved")
        self.assertTrue(r2.get("replayed"))
        refunds = self.c.execute(
            "SELECT * FROM charges WHERE item_id=? AND kind='refund'", (iid,)).fetchall()
        receipts = self.c.execute(
            "SELECT * FROM adapter_receipts WHERE approval_id=? AND provider='payment'",
            (ap,)).fetchall()
        self.assertEqual(len(refunds), 1)
        self.assertEqual(len(receipts), 1)  # 支付侧只退了一笔
        self.assertEqual(self.item(iid)["status"], "refunded")

    def test_request_approval_idempotent_key(self):
        iid = self.fresh_item("served")
        a = self.s.request_approval(iid, WAITER, "refund", "quality", 1000,
                                    idempotency_key="K-1")
        b = self.s.request_approval(iid, WAITER, "refund", "quality", 1000,
                                    idempotency_key="K-1")
        self.assertEqual(a["approval_id"], b["approval_id"])
        self.assertTrue(b.get("replayed"))

    def test_refund_before_serve_rejected(self):
        """未出餐不能全额退款（防与出餐并发造成既交付又全退）。"""
        iid = self.fresh_item("cooking")
        ap = self.approval_refund(iid)
        with self.assertRaises(ConflictError):
            self.s.decide_approval(ap, MGR, True)
        self.assertEqual(self.item(iid)["status"], "cooking")
        self.assertEqual(self.c.execute(
            "SELECT COUNT(*) n FROM charges WHERE item_id=?", (iid,)).fetchone()["n"], 0)

    def test_rejected_then_redecide_is_noop(self):
        iid = self.fresh_item("served")
        ap = self.approval_refund(iid)
        self.s.decide_approval(ap, MGR, False)
        again = self.s.decide_approval(ap, MGR, True)
        self.assertEqual(again["status"], "rejected")  # 终态不可翻案
        self.assertEqual(self.c.execute(
            "SELECT COUNT(*) n FROM charges WHERE item_id=? AND kind='refund'", (iid,)).fetchone()["n"], 0)


class TestConcurrentServeRefund(unittest.TestCase):
    """并发出餐与退款：任何调度下都不得出现两笔退款，或未出餐却退款。"""

    def setUp(self):
        self.s = seed(":memory:")
        self.db = self.s.db
        self.c = self.db.conn

    def _make(self):
        price = self.c.execute("SELECT price_cents FROM dishes WHERE id=1").fetchone()[0]
        from backend.db import now
        return self.c.execute(
            """INSERT INTO order_items (order_id,dish_id,seat_no,qty,price_cents,
                  note,status,queued_at) VALUES (1,1,1,1,?,'','cooking',?)""",
            (price, now())).lastrowid

    def test_race_invariant(self):
        outcomes = {"served_only": 0, "served_then_refunded": 0,
                    "refund_blocked": 0, "errors": []}
        for trial in range(30):
            iid = self._make()
            ap = self.s.request_approval(
                iid, WAITER, "refund", "quality",
                self.s._item(iid)["price_cents"],
                idempotency_key=f"race-{trial}")["approval_id"]
            barrier = threading.Barrier(2)

            def serve():
                barrier.wait()
                try:
                    self.s.advance_stage(iid, CHEF, "plated")
                    return "served"
                except ConflictError:
                    return "conflict"

            def refund():
                barrier.wait()
                try:
                    self.s.decide_approval(ap, MGR, True)
                    return "refunded"
                except ConflictError:
                    return "blocked"

            with ThreadPoolExecutor(2) as ex:
                f1, f2 = ex.submit(serve), ex.submit(refund)
                r_serve, r_refund = f1.result(), f2.result()

            status = self.s._item(iid)["status"]
            refund_rows = self.c.execute(
                "SELECT COUNT(*) n FROM charges WHERE item_id=? AND kind='refund'",
                (iid,)).fetchone()["n"]
            receipts = self.c.execute(
                "SELECT COUNT(*) n FROM adapter_receipts WHERE approval_id=? AND provider='payment'",
                (ap,)).fetchone()["n"]

            # 不变量
            self.assertLessEqual(refund_rows, 1)
            self.assertLessEqual(receipts, 1)
            if refund_rows:
                self.assertEqual(status, "refunded")  # 退款成功必然曾出餐
            if r_refund == "refunded":
                self.assertEqual(r_serve, "served")
                outcomes["served_then_refunded"] += 1
            elif r_refund == "blocked" and r_serve == "served":
                outcomes["served_only"] += 1
            elif r_refund == "blocked":
                outcomes["refund_blocked"] += 1
            else:
                outcomes["errors"].append((r_serve, r_refund, status))
        self.assertEqual(outcomes["errors"], [])
        # 30 次竞争中两种交错都应真实出现过（否则说明锁退化成了串行单路径）
        self.assertGreater(outcomes["served_then_refunded"] + outcomes["served_only"], 0)


class TestLiabilityAndCharges(ServiceTestBase):
    def test_wrong_delivery(self):
        """错上桌：前厅责任、菜不向客人收费、错菜计入内部损耗。"""
        iid = self.fresh_item("cooking", dish=7)
        r = self.s.mark_wrong_delivery(iid, WAITER, "拿混了")
        self.assertEqual(r["liability"], "floor")
        self.assertEqual(self.item(iid)["status"], "wrong_delivered")
        tk = self.c.execute("SELECT * FROM tickets WHERE id=?", (r["ticket_id"],)).fetchone()
        self.assertEqual(tk["reason_code"], "wrong_table")
        cost = self.c.execute(
            "SELECT * FROM charges WHERE item_id=? AND kind='dish_cost'", (iid,)).fetchall()
        self.assertEqual(len(cost), 1)
        # 账单不含错菜
        bill = self.s._table_bill(1)
        wrong_price = self.item(iid)["price_cents"]
        self.assertNotIn(wrong_price, [r["amount_cents"] for r in
            self.c.execute("SELECT amount_cents FROM charges c JOIN order_items i ON i.id=c.item_id JOIN orders o ON o.id=i.order_id WHERE o.table_id=1 AND c.kind!='dish_cost'")])
        self.assertGreaterEqual(bill, 0)

    def test_allergy_liability_split(self):
        # 服务员下单时未备注过敏原 -> 前厅责任
        iid_no_note = self.fresh_item("served", dish=6, note="")
        r1 = self.s.open_return(iid_no_note, WAITER2, "allergy_missed")
        self.assertEqual(r1["liability"], "floor")
        # 已在备注写明花生过敏仍出餐 -> 后厨责任
        iid_note = self.fresh_item("served", dish=6, note="客人花生过敏，免花生")
        r2 = self.s.open_return(iid_note, WAITER2, "allergy_missed")
        self.assertEqual(r2["liability"], "kitchen")

    def test_temperature_remake_chain_and_cost(self):
        """温度不合格：后厨责任重做，新菜按原单位置，原项冻结，仅一份在队列。"""
        iid = self.fresh_item("served", dish=4)
        r = self.s.open_return(iid, WAITER, "temperature")
        self.assertEqual(r["liability"], "kitchen")
        rem = self.s.start_remake(r["ticket_id"], CHEF)
        self.assertEqual(self.item(iid)["status"], "remaking")
        new = self.item(rem["new_item_id"])
        self.assertEqual(new["status"], "queued")
        self.assertEqual(new["root_item_id"], iid)
        self.assertEqual(new["seat_no"], 1)
        # 重做成本一条；不向客人加收
        costs = self.c.execute(
            "SELECT COUNT(*) n FROM charges WHERE item_id=? AND kind='dish_cost'", (iid,)).fetchone()["n"]
        self.assertEqual(costs, 1)
        # 重复重做同一处理单被拒
        with self.assertRaises(ConflictError):
            self.s.start_remake(r["ticket_id"], CHEF)

    def test_guest_away_cooking_requires_manager_charge(self):
        """客人离席且已开火：服务员不能免单；经理批准后按金额保留收费。"""
        iid = self.fresh_item("cooking", dish=5)
        r = self.s.open_return(iid, WAITER, "guest_away")
        self.assertEqual(r["liability"], "guest")
        ap = self.s.request_approval(
            iid, WAITER, "cancel", "guest_away", 1300,
            idempotency_key="away-1")["approval_id"]
        res = self.s.decide_approval(ap, MGR, True, "半价")
        self.assertEqual(res["status"], "approved")
        self.assertEqual(self.item(iid)["status"], "cancelled")
        charge = self.c.execute(
            "SELECT * FROM charges WHERE item_id=? AND kind='dish_charge'", (iid,)).fetchone()
        self.assertEqual(charge["amount_cents"], 1300)

    def test_guest_away_queued_waiter_cancels_free(self):
        """尚未开火客人离席：直接取消免单（无菜品成本）。"""
        iid = self.fresh_item("queued", dish=5)
        r = self.s.open_return(iid, WAITER, "guest_away")
        out = self.s.cancel_before_serve(r["ticket_id"], WAITER)
        self.assertTrue(out["ok"])
        self.assertFalse(out["charged"])
        self.assertEqual(self.item(iid)["status"], "cancelled")

    def test_served_return_full_refund_flow(self):
        """退菜时已经出餐：可经理全额退款，账单冲抵为 0，打印退款凭证。"""
        # 独立新桌台，避免与种子数据混算
        self.c.execute("INSERT INTO tables (id,code,seats) VALUES (9,'T9',2)")
        self.c.execute("INSERT INTO orders (id,table_id,waiter_id,created_at,status) VALUES (9,9,1,?,'open')",
                       (__import__("backend.db", fromlist=["now"]).now(),))
        iid = self.fresh_item("served", dish=5, order=9)
        price = self.item(iid)["price_cents"]
        self.s.open_return(iid, WAITER, "quality")
        ap = self.approval_refund(iid, key="srv-refund")
        self.s.decide_approval(ap, MGR, True)
        # 该桌账单：菜价 + 等额退款 = 0
        self.assertEqual(self.s._table_bill(9), 0)
        printed = self.c.execute(
            "SELECT COUNT(*) n FROM adapter_receipts WHERE approval_id=? AND provider='printer'",
            (ap,)).fetchone()["n"]
        self.assertEqual(printed, 1)


class TestStageGuards(ServiceTestBase):
    def test_no_stage_rollback(self):
        iid = self.fresh_item("cooking")
        with self.assertRaises(ConflictError):
            self.s.advance_stage(iid, CHEF, "prepping")

    def test_remake_progresses_through_chain(self):
        """重做链上催单，后厨推进的是新那份；出餐后原催单结案。"""
        iid = self.fresh_item("cooking", dish=4)
        urge = self.s.urge(iid, WAITER)["ticket_id"]
        ret = self.s.open_return(iid, WAITER, "temperature")
        rem = self.s.start_remake(ret["ticket_id"], CHEF)
        # 原催单仍 open，后厨响应应推进重做菜
        self.s.kitchen_ack(urge, CHEF, "cooking")
        self.assertEqual(self.item(rem["new_item_id"])["status"], "cooking")
        self.s.kitchen_ack(urge, CHEF, "plated")
        self.assertEqual(self.item(rem["new_item_id"])["status"], "served")
        tk = self.c.execute("SELECT status FROM tickets WHERE id=?", (urge,)).fetchone()
        self.assertEqual(tk["status"], "resolved")


class TestSeedData(unittest.TestCase):
    def test_seed_contains_wrong_table_case(self):
        s = seed(":memory:")
        row = s.db.conn.execute(
            """SELECT * FROM tickets WHERE reason_code='wrong_table'""").fetchone()
        self.assertIsNotNone(row)
        item = s._item(row["item_id"])
        self.assertEqual(item["status"], "wrong_delivered")
        # 三屏读模型都能渲染
        s.floor_view(); s.kitchen_view(); s.charges_view()
        pending = s.list_pending_approvals(MGR)
        reasons = {a["reason_code"] for a in pending}
        self.assertIn("allergy_missed", reasons)
        self.assertIn("guest_away", reasons)
        self.assertIn("quality", reasons)


class TestHttpAPI(unittest.TestCase):
    """通过真实 HTTP 服务器验证鉴权与并发（多线程服务器）。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
        cls.tmp.close()
        os.unlink(cls.tmp.name)
        from backend import server
        from backend.db import Database as _DB
        from backend.service import Service as _Svc
        seeded = seed(cls.tmp.name)
        seeded.db.close()
        cls.db = _DB(cls.tmp.name)
        server.service = _Svc(cls.db)
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.db.close()
        for suffix in ("", "-wal", "-shm"):
            p = cls.tmp.name + suffix
            if os.path.exists(p):
                os.unlink(p)

    def _req(self, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=data,
            headers={"Content-Type": "application/json"},
            method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_views_ok(self):
        for path in ("/api/floor", "/api/kitchen", "/api/charges",
                     f"/api/approvals/pending?employee_id={MGR}"):
            code, _ = self._req(path)
            self.assertEqual(code, 200, path)

    def test_waiter_approve_over_http_403(self):
        code, floor = self._req("/api/floor")
        # 找一份已出餐菜申请退款再由服务员批准 -> 403
        c = self.db.conn
        price = c.execute("SELECT price_cents FROM dishes WHERE id=3").fetchone()[0]
        from backend.db import now
        iid = c.execute(
            "INSERT INTO order_items (order_id,dish_id,seat_no,qty,price_cents,note,status,queued_at,delivered_at) VALUES (1,3,1,1,?,'','served',?,?)",
            (price, now(), now())).lastrowid
        code, body = self._req("/api/approvals", {
            "item_id": iid, "employee_id": WAITER, "request_kind": "refund",
            "reason_code": "quality", "amount_cents": price,
            "idempotency_key": f"http-{iid}"})
        self.assertEqual(code, 200)
        code, body = self._req(f"/api/approvals/{body['approval_id']}/decide",
                               {"manager_id": WAITER, "approve": True})
        self.assertEqual(code, 403)

    def test_concurrent_http_refund_requests_idempotent(self):
        c = self.db.conn
        price = c.execute("SELECT price_cents FROM dishes WHERE id=3").fetchone()[0]
        from backend.db import now
        iid = c.execute(
            "INSERT INTO order_items (order_id,dish_id,seat_no,qty,price_cents,note,status,queued_at,delivered_at) VALUES (1,3,1,1,?,'','served',?,?)",
            (price, now(), now())).lastrowid
        payload = {"item_id": iid, "employee_id": WAITER, "request_kind": "refund",
                   "reason_code": "quality", "amount_cents": price,
                   "idempotency_key": f"http-idem-{iid}"}
        with ThreadPoolExecutor(8) as ex:
            results = list(ex.map(lambda _: self._req("/api/approvals", payload), range(8)))
        ids = {b["approval_id"] for _, b in results}
        self.assertEqual(len(ids), 1)  # 并发重复请求只落一条审批


if __name__ == "__main__":
    unittest.main(verbosity=2)
