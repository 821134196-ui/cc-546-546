'use strict';
// 角色权限:HTTP 层验证 401/403,以及服务员不能自行退款(必须经理审批)
// 使用种子数据:1小王/2小李=waiter,3阿强=kitchen,4陈姐=manager;2号桌空闲
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

const WAITER = 1; const KITCHEN = 3; const MANAGER = 4;
let server; let base; let dir;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yw-perm-'));
  const app = createApp({
    dbPath: path.join(dir, 'test.db'),
    printerSpool: path.join(dir, 'spool.log'),
  });
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const call = (method, p, { user, body } = {}) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(user ? { 'X-User-Id': String(user) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test('未携带身份 → 401', async () => {
  const res = await call('GET', '/api/board');
  assert.equal(res.status, 401);
});

test('越权访问 → 403:后厨不能开单,服务员不能推进后厨阶段', async () => {
  let res = await call('POST', '/api/orders', { user: KITCHEN, body: { table_id: 2, items: [{ dish_id: 1 }] } });
  assert.equal(res.status, 403);
  res = await call('POST', '/api/items/1/stage', { user: WAITER, body: { stage: 'preparing' } });
  assert.equal(res.status, 403);
});

test('服务员不能审批退款(不能自行免单),经理才可以', async () => {
  // 服务员开单 → 后厨备料 → 服务员申请退菜
  let res = await call('POST', '/api/orders', { user: WAITER, body: { table_id: 2, items: [{ dish_id: 1 }] } });
  assert.equal(res.status, 201);
  const { itemIds } = await res.json();
  const item = itemIds[0];
  await call('POST', `/api/items/${item}/stage`, { user: KITCHEN, body: { stage: 'preparing' } });

  res = await call('POST', `/api/items/${item}/return`, {
    user: WAITER, body: { reason_code: 'temp_fail', request_id: 'perm-1' },
  });
  assert.equal(res.status, 202); // 已受理,待经理审批
  const { refund } = await res.json();

  // 服务员尝试审批 → 403;后厨尝试 → 403
  res = await call('POST', `/api/refunds/${refund.id}/approve`, { user: WAITER, body: {} });
  assert.equal(res.status, 403);
  res = await call('POST', `/api/refunds/${refund.id}/approve`, { user: KITCHEN, body: {} });
  assert.equal(res.status, 403);

  // 经理审批 → 200,菜品退掉
  res = await call('POST', `/api/refunds/${refund.id}/approve`, { user: MANAGER, body: {} });
  assert.equal(res.status, 200);
  const approved = await res.json();
  assert.equal(approved.refund.status, 'approved');

  // 经理看板服务员不可见
  res = await call('GET', '/api/manager/refunds', { user: WAITER });
  assert.equal(res.status, 403);
  res = await call('GET', '/api/manager/refunds', { user: MANAGER });
  assert.equal(res.status, 200);
});

test('后厨队列接口:后厨/经理可见,服务员不可见', async () => {
  let res = await call('GET', '/api/kitchen/queue', { user: KITCHEN });
  assert.equal(res.status, 200);
  res = await call('GET', '/api/kitchen/queue', { user: WAITER });
  assert.equal(res.status, 403);
});
