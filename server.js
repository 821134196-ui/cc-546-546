'use strict';
// HTTP 服务:node:http 原生实现,零依赖
// 角色鉴权:请求头 X-User-Id → users 表;路由级角色白名单
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('./src/db');
const { RestaurantService, REASONS, STATUS_LABELS, AppError } = require('./src/service');
const { seed } = require('./src/seed');
const { createPrinter } = require('./src/adapters/printer');
const { createPayment } = require('./src/adapters/payment');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json; charset=utf-8',
};

// 路由表:[方法, 路径模式, 允许角色, handler]
// handler(req, res, ctx, ...params) — ctx = {svc, actor, body}
const ROUTES = [
  ['GET', '/api/bootstrap', ['waiter', 'kitchen', 'manager'], (req, res, { svc }) => {
    send(res, 200, {
      users: svc.db.prepare('SELECT id, name, role FROM users ORDER BY id').all(),
      dishes: svc.db.prepare('SELECT * FROM dishes ORDER BY id').all(),
      reasons: REASONS,
      statusLabels: STATUS_LABELS,
    });
  }],
  ['GET', '/api/board', ['waiter', 'manager'], (req, res, { svc }) => send(res, 200, svc.board())],
  ['GET', '/api/tables/:id/order', ['waiter', 'manager'], (req, res, { svc }, id) => {
    send(res, 200, svc.tableOrder(Number(id)) || { empty: true });
  }],
  ['POST', '/api/orders', ['waiter'], (req, res, { svc, actor, body }) => {
    send(res, 201, svc.createOrder({
      tableId: Number(body.table_id),
      items: (body.items || []).map((i) => ({ dishId: Number(i.dish_id), qty: Number(i.qty) || 1, allergyNote: i.allergy_note || '' })),
      actor,
    }));
  }],
  ['GET', '/api/items/:id/timeline', ['waiter', 'kitchen', 'manager'], (req, res, { svc }, id) => {
    send(res, 200, svc.timeline(Number(id)));
  }],
  ['POST', '/api/items/:id/remind', ['waiter'], (req, res, { svc, actor, body }, id) => {
    send(res, 200, svc.remind({ itemId: Number(id), note: body.note, actor }));
  }],
  ['POST', '/api/items/:id/deliver', ['waiter'], (req, res, { svc, actor }, id) => {
    send(res, 200, svc.deliver({ itemId: Number(id), actor }));
  }],
  ['POST', '/api/items/:id/return', ['waiter'], (req, res, { svc, actor, body }, id) => {
    send(res, 202, svc.requestReturn({
      itemId: Number(id), reasonCode: body.reason_code, note: body.note,
      requestId: String(body.request_id || ''), actor,
    }));
  }],
  ['POST', '/api/items/:id/remake', ['waiter'], (req, res, { svc, actor, body }, id) => {
    send(res, 202, svc.requestRemake({ itemId: Number(id), reasonCode: body.reason_code, note: body.note, actor }));
  }],
  ['GET', '/api/kitchen/queue', ['kitchen', 'manager'], (req, res, { svc }) => {
    send(res, 200, svc.kitchenQueue());
  }],
  ['POST', '/api/items/:id/stage', ['kitchen'], (req, res, { svc, actor, body }, id) => {
    send(res, 200, svc.setStage({ itemId: Number(id), stage: body.stage, actor }));
  }],
  ['GET', '/api/manager/refunds', ['manager'], (req, res, { svc }) => {
    send(res, 200, svc.refundsList());
  }],
  ['GET', '/api/manager/losses', ['manager'], (req, res, { svc }) => {
    send(res, 200, svc.losses());
  }],
  ['POST', '/api/refunds/:id/approve', ['manager'], (req, res, { svc, actor, body }, id) => {
    send(res, 200, svc.approveRefund({
      refundId: Number(id),
      amountCents: body.amount_cents == null ? null : Number(body.amount_cents),
      actor,
    }));
  }],
  ['POST', '/api/refunds/:id/reject', ['manager'], (req, res, { svc, actor, body }, id) => {
    send(res, 200, svc.rejectRefund({ refundId: Number(id), note: body.note, actor }));
  }],
  ['POST', '/api/orders/:id/pay', ['waiter'], (req, res, { svc, actor, body }, id) => {
    send(res, 200, svc.pay({ orderId: Number(id), idempotencyKey: String(body.idempotency_key || ''), actor }));
  }],
  ['POST', '/api/orders/:id/print', ['waiter', 'manager'], (req, res, { svc }, id) => {
    const bill = svc.getBill(Number(id));
    const job = svc.printer.print({ type: 'bill', order_id: Number(id), total_cents: bill.total });
    send(res, 200, job);
  }],
];

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  send(res, status, { error: { code: err.code || 'INTERNAL', message: err.message } });
}

function matchRoute(method, pathname) {
  for (const [m, pattern, roles, handler] of ROUTES) {
    if (m !== method) continue;
    const pp = pattern.split('/').filter(Boolean);
    const up = pathname.split('/').filter(Boolean);
    if (pp.length !== up.length) continue;
    const params = [];
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      if (pp[i].startsWith(':')) params.push(up[i]);
      else if (pp[i] !== up[i]) { ok = false; break; }
    }
    if (ok) return { handler, roles, params };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { reject(new AppError(413, 'TOO_LARGE', '请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new AppError(400, 'BAD_JSON', '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) return sendError(res, new AppError(404, 'NOT_FOUND', '页面不存在'));
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

function createApp({ dbPath, printerSpool } = {}) {
  const db = createDb(dbPath || path.join(ROOT, 'var', 'restaurant.db'));
  seed(db);
  const svc = new RestaurantService(db, {
    printer: createPrinter(printerSpool || path.join(ROOT, 'var', 'print-spool.log')),
    payment: createPayment(),
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      // 静态页面与资源
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        const page = { '/': 'index.html', '/kitchen': 'kitchen.html', '/manager': 'manager.html' }[pathname];
        if (page) return serveStatic(res, path.join(ROOT, 'public', page));
        if (pathname.startsWith('/photos/')) {
          const p = path.join(ROOT, 'photos', path.basename(pathname));
          return serveStatic(res, p);
        }
        if (pathname.startsWith('/assets/')) {
          const p = path.join(ROOT, 'public', 'assets', path.basename(pathname));
          return serveStatic(res, p);
        }
        return sendError(res, new AppError(404, 'NOT_FOUND', '页面不存在'));
      }

      const route = matchRoute(req.method, pathname);
      if (!route) throw new AppError(404, 'NOT_FOUND', '接口不存在');

      // 鉴权:X-User-Id → 用户与角色
      const userId = Number(req.headers['x-user-id']);
      const actor = userId
        ? svc.db.prepare('SELECT * FROM users WHERE id = ?').get(userId)
        : null;
      if (!actor) throw new AppError(401, 'UNAUTHORIZED', '缺少或无效的 X-User-Id');
      if (!route.roles.includes(actor.role)) {
        throw new AppError(403, 'FORBIDDEN', `角色「${actor.role}」无权执行此操作`);
      }

      const body = req.method === 'POST' ? await readBody(req) : {};
      return route.handler(req, res, { svc, actor, body }, ...route.params);
    } catch (err) {
      return sendError(res, err);
    }
  });

  return { server, svc, db };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const { server } = createApp();
  server.listen(port, () => {
    console.log(`\n  一味小馆 · 前厅后厨协同系统`);
    console.log(`  ─────────────────────────────`);
    console.log(`  前厅页   → http://localhost:${port}/        (小王/小李)`);
    console.log(`  后厨屏   → http://localhost:${port}/kitchen (阿强)`);
    console.log(`  经理审批 → http://localhost:${port}/manager (陈姐)`);
    console.log(`\n  演示数据已就绪:3号桌「错上桌」重做中,4号桌有待审批退菜,1号桌有催单时间线\n`);
  });
}

module.exports = { createApp };
