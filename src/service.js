'use strict';
// 业务服务层:所有写操作都在 BEGIN IMMEDIATE 事务内,并用"条件 UPDATE + 影响行数"做乐观并发控制。
// 三条核心不变量:
//  1. 同一菜多次催单 → 只追加 reminders 时间线,kitchen_queue 永远一行(不重复入队)
//  2. 退菜与出餐并发 → 条件更新保证只有一个赢;已交付(delivered)的菜不能被全额退款
//  3. 退款/支付幂等  → request_id / idempotency_key 唯一约束,重复请求返回原记录
const REASONS = {
  wrong_table:    { label: '错上桌',       responsibility: 'front',   costBorneBy: 'house', desc: '送错桌台,前厅责任,门店承担重做成本' },
  allergy_missed: { label: '过敏提醒漏看', responsibility: 'front',   costBorneBy: 'house', desc: '过敏信息未传达后厨,前厅责任' },
  temp_fail:      { label: '温度不合格',   responsibility: 'kitchen', costBorneBy: 'house', desc: '出品温度不达标,厨房责任' },
  guest_away:     { label: '客人临时离席', responsibility: 'guest',   costBorneBy: 'guest', desc: '客人原因暂离,复热即可,不产生费用' },
  served_return:  { label: '出餐后退菜',   responsibility: 'house',   costBorneBy: 'shared', desc: '已出餐退菜,经理核定退款金额' },
  other:          { label: '其他',         responsibility: 'house',   costBorneBy: 'shared', desc: '其他原因' },
};

const STATUS_LABELS = {
  pending: '待处理', preparing: '已备料', cooking: '正在烹制', served: '已出餐',
  delivered: '已上桌', remaking: '重做中', return_requested: '退菜审批中',
  returned: '已退菜', cancelled: '已取消',
};

// 主流程允许的状态迁移(条件 UPDATE 的 WHERE 依据)
const NEXT_STAGE = {
  pending: 'preparing',
  preparing: 'cooking',
  cooking: 'served',
  served: 'delivered',
  remaking: 'preparing', // 重做:重新备料
};

class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const badRequest = (m) => new AppError(400, 'BAD_REQUEST', m);
const notFound = (m) => new AppError(404, 'NOT_FOUND', m);
const conflict = (m) => new AppError(409, 'CONFLICT', m);

function nowIso() { return new Date().toISOString(); }

/** 事务包装:BEGIN IMMEDIATE 保证写事务串行,读-改-写不会交错 */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

class RestaurantService {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{printer:{print:Function}, payment:{charge:Function,refund:Function}}} adapters
   */
  constructor(db, adapters) {
    this.db = db;
    this.printer = adapters.printer;
    this.payment = adapters.payment;
  }

  // ---------- 基础查询 ----------

  getUser(id) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw notFound('用户不存在');
    return u;
  }

  getItem(itemId) {
    const it = this.db.prepare(`
      SELECT oi.*, d.name AS dish_name, d.photo, o.table_id, t.name AS table_name
      FROM order_items oi
      JOIN dishes d ON d.id = oi.dish_id
      JOIN orders o ON o.id = oi.order_id
      JOIN tables t ON t.id = o.table_id
      WHERE oi.id = ?`).get(itemId);
    if (!it) throw notFound(`订单项 #${itemId} 不存在`);
    return it;
  }

  _event(itemId, orderId, actor, action, detail, at) {
    this.db.prepare(
      'INSERT INTO events (order_item_id, order_id, actor, action, detail, created_at) VALUES (?,?,?,?,?,?)'
    ).run(itemId, orderId, actor, action, detail || '', at || nowIso());
  }

  // ---------- 下单 ----------

  /** 服务员下单/加菜:桌台无未结订单则开单,否则并入现有订单 */
  createOrder({ tableId, items, actor }) {
    if (!Array.isArray(items) || items.length === 0) throw badRequest('订单不能为空');
    return tx(this.db, () => {
      const table = this.db.prepare('SELECT * FROM tables WHERE id = ?').get(tableId);
      if (!table) throw notFound('桌台不存在');

      let order = this.db.prepare(
        "SELECT * FROM orders WHERE table_id = ? AND status = 'open'").get(tableId);
      const at = nowIso();
      if (!order) {
        const r = this.db.prepare(
          "INSERT INTO orders (table_id, status, opened_by, created_at) VALUES (?,'open',?,?)")
          .run(tableId, actor.id, at);
        order = { id: Number(r.lastInsertRowid), table_id: tableId };
        this.db.prepare("UPDATE tables SET status = 'dining' WHERE id = ?").run(tableId);
      }

      const seqRow = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS m FROM kitchen_queue').get();
      let seq = seqRow.m;
      const created = [];
      for (const { dishId, qty = 1, allergyNote = '' } of items) {
        const dish = this.db.prepare('SELECT * FROM dishes WHERE id = ?').get(dishId);
        if (!dish) throw notFound(`菜品 #${dishId} 不存在`);
        if (qty < 1 || qty > 20) throw badRequest('数量不合法');
        const r = this.db.prepare(`
          INSERT INTO order_items (order_id, dish_id, qty, unit_price_cents, status, allergy_note, created_at, updated_at)
          VALUES (?,?,?,?, 'pending', ?, ?, ?)`)
          .run(order.id, dishId, qty, dish.price_cents, String(allergyNote).slice(0, 120), at, at);
        const itemId = Number(r.lastInsertRowid);
        this.db.prepare(
          "INSERT INTO kitchen_queue (seq, order_item_id, kind, status, created_at) VALUES (?,?, 'cook','open',?)")
          .run(++seq, itemId, at);
        this._event(itemId, order.id, actor.name, 'created',
          `下单 ${dish.name}×${qty}${allergyNote ? `,过敏备注:${allergyNote}` : ''}`, at);
        created.push(itemId);
      }
      this.printer.print({ type: 'kitchen_ticket', order_id: order.id, table: table.name, items: created });
      return { orderId: order.id, itemIds: created };
    });
  }

  // ---------- 催单:时间线追加,队列不重复 ----------

  remind({ itemId, note = '', actor }) {
    return tx(this.db, () => {
      const item = this.getItem(itemId);
      if (['returned', 'cancelled', 'delivered'].includes(item.status)) {
        throw conflict(`当前状态(${STATUS_LABELS[item.status]})不可催单`);
      }
      const at = nowIso();
      const { c } = this.db.prepare(
        'SELECT COUNT(*) AS c FROM reminders WHERE order_item_id = ?').get(itemId);
      const seq = c + 1;
      this.db.prepare(
        'INSERT INTO reminders (order_item_id, seq, note, created_by, created_at) VALUES (?,?,?,?,?)')
        .run(itemId, seq, String(note).slice(0, 120), actor.id, at);
      // 关键:只更新已存在的队列行,绝不新增 → 同一菜多次催单不会重复进入后厨队列
      this.db.prepare(
        "UPDATE kitchen_queue SET remind_count = remind_count + 1, last_remind_at = ? WHERE order_item_id = ? AND status = 'open'")
        .run(at, itemId);
      this._event(itemId, item.order_id, actor.name, 'remind', `第${seq}次催单${note ? `:${note}` : ''}`, at);
      return { itemId, seq };
    });
  }

  // ---------- 后厨阶段推进(条件更新,防并发覆盖) ----------

  setStage({ itemId, stage, actor }) {
    return tx(this.db, () => {
      const item = this.getItem(itemId);
      const expect = NEXT_STAGE[item.status];
      if (expect !== stage) {
        throw conflict(`状态已变化:当前「${STATUS_LABELS[item.status]}」,不能推进到「${STATUS_LABELS[stage] || stage}」`);
      }
      const at = nowIso();
      // 条件 UPDATE:WHERE 带上期望状态,并发下只有一个请求能改成功
      const r = this.db.prepare(
        'UPDATE order_items SET status = ?, version = version + 1, updated_at = ? WHERE id = ? AND status = ?')
        .run(stage, at, itemId, item.status);
      if (r.changes === 0) throw conflict('状态已被并发修改,请刷新');
      if (stage === 'served') {
        this.db.prepare(
          "UPDATE kitchen_queue SET status = 'closed' WHERE order_item_id = ? AND status = 'open'").run(itemId);
        // 重做完成 → 关闭重做单
        this.db.prepare(
          "UPDATE remakes SET status = 'done' WHERE order_item_id = ? AND status = 'open'").run(itemId);
      }
      this._event(itemId, item.order_id, actor.name, 'stage', `后厨:${STATUS_LABELS[stage]}`, at);
      return { itemId, status: stage };
    });
  }

  /** 服务员确认上桌(served → delivered) */
  deliver({ itemId, actor }) {
    return tx(this.db, () => {
      const item = this.getItem(itemId);
      const at = nowIso();
      const r = this.db.prepare(
        "UPDATE order_items SET status = 'delivered', version = version + 1, updated_at = ? WHERE id = ? AND status = 'served'")
        .run(at, itemId);
      if (r.changes === 0) {
        throw conflict(`无法上桌:当前状态「${STATUS_LABELS[item.status]}」(可能已被退菜/重做锁定)`);
      }
      this._event(itemId, item.order_id, actor.name, 'deliver', '已上桌', at);
      return { itemId, status: 'delivered' };
    });
  }

  // ---------- 退菜:服务员发起(幂等),经理审批 ----------

  requestReturn({ itemId, reasonCode, note = '', requestId, actor }) {
    if (!REASONS[reasonCode]) throw badRequest('未知退菜原因');
    if (!requestId) throw badRequest('缺少幂等键 request_id');
    return tx(this.db, () => {
      // 幂等:同一 request_id 直接返回原申请,不产生第二条
      const dup = this.db.prepare('SELECT * FROM refunds WHERE request_id = ?').get(requestId);
      if (dup) return { refund: dup, duplicated: true };

      const item = this.getItem(itemId);
      if (['returned', 'cancelled', 'return_requested'].includes(item.status)) {
        throw conflict(`当前状态(${STATUS_LABELS[item.status]})不可重复申请退菜`);
      }
      const at = nowIso();
      const full = item.qty * item.unit_price_cents;
      const alreadyOut = ['served', 'delivered'].includes(item.status);
      const amount = reasonCode === 'guest_away' ? 0 : full;

      const r = this.db.prepare(`
        INSERT INTO refunds (request_id, order_item_id, reason_code, note, amount_cents, status, requested_by, created_at)
        VALUES (?,?,?,?,?, 'pending', ?, ?)`)
        .run(requestId, itemId, reasonCode, String(note).slice(0, 200), amount, actor.id, at);

      // 未交付的菜先冻结,等待经理审批;已交付的保持 delivered(只能部分退款,见 approveRefund)
      if (!alreadyOut) {
        this.db.prepare(
          "UPDATE order_items SET prev_status = status, status = 'return_requested', updated_at = ? WHERE id = ?")
          .run(at, itemId);
      }
      this._event(itemId, item.order_id, actor.name, 'return_request',
        `申请退菜(${REASONS[reasonCode].label})¥${(amount / 100).toFixed(2)}${note ? `:${note}` : ''}`, at);
      const refund = this.db.prepare('SELECT * FROM refunds WHERE id = ?').get(Number(r.lastInsertRowid));
      return { refund, duplicated: false };
    });
  }

  /**
   * 经理批准退款。不变量:已交付(delivered)的菜不能全额退款 ——
   * 与 deliver() 的条件更新互斥,保证"不会既交付又全额退款"。重复批准是幂等的。
   */
  approveRefund({ refundId, amountCents, actor }) {
    return tx(this.db, () => {
      const refund = this.db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
      if (!refund) throw notFound('退款申请不存在');
      if (refund.status === 'approved') return { refund, duplicated: true }; // 幂等
      if (refund.status === 'rejected') throw conflict('该申请已被拒绝');

      const item = this.getItem(refund.order_item_id);
      const full = item.qty * item.unit_price_cents;
      const amount = amountCents == null ? refund.amount_cents : amountCents;
      if (!Number.isInteger(amount) || amount < 0 || amount > full) {
        throw badRequest(`退款金额须在 0 ~ ¥${(full / 100).toFixed(2)} 之间`);
      }
      const isFull = amount === full;
      if (isFull && item.status === 'delivered') {
        throw conflict('菜品已上桌交付,不能全额退款(可改为部分退款)');
      }
      const at = nowIso();

      if (isFull) {
        // 条件更新兜底:若此刻已被并发上桌,则拒绝全额退款
        const r = this.db.prepare(`
          UPDATE order_items SET status = 'returned', version = version + 1, updated_at = ?
          WHERE id = ? AND status NOT IN ('delivered','returned','cancelled')`).run(at, item.id);
        if (r.changes === 0) throw conflict('菜品已交付,全额退款被拒绝');
        this.db.prepare(
          "UPDATE kitchen_queue SET status = 'closed' WHERE order_item_id = ? AND status = 'open'").run(item.id);
      } else if (item.status === 'return_requested') {
        // 部分退款:解冻,回到原状态继续制作/上桌
        this.db.prepare(
          "UPDATE order_items SET status = prev_status, prev_status = NULL, updated_at = ? WHERE id = ?")
          .run(at, item.id);
      }

      // 费用调整:全额退 → 菜品从账单移除,调整仅作审计(affects_bill=0);部分退 → 直接冲减账单
      this.db.prepare(`
        INSERT INTO fee_adjustments (order_id, order_item_id, kind, amount_cents, reason, responsibility, affects_bill, created_by, created_at)
        VALUES (?,?, 'refund', ?, ?, ?, ?, ?, ?)`)
        .run(item.order_id, item.id, -amount,
          `退菜退款(${REASONS[refund.reason_code].label})${refund.note ? `:${refund.note}` : ''}`,
          REASONS[refund.reason_code].responsibility, isFull ? 0 : 1, actor.id, at);

      this.db.prepare(
        "UPDATE refunds SET status = 'approved', final_amount_cents = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(amount, actor.id, at, refundId);
      this.payment.refund(`refund_${refund.request_id}`, amount);
      this._event(item.id, item.order_id, actor.name, 'refund_approved',
        `批准退款 ¥${(amount / 100).toFixed(2)}(${REASONS[refund.reason_code].label})`, at);
      return { refund: this.db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId), duplicated: false };
    });
  }

  /** 经理拒绝退款:解冻菜品回到原状态。幂等。 */
  rejectRefund({ refundId, note = '', actor }) {
    return tx(this.db, () => {
      const refund = this.db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId);
      if (!refund) throw notFound('退款申请不存在');
      if (refund.status === 'rejected') return { refund, duplicated: true };
      if (refund.status === 'approved') throw conflict('该申请已批准,不能拒绝');
      const at = nowIso();
      this.db.prepare(
        "UPDATE refunds SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
        .run(actor.id, at, refundId);
      this.db.prepare(
        "UPDATE order_items SET status = prev_status, prev_status = NULL, updated_at = ? WHERE id = ? AND status = 'return_requested'")
        .run(at, refund.order_item_id);
      this._event(refund.order_item_id, null, actor.name, 'refund_rejected',
        `拒绝退款${note ? `:${note}` : ''}`, at);
      return { refund: this.db.prepare('SELECT * FROM refunds WHERE id = ?').get(refundId), duplicated: false };
    });
  }

  // ---------- 重做:原因/责任/成本 + 原单位置重新入队 ----------

  requestRemake({ itemId, reasonCode, note = '', actor }) {
    const reason = REASONS[reasonCode];
    if (!reason) throw badRequest('未知重做原因');
    return tx(this.db, () => {
      const item = this.getItem(itemId);
      if (!['cooking', 'served', 'delivered'].includes(item.status)) {
        throw conflict(`当前状态(${STATUS_LABELS[item.status]})不可发起重做`);
      }
      const at = nowIso();
      const cost = reason.costBorneBy === 'house' ? item.qty * item.unit_price_cents : 0;
      const r = this.db.prepare(`
        INSERT INTO remakes (order_item_id, reason_code, responsibility, cost_cents, note, status, created_by, created_at)
        VALUES (?,?,?,?,?, 'open', ?, ?)`)
        .run(itemId, reasonCode, reason.responsibility, cost, String(note).slice(0, 200), actor.id, at);

      this.db.prepare(
        "UPDATE order_items SET prev_status = NULL, status = 'remaking', version = version + 1, updated_at = ? WHERE id = ?")
        .run(at, itemId);
      // 原单位置:同一队列行重新打开,kind 改为 remake,seq 不变 → 后厨屏在原位置显示重做标记
      this.db.prepare(`
        INSERT INTO kitchen_queue (seq, order_item_id, kind, status, created_at)
        VALUES ((SELECT COALESCE(MAX(seq),0)+1 FROM kitchen_queue), ?, 'remake', 'open', ?)
        ON CONFLICT(order_item_id) DO UPDATE SET kind = 'remake', status = 'open'`).run(itemId, at);

      if (cost > 0) {
        this.db.prepare(`
          INSERT INTO fee_adjustments (order_id, order_item_id, kind, amount_cents, reason, responsibility, affects_bill, created_by, created_at)
          VALUES (?,?, 'loss', ?, ?, ?, 0, ?, ?)`)
          .run(item.order_id, itemId, -cost, `重做损耗(${reason.label})${note ? `:${note}` : ''}`,
            reason.responsibility, actor.id, at);
      }
      this.printer.print({ type: 'remake_ticket', item_id: itemId, reason: reason.label, table: item.table_name });
      this._event(itemId, item.order_id, actor.name, 'remake',
        `发起重做(${reason.label},责任:${reason.responsibility})${note ? `:${note}` : ''}`, at);
      return { remakeId: Number(r.lastInsertRowid) };
    });
  }

  // ---------- 账单与支付 ----------

  getBill(orderId) {
    const items = this.db.prepare(`
      SELECT oi.*, d.name AS dish_name FROM order_items oi JOIN dishes d ON d.id = oi.dish_id
      WHERE oi.order_id = ? ORDER BY oi.id`).all(orderId);
    const adjustments = this.db.prepare(
      'SELECT * FROM fee_adjustments WHERE order_id = ? ORDER BY id').all(orderId);
    const itemsTotal = items
      .filter((i) => !['returned', 'cancelled'].includes(i.status))
      .reduce((s, i) => s + i.qty * i.unit_price_cents, 0);
    const adjTotal = adjustments
      .filter((a) => a.affects_bill === 1)
      .reduce((s, a) => s + a.amount_cents, 0);
    return {
      items, adjustments,
      itemsTotal, adjustmentsTotal: adjTotal,
      total: Math.max(0, itemsTotal + adjTotal),
    };
  }

  /** 买单:幂等(idempotency_key 唯一),重复调用返回原支付记录 */
  pay({ orderId, idempotencyKey, actor }) {
    if (!idempotencyKey) throw badRequest('缺少幂等键 idempotency_key');
    return tx(this.db, () => {
      const dup = this.db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(idempotencyKey);
      if (dup) return { payment: dup, duplicated: true };
      const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
      if (!order) throw notFound('订单不存在');
      if (order.status !== 'open') throw conflict('订单已结账');
      const bill = this.getBill(orderId);
      const at = nowIso();
      const charge = this.payment.charge(idempotencyKey, bill.total);
      const r = this.db.prepare(
        'INSERT INTO payments (idempotency_key, order_id, amount_cents, status, created_at) VALUES (?,?,?,?,?)')
        .run(idempotencyKey, orderId, bill.total, charge.status, at);
      this.db.prepare("UPDATE orders SET status = 'paid', paid_at = ? WHERE id = ?").run(at, orderId);
      this.db.prepare("UPDATE tables SET status = 'free' WHERE id = ?").run(order.table_id);
      this._event(null, orderId, actor.name, 'paid',
        `结账 ¥${(bill.total / 100).toFixed(2)}(${charge.transaction_id})`, at);
      return { payment: this.db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(r.lastInsertRowid)), duplicated: false };
    });
  }

  // ---------- 看板查询 ----------

  /** 前厅看板:每桌等待时长 = 未上桌菜品中最长的等待分钟数 */
  board() {
    const tables = this.db.prepare('SELECT * FROM tables ORDER BY id').all();
    const openOrders = this.db.prepare(`
      SELECT o.id AS order_id, o.table_id, o.created_at AS order_at,
        (SELECT MAX(oi.created_at) FROM order_items oi
          WHERE oi.order_id = o.id AND oi.status NOT IN ('delivered','returned','cancelled')) AS oldest_wait,
        (SELECT COUNT(*) FROM order_items oi
          WHERE oi.order_id = o.id AND oi.status NOT IN ('delivered','returned','cancelled')) AS pending_count
      FROM orders o WHERE o.status = 'open'`).all();
    const byTable = new Map(openOrders.map((o) => [o.table_id, o]));
    const now = Date.now();
    return tables.map((t) => {
      const o = byTable.get(t.id);
      let waitMin = 0;
      if (o && o.oldest_wait) waitMin = Math.max(0, Math.floor((now - Date.parse(o.oldest_wait)) / 60000));
      return {
        ...t,
        order_id: o ? o.order_id : null,
        wait_min: waitMin,
        pending_count: o ? o.pending_count : 0,
      };
    });
  }

  /** 后厨屏:按原单位置(seq)排序,重做带原因,催单带次数 */
  kitchenQueue() {
    return this.db.prepare(`
      SELECT kq.id AS queue_id, kq.seq, kq.kind, kq.remind_count, kq.last_remind_at,
             oi.id AS item_id, oi.status, oi.qty, oi.allergy_note, oi.created_at,
             d.name AS dish_name, t.name AS table_name, o.id AS order_id,
             (SELECT r.reason_code FROM remakes r WHERE r.order_item_id = oi.id AND r.status = 'open'
               ORDER BY r.id DESC LIMIT 1) AS remake_reason
      FROM kitchen_queue kq
      JOIN order_items oi ON oi.id = kq.order_item_id
      JOIN dishes d ON d.id = oi.dish_id
      JOIN orders o ON o.id = oi.order_id
      JOIN tables t ON t.id = o.table_id
      WHERE kq.status = 'open' AND oi.status NOT IN ('returned','cancelled','return_requested')
      ORDER BY kq.seq`).all();
  }

  tableOrder(tableId) {
    const order = this.db.prepare(
      "SELECT * FROM orders WHERE table_id = ? AND status = 'open'").get(tableId);
    if (!order) return null;
    const bill = this.getBill(order.id);
    return { order, ...bill };
  }

  /** 菜品时间线:事件流(含每次催单)按时间正序 —— 多次催单形成连续时间线 */
  timeline(itemId) {
    this.getItem(itemId);
    return this.db.prepare(
      'SELECT * FROM events WHERE order_item_id = ? ORDER BY created_at, id').all(itemId);
  }

  refundsList() {
    return this.db.prepare(`
      SELECT r.*, d.name AS dish_name, t.name AS table_name, u.name AS requester,
             oi.qty, oi.unit_price_cents, oi.status AS item_status
      FROM refunds r
      JOIN order_items oi ON oi.id = r.order_item_id
      JOIN dishes d ON d.id = oi.dish_id
      JOIN orders o ON o.id = oi.order_id
      JOIN tables t ON t.id = o.table_id
      JOIN users u ON u.id = r.requested_by
      ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.id DESC`).all();
  }

  /** 损耗汇总:按责任方统计(错上桌/过敏漏看等内部成本) */
  losses() {
    return this.db.prepare(`
      SELECT responsibility, reason, COUNT(*) AS cases, SUM(-amount_cents) AS cost_cents
      FROM fee_adjustments WHERE kind = 'loss'
      GROUP BY responsibility, reason ORDER BY cost_cents DESC`).all();
  }
}

module.exports = { RestaurantService, REASONS, STATUS_LABELS, AppError, tx };
