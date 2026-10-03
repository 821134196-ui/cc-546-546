"""打印与支付的模拟适配器。

真实环境里这些是网络外设/网关；这里本地生成回执并落库，
同样做幂等：同一 idempotency_key 重试不会重复出单/重复退款。
"""
from __future__ import annotations

import itertools
import json

from .db import Database, now

_seq = itertools.count(1)


class AdapterError(RuntimeError):
    pass


class PaymentAdapter:
    PROVIDER = "payment"

    def __init__(self, db: Database):
        self.db = db

    def refund(self, amount_cents: int, approval_id: int, key: str,
               memo: str = "") -> dict:
        """模拟原路退回。金额为正数表示退回多少。"""
        if amount_cents <= 0:
            raise AdapterError("退款金额必须为正")
        return self._record(-abs(amount_cents), approval_id, key,
                            {"action": "refund", "memo": memo})

    def charge(self, amount_cents: int, approval_id: int, key: str,
               memo: str = "") -> dict:
        return self._record(abs(amount_cents), approval_id, key,
                            {"action": "charge", "memo": memo})

    def _record(self, amount: int, approval_id: int, key: str,
                payload: dict) -> dict:
        row = self.db.conn.execute(
            "SELECT * FROM adapter_receipts WHERE idempotency_key=?", (key,)
        ).fetchone()
        if row:
            return {"replayed": True, **dict(row)}
        ref = f"PAY-{next(_seq):06d}"
        payload["channel"] = "mock-wechatpay"
        with self.db.lock:
            self.db.conn.execute(
                """INSERT INTO adapter_receipts
                   (provider,external_ref,approval_id,amount_cents,
                    idempotency_key,payload,created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (self.PROVIDER, ref, approval_id, amount, key,
                 json.dumps(payload, ensure_ascii=False), now()),
            )
        return {"replayed": False, "external_ref": ref, "amount_cents": amount}


class PrinterAdapter:
    PROVIDER = "printer"

    def __init__(self, db: Database):
        self.db = db

    def print_slip(self, title: str, lines: list[str], approval_id: int,
                   key: str) -> dict:
        row = self.db.conn.execute(
            "SELECT * FROM adapter_receipts WHERE idempotency_key=?", (key,)
        ).fetchone()
        if row:
            return {"replayed": True, **dict(row)}
        ref = f"PRT-{next(_seq):06d}"
        payload = {"action": "print", "title": title, "lines": lines}
        with self.db.lock:
            self.db.conn.execute(
                """INSERT INTO adapter_receipts
                   (provider,external_ref,approval_id,amount_cents,
                    idempotency_key,payload,created_at)
                   VALUES (?,?,?,0,?,?,?)""",
                (self.PROVIDER, ref, approval_id, key,
                 json.dumps(payload, ensure_ascii=False), now()),
            )
        return {"replayed": False, "external_ref": ref}
