'use strict';
/* 经理页:退款审批(可调整金额) + 损耗责任汇总 */
let BOOT = null;

const RESP_LABEL = { front: '前厅', kitchen: '后厨', guest: '客人', house: '门店' };

async function refresh() {
  const [refunds, losses] = await Promise.all([
    api('GET', '/api/manager/refunds'),
    api('GET', '/api/manager/losses'),
  ]);
  renderRefunds(refunds);
  renderLosses(losses);
}

function renderRefunds(list) {
  const el = document.getElementById('refunds');
  if (!list.length) { el.innerHTML = '<div class="empty">暂无退款申请</div>'; return; }
  el.innerHTML = list.map((r) => {
    const reason = BOOT.reasons[r.reason_code] || { label: r.reason_code, responsibility: 'house' };
    const pending = r.status === 'pending';
    const decided = r.status === 'approved'
      ? `<span class="tag decided-ok">已批准 ${fmtMoney(r.final_amount_cents)}</span>`
      : r.status === 'rejected' ? '<span class="tag decided-ok">已拒绝</span>' : '';
    return `<div class="refund-card">
      <div>
        <div class="r-title">
          ${esc(r.table_name)} · ${esc(r.dish_name)} ×${r.qty}
          <span class="tag reason">${esc(reason.label)}</span>
          <span class="tag resp">责任:${RESP_LABEL[reason.responsibility]}</span>
          ${decided}
        </div>
        <div class="r-meta">
          <span>申请人:${esc(r.requester)}</span>
          <span>菜品状态:${BOOT.statusLabels[r.item_status]}</span>
          <span>申请金额:<b class="money">${fmtMoney(r.amount_cents)}</b></span>
          ${r.note ? `<span>备注:${esc(r.note)}</span>` : ''}
          <span>${fmtTime(r.created_at)}</span>
        </div>
      </div>
      ${pending ? `<div class="r-actions">
        <input class="amount" id="amt-${r.id}" type="number" min="0" step="0.01"
          value="${(r.amount_cents / 100).toFixed(2)}">
        <button class="btn danger sm" onclick="approve(${r.id})">批准退款</button>
        <button class="btn sm" onclick="reject(${r.id})">拒绝</button>
      </div>` : '<div></div>'}
    </div>`;
  }).join('');
}

function renderLosses(rows) {
  const el = document.getElementById('losses');
  if (!rows.length) { el.innerHTML = '<div class="empty">暂无损耗记录</div>'; return; }
  const total = rows.reduce((s, r) => s + r.cost_cents, 0);
  el.innerHTML = `
    ${rows.map((r) => `
      <div class="bill-line">
        <span><span class="tag resp">${RESP_LABEL[r.responsibility] || r.responsibility}</span>
          ${esc(r.reason)} <span style="color:var(--ink-3)">×${r.cases}</span></span>
        <span class="money" style="color:var(--warm)">-${fmtMoney(r.cost_cents)}</span>
      </div>`).join('')}
    <div class="bill-total"><span>损耗合计</span><span class="num" style="color:var(--warm)">-${fmtMoney(total)}</span></div>`;
}

async function approve(id) {
  const yuan = Number(document.getElementById(`amt-${id}`).value);
  if (!Number.isFinite(yuan) || yuan < 0) return fail(new Error('金额不合法'));
  try {
    const r = await api('POST', `/api/refunds/${id}/approve`, { amount_cents: Math.round(yuan * 100) });
    ok(r.duplicated ? '该申请已批准过(幂等)' : '已批准退款');
    refresh();
  } catch (e) { fail(e); refresh(); }
}

async function reject(id) {
  const note = prompt('拒绝原因(可留空)', '');
  if (note === null) return;
  try {
    await api('POST', `/api/refunds/${id}/reject`, { note });
    ok('已拒绝,菜品解冻继续制作');
    refresh();
  } catch (e) { fail(e); refresh(); }
}

(async function main() {
  BOOT = await mountTopbar('manager', ['manager']);
  await refresh();
  setInterval(() => { refresh().catch(() => {}); }, 3000);
})();
