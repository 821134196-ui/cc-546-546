'use strict';
/* 公共:API 客户端(带角色头)、会话、格式化、提示 */
const session = {
  get userId() { return Number(localStorage.getItem('yw_uid')) || null; },
  set userId(v) { localStorage.setItem('yw_uid', String(v)); },
};

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-User-Id': String(session.userId || ''),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data.error && data.error.message) || `请求失败(${res.status})`);
    err.status = res.status;
    err.code = data.error && data.error.code;
    throw err;
  }
  return data;
}

const fmtMoney = (cents) => `¥${(cents / 100).toFixed(2)}`;
const fmtTime = (iso) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtWait = (iso) => {
  const m = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? '刚下单' : `${m}分钟`;
};

let toastTimer = null;
function toast(msg, isErr) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = `toast${isErr ? ' err' : ''}`;
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2600);
}
const ok = (m) => toast(m, false);
const fail = (e) => toast(e.message || String(e), true);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 顶栏:用户切换 + 导航 */
async function mountTopbar(activePage, roleFilter) {
  const boot = await api('GET', '/api/bootstrap');
  window.BOOT = boot;
  const bar = document.querySelector('.topbar');
  const users = roleFilter ? boot.users.filter((u) => roleFilter.includes(u.role)) : boot.users;
  if (!session.userId || !users.some((u) => u.id === session.userId)) {
    session.userId = users[0] ? users[0].id : null;
  }
  const roleName = { waiter: '服务员', kitchen: '后厨', manager: '值班经理' };
  bar.innerHTML = `
    <div class="brand">一味<em>小馆</em></div>
    <nav class="nav">
      <a href="/" class="${activePage === 'front' ? 'active' : ''}">前厅</a>
      <a href="/kitchen" class="${activePage === 'kitchen' ? 'active' : ''}">后厨屏</a>
      <a href="/manager" class="${activePage === 'manager' ? 'active' : ''}">经理审批</a>
    </nav>
    <div class="spacer"></div>
    <div class="user-picker">
      <span>当前身份</span>
      <select id="userSel">${users.map((u) =>
        `<option value="${u.id}" ${u.id === session.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}
      </select>
      <span class="role-tag ${users.find((u) => u.id === session.userId)?.role || ''}">
        ${roleName[users.find((u) => u.id === session.userId)?.role] || ''}
      </span>
    </div>`;
  bar.querySelector('#userSel').addEventListener('change', (e) => {
    session.userId = Number(e.target.value);
    location.reload();
  });
  return boot;
}

function heatLevel(waitMin) {
  if (waitMin >= 30) return 3;
  if (waitMin >= 20) return 2;
  if (waitMin >= 10) return 1;
  return 0;
}
