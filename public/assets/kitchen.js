'use strict';
/* 后厨屏:队列按原单位置(seq)展示;重做带标记;催单次数闪烁;一键推进阶段 */
let BOOT = null;

const NEXT_STAGE_LABEL = {
  pending: '开始备料',
  preparing: '开始烹制',
  cooking: '出餐',
  remaking: '重新备料',
};
const NEXT_STAGE = {
  pending: 'preparing',
  preparing: 'cooking',
  cooking: 'served',
  remaking: 'preparing',
};

async function refresh() {
  const rows = await api('GET', '/api/kitchen/queue');
  const el = document.getElementById('queue');
  if (!rows.length) {
    el.innerHTML = '<div class="empty">队列已清空,暂无待制作菜品</div>';
    return;
  }
  el.innerHTML = rows.map((r) => {
    const isRemake = r.kind === 'remake';
    const reasonLabel = r.remake_reason && BOOT.reasons[r.remake_reason]
      ? BOOT.reasons[r.remake_reason].label : '';
    return `<div class="k-row ${isRemake ? 'remake' : ''}">
      <div class="seq">#${r.seq}</div>
      <div class="ktable">${esc(r.table_name)}</div>
      <div>
        <div class="kdish">${esc(r.dish_name)} ×${r.qty}
          ${isRemake ? `<span class="badge-remake">重做${reasonLabel ? ` · ${esc(reasonLabel)}` : ''}</span>` : ''}
          ${r.remind_count > 0 ? `<span class="badge-urge">催×${r.remind_count}</span>` : ''}
        </div>
        <div class="kmeta">
          <span class="chip st-${r.status}">${BOOT.statusLabels[r.status]}</span>
          ${r.allergy_note ? `<span class="allergy">⚠ ${esc(r.allergy_note)}</span>` : ''}
          <span class="ktime">下单 ${fmtTime(r.created_at)} · 已等 ${fmtWait(r.created_at)}</span>
        </div>
      </div>
      <div></div>
      <div>
        ${NEXT_STAGE[r.status]
          ? `<button class="btn primary" onclick="advance(${r.item_id}, '${NEXT_STAGE[r.status]}')">${NEXT_STAGE_LABEL[r.status]} →</button>`
          : `<span class="chip">${BOOT.statusLabels[r.status]}</span>`}
      </div>
    </div>`;
  }).join('');
}

async function advance(itemId, stage) {
  try {
    await api('POST', `/api/items/${itemId}/stage`, { stage });
    refresh();
  } catch (e) {
    fail(e); // 状态冲突(如同时被退菜冻结)会收到 409,刷新后呈现最新状态
    refresh();
  }
}

(async function main() {
  BOOT = await mountTopbar('kitchen', ['kitchen', 'manager']);
  await refresh();
  setInterval(() => { refresh().catch(() => {}); }, 3000);
})();
