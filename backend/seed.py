"""演示数据播种。

每次启动都重建一个干净库，并通过真实 Service 方法走完各业务流程，
因此数据与生产逻辑始终一致（不会绕过状态机）。
包含明确的「错上桌」案例，以及过敏漏看、温度不合格、客人离席、
出餐后退菜、连续催单、重做时间线。
"""
from __future__ import annotations

import os
from datetime import timedelta

from .db import Database, now
from .service import Service

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSET_DIR = os.path.join(ROOT, "assets", "dishes")

# (name, station, price_yuan, allergen, emoji, bg)
DISHES = [
    ("宫保鸡丁", "热炒", 38.00, "花生", "🍗", "#f7e9d7"),
    ("清蒸鲈鱼", "热炒", 68.00, "海鲜", "🐟", "#e3ece4"),
    ("拍黄瓜", "凉菜", 16.00, None, "🥒", "#e7f1e2"),
    ("番茄蛋汤", "汤品", 22.00, "鸡蛋", "🍅", "#fbe3da"),
    ("扬州炒饭", "主食", 26.00, None, "🍚", "#f6f0df"),
    ("口水鸡", "凉菜", 32.00, "花生", "🌶️", "#f7dcd6"),
    ("红烧肉", "热炒", 58.00, None, "🥘", "#f3e0d6"),
]


def _ensure_photos() -> dict[str, str]:
    """生成极简 SVG 演示照片（本地文件，不依赖外网）。"""
    os.makedirs(ASSET_DIR, exist_ok=True)
    paths = {}
    for idx, (name, _station, _price, _alg, emoji, bg) in enumerate(DISHES, 1):
        fname = f"dish_{idx}.svg"
        p = os.path.join(ASSET_DIR, fname)
        svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200">
<rect width="320" height="200" rx="14" fill="{bg}"/>
<circle cx="160" cy="92" r="58" fill="#ffffff" opacity="0.85"/>
<text x="160" y="112" font-size="58" text-anchor="middle">{emoji}</text>
<text x="160" y="178" font-size="20" text-anchor="middle" fill="#22201d"
      font-family="sans-serif">{name}</text>
</svg>"""
        with open(p, "w", encoding="utf-8") as f:
            f.write(svg)
        paths[name] = f"/assets/dishes/{fname}"
    return paths


def seed(db_path: str) -> Service:
    if db_path != ":memory:" and os.path.exists(db_path):
        for suffix in ("", "-wal", "-shm"):
            p = db_path + suffix
            if os.path.exists(p):
                os.remove(p)
    photos = _ensure_photos()
    db = Database(db_path)
    s = Service(db)
    c = db.conn
    t0 = now

    def ago(minutes: float) -> str:
        from datetime import datetime, timezone
        return (datetime.now(timezone.utc) - timedelta(minutes=minutes)
                ).isoformat(timespec="seconds")

    with db.lock:
        c.execute("BEGIN")
        # 员工
        c.executemany(
            "INSERT INTO employees (id,name,role) VALUES (?,?,?)",
            [(1, "小王", "waiter"), (2, "小李", "waiter"),
             (3, "张大厨", "chef"), (4, "陈经理", "manager")])
        # 桌台
        c.executemany("INSERT INTO tables (id,code,seats) VALUES (?,?,?)",
                      [(1, "A1", 4), (2, "A2", 4), (3, "B1", 6)])
        # 菜品
        for i, (name, station, price, alg, _e, _bg) in enumerate(DISHES, 1):
            c.execute(
                "INSERT INTO dishes (id,name,station,price_cents,allergen,photo) VALUES (?,?,?,?,?,?)",
                (i, name, station, int(price * 100), alg, photos[name]))
        # 订单
        c.execute("INSERT INTO orders (id,table_id,waiter_id,created_at,status) VALUES (1,1,1,?,'open')", (ago(25),))
        c.execute("INSERT INTO orders (id,table_id,waiter_id,created_at,status) VALUES (2,2,2,?,'open')", (ago(18),))
        c.execute("INSERT INTO orders (id,table_id,waiter_id,created_at,status) VALUES (3,3,1,?,'open')", (ago(30),))

        def item(iid, oid, did, seat, status, mins, note=""):
            price = c.execute("SELECT price_cents FROM dishes WHERE id=?", (did,)).fetchone()[0]
            c.execute(
                """INSERT INTO order_items (id,order_id,dish_id,seat_no,qty,price_cents,
                      note,status,root_item_id,remake_seq,queued_at,delivered_at)
                   VALUES (?,?,?,?,1,?,?,?,NULL,0,?,?)""",
                (iid, oid, did, seat, price, note, status, ago(mins),
                 ago(mins) if status in ("served",) else None))

        # ---- A1：连续催单（宫保鸡丁）、已上的拍黄瓜、错上桌（红烧肉）
        item(101, 1, 1, 1, "cooking", 13)                 # 宫保鸡丁 烹制中
        item(102, 1, 2, 2, "prepping", 9)                 # 清蒸鲈鱼 已备料
        item(103, 1, 3, 3, "served", 20)                  # 拍黄瓜 已交付
        item(104, 1, 7, 4, "cooking", 7)                  # 红烧肉 -> 错上桌
        # ---- A2：过敏漏看（口水鸡，服务员未记录过敏原）
        item(201, 2, 6, 1, "served", 15, note="")         # 口水鸡 已交付
        item(202, 2, 4, 2, "cooking", 11)                 # 番茄蛋汤 -> 温度不合格重做
        item(203, 2, 5, 3, "cooking", 6)                  # 扬州炒饭 -> 客人临时离席
        # ---- B1：已出餐退菜（质量问题）+ 一笔已完成退款
        item(301, 3, 5, 1, "served", 22)                  # 扬州炒饭 待退
        item(302, 3, 1, 2, "served", 28)                  # 宫保鸡丁 已退过款
        c.execute("COMMIT")

    # ================= 通过 Service 走真实业务流 =================
    WAITER, WAITER2, CHEF, MGR = 1, 2, 3, 4

    # A1-宫保鸡丁：第一次催菜 → 后厨响应“烹制中” → 客人再催（连续时间线，不重复入队）
    s.urge(101, WAITER, "客人问还要多久")
    s.kitchen_ack(s.last_ticket(101, "urge"), CHEF, "cooking", "大火收汁中，约 3 分钟")
    s.urge(101, WAITER, "客人第二次催")
    s.urge(101, WAITER, "客人第三次催，情绪较大")

    # A1-红烧肉：错上桌案例（端到 B1 又退回）。服务员标记 → 自动开退菜单，前厅责任
    wrong = s.mark_wrong_delivery(104, WAITER, "后厨出餐口与 B1 的菜拿混，上错桌")

    # A2-口水鸡：已出餐，客人花生过敏。服务员下单时没记过敏原 → 前厅责任
    s.open_return(201, WAITER2, "allergy_missed",
                  "客人声明花生过敏，点单时漏记，口水鸡含花生")
    s.request_approval(201, WAITER2, "refund", "allergy_missed", 3200,
                       idempotency_key="seed-refund-201",
                       note="全额退款，撤下菜品")

    # A2-番茄蛋汤：温度不合格（后厨责任）→ 重做，重做菜已再次入队且在烹制
    r = s.open_return(202, WAITER2, "temperature", "汤端上来是温的")
    rem = s.start_remake(r["ticket_id"], CHEF, "重新烧一锅，滚烫出餐")
    s.advance_stage(rem["new_item_id"], CHEF, "prepping")
    s.advance_stage(rem["new_item_id"], CHEF, "cooking")

    # A2-扬州炒饭：客人临时离席，已在炒制 → 需经理审批是否保留收费
    s.open_return(203, WAITER2, "guest_away", "客人接电话离店，未说明何时回")
    s.request_approval(203, WAITER2, "cancel", "guest_away", 1300,
                       idempotency_key="seed-cancel-203",
                       note="已开火，申请半价保留收费")

    # B1-扬州炒饭：已出餐后发现质量问题，全额退款待经理审批
    s.open_return(301, WAITER, "quality", "炒饭夹生")
    s.request_approval(301, WAITER, "refund", "quality", 2600,
                       idempotency_key="seed-refund-301",
                       note="客人要求整份退")

    # B1-宫保鸡丁：较早前一笔已完成的退款流程（历史记录，验证幂等）
    done = s.open_return(302, WAITER, "quality", "鸡丁不新鲜")
    ap = s.request_approval(302, WAITER, "refund", "quality", 3800,
                            idempotency_key="seed-refund-302")
    s.decide_approval(ap["approval_id"], MGR, True, "同意全额退款并致歉")

    return s
