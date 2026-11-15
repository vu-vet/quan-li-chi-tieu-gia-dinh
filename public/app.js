'use strict';
/* Quản lí chi tiêu gia đình — client logic (vanilla JS, no build step). */

const $ = (id) => document.getElementById(id);
const state = {
  user: null,
  transactions: [],
  budgets: [],
  recurringItems: [],
  options: { incomeCategory: [], expenseCategory: [], person: [], paymentMethod: [] },
};
let currentMonth = monthOf(new Date());
let editingTxId = null;
let entryType = 'expense';
let sel = { category: '', person: '', payment: '' };
let editingRecId = null;
let recType = 'expense';
let deleteArm = false;

const PALETTE = ['#2563eb', '#e11d48', '#f59e0b', '#16a34a', '#9333ea', '#0891b2', '#ea580c', '#65a30d', '#db2777', '#475569', '#0d9488', '#b45309'];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(n) { return '¥' + Number(n || 0).toLocaleString('ja-JP'); }
function monthOf(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); }
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return monthOf(d);
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `Tháng ${m}/${y}`;
}
function todayStr() {
  const d = new Date();
  return monthOf(d) + '-' + String(d.getDate()).padStart(2, '0');
}
function normalizeLoose(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D').trim().toLowerCase();
}

async function api(pathname, method, body) {
  const res = await fetch(pathname, {
    method: method || 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ------------------------------------------------------------ data loading
async function loadState() {
  const s = await api('/api/state');
  state.user = s.user;
  state.transactions = s.transactions;
  state.budgets = s.budgets;
  state.recurringItems = s.recurringItems;
  state.options = s.options;
}

async function applyRecurringFor(month) {
  const r = await api('/api/recurring-items/apply', 'POST', { month });
  state.transactions = r.transactions;
}

async function refresh() {
  await loadState();
  await applyRecurringFor(currentMonth);
  render();
}

// ------------------------------------------------------------ derived data
function txOfMonth(month) { return state.transactions.filter((t) => t.date.startsWith(month)); }
function totals(month) {
  let inc = 0, exp = 0;
  for (const t of txOfMonth(month)) {
    if (t.type === 'income') inc += t.amount; else exp += t.amount;
  }
  return { inc, exp, bal: inc - exp };
}
function settlementOf(methodName) {
  const opt = state.options.paymentMethod.find(
    (o) => o.name.trim().toLowerCase() === String(methodName || '').trim().toLowerCase()
  );
  if (opt && opt.settlement) return opt.settlement;
  const n = String(methodName || '').toLowerCase();
  return (n.includes('paypay') || n.includes('thẻ tín dụng') || n.includes('credit')) ? 'next' : 'now';
}
function deferredInfo(month) {
  const per = {};
  let total = 0;
  for (const t of txOfMonth(month)) {
    if (t.type !== 'expense' || !t.paymentMethod) continue;
    if (settlementOf(t.paymentMethod) === 'next') {
      per[t.paymentMethod] = (per[t.paymentMethod] || 0) + t.amount;
      total += t.amount;
    }
  }
  return { total, per };
}

// ------------------------------------------------------------ rendering
function render() {
  $('month-label').textContent = monthLabel(currentMonth);
  $('month-today').classList.toggle('hidden', currentMonth === monthOf(new Date()));
  $('donut-month-label').textContent = monthLabel(currentMonth);
  const t = totals(currentMonth);
  $('summary').innerHTML =
    `<div class="stat in"><div class="num">${fmt(t.inc)}</div><div class="lab">Tổng thu</div></div>` +
    `<div class="stat out"><div class="num">${fmt(t.exp)}</div><div class="lab">Tổng chi</div></div>` +
    `<div class="stat"><div class="num">${fmt(t.bal)}</div><div class="lab">Còn lại</div></div>`;

  const d = deferredInfo(currentMonth);
  const note = $('deferred-note');
  if (d.total > 0) {
    const parts = Object.entries(d.per).map(([k, v]) => `${esc(k)}: ${fmt(v)}`).join(' · ');
    note.innerHTML = `💳 <span class="big">Sẽ thanh toán tháng sau: ${fmt(d.total)}</span><br>${esc(parts)} — các khoản này vẫn tính vào chi của ${esc(monthLabel(currentMonth).toLowerCase())}.`;
    note.classList.remove('hidden');
  } else {
    note.classList.add('hidden');
    note.innerHTML = '';
  }

  renderBarChart();
  renderDonut();
  renderTxList();
  renderBudgets();
  renderRecurring();
  renderSettlement();
  $('account-info').textContent = state.user
    ? `Gia đình: ${state.user.familyName} · Tên đăng nhập: ${state.user.username}` : '';
}

function renderBarChart() {
  const months = [];
  for (let i = 5; i >= 0; i--) months.push(shiftMonth(currentMonth, -i));
  const data = months.map((m) => ({ m, ...totals(m) }));
  const max = Math.max(1, ...data.map((d) => Math.max(d.inc, d.exp)));
  $('bar-chart').innerHTML = data.map((d) => {
    const hi = Math.round((d.inc / max) * 100);
    const ho = Math.round((d.exp / max) * 100);
    const [y, mm] = d.m.split('-');
    return `<div class="bar-col ${d.m === currentMonth ? 'current' : ''}" data-month="${d.m}" title="Thu ${fmt(d.inc)} · Chi ${fmt(d.exp)}">
      <div class="bar-pair"><div class="bar in" style="height:${hi}%"></div><div class="bar out" style="height:${ho}%"></div></div>
      <div class="blab">T${Number(mm)}/${y.slice(2)}</div></div>`;
  }).join('');
  $('bar-chart').querySelectorAll('.bar-col').forEach((el) => {
    el.addEventListener('click', async () => {
      currentMonth = el.dataset.month;
      await applyRecurringFor(currentMonth);
      render();
    });
  });
}

function renderDonut() {
  const byCat = {};
  let total = 0;
  for (const t of txOfMonth(currentMonth)) {
    if (t.type !== 'expense') continue;
    byCat[t.category] = (byCat[t.category] || 0) + t.amount;
    total += t.amount;
  }
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const chart = $('donut-chart');
  const legend = $('donut-legend');
  if (!entries.length || total === 0) {
    chart.innerHTML = '<p class="muted">Chưa có khoản chi nào trong tháng này.</p>';
    legend.innerHTML = '';
    return;
  }
  const r = 70, c = 2 * Math.PI * r;
  let offset = 0;
  const segs = entries.map(([cat, amt], i) => {
    const frac = amt / total;
    const seg = `<circle cx="90" cy="90" r="${r}" fill="none" stroke="${PALETTE[i % PALETTE.length]}" stroke-width="30"
      stroke-dasharray="${(frac * c).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-offset * c).toFixed(2)}"
      transform="rotate(-90 90 90)"><title>${esc(cat)}: ${fmt(amt)}</title></circle>`;
    offset += frac;
    return seg;
  }).join('');
  chart.innerHTML = `<svg width="180" height="180" viewBox="0 0 180 180">${segs}
    <text x="90" y="86" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor">Tổng chi</text>
    <text x="90" y="106" text-anchor="middle" font-size="14" fill="currentColor">${fmt(total)}</text></svg>`;
  legend.innerHTML = entries.map(([cat, amt], i) =>
    `<li><span class="swatch" style="background:${PALETTE[i % PALETTE.length]}"></span>${esc(cat)}
     <span class="amt">${fmt(amt)}</span><span class="pct">${Math.round((amt / total) * 100)}%</span></li>`).join('');
}

function renderTxList() {
  const list = [...txOfMonth(currentMonth)].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  const box = $('tx-list');
  if (!list.length) { box.innerHTML = '<p class="empty">Chưa có khoản nào trong tháng này. Bấm “＋ Thêm khoản” để nhập.</p>'; return; }
  let lastDate = '';
  box.innerHTML = list.map((t) => {
    const head = t.date !== lastDate ? `<div class="tx-date-lab">${esc(t.date)}</div>` : '';
    lastDate = t.date;
    const badges =
      (t.recurringItemId ? ' <span class="badge fixed">Cố định hàng tháng</span>' : '') +
      (t.type === 'expense' && t.paymentMethod && settlementOf(t.paymentMethod) === 'next' ? ' <span class="badge">trả tháng sau</span>' : '');
    const sub = [t.person, t.paymentMethod, t.note].filter(Boolean).map(esc).join(' · ');
    return head + `<div class="tx" data-id="${t.id}">
      <div class="tx-head"><span class="tx-cat">${esc(t.category)}${badges}</span>
      <span class="tx-amt ${t.type === 'income' ? 'in' : 'out'}">${t.type === 'income' ? '+' : '−'}${fmt(t.amount)}</span></div>
      ${sub ? `<div class="tx-sub">${sub}</div>` : ''}</div>`;
  }).join('');
  box.querySelectorAll('.tx').forEach((el) => {
    el.addEventListener('click', () => openEntry(state.transactions.find((t) => t.id === Number(el.dataset.id))));
  });
}

function renderBudgets() {
  const box = $('budget-list');
  if (!state.budgets.length) {
    box.innerHTML = '<p class="muted">Chưa đặt hạn mức cho mục nào. Dùng mẫu bên dưới để đặt — chỉ mục đã đặt mới hiện ở đây.</p>';
  } else {
    box.innerHTML = state.budgets.map((b) => {
      const spent = txOfMonth(currentMonth)
        .filter((t) => t.type === 'expense' && t.category.toLowerCase() === b.category.toLowerCase())
        .reduce((s, t) => s + t.amount, 0);
      const pct = b.amount > 0 ? Math.floor((spent / b.amount) * 100) : 0;
      const cls = spent > b.amount ? 'over' : pct >= b.alertThreshold ? 'warn' : '';
      const alert = spent > b.amount
        ? `<div class="budget-alert over">Đã vượt hạn mức ${fmt(spent - b.amount)}</div>`
        : pct >= b.alertThreshold
          ? `<div class="budget-alert warn">Đã dùng ${pct}% — đạt ngưỡng cảnh báo ${b.alertThreshold}%</div>` : '';
      return `<div class="budget-row">
        <div class="budget-head"><b>${esc(b.category)}</b><span>${fmt(spent)} / ${fmt(b.amount)}</span></div>
        <div class="progress"><div class="${cls}" style="width:${Math.min(100, pct)}%"></div></div>
        ${alert}
        <div class="row-btns">
          <button class="btn btn-small" data-budget-edit="${b.id}">Sửa</button>
          <button class="btn btn-small" data-budget-del="${b.id}">Xoá hạn mức</button>
        </div></div>`;
    }).join('');
    box.querySelectorAll('[data-budget-edit]').forEach((btn) => btn.addEventListener('click', () => {
      const b = state.budgets.find((x) => x.id === Number(btn.dataset.budgetEdit));
      if (!b) return;
      fillBudgetCategorySelect(b.category);
      $('budget-amount').value = b.amount;
      $('budget-threshold').value = b.alertThreshold;
      $('budget-category').value = b.category;
      $('form-budget').scrollIntoView({ behavior: 'smooth' });
    }));
    box.querySelectorAll('[data-budget-del]').forEach((btn) => btn.addEventListener('click', async () => {
      await api('/api/budgets/' + btn.dataset.budgetDel, 'DELETE');
      await refresh();
    }));
  }
  fillBudgetCategorySelect($('budget-category').value);
}

function fillBudgetCategorySelect(keep) {
  const select = $('budget-category');
  const budgeted = new Set(state.budgets.map((b) => b.category.toLowerCase()));
  const names = state.options.expenseCategory.map((o) => o.name)
    .filter((n) => !budgeted.has(n.toLowerCase()) || (keep && n.toLowerCase() === keep.toLowerCase()));
  select.innerHTML = names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  if (keep && names.some((n) => n.toLowerCase() === keep.toLowerCase())) select.value = keep;
}

function renderRecurring() {
  const box = $('recurring-list');
  if (!state.recurringItems.length) {
    box.innerHTML = '<p class="muted">Chưa có mục cố định nào.</p>';
  } else {
    box.innerHTML = state.recurringItems.map((r) =>
      `<div class="rec-row"><div class="rec-main"><b>${esc(r.name)}</b> — ${r.type === 'income' ? '+' : '−'}${fmt(r.amount)}
       · quyết toán ngày ${r.settlementDay} hàng tháng · từ ${esc(r.startMonth)}<br>
       <span class="muted">${esc([r.category, r.person, r.paymentMethod].filter(Boolean).join(' · '))}</span></div>
       <button class="btn btn-small" data-rec-edit="${r.id}">Sửa</button>
       <button class="btn btn-small" data-rec-del="${r.id}">Xoá</button></div>`).join('');
    box.querySelectorAll('[data-rec-edit]').forEach((btn) => btn.addEventListener('click', () => startEditRecurring(Number(btn.dataset.recEdit))));
    box.querySelectorAll('[data-rec-del]').forEach((btn) => btn.addEventListener('click', async () => {
      await api('/api/recurring-items/' + btn.dataset.recDel, 'DELETE');
      await refresh();
    }));
  }
  const fill = (id, opts) => { $(id).innerHTML = opts.map((o) => `<option value="${esc(o.name)}">`).join(''); };
  fill('rec-category-list', state.options[recType === 'income' ? 'incomeCategory' : 'expenseCategory']);
  fill('rec-person-list', state.options.person);
  fill('rec-payment-list', state.options.paymentMethod);
}

function renderSettlement() {
  const box = $('settlement-list');
  box.innerHTML = state.options.paymentMethod.map((o) => {
    const cur = o.settlement || 'now';
    return `<div class="settle-row"><div class="settle-main"><b>${esc(o.name)}</b></div>
      <div class="settle-toggle">
        <button class="toggle-btn ${cur === 'now' ? 'active' : ''}" data-settle="${esc(o.name)}" data-val="now">Trả ngay</button>
        <button class="toggle-btn ${cur === 'next' ? 'active' : ''}" data-settle="${esc(o.name)}" data-val="next">Tháng sau</button>
      </div></div>`;
  }).join('');
  box.querySelectorAll('[data-settle]').forEach((btn) => btn.addEventListener('click', async () => {
    await api('/api/payment-settlement', 'POST', { name: btn.dataset.settle, settlement: btn.dataset.val });
    await refresh();
  }));
}

// ------------------------------------------------------------ entry form
function optionKindFor(which) {
  if (which === 'category') return entryType === 'income' ? 'incomeCategory' : 'expenseCategory';
  if (which === 'person') return 'person';
  return 'paymentMethod';
}

function renderPickers() {
  renderPicker('category');
  renderPicker('person');
  renderPicker('payment');
  $('entry-deferred-hint').classList.toggle('hidden',
    !(entryType === 'expense' && sel.payment && settlementOf(sel.payment) === 'next'));
}

function renderPicker(which) {
  const kind = optionKindFor(which);
  const opts = state.options[kind];
  const selected = which === 'category' ? sel.category : which === 'person' ? sel.person : sel.payment;
  const box = $('picker-' + which);
  box.innerHTML = opts.map((o) =>
    `<button type="button" class="chip ${o.name === selected ? 'active' : ''}" data-pick="${esc(o.name)}">${esc(o.name)}</button>`).join('') +
    `<button type="button" class="chip custom" data-custom="1">＋ Tự đặt tên</button>`;
  box.querySelectorAll('[data-pick]').forEach((chip) => chip.addEventListener('click', () => {
    if (which === 'category') sel.category = chip.dataset.pick;
    else if (which === 'person') sel.person = chip.dataset.pick;
    else sel.payment = chip.dataset.pick;
    renderPickers();
  }));
  box.querySelector('[data-custom]').addEventListener('click', async () => {
    const name = (prompt('Nhập tên mới:') || '').trim();
    if (!name) return;
    await api('/api/options', 'POST', { kind, name });
    await loadState();
    if (which === 'category') sel.category = name;
    else if (which === 'person') sel.person = name;
    else sel.payment = name;
    renderPickers();
    renderManagePanels();
  });
  renderManagePanel(which);
}

function renderManagePanels() {
  renderManagePanel('category');
  renderManagePanel('person');
  renderManagePanel('payment');
}

function renderManagePanel(which) {
  const panel = document.querySelector(`[data-panel="${which}"]`);
  if (panel.classList.contains('hidden')) return;
  const kind = optionKindFor(which);
  const opts = state.options[kind];
  panel.innerHTML = opts.map((o) =>
    `<div class="manage-row"><span class="mname">${esc(o.name)}</span>
     ${o.id ? `<button type="button" class="btn btn-small" data-rename="${o.id}">Đổi tên</button>` : ''}
     <button type="button" class="btn btn-small" data-del="${o.id || ''}" data-name="${esc(o.name)}">Xoá</button></div>`).join('') +
    `<div class="manage-add"><input placeholder="Thêm mục mới…" data-add-input="1"><button type="button" class="btn btn-small" data-add="1">Thêm</button></div>`;
  panel.querySelectorAll('[data-rename]').forEach((btn) => btn.addEventListener('click', async () => {
    const opt = opts.find((o) => o.id === Number(btn.dataset.rename));
    const name = (prompt('Tên mới:', opt ? opt.name : '') || '').trim();
    if (!name) return;
    await api('/api/options/' + btn.dataset.rename, 'PUT', { name });
    await loadState(); renderPickers();
  }));
  panel.querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', async () => {
    let id = btn.dataset.del ? Number(btn.dataset.del) : null;
    if (!id) { // default value: create its row first, then hide it
      const created = await api('/api/options', 'POST', { kind, name: btn.dataset.name });
      id = created.option.id;
    }
    await api('/api/options/' + id, 'DELETE');
    await loadState(); renderPickers();
  }));
  const addBtn = panel.querySelector('[data-add]');
  addBtn.addEventListener('click', async () => {
    const input = panel.querySelector('[data-add-input]');
    const name = input.value.trim();
    if (!name) return;
    await api('/api/options', 'POST', { kind, name });
    await loadState(); renderPickers();
  });
}

function setEntryType(type) {
  entryType = type;
  $('type-expense').classList.toggle('active', type === 'expense');
  $('type-income').classList.toggle('active', type === 'income');
  renderPickers();
}

function openEntry(tx) {
  deleteArm = false;
  $('entry-delete').textContent = 'Xoá khoản';
  $('entry-error').textContent = '';
  if (tx) {
    editingTxId = tx.id;
    $('entry-title').textContent = 'Sửa khoản';
    setEntryType(tx.type);
    $('entry-amount').value = tx.amount;
    $('entry-date').value = tx.date;
    sel = { category: tx.category, person: tx.person || '', payment: tx.paymentMethod || '' };
    $('entry-note').value = tx.note || '';
    $('entry-delete').classList.remove('hidden');
  } else {
    editingTxId = null;
    $('entry-title').textContent = 'Thêm khoản';
    setEntryType('expense');
    $('entry-amount').value = '';
    $('entry-date').value = currentMonth === monthOf(new Date()) ? todayStr() : currentMonth + '-01';
    sel = { category: '', person: state.options.person.length ? state.options.person[0].name : '', payment: state.options.paymentMethod.length ? state.options.paymentMethod[0].name : '' };
    $('entry-note').value = '';
    $('entry-delete').classList.add('hidden');
  }
  renderPickers();
  $('entry-sheet').classList.remove('hidden');
  $('entry-sheet').scrollIntoView({ behavior: 'smooth' });
}

function closeEntry() { $('entry-sheet').classList.add('hidden'); }

// ------------------------------------------------------------ recurring form
function setRecType(type) {
  recType = type;
  $('rec-type-expense').classList.toggle('active', type === 'expense');
  $('rec-type-income').classList.toggle('active', type === 'income');
  renderRecurring();
}

function startEditRecurring(id) {
  const r = state.recurringItems.find((x) => x.id === id);
  if (!r) return;
  editingRecId = id;
  $('recurring-form-title').textContent = 'Sửa mục cố định';
  $('rec-name').value = r.name;
  setRecType(r.type);
  $('rec-amount').value = r.amount;
  $('rec-day').value = r.settlementDay;
  $('rec-start').value = r.startMonth;
  $('rec-category').value = r.category;
  $('rec-person').value = r.person;
  $('rec-payment').value = r.paymentMethod;
  $('rec-cancel-edit').classList.remove('hidden');
  $('form-recurring').scrollIntoView({ behavior: 'smooth' });
}

function clearRecurringForm() {
  editingRecId = null;
  $('recurring-form-title').textContent = 'Thêm mục cố định';
  $('form-recurring').reset();
  $('rec-start').value = currentMonth;
  $('rec-cancel-edit').classList.add('hidden');
}

// ------------------------------------------------------------ reset
async function renderResetCounts() {
  try {
    const r = await api('/api/reset/counts');
    const c = r.counts;
    $('reset-counts').textContent =
      `Sẽ xoá: ${c.transactions} khoản thu/chi · ${c.budgets} hạn mức · ${c.recurringItems} mục cố định · ${c.options} mục đã lưu/tuỳ chỉnh (gồm thiết lập thanh toán).`;
  } catch (e) { /* not signed in yet */ }
}

function resetUiBack() {
  $('reset-step1').classList.remove('hidden');
  $('reset-step2').classList.add('hidden');
  $('reset-confirm').value = '';
  $('btn-reset-do').disabled = true;
}

// ------------------------------------------------------------ auth & wiring
function showAuth() {
  $('view-auth').classList.remove('hidden');
  $('view-app').classList.add('hidden');
  $('user-box').classList.add('hidden');
}
function showApp() {
  $('view-auth').classList.add('hidden');
  $('view-app').classList.remove('hidden');
  $('user-box').classList.remove('hidden');
  $('user-label').textContent = state.user ? state.user.familyName : '';
}

async function boot() {
  try {
    const s = await api('/api/status');
    if (s.user) {
      state.user = s.user;
      await refresh();
      showApp();
      renderResetCounts();
      return;
    }
  } catch (e) { /* fall through to auth */ }
  showAuth();
}

document.addEventListener('DOMContentLoaded', () => {
  $('entry-date').value = todayStr();
  $('rec-start').value = currentMonth;

  // auth tabs
  $('tab-login').addEventListener('click', () => {
    $('tab-login').classList.add('active'); $('tab-register').classList.remove('active');
    $('form-login').classList.remove('hidden'); $('form-register').classList.add('hidden');
  });
  $('tab-register').addEventListener('click', () => {
    $('tab-register').classList.add('active'); $('tab-login').classList.remove('active');
    $('form-register').classList.remove('hidden'); $('form-login').classList.add('hidden');
  });

  $('form-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('login-error').textContent = '';
    try {
      const r = await api('/api/login', 'POST', {
        username: $('login-username').value, password: $('login-password').value,
      });
      state.user = r.user;
      currentMonth = monthOf(new Date());
      await refresh();
      showApp();
      renderResetCounts();
    } catch (e) {
      $('login-error').textContent = 'Sai tên đăng nhập hoặc mật khẩu.';
    }
  });

  $('form-register').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('reg-error').textContent = '';
    try {
      const r = await api('/api/register', 'POST', {
        familyName: $('reg-family').value, username: $('reg-username').value, password: $('reg-password').value,
      });
      state.user = r.user;
      currentMonth = monthOf(new Date());
      await refresh();
      showApp();
      renderResetCounts();
    } catch (e) {
      $('reg-error').textContent = e.message === 'username_taken'
        ? 'Tên đăng nhập đã có người dùng — chọn tên khác nhé.'
        : 'Không đăng kí được — kiểm tra lại thông tin (mật khẩu ít nhất 6 ký tự).';
    }
  });

  async function logout() {
    await api('/api/logout', 'POST', {}).catch(() => {});
    state.user = null;
    showAuth();
  }
  $('btn-logout').addEventListener('click', logout);
  $('btn-logout-2').addEventListener('click', logout);

  $('form-password').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('pw-error').textContent = ''; $('pw-ok').textContent = '';
    try {
      await api('/api/change-password', 'POST', {
        currentPassword: $('pw-current').value, newPassword: $('pw-new').value,
      });
      $('pw-ok').textContent = 'Đã đổi mật khẩu.';
      $('form-password').reset();
    } catch (e) {
      $('pw-error').textContent = 'Mật khẩu hiện tại chưa đúng, hoặc mật khẩu mới quá ngắn.';
    }
  });

  // month nav
  $('month-prev').addEventListener('click', async () => { currentMonth = shiftMonth(currentMonth, -1); await applyRecurringFor(currentMonth); render(); });
  $('month-next').addEventListener('click', async () => { currentMonth = shiftMonth(currentMonth, 1); await applyRecurringFor(currentMonth); render(); });
  $('month-today').addEventListener('click', async () => { currentMonth = monthOf(new Date()); await applyRecurringFor(currentMonth); render(); });

  // entry form
  $('btn-add').addEventListener('click', () => openEntry(null));
  $('entry-cancel').addEventListener('click', closeEntry);
  $('type-expense').addEventListener('click', () => setEntryType('expense'));
  $('type-income').addEventListener('click', () => setEntryType('income'));
  document.querySelectorAll('[data-manage]').forEach((btn) => btn.addEventListener('click', () => {
    const panel = document.querySelector(`[data-panel="${btn.dataset.manage}"]`);
    panel.classList.toggle('hidden');
    renderManagePanel(btn.dataset.manage);
  }));
  $('form-entry').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('entry-error').textContent = '';
    const body = {
      type: entryType,
      amount: Number($('entry-amount').value),
      date: $('entry-date').value,
      category: sel.category,
      person: sel.person,
      paymentMethod: sel.payment,
      note: $('entry-note').value,
    };
    if (!body.category) { $('entry-error').textContent = 'Hãy chọn hoặc tự đặt tên danh mục.'; return; }
    try {
      if (editingTxId) await api('/api/transactions/' + editingTxId, 'PUT', body);
      else await api('/api/transactions', 'POST', body);
      currentMonth = body.date.slice(0, 7);
      closeEntry();
      await refresh();
    } catch (e) {
      $('entry-error').textContent = 'Không lưu được — kiểm tra số tiền và ngày.';
    }
  });
  $('entry-delete').addEventListener('click', async () => {
    if (!editingTxId) return;
    if (!deleteArm) {
      deleteArm = true;
      $('entry-delete').textContent = 'Bấm lần nữa để xoá';
      return;
    }
    await api('/api/transactions/' + editingTxId, 'DELETE');
    closeEntry();
    await refresh();
  });

  // budgets
  $('form-budget').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('budget-error').textContent = '';
    try {
      await api('/api/budgets', 'POST', {
        category: $('budget-category').value,
        amount: Number($('budget-amount').value),
        alertThreshold: Number($('budget-threshold').value || 80),
      });
      $('budget-amount').value = '';
      await refresh();
    } catch (e) {
      $('budget-error').textContent = 'Không lưu được hạn mức — kiểm tra số tiền và % cảnh báo (1–100).';
    }
  });

  // recurring
  $('rec-type-expense').addEventListener('click', () => setRecType('expense'));
  $('rec-type-income').addEventListener('click', () => setRecType('income'));
  $('rec-cancel-edit').addEventListener('click', clearRecurringForm);
  $('form-recurring').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    $('recurring-error').textContent = '';
    const body = {
      name: $('rec-name').value,
      type: recType,
      amount: Number($('rec-amount').value),
      settlementDay: Number($('rec-day').value),
      startMonth: $('rec-start').value,
      category: $('rec-category').value,
      person: $('rec-person').value,
      paymentMethod: $('rec-payment').value,
    };
    try {
      if (editingRecId) await api('/api/recurring-items/' + editingRecId, 'PUT', body);
      else await api('/api/recurring-items', 'POST', body);
      clearRecurringForm();
      await refresh();
    } catch (e) {
      $('recurring-error').textContent = 'Không lưu được — kiểm tra tên mục, số tiền, ngày quyết toán (1–31) và tháng bắt đầu.';
    }
  });

  // reset
  $('section-reset').addEventListener('toggle', () => { if ($('section-reset').open) renderResetCounts(); });
  $('btn-reset-start').addEventListener('click', () => {
    $('reset-step1').classList.add('hidden');
    $('reset-step2').classList.remove('hidden');
    $('reset-ok').textContent = '';
  });
  $('btn-reset-cancel').addEventListener('click', resetUiBack);
  $('reset-confirm').addEventListener('input', () => {
    $('btn-reset-do').disabled = normalizeLoose($('reset-confirm').value) !== 'xoa het';
  });
  $('btn-reset-do').addEventListener('click', async () => {
    await api('/api/reset', 'POST', { confirmText: $('reset-confirm').value });
    resetUiBack();
    $('reset-ok').textContent = 'Đã xoá toàn bộ dữ liệu của gia đình bạn. Sổ đã trống để nhập lại từ đầu.';
    await refresh();
    renderResetCounts();
  });

  boot();
});
