"""HTTP 服务（stdlib，零三方依赖）+ 静态前端。

角色由请求体里的 employee_id 表示（演示用），Service 层做强校验。
"""
from __future__ import annotations

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .db import Database
from .service import ConflictError, ServiceError, Service

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
ASSETS_DIR = os.path.join(os.path.dirname(__file__), "..", "assets")
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/floor": ("floor.html", "text/html; charset=utf-8"),
    "/kitchen": ("kitchen.html", "text/html; charset=utf-8"),
    "/manager": ("manager.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "application/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}

service: Service


def _json_default(obj):
    return str(obj)


class Handler(BaseHTTPRequestHandler):
    server_version = "RestaurantFlow/1.0"

    def log_message(self, fmt, *args):  # 安静一点
        pass

    # ------------------------------------------------------------ helpers
    def _send_json(self, code: int, payload) -> None:
        body = json.dumps(payload, ensure_ascii=False,
                          default=_json_default).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            raise ServiceError("请求体不是合法 JSON")

    def _serve_static(self, path: str) -> None:
        fname, ctype = STATIC[path]
        with open(os.path.join(FRONTEND_DIR, fname), "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_asset(self, path: str) -> None:
        rel = path[len("/assets/"):]
        # 防目录穿越
        rel = os.path.normpath(rel).lstrip(os.sep)
        full = os.path.join(ASSETS_DIR, rel)
        if not os.path.isfile(full):
            self._send_json(404, {"error": "asset not found"})
            return
        ctype = ("image/svg+xml" if full.endswith(".svg") else
                 "image/png" if full.endswith(".png") else
                 "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ------------------------------------------------------------ routing
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path in STATIC:
                return self._serve_static(path)
            if path.startswith("/assets/"):
                return self._serve_asset(path)
            if path == "/api/floor":
                return self._send_json(200, service.floor_view())
            if path == "/api/kitchen":
                return self._send_json(200, service.kitchen_view())
            if path == "/api/charges":
                return self._send_json(200, {"charges": service.charges_view()})
            if path == "/api/employees":
                rows = service.db.conn.execute(
                    "SELECT id,name,role FROM employees ORDER BY id").fetchall()
                return self._send_json(200, {"employees": [dict(r) for r in rows]})
            m = re.fullmatch(r"/api/tickets/(\d+)/timeline", path)
            if m:
                return self._send_json(
                    200, {"events": service.ticket_timeline(int(m.group(1)))})
            m = re.fullmatch(r"/api/approvals/pending", path)
            if m:
                qs = self._query()
                return self._send_json(
                    200, {"approvals": service.list_pending_approvals(int(qs["employee_id"][0]))})
            self._send_json(404, {"error": "not found"})
        except ServiceError as e:
            self._send_json(e.status, {"error": str(e)})

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        try:
            body = self._read_json()
            if path == "/api/urge":
                return self._send_json(200, service.urge(
                    int(body["item_id"]), int(body["employee_id"]),
                    body.get("note", "")))
            if path == "/api/returns":
                return self._send_json(200, service.open_return(
                    int(body["item_id"]), int(body["employee_id"]),
                    body["reason_code"], body.get("note", ""),
                    body.get("liability")))
            if path == "/api/wrong-delivery":
                return self._send_json(200, service.mark_wrong_delivery(
                    int(body["item_id"]), int(body["employee_id"]),
                    body.get("note", "")))
            if path == "/api/kitchen/stage":
                return self._send_json(200, service.advance_stage(
                    int(body["item_id"]), int(body["employee_id"]), body["stage"]))
            m = re.fullmatch(r"/api/tickets/(\d+)/ack", path)
            if m:
                return self._send_json(200, service.kitchen_ack(
                    int(m.group(1)), int(body["employee_id"]),
                    body["stage"], body.get("message", "")))
            m = re.fullmatch(r"/api/tickets/(\d+)/remake", path)
            if m:
                return self._send_json(200, service.start_remake(
                    int(m.group(1)), int(body["employee_id"]),
                    body.get("message", "")))
            m = re.fullmatch(r"/api/tickets/(\d+)/cancel", path)
            if m:
                return self._send_json(200, service.cancel_before_serve(
                    int(m.group(1)), int(body["employee_id"])))
            if path == "/api/approvals":
                return self._send_json(200, service.request_approval(
                    int(body["item_id"]), int(body["employee_id"]),
                    body["request_kind"], body["reason_code"],
                    int(body["amount_cents"]),
                    body.get("idempotency_key"), body.get("note", "")))
            m = re.fullmatch(r"/api/approvals/(\d+)/decide", path)
            if m:
                return self._send_json(200, service.decide_approval(
                    int(m.group(1)), int(body["manager_id"]),
                    bool(body["approve"]), body.get("manager_note", "")))
            self._send_json(404, {"error": "not found"})
        except (KeyError, ValueError) as e:
            self._send_json(400, {"error": f"参数错误: {e}"})
        except ServiceError as e:
            self._send_json(e.status, {"error": str(e)})

    def _query(self) -> dict:
        from urllib.parse import parse_qs
        q = self.path.split("?", 1)[1] if "?" in self.path else ""
        return parse_qs(q)


def serve(db_path: str | None = None, port: int = 8000) -> None:
    global service
    db = Database(db_path)
    service = Service(db)
    httpd = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"餐厅协同系统已启动: http://localhost:{port}")
    print(f"  前厅 /floor   后厨 /kitchen   值班经理 /manager")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        db.close()
