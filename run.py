#!/usr/bin/env python3
"""一条命令启动餐厅协同系统：

    python3 run.py                # 重建演示数据（含错上桌案例）并启动
    python3 run.py --keep-db      # 保留现有数据
    python3 run.py --port 8080

演示账号（前端右上角可切换）：
    1 小王(服务员)  2 小李(服务员)  3 张大厨(后厨)  4 陈经理(值班经理)
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backend.db import Database  # noqa: E402
from backend.seed import seed  # noqa: E402
from backend import server  # noqa: E402

DEFAULT_DB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "restaurant.db")


def main() -> None:
    ap = argparse.ArgumentParser(description="餐厅催/退/重做协同系统")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--keep-db", action="store_true", help="不重建演示数据")
    args = ap.parse_args()

    if not args.keep_db:
        print("播种演示数据（含错上桌、过敏漏看、温度不合格、客人离席、出餐后退款）…")
        seeded = seed(args.db)
        seeded.db.close()

    server.serve(args.db, port=args.port)


if __name__ == "__main__":
    main()
