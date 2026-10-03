'use strict';
/* 前厅页:桌台等待热力 + 订单操作(催单/退菜/重做/上桌) + 账单(费用调整与原因紧邻) */
let BOOT = null;
let selectedTable = null;
let pollTimer = null;

const STATUS_ACTIONS = {
  remind: (s) => !['delivered', 'returned', 'cancelled'].includes(s),
  deliver: (s) => s === 'served',
  ret: (s) => !['returned', 'cancelled', 'return_requested'].includes(s),
  remake: (s) => ['cooking', 'served', 'delivered'].includes(s),
};

async function refreshBoard() {
  const tables = await api('GET', '/api/board');
  const grid = document.getElementById('tablesGrid');
  grid.innerHTML = tables.map((t) => {
    const heat = t.status === 'free' ? 0 : heatLevel(t.wait_min);
    return `<div class="table-card ${t.status === 'free' ? 'free' : ''} ${selectedTable === t.id ? 'selected' : ''}"
      data-heat="${heat}" onclick="selectTable(${t.id})">
      <div class="tno">${esc(t.name)}</div>
      <div class="tmeta">${t.status === 'free' ? '空闲 · 点击开单' : `进行中 · ${t.pending_count}道菜未上桌`}</div>
      ${t.status !== 'free' ? `<div class="wait"><span class="num">${t.wait_min}</span><span>分钟等待</span></div>` : ''}
    </div>`;
  }).join('');
}

async function selectTable(id) {
  selectedTable = id;
  await refreshBoard();
  await refreshOrder();
}

async function refreshOrder() {
  if (!selectedTable) return;
  const data = await api('GET', `/api/tables/${selectedTable}/order`);
  const head = document.getElementById('orderHead');
  const body = document.getElementById('orderBody');
  const tname = `桌台 #${selectedTable}`;
  if (!data) {
    head.innerHTML = `${tname} <span class="hint">空闲中</span>`;
    body.innerHTML = `<div class="empty">暂无订单</div>
      <div style="text-align:center;padding-bottom:16px">
        <button class="btn primary" onclick="openNewOrder()">开台点单</button>
      </div>`;
    return;
  }
  head.innerHTML = `${tname} · 订单 #${data.order.id}
    <span class="hint">开台 ${fmtTime(data.order.created_at)}</span>
    <div style="flex:1"></div>
    <button class="btn sm" onclick="openNewOrder()">加菜</button>`;

  const itemsHtml = data.items.map((it) => {
    const st = BOOT.statusLabels[it.status];
    const wait = ['delivered', 'returned', 'cancelled'].includes(it.status) ? '' :
      `<span class="item-wait ${heatLevel(Math.floor((Date.now() - Date.parse(it.created_at)) / 60000)) >= 2 ? 'hot' : ''}">等待 ${fmtWait(it.created_at)}</span>`;
    return `<div class="item-row">
      <img src="/photos/dish-${it.dish_id}.svg" alt="">
      <div>
        <div class="item-name">${esc(it.dish_name)} ×${it.qty}
          <span class="chip st-${it.status}">${st}</span>
          ${it.remake_reason ? `<span class="badge-remake">重做</span>` : ''}
        </div>
        <div class="item-sub">
          ${it.allergy_note ? `<span class="allergy">⚠ ${esc(it.allergy_note)}</span>` : ''}
          ${wait}
          <a href="javascript:void 0" onclick="openTimeline(${it.id})" style="color:var(--ink-2)">时间线 ›</a>
        </div>
      </div>
      <div>
        <div class="item-price">${fmtMoney(it.qty * it.unit_price_cents)}</div>
        <div class="item-actions" style="margin-top:6px">
          ${STATUS_ACTIONS.remind(it.status) ? `<button class="btn sm" onclick="doRemind(${it.id})">催单</button>` : ''}
          ${STATUS_ACTIONS.deliver(it.status) ? `<button class="btn sm primary" onclick="doDeliver(${it.id})">上桌</button>` : ''}
          ${STATUS_ACTIONS.remake(it.status) ? `<button class="btn sm" onclick="openRemake(${it.id})">重做</button>` : ''}
          ${STATUS_ACTIONS.ret(it.status) ? `<button class="btn sm warm" onclick="openReturn(${it.id})">退菜</button>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  const adjHtml = data.adjustments.length ? `
    <div class="section-title">费用调整(与原因对应)</div>
    ${data.adjustments.map((a) => `
      <div class="bill-line adj">
        <span class="reason">${esc(a.reason)}${a.affects_bill ? '' : ' · 内部损耗,不影响账单'}</span>
        <span class="money">${a.amount_cents > 0 ? '+' : ''}${fmtMoney(a.amount_cents)}</span>
      </div>`).join('')}` : '';

  body.innerHTML = `
    ${itemsHtml || '<div class="empty">暂无菜品</div>'}
    <div class="section-title">账单</div>
    <div class="bill-line"><span>菜品合计</span><span class="money">${fmtMoney(data.itemsTotal)}</span></div>
    ${adjHtml}
    ${data.adjustmentsTotal ? `<div class="bill-line adj"><span>调整合计</span><span class="money">${fmtMoney(data.adjustmentsTotal)}</span></div>` : ''}
    <div class="bill-total"><span>应付</span><span class="num">${fmtMoney(data.total)}</span></div>
    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
      <button class="btn" onclick="doPrint(${data.order.id})">打印账单</button>
      <button class="btn primary" onclick="doPay(${data.order.id})">买单结账</button>
    </div>`;
}

/* ── 操作 ── */
async function doRemind(itemId) {
  const note = prompt('催单备注(可留空)', '');
  if (note === null) return;
  try {
    const r = await api('POST', `/api/items/${itemId}/remind`, { note });
    ok(`已记录第 ${r.seq} 次催单(时间线追加,后厨不重复排队)`);
    refreshOrder();
  } catch (e) { fail(e); }
}

async function doDeliver(itemId) {
  try { await api('POST', `/api/items/${itemId}/deliver`); ok('已上桌'); refreshOrder(); }
  catch (e) { fail(e); refreshOrder(); }
}

async function doPrint(orderId) {
  try { const j = await api('POST', `/api/orders/${orderId}/print`); ok(`已发送打印 ${j.job_id}`); }
  catch (e) { fail(e); }
}

async function doPay(orderId) {
  if (!confirm('确认买单结账?(模拟支付,幂等键防止重复扣款)')) return;
  try {
    const p = await api('POST', `/api/orders/${orderId}/pay`, { idempotency_key: `bill-${orderId}` });
    ok(p.duplicated ? '该订单已支付过(幂等命中,未重复扣款)' : `支付成功 ${fmtMoney(p.payment.amount_cents)}`);
    selectedTable = null;
    refreshBoard();
    document.getElementById('orderBody').innerHTML = '<div class="empty">点击左侧桌台查看订单</div>';
    document.getElementById('orderHead').textContent = '选择桌台';
  } catch (e) { fail(e); }
}

/* ── 退菜(生成幂等键;服务员只能发起,经理审批) ── */
function reasonModal(title, onPick) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const reasons = Object.entries(BOOT.reasons);
  mask.innerHTML = `<div class="modal">
    <div class="panel-head">${title}<div style="flex:1"></div>
      <button class="btn sm" id="mClose">关闭</button></div>
    <div class="panel-body">
      <div class="form-row"><label>原因(决定责任归属与费用)</label>
        <div id="reasonList">${reasons.map(([code, r]) => `
          <div class="reason-option" data-code="${code}">
            <div><b>${esc(r.label)}</b><div class="rd">${esc(r.desc)}</div></div>
            <span class="tag resp">责任:${({ front: '前厅', kitchen: '后厨', guest: '客人', house: '门店' })[r.responsibility]}</span>
          </div>`).join('')}
        </div>
      </div>
      <div class="form-row"><label>备注</label><input id="mNote" placeholder="补充说明(可选)"></div>
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button class="btn primary" id="mOk" disabled>提交</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(mask);
  let picked = null;
  mask.querySelector('#mClose').onclick = () => mask.remove();
  mask.querySelectorAll('.reason-option').forEach((el) => {
    el.onclick = () => {
      mask.querySelectorAll('.reason-option').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
      picked = el.dataset.code;
      mask.querySelector('#mOk').disabled = false;
    };
  });
  mask.querySelector('#mOk').onclick = () => {
    const note = mask.querySelector('#mNote').value.trim();
    mask.remove();
    onPick(picked, note);
  };
}

function openReturn(itemId) {
  const requestId = `ret-${itemId}-${Date.now()}`; // 本次申请的幂等键:重复提交/网络重试只生效一次
  reasonModal('申请退菜(需值班经理审批后退款)', async (reasonCode, note) => {
    try {
      const r = await api('POST', `/api/items/${itemId}/return`, { reason_code: reasonCode, note, request_id: requestId });
      ok(r.duplicated ? '重复提交被幂等拦截' : '退菜申请已提交,等待经理审批');
      refreshOrder();
    } catch (e) { fail(e); refreshOrder(); }
  });
}

function openRemake(itemId) {
  reasonModal('申请重做(后厨按原单位置重新制作)', async (reasonCode, note) => {
    try {
      await api('POST', `/api/items/${itemId}/remake`, { reason_code: reasonCode, note });
      ok('已通知后厨重做,队列保持原单位置');
      refreshOrder();
    } catch (e) { fail(e); refreshOrder(); }
  });
}

/* ── 时间线抽屉 ── */
async function openTimeline(itemId) {
  const tl = await api('GET', `/api/items/${itemId}/timeline`);
  const drawer = document.createElement('div');
  drawer.className = 'drawer';
  drawer.innerHTML = `
    <div class="panel-head">菜品时间线 #${itemId}
      <button class="btn sm" id="dClose">关闭</button></div>
    <div class="timeline">
      ${tl.map((e) => `
        <div class="tl-item ${e.action === 'remind' ? 'remind' : ''}">
          <div class="t">${fmtTime(e.created_at)}</div>
          <div class="d"><span class="actor">${esc(e.actor)}</span>${esc(e.detail)}</div>
        </div>`).join('') || '<div class="empty">暂无记录</div>'}
    </div>`;
  drawer.querySelector('#dClose').onclick = () => drawer.remove();
  document.body.appendChild(drawer);
}

/* ── 开台/加菜 ── */
function openNewOrder() {
  if (!selectedTable) return;
  const picked = new Map(); // dishId -> {qty, allergy}
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const render = () => {
    mask.querySelector('#dishList').innerHTML = BOOT.dishes.map((d) => {
      const p = picked.get(d.id);
      return `<div class="dp" data-id="${d.id}">
        <img src="${d.photo}" alt="">
        <div><div class="dn">${esc(d.name)}</div>
          <div class="dpr">${fmtMoney(d.price_cents)}${d.allergens ? ` · 含${esc(d.allergens)}` : ''}</div></div>
        <div class="qty-ctl">
          <button data-act="dec">−</button><span class="q">${p ? p.qty : 0}</span><button data-act="inc">+</button>
        </div>
      </div>`;
    }).join('');
    mask.querySelector('#allergyRow').style.display = picked.size ? 'block' : 'none';
  };
  mask.innerHTML = `<div class="modal">
    <div class="panel-head">桌台 #${selectedTable} 点单<div style="flex:1"></div>
      <button class="btn sm" id="mClose">关闭</button></div>
    <div class="panel-body">
      <div class="dish-pick" id="dishList"></div>
      <div class="form-row" id="allergyRow" style="display:none;margin-top:12px">
        <label>过敏/忌口备注(随单传给后厨,漏看属前厅责任)</label>
        <input id="allergyNote" placeholder="如:花生过敏,免花生">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:12px">
        <button class="btn primary" id="mSubmit">提交厨单</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(mask);
  render();
  mask.querySelector('#mClose').onclick = () => mask.remove();
  mask.querySelector('#dishList').onclick = (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const id = Number(e.target.closest('.dp').dataset.id);
    const cur = picked.get(id) || { qty: 0 };
    cur.qty = Math.max(0, Math.min(20, cur.qty + (btn.dataset.act === 'inc' ? 1 : -1)));
    if (cur.qty === 0) picked.delete(id); else picked.set(id, cur);
    render();
  };
  mask.querySelector('#mSubmit').onclick = async () => {
    if (!picked.size) return fail(new Error('请选择菜品'));
    const allergy = mask.querySelector('#allergyNote').value.trim();
    try {
      await api('POST', '/api/orders', {
        table_id: selectedTable,
        items: [...picked.entries()].map(([dish_id, p]) => ({ dish_id, qty: p.qty, allergy_note: allergy })),
      });
      mask.remove();
      ok('已下单,厨单已打印');
      refreshBoard();
      refreshOrder();
    } catch (e) { fail(e); }
  };
}

/* ── 启动 ── */
(async function main() {
  BOOT = await mountTopbar('front', ['waiter', 'manager']);
  await refreshBoard();
  pollTimer = setInterval(async () => {
    if (document.querySelector('.modal-mask, .drawer')) return; // 弹层打开时暂停轮询,避免打断操作
    try { await refreshBoard(); if (selectedTable) await refreshOrder(); } catch { /* 忽略瞬时错误 */ }
  }, 3000);
})();
