/* 三屏共用：角色切换、轮询、渲染与操作 */

const REASONS = [
  ["slow", "催菜"], ["allergy_missed", "过敏漏看"], ["temperature", "温度不合格"],
  ["quality", "质量问题"], ["wrong_item", "上错菜"], ["guest_away", "客人离席"],
  ["other", "其他"],
];
const EVENT_LABEL = {
  created: "开单", urge_again: "再次催单", kitchen_ack: "后厨响应",
  stage_update: "阶段更新", remake_started: "发起重做", served: "已出餐",
  wrong_delivered: "标记错上桌", reject: "驳回", resolve: "结案",
};
const REFRESH_MS = 3000;

const state = { emp: null, employees: [] };

// ------------------------------------------------------------- 基础
const $ = (sel, root = document) => root.querySelector(sel);
const yuan = (cents) => (cents / 100).toFixed(2);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function hhmm(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-CN", { hour12: false }).slice(0, 5);
}

function waitClass(sec) {
  if (sec <= 0) return "none";
  if (sec < 5 * 60) return "ok";
  if (sec < 10 * 60) return "warn";
  return "hot";
}
function waitText(sec) {
  if (sec <= 0) return "—";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m < 1 ? `${s}s` : `${m}分${s.toString().padStart(2, "0")}`;
}
const isActive = (st) => ["queued", "prepping", "cooking"].includes(st);

async function api(path, body) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 2600);
}

async function callApi(path, body, okMsg) {
  try {
    await api(path, body);
    toast(okMsg);
    await refresh();
  } catch (e) {
    toast(e.message, true);
  }
}

// ------------------------------------------------------------- 顶栏
async function initTopbar(active) {
  state.employees = (await api("/api/employees")).employees;
  const sel = $("#empSelect");
  sel.innerHTML = state.employees
    .map((e) => `<option value="${e.id}">${esc(e.name)} · ${
      { waiter: "服务员", chef: "后厨", manager: "值班经理" }[e.role]}</option>`)
    .join("");
  const saved = Number(localStorage.getItem("emp_id"));
  state.emp = state.employees.find((e) => e.id === saved) || state.employees[0];
  sel.value = state.emp.id;
  sel.onchange = () => {
    state.emp = state.employees.find((e) => e.id === Number(sel.value));
    localStorage.setItem("emp_id", state.emp.id);
    refresh();
  };
  document.querySelectorAll(".topbar nav a").forEach((a) => {
    if (a.dataset.page === active) a.classList.add("active");
  });
  setInterval(() => {
    const c = $("#clock");
    if (c) c.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }, 1000);
}
const empId = () => state.emp.id;
const role = () => state.emp.role;

// ------------------------------------------------------------- 共享渲染
function statusBadge(st, label) {
  return `<span class="badge ${st}">${esc(label || st)}</span>`;
}

function timelineHtml(events) {
  if (!events || !events.length) return "";
  return `<ul class="timeline">${events
    .map((e) => {
      const msg = e.payload?.message || e.payload?.note ||
        (e.payload?.outcome ? `结果：${e.payload.outcome}` : "") ||
        (e.payload?.stage ? `阶段：${e.payload.stage}` : "");
      return `<li class="${e.type === "urge_again" ? "again" : ""}">
        <span class="t">${hhmm(e.created_at)}</span>
        <span>${esc(e.actor)} · ${EVENT_LABEL[e.type] || e.type}${msg ? "：" + esc(msg) : ""}</span>
      </li>`;
    })
    .join("")}</ul>`;
}

function ticketHtml(tk) {
  const isUrge = tk.kind === "urge";
  const ackCls = tk.status === "acknowledged" ? " ack" : "";
  return `<div class="ticket ${isUrge ? "urge" : ""}${ackCls}" data-ticket="${tk.id}" data-item="${tk.link_item ?? tk.item_id ?? ""}">
    <div class="ticket-head">
      <span class="kind">${isUrge ? "催菜" : "退/问题"} #${tk.id}</span>
      <span class="reason">${esc(tk.reason_label)}</span>
      <span class="liab">责任：${esc(tk.liability_label)}</span>
      <span class="spacer"></span>
      <span class="liab">${tk.status === "acknowledged" ? "后厨已响应" : "待处理"}</span>
    </div>
    ${tk.note ? `<div class="ticket-note">${esc(tk.note)}</div>` : ""}
    ${timelineHtml(tk.events)}
    <div class="ticket-actions" data-hook="ticket-actions" data-ticket="${tk.id}"
         data-kind="${tk.kind}" data-reason="${tk.reason_code}"></div>
  </div>`;
}

// ============================================================= 前厅
async function renderFloor() {
  const data = await api("/api/floor");
  const root = $("#floorBoard");
  root.innerHTML = data.tables
    .map((t) => {
      const wc = waitClass(t.max_wait_seconds);
      return `<section class="card" data-table="${t.table_id}">
        <div class="card-head">
          <span class="table-no">${esc(t.table_code)}</span>
          <span class="spacer"></span>
          <span class="wait ${wc}">${wc === "none" ? "无等待" : "等待 " + waitText(t.max_wait_seconds)}</span>
        </div>
        <div class="card-body">
          ${t.items.map((it) => dishHtml(it)).join("") || `<div class="empty">暂无菜品</div>`}
          <div class="bill" style="margin-top:8px">当前账单 <b>¥${yuan(t.bill_cents)}</b></div>
          ${t.open_tickets.map(ticketHtml).join("")}
        </div>
      </section>`;
    })
    .join("");

  // 菜行操作
  root.querySelectorAll("[data-urge]").forEach((b) =>
    b.onclick = () => callApi("/api/urge",
      { item_id: Number(b.dataset.urge), employee_id: empId(), note: "" }, "已催菜，后厨队列不会重复"));
  root.querySelectorAll("[data-wrong]").forEach((b) =>
    b.onclick = () => callApi("/api/wrong-delivery",
      { item_id: Number(b.dataset.wrong), employee_id: empId() }, "已标记错上桌，自动生成前厅责任处理单"));
  root.querySelectorAll("[data-reason-pick]").forEach((box) => {
    box.querySelectorAll("button").forEach((b) =>
      (b.onclick = () =>
        callApi("/api/returns", {
          item_id: Number(box.dataset.reasonPick), employee_id: empId(),
          reason_code: b.dataset.reason, note: b.dataset.note || "",
        }, `已记录「${b.textContent}」处理单`)));
  });

  bindTicketActions(root);
}

function dishHtml(it) {
  const active = isActive(it.live_status);
  const canManage = role() === "waiter" || role() === "manager";
  const remakeCount = it.remake_total
    ? `<span class="badge remaking">重做×${it.remake_total}</span>` : "";
  return `<div class="dish">
    <img src="${esc(it.photo || "")}" alt="" onerror="this.style.visibility='hidden'">
    <div class="info">
      <div class="name">
        ${it.seat_no ? `<span class="seat-tag">${it.seat_no}号位</span>` : ""}
        ${esc(it.dish_name)} ${remakeCount}
        ${it.allergen ? `<span class="allergen">含${esc(it.allergen)}</span>` : ""}
      </div>
      <div class="sub">¥${yuan(it.price_cents)} · ${statusBadge(it.live_status, it.status_label)}
        ${it.has_open_urge ? '<span class="badge cooking">催单中</span>' : ""}</div>
    </div>
    ${canManage ? `<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
      ${active ? `<button class="tiny ghost" data-urge="${it.root_item_id || it.id}">催菜</button>` : ""}
      <span class="reason-pick" style="padding:0" data-reason-pick="${it.root_item_id || it.id}">
        <button class="tiny" data-reason="allergy_missed">过敏</button>
        <button class="tiny" data-reason="temperature">温度</button>
        <button class="tiny" data-reason="quality">质量</button>
        <button class="tiny" data-reason="guest_away">离席</button>
      </span>
      <button class="tiny danger" data-wrong="${it.root_item_id || it.id}">错上桌</button>
    </div>` : ""}
  </div>`;
}

// 处理单上的动作（前厅屏：重做/取消/申请退款；后厨屏单独绑定）
function bindTicketActions(root) {
  root.querySelectorAll("[data-hook=ticket-actions]").forEach((box) => {
    const tid = Number(box.dataset.ticket);
    const reason = box.dataset.reason;
    if (box.dataset.kind === "urge") {
      box.innerHTML = role() === "chef"
        ? `<button class="tiny" data-ack="prepping">已备料</button>
           <button class="tiny" data-ack="cooking">烹制中</button>
           <button class="tiny done" data-ack="plated">已出餐</button>`
        : `<span class="sub" style="font-size:12px;color:#9a938a">后厨响应见后厨屏</span>`;
    } else if (role() !== "chef") {
      box.innerHTML = `
        <button class="tiny" data-remake>重做</button>
        <button class="tiny ghost" data-cancel>出餐前取消·免单</button>
        <button class="tiny danger" data-refund-req>申请退款/收费审批</button>`;
    }
    box.querySelectorAll("[data-ack]").forEach((b) =>
      (b.onclick = () => callApi(`/api/tickets/${tid}/ack`,
        { employee_id: empId(), stage: b.dataset.ack }, "后厨已响应")));
    const rb = $("[data-remake]", box);
    if (rb) rb.onclick = () => callApi(`/api/tickets/${tid}/remake`,
      { employee_id: empId() }, "已发起重做，新菜进入后厨队列（仅一份）");
    const cb = $("[data-cancel]", box);
    if (cb) cb.onclick = () => callApi(`/api/tickets/${tid}/cancel`,
      { employee_id: empId() }, "已取消且免单");
    const fb = $("[data-refund-req]", box);
    if (fb) fb.onclick = () => submitApproval(tid, reason);
  });
}

async function submitApproval(ticketId, reason) {
  // 金额与类型由服务员在极简弹窗确认；服务员只能“申请”，批准权在经理
  const card = $(`[data-ticket="${ticketId}"]`);
  const itemId = Number(card?.dataset.item);
  if (!itemId) return toast("找不到关联订单项", true);
  const raw = prompt("申请金额（元）。已出餐=退款，未出餐=取消保留收费；\n服务员仅能提交，需值班经理审批。", "");
  if (raw === null) return;
  const amount = Math.round(Number(raw) * 100);
  if (!Number.isFinite(amount) || amount < 0) return toast("金额无效", true);
  const kind = reason === "guest_away" ? "cancel" : "refund";
  // 幂等键由前端生成：双击/重试不会产生两条审批
  const key = `ui:${itemId}:${kind}:${amount}`;
  await callApi("/api/approvals", {
    item_id: itemId,
    employee_id: empId(), request_kind: kind, reason_code: reason,
    amount_cents: amount, idempotency_key: key,
  }, "已提交值班经理审批");
}

// ============================================================= 后厨
async function renderKitchen() {
  const data = await api("/api/kitchen");
  const root = $("#kitchenBoard");
  if (!data.stations.length) {
    root.innerHTML = `<div class="empty">后厨队列已清空</div>`;
    return;
  }
  root.innerHTML = data.stations
    .map(
      (st) => `<div>
        <div class="station-title">${esc(st.station)} <span class="count">${st.items.length} 份在制</span></div>
        <div class="kitchen-board" style="grid-template-columns:1fr">
          ${st.items.map(kitchenCardHtml).join("")}
        </div>
      </div>`
    )
    .join("");

  root.querySelectorAll("[data-stage]").forEach((b) =>
    (b.onclick = () => callApi("/api/kitchen/stage",
      { item_id: Number(b.dataset.stage), employee_id: empId(), stage: b.dataset.to },
      "阶段已更新")));
  root.querySelectorAll("[data-kremake]").forEach((b) =>
    (b.onclick = () => callApi(`/api/tickets/${Number(b.dataset.kremake)}/remake`,
      { employee_id: empId() }, "已重做，新菜按原单位置入队")));
  root.querySelectorAll("[data-kack]").forEach((b) =>
    (b.onclick = () => callApi(`/api/tickets/${Number(b.dataset.kack)}/ack`,
      { employee_id: empId(), stage: b.dataset.to }, "已响应处理单")));
}

function kitchenCardHtml(it) {
  const canOp = role() === "chef" || role() === "manager";
  const wc = waitClass(it.wait_seconds);
  const stageBtns = canOp
    ? `<div class="stage-actions">
        <button class="tiny ghost stage-btn" data-stage="${it.id}" data-to="prepping" ${it.status !== "queued" ? "disabled" : ""}>已备料</button>
        <button class="tiny ghost stage-btn" data-stage="${it.id}" data-to="cooking" ${it.status !== "prepping" ? "disabled" : ""}>烹制中</button>
        <button class="tiny stage-btn done" data-stage="${it.id}" data-to="plated" ${it.status === "queued" ? "disabled" : ""}>出餐</button>
      </div>`
    : "";
  return `<section class="card kcard">
    ${it.is_remake
      ? `<div class="remake-flag">🔁 重做 <span class="seq">第 ${it.origin.remake_seq} 版</span>
           <span style="font-weight:400;font-size:12px">原单位置：${esc(it.origin.table_code)} · ${it.origin.seat_no || "?"}号位</span></div>`
      : ""}
    <div class="dishrow">
      <div class="name">
        ${esc(it.dish_name)}
        <span class="seat-tag">${esc(it.table_code)} · ${it.seat_no || "?"}号位</span>
        ${statusBadge(it.status, it.status_label)}
      </div>
      <div class="origin">下单服务员：${esc(it.waiter_name)}${it.note ? " · 备注：" + esc(it.note) : ""}</div>
      <div class="waitline">
        <span class="wait ${wc}">${waitText(it.wait_seconds)}</span>
      </div>
      ${it.tickets
        .map(
          (tk) => `<div class="ticket ${tk.kind === "urge" ? "urge" : ""}">
            <div class="ticket-head">
              <span class="kind">${tk.kind === "urge" ? "催菜" : "退/问题"} #${tk.id}</span>
              <span class="reason">${esc(tk.reason_label)}</span>
              <span class="liab">责任：${esc({ kitchen: "后厨", floor: "前厅", guest: "客人", split: "双方分担" }[tk.liability])}</span>
            </div>
            ${timelineHtml(tk.events)}
            ${canOp ? `<div class="ticket-actions">
              ${tk.kind === "urge"
                ? `<button class="tiny" data-kack="${tk.id}" data-to="prepping">已备料</button>
                   <button class="tiny" data-kack="${tk.id}" data-to="cooking">烹制中</button>
                   <button class="tiny" data-kack="${tk.id}" data-to="plated">已出餐</button>`
                : `<button class="tiny danger" data-kremake="${tk.id}">重做新菜</button>`}
            </div>` : ""}
          </div>`
        )
        .join("")}
      ${stageBtns}
    </div>
    ${it.allergen_alert ? `<div class="allergy-bar">⚠ 过敏原：${esc(it.allergen_alert)}</div>` : ""}
  </section>`;
}

// ============================================================= 经理
async function renderManager() {
  const [pend, ch] = await Promise.all([
    api(`/api/approvals/pending?employee_id=${empId()}`).catch((e) => ({ error: e.message })),
    api("/api/charges"),
  ]);
  const list = $("#approvalList");
  if (pend.error) {
    list.innerHTML = `<div class="empty">${esc(pend.error)}（仅值班经理可审批）</div>`;
  } else if (!pend.approvals.length) {
    list.innerHTML = `<div class="empty">没有待审批单</div>`;
  } else {
    list.innerHTML = pend.approvals
      .map(
        (a) => `<div class="approval" data-ap="${a.id}">
          <div class="a-main">
            <div class="a-title">${esc(a.table_code)} · ${esc(a.dish_name)}
              <span class="tag-pending">${a.request_kind === "refund" ? "退款" : a.request_kind === "cancel" ? "取消收费" : "重做"}待批</span>
            </div>
            <div class="a-sub">原因：${esc({ slow: "出餐慢", wrong_table: "错上桌", wrong_item: "上错菜",
              allergy_missed: "过敏漏看", temperature: "温度不合格", quality: "质量",
              guest_away: "客人离席", other: "其他" }[a.reason_code] || a.reason_code)}
              · 申请人 ${esc(a.requester)} · 菜价 ¥${yuan(a.item_price)}</div>
          </div>
          <div class="amount ${a.request_kind === "refund" ? "neg" : ""}">
            ${a.request_kind === "refund" ? "−" : ""}¥${yuan(a.amount_cents)}</div>
          <input type="text" placeholder="经理批示（可选）" style="width:170px" data-note>
          <button data-decide="1" class="danger">批准</button>
          <button data-decide="0" class="ghost">驳回</button>
        </div>`
      )
      .join("");
    list.querySelectorAll("[data-ap]").forEach((row) => {
      const id = Number(row.dataset.ap);
      row.querySelectorAll("[data-decide]").forEach((b) =>
        (b.onclick = () =>
          callApi(`/api/approvals/${id}/decide`,
            { manager_id: empId(), approve: b.dataset.decide === "1",
              manager_note: $("[data-note]", row).value },
            b.dataset.decide === "1" ? "已批准并执行（退款幂等）" : "已驳回")));
    });
  }

  const led = $("#chargeLedger");
  led.innerHTML = ch.charges
    .map(
      (c) => `<tr class="${c.kind === "dish_cost" ? "cost" : ""}">
        <td>${esc(c.table_code)}</td><td>${esc(c.dish_name)}</td>
        <td>${esc(c.kind_label)}</td><td>${esc(c.reason_label)}</td>
        <td>${esc(c.approval_status === "approved" ? "已审批" : c.approval_status || "—")}</td>
        <td class="num ${c.amount_cents < 0 ? "neg" : ""}">${c.amount_cents < 0 ? "−" : ""}¥${yuan(Math.abs(c.amount_cents))}</td>
      </tr>`
    )
    .join("");
}

// ------------------------------------------------------------- 启动
async function boot(page) {
  await initTopbar(page);
  const pages = {
    floor: [renderFloor, "#floorBoard"],
    kitchen: [renderKitchen, "#kitchenBoard"],
    manager: [renderManager, "#approvalList"],
  };
  const [renderFn] = pages[page];
  async function refresh() {
    try {
      await renderFn();
    } catch (e) {
      toast(e.message, true);
    }
  }
  window.refresh = refresh;
  await refresh();
  setInterval(refresh, REFRESH_MS);
}
