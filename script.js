'use strict';

/* ---------------------------------- Setup ---------------------------------- */

// The anon key is public by design. Row Level Security only lets the signed-in
// admin read or write anything, so Supabase checks the password, not this file.
const SUPABASE_URL = 'https://ufsujcmcsmlnjwutvpfv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7yq_heVytMp6WbE3hUuvGg_w5U5qB7o';
const ADMIN_EMAIL = 'admin@fresh-g.invalid';

const IS_CONNECTED = SUPABASE_URL.startsWith('http');
const TABLES = ['products', 'expense_items', 'sales', 'expenses'];
const PAGE_SIZE = 1000;
const MONTHS = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const EASE = 'cubic-bezier(.22, 1, .36, 1)';

/* --------------------------------- Helpers --------------------------------- */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sum = (rows, pick) => rows.reduce((total, row) => total + pick(row), 0);
const icon = (name, extra = '') => `<svg class="icon ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt = (n) => numberFormat.format(n);
const rp = (n) => `${n < 0 ? '-' : ''}Rp ${fmt(Math.abs(n))}`;
const num = (text) => `<bdi class="num" dir="ltr">${text}</bdi>`;
const money = (n) => num(rp(n));
const signedMoney = (n) => num(`${n > 0 ? '+' : ''}${rp(n)}`);

// Arabic keyboards can type ٠١٢٣ or ۰۱۲۳, so every number input goes through this.
const digitsOf = (text) => String(text)
  .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
  .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06F0)
  .replace(/\D/g, '');

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: the app still works */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch { /* same as above */ }
  },
};

/* ---------------------------------- Dates ---------------------------------- */

// Dates stay as local YYYY-MM-DD strings: toISOString would shift them to UTC.
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => isoDate(new Date());
const yesterday = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return isoDate(d);
};

function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function dayHeading(iso) {
  if (iso === today()) return 'اليوم';
  if (iso === yesterday()) return 'أمس';
  const [y, m, d] = iso.split('-').map(Number);
  const year = y === new Date().getFullYear() ? '' : ` ${y}`;
  return `${DAYS[new Date(y, m - 1, d).getDay()]} ${d} ${MONTHS[m - 1]}${year}`;
}

/* ------------------------------ Supabase access ----------------------------- */

class AuthError extends Error {}

let session = store.get('fg.session', null);
let refreshing = null;

function saveSession(data) {
  session = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at ?? Math.floor(Date.now() / 1000) + data.expires_in,
  };
  store.set('fg.session', session);
}

async function requestToken(grant, body) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=${grant}`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ([400, 401, 403].includes(res.status)) throw new AuthError();
  if (!res.ok) throw new Error(`auth ${res.status}`);
  saveSession(await res.json());
}

async function accessToken(force = false) {
  if (!session) throw new AuthError();
  if (force || session.expires_at - 60 < Date.now() / 1000) {
    refreshing ??= requestToken('refresh_token', { refresh_token: session.refresh_token })
      .finally(() => { refreshing = null; });
    await refreshing;
  }
  return session.access_token;
}

async function rest(path, { method = 'GET', body, prefer } = {}, retried = false) {
  const headers = { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${await accessToken()}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { method, headers, body: body && JSON.stringify(body) });
  if (res.status === 401 && !retried) {
    await accessToken(true);
    return rest(path, { method, body, prefer }, true);
  }
  if (res.status === 401) throw new AuthError();
  if (!res.ok) {
    const error = new Error(`rest ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return method === 'GET' ? res.json() : null;
}

/* ------------------------------ Local data + sync --------------------------- */

// Every change lands on screen at once and waits in an outbox saved on the phone,
// so a save never blocks and nothing is lost if the connection drops mid-sale.
const emptyDb = () => Object.fromEntries(TABLES.map((table) => [table, []]));

let db = { ...emptyDb(), ...store.get('fg.db', {}) };
let outbox = store.get('fg.outbox', []);
let changeCount = 0;
let lastPull = 0;
let pulling = false;
let flushing = false;
let retryTimer = null;
let syncTimer = null;
let saveDbTimer = null;

function applyOp(target, op) {
  const list = target[op.table];
  if (op.type === 'delete') {
    const index = list.findIndex((row) => row.id === op.id);
    if (index >= 0) list.splice(index, 1);
    return;
  }
  for (const row of op.rows) {
    const index = list.findIndex((existing) => existing.id === row.id);
    if (index >= 0) list[index] = row;
    else list.push(row);
  }
}

function saveDbSoon() {
  clearTimeout(saveDbTimer);
  saveDbTimer = setTimeout(() => store.set('fg.db', db), 250);
}

function mutate(op) {
  changeCount += 1;
  applyOp(db, op);
  outbox.push(op);
  store.set('fg.outbox', outbox);
  saveDbSoon();
  flush();
}

const upsert = (table, rows) => mutate({ type: 'upsert', table, rows });
const removeRow = (table, id) => mutate({ type: 'delete', table, id });

function sendOp(op) {
  if (op.type === 'delete') {
    return rest(`${op.table}?id=eq.${op.id}`, { method: 'DELETE', prefer: 'return=minimal' });
  }
  return rest(op.table, { method: 'POST', body: op.rows, prefer: 'resolution=merge-duplicates,return=minimal' });
}

async function flush() {
  if (flushing || !session) return;
  flushing = true;
  paintSync();
  while (outbox.length) {
    try {
      await sendOp(outbox[0]);
    } catch (error) {
      if (error instanceof AuthError) {
        flushing = false;
        lock();
        return;
      }
      const refused = error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
      if (!refused) {
        // Offline or a server hiccup: keep the change and try again shortly.
        clearTimeout(retryTimer);
        retryTimer = setTimeout(flush, 10000);
        flushing = false;
        paintSync();
        return;
      }
      toast('تعذّر حفظ أحد التعديلات', { tone: 'error' });
      outbox.shift();
      store.set('fg.outbox', outbox);
      lastPull = 0;
      continue;
    }
    outbox.shift();
    store.set('fg.outbox', outbox);
    changeCount += 1;
  }
  flushing = false;
  paintSync();
  if (!lastPull) pull();
}

async function fetchTable(table) {
  const rows = [];
  for (;;) {
    const page = await rest(`${table}?select=*&order=created_at.asc,id.asc&limit=${PAGE_SIZE}&offset=${rows.length}`);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

async function pull() {
  if (pulling || !session) return;
  pulling = true;
  const startedAt = changeCount;
  try {
    const entries = await Promise.all(TABLES.map(async (table) => [table, await fetchTable(table)]));
    pulling = false;
    if (startedAt !== changeCount) {
      // A change landed while downloading, so this copy may not include it.
      pull();
      return;
    }
    const fresh = Object.fromEntries(entries);
    outbox.forEach((op) => applyOp(fresh, op));
    lastPull = Date.now();
    const changed = JSON.stringify(fresh) !== JSON.stringify(db);
    db = fresh;
    saveDbSoon();
    if (changed && !$('#app').hidden) render();
  } catch (error) {
    pulling = false;
    if (error instanceof AuthError) lock();
  }
}

function paintSync() {
  clearTimeout(syncTimer);
  const paint = () => {
    const pending = outbox.length > 0;
    $('#sync').hidden = !pending;
    $('#brand-name').hidden = pending;
    if (pending) {
      $('#sync').innerHTML = navigator.onLine ? 'جارٍ الحفظ…' : `بانتظار الإنترنت · ${num(fmt(outbox.length))}`;
    }
  };
  // Saves usually finish instantly, so only mention it when one takes a moment.
  if (outbox.length) syncTimer = setTimeout(paint, 900);
  else paint();
}

/* ---------------------------------- State ---------------------------------- */

const state = {
  tab: 'summary',
  manage: 'products',
  period: { mode: 'month', year: new Date().getFullYear(), month: new Date().getMonth() + 1 },
  filter: { sales: null, expenses: null },
};

const bySortOrder = (a, b) => a.sort_order - b.sort_order || (a.created_at < b.created_at ? -1 : 1);
const products = () => db.products.filter((row) => !row.archived).sort(bySortOrder);
const expenseItems = () => db.expense_items.filter((row) => !row.archived).sort(bySortOrder);
const findRow = (table, id) => db[table].find((row) => row.id === id);
const nameMap = (table) => new Map(db[table].map((row) => [row.id, row.name]));

const newestFirst = (dateKey) => (a, b) => {
  if (a[dateKey] !== b[dateKey]) return a[dateKey] < b[dateKey] ? 1 : -1;
  return new Date(b.created_at) - new Date(a.created_at);
};

/* --------------------------------- Periods --------------------------------- */

function periodKey({ mode, year, month } = state.period) {
  if (mode === 'all') return '';
  return mode === 'year' ? String(year) : `${year}-${pad(month)}`;
}

function periodLabel({ mode, year, month } = state.period) {
  if (mode === 'all') return 'كل الوقت';
  return mode === 'year' ? num(year) : `${MONTHS[month - 1]} ${num(year)}`;
}

function isLatestPeriod() {
  const now = new Date();
  const { mode, year, month } = state.period;
  if (mode === 'year') return year >= now.getFullYear();
  return year > now.getFullYear() || (year === now.getFullYear() && month >= now.getMonth() + 1);
}

function shiftPeriod(delta) {
  const period = state.period;
  if (period.mode === 'year') {
    period.year += delta;
    return;
  }
  const index = period.year * 12 + period.month - 1 + delta;
  period.year = Math.floor(index / 12);
  period.month = (index % 12) + 1;
}

function setMode(mode) {
  const period = state.period;
  const previous = period.mode;
  period.mode = mode;
  // A year in the past remembers its month, but never lands in the future.
  if (mode === 'month' && isLatestPeriod()) {
    period.year = new Date().getFullYear();
    period.month = new Date().getMonth() + 1;
  }
  if (previous !== mode) render({ slide: 0 });
}

/* -------------------------------- Calculation ------------------------------- */

function summarize() {
  const key = periodKey();
  const sales = db.sales.filter((row) => row.sold_on.startsWith(key));
  const expenses = db.expenses.filter((row) => row.spent_on.startsWith(key));
  const revenue = sum(sales, (row) => row.total);
  const spent = sum(expenses, (row) => row.amount);

  const perProduct = new Map();
  for (const sale of sales) {
    const entry = perProduct.get(sale.product_id) ?? { id: sale.product_id, qty: 0, revenue: 0 };
    entry.qty += sale.quantity;
    entry.revenue += sale.total;
    perProduct.set(sale.product_id, entry);
  }
  const productRows = [...perProduct.values()].sort((a, b) => b.revenue - a.revenue);

  // Expenses are not tied to one product, so each product carries a share of them
  // equal to its share of sales. Rounding the running total keeps the rows adding
  // up to the period's net profit exactly.
  let runningRevenue = 0;
  let allocated = 0;
  for (const row of productRows) {
    runningRevenue += row.revenue;
    const allocatedSoFar = revenue ? Math.round(spent * (runningRevenue / revenue)) : 0;
    row.profit = row.revenue - (allocatedSoFar - allocated);
    row.share = revenue ? row.revenue / revenue : 0;
    allocated = allocatedSoFar;
  }

  const perItem = new Map();
  for (const expense of expenses) {
    const entry = perItem.get(expense.item_id) ?? { id: expense.item_id, count: 0, amount: 0 };
    entry.count += 1;
    entry.amount += expense.amount;
    perItem.set(expense.item_id, entry);
  }
  const itemRows = [...perItem.values()].sort((a, b) => b.amount - a.amount);
  for (const row of itemRows) row.share = spent ? row.amount / spent : 0;

  return { sales, expenses, revenue, spent, net: revenue - spent, productRows, itemRows };
}

function breakdownRows() {
  const { mode, year } = state.period;
  const buckets = new Map();
  const add = (date, field, amount) => {
    const key = mode === 'year' ? date.slice(0, 7) : date.slice(0, 4);
    if (mode === 'year' && !date.startsWith(String(year))) return;
    const bucket = buckets.get(key) ?? { key, revenue: 0, spent: 0 };
    bucket[field] += amount;
    buckets.set(key, bucket);
  };
  db.sales.forEach((row) => add(row.sold_on, 'revenue', row.total));
  db.expenses.forEach((row) => add(row.spent_on, 'spent', row.amount));
  return [...buckets.values()].sort((a, b) => (a.key < b.key ? -1 : 1)).map((row) => ({ ...row, net: row.revenue - row.spent }));
}

/* ---------------------------------- Views ---------------------------------- */

const percent = (share) => `${Math.round(share * 100)}%`;

function statusLabel(value) {
  if (value < 0) return `<span class="status status-loss">${icon('trend-down')}خسارة</span>`;
  return `<span class="status status-profit">${icon('trend-up')}ربح</span>`;
}

const emptyBlock = (text) => `
  <div class="empty">
    <svg aria-hidden="true"><use href="#leaves"/></svg>
    <div>${text}</div>
  </div>`;

function heroSection(summary) {
  const hasData = summary.sales.length || summary.expenses.length;
  const tone = !hasData ? 'none' : summary.net < 0 ? 'loss' : 'profit';
  const labels = { none: 'لا توجد حركة في هذه الفترة', loss: 'صافي الخسارة', profit: summary.net ? 'صافي الربح' : 'لا ربح ولا خسارة' };
  const length = fmt(Math.abs(summary.net)).length;
  const size = length <= 10 ? [44, 11.6] : length <= 12 ? [38, 10] : length <= 14 ? [32, 8.4] : [26, 6.8];
  return `
    <section class="hero" data-tone="${tone}">
      <svg class="hero-leaf" aria-hidden="true"><use href="#leaves"/></svg>
      <div class="hero-label">${tone === 'none' ? '' : icon(tone === 'loss' ? 'trend-down' : 'trend-up')}<span>${labels[tone]}</span></div>
      <div class="hero-num" style="--hero:${size[0]}px;--hero-vw:${size[1]}vw"><bdi dir="ltr" class="num"><small><span id="hero-sign">${summary.net < 0 ? '-' : ''}</span>Rp</small> <span id="hero-value" data-value="${summary.net}">${fmt(Math.abs(summary.net))}</span></bdi></div>
      <div class="hero-tiles">
        <div class="tile"><span>المبيعات</span><strong style="--len:${rp(summary.revenue).length}">${money(summary.revenue)}</strong></div>
        <div class="tile"><span>المصاريف</span><strong style="--len:${rp(summary.spent).length}">${money(summary.spent)}</strong></div>
      </div>
    </section>`;
}

function breakdownSection() {
  const { mode } = state.period;
  if (mode === 'month') return '';
  const rows = breakdownRows();
  if (!rows.length) return '';
  const largest = Math.max(...rows.map((row) => Math.abs(row.net)), 1);
  return `
    <section class="section">
      <h2 class="section-title">${mode === 'year' ? 'حسب الشهر' : 'حسب السنة'}</h2>
      <div class="card">
        ${rows.map((row) => `
          <button type="button" class="row" data-act="open-period" data-key="${row.key}">
            <span class="row-title">${mode === 'year' ? MONTHS[Number(row.key.slice(5)) - 1] : num(row.key)} ${statusLabel(row.net)}</span>
            <span class="row-value">${signedMoney(row.net)}</span>
            <span class="row-sub row-wide">المبيعات ${money(row.revenue)} · المصاريف ${money(row.spent)}</span>
            <span class="dbar ${row.net < 0 ? 'dbar-loss' : 'dbar-profit'}"><i style="--w:${(Math.abs(row.net) / largest) * 100}%"></i></span>
          </button>`).join('')}
      </div>
    </section>`;
}

function productsSection(summary) {
  if (!summary.productRows.length) return '';
  const names = nameMap('products');
  return `
    <section class="section">
      <h2 class="section-title">ما بعته وربح كل منتج</h2>
      <p class="section-note">ربح المنتج = مبيعاته ناقص نصيبه من المصاريف بحسب نسبة مبيعاته.</p>
      <div class="card">
        ${summary.productRows.map((row) => `
          <button type="button" class="row" data-act="drill" data-tab="sales" data-id="${row.id}">
            <span class="row-title">${esc(names.get(row.id))}</span>
            <span class="row-value">${signedMoney(row.profit)}</span>
            <span class="row-sub">الكمية ${num(fmt(row.qty))} · المبيعات ${money(row.revenue)}</span>
            <span class="row-side">${statusLabel(row.profit)}</span>
            <span class="bar"><i style="--w:${row.share * 100}%"></i></span>
          </button>`).join('')}
      </div>
    </section>`;
}

function expensesSection(summary) {
  if (!summary.itemRows.length) return '';
  const names = nameMap('expense_items');
  return `
    <section class="section">
      <h2 class="section-title">ما اشتريته</h2>
      <div class="card">
        ${summary.itemRows.map((row) => `
          <button type="button" class="row" data-act="drill" data-tab="expenses" data-id="${row.id}">
            <span class="row-title">${esc(names.get(row.id))}</span>
            <span class="row-value">${money(row.amount)}</span>
            <span class="row-sub">مرات الشراء ${num(fmt(row.count))}</span>
            <span class="row-side">${num(percent(row.share))}</span>
            <span class="bar bar-spend"><i style="--w:${row.share * 100}%"></i></span>
          </button>`).join('')}
      </div>
    </section>`;
}

function viewSummary() {
  const summary = summarize();
  const hasData = summary.sales.length || summary.expenses.length;
  return `
    ${heroSection(summary)}
    ${breakdownSection()}
    ${productsSection(summary)}
    ${expensesSection(summary)}
    ${hasData ? '' : emptyBlock('سجّل عملية بيع أو مصروفًا من الأزرار بالأسفل.')}`;
}

function filterChips(tab, options) {
  const current = state.filter[tab];
  return `
    <div class="chips">
      <button type="button" class="chip ${current ? '' : 'on'}" data-act="filter" data-tab="${tab}" data-id="">الكل</button>
      ${options.map((option) => `<button type="button" class="chip ${current === option.id ? 'on' : ''}" data-act="filter" data-tab="${tab}" data-id="${option.id}">${esc(option.name)}</button>`).join('')}
    </div>`;
}

function dayGroups(rows, dateKey, valueOf, rowHtml) {
  const groups = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === row[dateKey]) last.rows.push(row);
    else groups.push({ date: row[dateKey], rows: [row] });
  }
  return groups.map((group) => `
    <div class="day">
      <div class="day-head"><span>${dayHeading(group.date)}</span>${money(sum(group.rows, valueOf))}</div>
      <div class="card">${group.rows.map(rowHtml).join('')}</div>
    </div>`).join('');
}

function saleRow(sale, names) {
  const exact = sale.total % sale.quantity === 0;
  const custom = sale.total !== sale.list_price * sale.quantity;
  const detail = exact ? num(`${fmt(sale.quantity)} × ${rp(sale.total / sale.quantity)}`) : `الكمية ${num(fmt(sale.quantity))}`;
  return `
    <button type="button" class="row" data-act="edit-sale" data-id="${sale.id}" data-flip="${sale.id}">
      <span class="row-title">${esc(names.get(sale.product_id))}</span>
      <span class="row-value">${money(sale.total)}</span>
      <span class="row-sub">${detail}${sale.note ? ` · ${esc(sale.note)}` : ''}</span>
      ${custom ? '<span class="row-side"><span class="tag">سعر مخصص</span></span>' : ''}
    </button>`;
}

function viewSales() {
  const names = nameMap('products');
  const inPeriod = db.sales.filter((row) => row.sold_on.startsWith(periodKey()));
  const filter = state.filter.sales;
  const rows = (filter ? inPeriod.filter((row) => row.product_id === filter) : inPeriod).sort(newestFirst('sold_on'));
  const used = new Set(inPeriod.map((row) => row.product_id));
  if (filter) used.add(filter);
  const options = db.products.filter((row) => used.has(row.id)).sort(bySortOrder);
  return `
    <div class="strip">
      <div><span>إجمالي المبيعات</span><strong>${money(sum(rows, (row) => row.total))}</strong></div>
      <div><span>الكمية</span><strong>${num(fmt(sum(rows, (row) => row.quantity)))}</strong></div>
    </div>
    ${options.length ? filterChips('sales', options) : ''}
    ${rows.length
      ? dayGroups(rows, 'sold_on', (row) => row.total, (row) => saleRow(row, names))
      : emptyBlock('لا توجد مبيعات في هذه الفترة.')}`;
}

function expenseRow(expense, names) {
  return `
    <button type="button" class="row" data-act="edit-expense" data-id="${expense.id}" data-flip="${expense.id}">
      <span class="row-title">${esc(names.get(expense.item_id))}</span>
      <span class="row-value">${money(expense.amount)}</span>
      ${expense.note ? `<span class="row-sub">${esc(expense.note)}</span>` : ''}
    </button>`;
}

function viewExpenses() {
  const names = nameMap('expense_items');
  const inPeriod = db.expenses.filter((row) => row.spent_on.startsWith(periodKey()));
  const filter = state.filter.expenses;
  const rows = (filter ? inPeriod.filter((row) => row.item_id === filter) : inPeriod).sort(newestFirst('spent_on'));
  const used = new Set(inPeriod.map((row) => row.item_id));
  if (filter) used.add(filter);
  const options = db.expense_items.filter((row) => used.has(row.id)).sort(bySortOrder);
  return `
    <div class="strip">
      <div><span>إجمالي المصاريف</span><strong>${money(sum(rows, (row) => row.amount))}</strong></div>
      <div><span>مرات الشراء</span><strong>${num(fmt(rows.length))}</strong></div>
    </div>
    ${options.length ? filterChips('expenses', options) : ''}
    ${rows.length
      ? dayGroups(rows, 'spent_on', (row) => row.amount, (row) => expenseRow(row, names))
      : emptyBlock('لا توجد مصاريف في هذه الفترة.')}`;
}

function manageRow(row, index, count, act, subline) {
  return `
    <div class="m-row" data-flip="${row.id}">
      <button type="button" class="m-main" data-act="${act}" data-id="${row.id}">
        <span class="m-title">${esc(row.name)}</span>
        ${subline ? `<span class="m-sub">${subline}</span>` : ''}
      </button>
      <span class="m-sort">
        <button type="button" data-act="move" data-id="${row.id}" data-delta="-1" aria-label="تحريك لأعلى" ${index === 0 ? 'disabled' : ''}>${icon('up')}</button>
        <button type="button" data-act="move" data-id="${row.id}" data-delta="1" aria-label="تحريك لأسفل" ${index === count - 1 ? 'disabled' : ''}>${icon('down')}</button>
      </span>
    </div>`;
}

function viewManage() {
  const onProducts = state.manage === 'products';
  const list = onProducts ? products() : expenseItems();
  const rows = list.map((row, index) => (onProducts
    ? manageRow(row, index, list.length, 'edit-product', row.price ? money(row.price) : '<span class="tag">حدد السعر</span>')
    : manageRow(row, index, list.length, 'edit-item', '')));
  return `
    <div class="seg seg-2" style="--i:${onProducts ? 0 : 1}">
      <span class="seg-thumb"></span>
      <button type="button" data-act="manage-tab" data-manage="products" aria-pressed="${onProducts}">المنتجات والأسعار</button>
      <button type="button" data-act="manage-tab" data-manage="items" aria-pressed="${!onProducts}">قائمة المصاريف</button>
    </div>
    ${rows.length ? `<div class="card">${rows.join('')}</div>` : emptyBlock(onProducts ? 'لا توجد منتجات بعد.' : 'لا توجد أصناف بعد.')}
    <button type="button" class="link-btn" data-act="logout">${icon('logout')}تسجيل الخروج</button>`;
}

/* --------------------------------- Rendering -------------------------------- */

const views = { summary: viewSummary, sales: viewSales, expenses: viewExpenses, manage: viewManage };
const TAB_ORDER = ['summary', 'sales', 'expenses', 'manage'];
const MODE_ORDER = ['month', 'year', 'all'];

let shownNet = 0;
let heroFrame = 0;
let dockKey = '';

function countHero() {
  const value = $('#hero-value');
  if (!value) return;
  const target = Number(value.dataset.value);
  const from = shownNet;
  shownNet = target;
  cancelAnimationFrame(heroFrame);
  if (from === target || reducedMotion()) return;
  const sign = $('#hero-sign');
  const started = performance.now();
  const tick = (time) => {
    const progress = Math.min(1, (time - started) / 620);
    const current = Math.round(from + (target - from) * (1 - (1 - progress) ** 3));
    value.textContent = fmt(Math.abs(current));
    sign.textContent = current < 0 ? '-' : '';
    if (progress < 1) heroFrame = requestAnimationFrame(tick);
  };
  heroFrame = requestAnimationFrame(tick);
}

function renderDock() {
  const key = `${state.tab}:${state.manage}`;
  if (key === dockKey) return;
  dockKey = key;
  const sale = `<button type="button" class="fab fab-sale" data-act="new-sale">${icon('plus')}بيع جديد</button>`;
  const expense = `<button type="button" class="fab fab-expense" data-act="new-expense">${icon('plus')}مصروف جديد</button>`;
  const manage = state.manage === 'products'
    ? `<button type="button" class="fab fab-sale" data-act="new-product">${icon('plus')}إضافة منتج</button>`
    : `<button type="button" class="fab fab-sale" data-act="new-item">${icon('plus')}إضافة صنف</button>`;
  $('#dock').innerHTML = { summary: sale + expense, sales: sale, expenses: expense, manage }[state.tab];
}

function renderChrome() {
  const { mode } = state.period;
  const onManage = state.tab === 'manage';

  const tabs = $('#tabs');
  tabs.style.setProperty('--i', TAB_ORDER.indexOf(state.tab));
  $$('button', tabs).forEach((button) => {
    if (button.dataset.tab === state.tab) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  const modes = $('#period-mode');
  modes.hidden = onManage;
  modes.style.setProperty('--i', MODE_ORDER.indexOf(mode));
  $$('button', modes).forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));

  const nav = $('#period-nav');
  nav.hidden = onManage;
  nav.classList.toggle('all', mode === 'all');
  $('#period-label').innerHTML = periodLabel();
  $('[data-delta="1"]', nav).disabled = isLatestPeriod();

  renderDock();
}

/**
 * Options:
 *  - slide: animate the page in. 0 fades up (tab or mode change), 1 / -1 slides it
 *    in from the direction the arrow pointed. Leave it out for a silent refresh.
 *  - keepScroll: leave the scroll position alone.
 */
function render({ slide, keepScroll = true } = {}) {
  const view = $('#view');
  view.classList.toggle('quiet', slide === undefined);
  view.innerHTML = views[state.tab]();
  renderChrome();
  countHero();
  if (!keepScroll) window.scrollTo(0, 0);
  if (slide !== undefined && !reducedMotion()) {
    const from = slide === 0 ? 'translateY(8px)' : `translateX(${slide > 0 ? -26 : 26}px)`;
    view.animate([{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE });
  }
}

// Elements glide to their new place instead of jumping when their list changes.
function glide(elementsOf, update) {
  const before = elementsOf();
  const animate = before.length > 0 && before.length < 200 && !reducedMotion();
  const first = new Map(animate ? before.map((el) => [el.dataset.flip, el.getBoundingClientRect()]) : []);
  update();
  if (!animate) return;
  for (const el of elementsOf()) {
    const from = first.get(el.dataset.flip);
    const to = el.getBoundingClientRect();
    if (!from) {
      el.animate([{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE });
    } else if (from.left !== to.left || from.top !== to.top) {
      el.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: 'none' }], { duration: 320, easing: EASE });
    }
  }
}

function renderWithFlip(flashId) {
  glide(() => $$('#view [data-flip]'), () => render());
  if (flashId) $(`#view [data-flip="${flashId}"]`)?.classList.add('flash');
}

function setTab(tab) {
  if (tab === state.tab) {
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  state.tab = tab;
  render({ slide: 0, keepScroll: false });
}

/* ---------------------------------- Toast ---------------------------------- */

let toastTimer = null;

function hideToast() {
  clearTimeout(toastTimer);
  $('#toast').classList.remove('show');
}

function toast(message, { action, onAction, tone = '' } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.dataset.tone = tone;
  if (action) {
    $('button', el).addEventListener('click', () => {
      hideToast();
      onAction();
    });
  }
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 5000 : 2400);
}

function shake(el) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  navigator.vibrate?.(30);
}

/* ------------------------------- Bottom sheet ------------------------------- */

let openSheetRoot = null;
let ignoreNextPop = false;

function finishClosingSheet() {
  const root = openSheetRoot;
  if (!root) return;
  openSheetRoot = null;
  document.body.classList.remove('sheet-open');
  $('#app').inert = false;
  document.activeElement?.blur?.();
  root.classList.remove('open');
  const remove = () => root.remove();
  root.addEventListener('transitionend', (event) => {
    if (event.target.classList.contains('sheet')) remove();
  });
  setTimeout(remove, 480);
}

function closeSheet() {
  if (!openSheetRoot) return;
  finishClosingSheet();
  if (history.state?.sheet) {
    ignoreNextPop = true;
    history.back();
  }
}

function bindSheetDrag(root) {
  const sheet = $('.sheet', root);
  const head = $('.sheet-head', root);
  let startY = 0;
  let startTime = 0;
  let dragY = 0;
  let dragging = false;
  head.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button')) return;
    dragging = true;
    startY = event.clientY;
    startTime = event.timeStamp;
    dragY = 0;
    head.setPointerCapture(event.pointerId);
    sheet.style.transition = 'none';
  });
  head.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    dragY = Math.max(0, event.clientY - startY);
    sheet.style.transform = `translate(-50%, ${dragY}px)`;
  });
  const end = (event) => {
    if (!dragging) return;
    dragging = false;
    sheet.style.transition = '';
    sheet.style.transform = '';
    const speed = dragY / Math.max(1, event.timeStamp - startTime);
    if (dragY > 110 || (dragY > 24 && speed > 0.6)) closeSheet();
  };
  head.addEventListener('pointerup', end);
  head.addEventListener('pointercancel', end);
}

function openSheet({ title, body, foot, onSubmit }) {
  if (openSheetRoot) closeSheet();
  const root = document.createElement('div');
  root.className = 'sheet-root';
  root.innerHTML = `
    <div class="scrim" data-sheet-close></div>
    <form class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" autocomplete="off" novalidate>
      <div class="sheet-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-sheet-close aria-label="إغلاق">${icon('x')}</button>
      </div>
      <div class="sheet-body">${body}</div>
      <div class="sheet-foot">${foot}</div>
    </form>`;
  document.body.append(root);
  openSheetRoot = root;
  document.body.classList.add('sheet-open');
  $('#app').inert = true;
  $$('[data-sheet-close]', root).forEach((el) => el.addEventListener('click', closeSheet));
  $('form', root).addEventListener('submit', (event) => {
    event.preventDefault();
    // A second tap while the sheet is sliding away must not save a duplicate.
    if (root === openSheetRoot) onSubmit();
  });
  $('.sheet-body', root).addEventListener('focusin', (event) => {
    setTimeout(() => event.target.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 280);
  });
  bindSheetDrag(root);
  history.pushState({ sheet: true }, '');
  void root.offsetHeight;
  root.classList.add('open');
  return root;
}

window.addEventListener('popstate', () => {
  if (ignoreNextPop) {
    ignoreNextPop = false;
    return;
  }
  finishClosingSheet();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSheet();
});

// iOS slides the keyboard over the page instead of resizing it, so lift the sheet.
if (window.visualViewport) {
  const viewport = window.visualViewport;
  const syncKeyboard = () => {
    const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty('--kb', `${covered}px`);
  };
  viewport.addEventListener('resize', syncKeyboard);
  viewport.addEventListener('scroll', syncKeyboard);
}

/* -------------------------------- Form pieces ------------------------------- */

// The sheet is a form, so Enter here must run this action instead of saving the sheet.
const onEnter = (input, action) => input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    action();
  }
});

const moneyInput = (id, big = false) => `
  <div class="money ${big ? 'money-big' : ''}">
    <span>Rp</span>
    <input id="${id}" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="done" placeholder="0">
  </div>`;

const dateField = () => `
  <div class="field">
    <span class="label">التاريخ</span>
    <div class="date-row">
      <button type="button" class="chip" data-date="today">اليوم</button>
      <button type="button" class="chip" data-date="yesterday">أمس</button>
      <label class="chip date-other">${icon('calendar')}<span data-date-text></span><input type="date" aria-label="اختر التاريخ"></label>
    </div>
  </div>`;

const noteField = (placeholder) => `
  <div class="field">
    <label class="label" for="f-note">ملاحظة (اختياري)</label>
    <input id="f-note" class="input" type="text" autocomplete="off" enterkeyhint="done" placeholder="${esc(placeholder)}">
  </div>`;

function saveButtons(isEdit) {
  if (isEdit) {
    return `
      <button type="button" class="btn btn-danger" data-form-delete aria-label="حذف">${icon('trash')}</button>
      <button type="submit" class="btn btn-primary">حفظ</button>`;
  }
  return `
    <button type="submit" class="btn btn-primary">حفظ</button>
    <button type="button" class="btn btn-soft" data-form-again>حفظ وإضافة آخر</button>`;
}

// Live commas while typing, with the caret kept after the same digit.
function bindNumberInput(input, onChange, maxDigits = 15) {
  input.addEventListener('input', () => {
    const caret = input.selectionStart ?? input.value.length;
    const digitsBeforeCaret = digitsOf(input.value.slice(0, caret)).length;
    const digits = digitsOf(input.value).replace(/^0+(?=\d)/, '').slice(0, maxDigits);
    input.value = digits ? fmt(Number(digits)) : '';
    let position = 0;
    for (let seen = 0; position < input.value.length && seen < digitsBeforeCaret; position += 1) {
      if (/\d/.test(input.value[position])) seen += 1;
    }
    input.setSelectionRange(position, position);
    onChange(Number(digits || 0));
  });
  input.addEventListener('focus', () => setTimeout(() => input.select(), 0));
}

function bindDateField(root, form) {
  const input = $('input[type=date]', root);
  const other = $('.date-other', root);
  const text = $('[data-date-text]', root);
  const todayChip = $('[data-date=today]', root);
  const yesterdayChip = $('[data-date=yesterday]', root);
  const paint = () => {
    const isToday = form.date === today();
    const isYesterday = form.date === yesterday();
    todayChip.classList.toggle('on', isToday);
    yesterdayChip.classList.toggle('on', isYesterday);
    other.classList.toggle('on', !isToday && !isYesterday);
    text.textContent = isToday || isYesterday ? 'تاريخ آخر' : longDate(form.date);
    input.max = today();
    input.value = form.date;
  };
  const pick = (date) => {
    form.date = date > today() ? today() : date;
    paint();
  };
  todayChip.addEventListener('click', () => pick(today()));
  yesterdayChip.addEventListener('click', () => pick(yesterday()));
  input.addEventListener('change', () => {
    if (input.value) pick(input.value);
    else paint();
  });
  input.addEventListener('click', () => {
    try { input.showPicker(); } catch { /* the browser opens its own picker */ }
  });
  paint();
  return paint;
}

function savedMessage(prefix, date) {
  return date.startsWith(periodKey()) ? prefix : `${prefix} في ${longDate(date)}`;
}

/* -------------------------------- Sale sheet -------------------------------- */

function openSaleSheet(sale = null) {
  const list = products();
  const saleProduct = sale && findRow('products', sale.product_id);
  if (saleProduct?.archived) list.push(saleProduct);
  if (!list.length) {
    state.manage = 'products';
    setTab('manage');
    toast('أضف منتجًا أولًا');
    return;
  }

  const form = {
    productId: sale?.product_id ?? null,
    qty: sale?.quantity ?? 1,
    listPrice: sale?.list_price ?? 0,
    unit: 0,
    total: sale?.total ?? 0,
    mode: 'list',
    date: sale?.sold_on ?? today(),
  };
  if (sale && sale.total !== sale.list_price * sale.quantity) {
    form.mode = sale.total % sale.quantity === 0 ? 'unit' : 'total';
    form.unit = Math.round(sale.total / sale.quantity);
  }

  const root = openSheet({
    title: sale ? 'تعديل عملية البيع' : 'بيع جديد',
    body: `
      <div class="field">
        <span class="label">المنتج</span>
        <div class="pick-grid" id="f-products">
          ${list.map((product) => `
            <button type="button" class="pick" data-id="${product.id}">
              <b>${esc(product.name)}</b>
              <small>${product.price ? money(product.price) : 'بدون سعر'}</small>
            </button>`).join('')}
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label class="label" for="f-qty">الكمية</label>
          <div class="stepper">
            <button type="button" data-step="-1" aria-label="إنقاص الكمية">${icon('minus')}</button>
            <input id="f-qty" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="done">
            <button type="button" data-step="1" aria-label="زيادة الكمية">${icon('plus')}</button>
          </div>
        </div>
        <div class="field">
          <label class="label" for="f-unit">سعر القطعة</label>
          ${moneyInput('f-unit')}
        </div>
      </div>
      <div id="f-hint"></div>
      <div class="field">
        <label class="label" for="f-total">الإجمالي</label>
        ${moneyInput('f-total', true)}
      </div>
      ${dateField()}
      ${noteField('مثال: اسم الزبون')}`,
    foot: saveButtons(Boolean(sale)),
    onSubmit: () => save(false),
  });

  const qtyInput = $('#f-qty', root);
  const unitInput = $('#f-unit', root);
  const totalInput = $('#f-total', root);
  const noteInput = $('#f-note', root);
  const hint = $('#f-hint', root);
  const picks = $$('.pick', root);
  noteInput.value = sale?.note ?? '';

  // The last price typed wins: the set price, a price per piece, or a final total.
  function paint(skip) {
    if (form.mode === 'list') form.unit = form.listPrice;
    if (form.mode === 'total') form.unit = form.qty ? Math.round(form.total / form.qty) : 0;
    else form.total = form.unit * form.qty;
    if (skip !== qtyInput) qtyInput.value = form.qty ? fmt(form.qty) : '';
    if (skip !== unitInput) unitInput.value = form.unit ? fmt(form.unit) : '';
    if (skip !== totalInput) totalInput.value = form.total ? fmt(form.total) : '';
    picks.forEach((pick) => pick.classList.toggle('on', pick.dataset.id === form.productId));
    const custom = form.mode !== 'list' && form.listPrice > 0;
    if (custom && !hint.firstChild) {
      hint.innerHTML = `<div class="price-hint"><span>السعر المحدد ${money(form.listPrice)}</span><button type="button">استخدامه</button></div>`;
      $('button', hint).addEventListener('click', () => {
        form.mode = 'list';
        paint();
      });
    } else if (custom) {
      $('.num', hint).textContent = rp(form.listPrice);
    } else {
      hint.textContent = '';
    }
  }

  picks.forEach((pick) => pick.addEventListener('click', () => {
    const product = findRow('products', pick.dataset.id);
    form.productId = product.id;
    form.listPrice = product.price;
    form.mode = product.price ? 'list' : 'unit';
    if (!product.price) form.unit = 0;
    paint();
    if (!product.price) unitInput.focus();
  }));

  $$('[data-step]', root).forEach((button) => button.addEventListener('click', () => {
    form.qty = Math.max(1, form.qty + Number(button.dataset.step));
    paint();
  }));

  bindNumberInput(qtyInput, (value) => {
    form.qty = value;
    paint(qtyInput);
  }, 7);
  qtyInput.addEventListener('blur', () => {
    if (form.qty < 1) {
      form.qty = 1;
      paint();
    }
  });

  bindNumberInput(unitInput, (value) => {
    form.unit = value;
    form.mode = value === form.listPrice && form.listPrice > 0 ? 'list' : 'unit';
    paint(unitInput);
  });

  bindNumberInput(totalInput, (value) => {
    form.total = value;
    form.mode = value === form.listPrice * form.qty && form.listPrice > 0 ? 'list' : 'total';
    paint(totalInput);
  });

  const paintDate = bindDateField(root, form);

  function save(again) {
    if (!form.productId) {
      shake($('#f-products', root));
      return;
    }
    if (form.total <= 0) {
      shake(totalInput.parentElement);
      totalInput.focus();
      return;
    }
    const row = {
      id: sale?.id ?? uuid(),
      product_id: form.productId,
      quantity: Math.max(1, form.qty),
      list_price: form.listPrice,
      total: form.total,
      sold_on: form.date,
      note: noteInput.value.trim() || null,
      created_at: sale?.created_at ?? new Date().toISOString(),
    };
    upsert('sales', [row]);
    toast(savedMessage('تم حفظ البيع', row.sold_on));
    navigator.vibrate?.(12);
    if (again) {
      Object.assign(form, { productId: null, qty: 1, listPrice: 0, unit: 0, total: 0, mode: 'list' });
      noteInput.value = '';
      paint();
      paintDate();
      $('.sheet-body', root).scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      closeSheet();
    }
    renderWithFlip(row.id);
  }

  $('[data-form-again]', root)?.addEventListener('click', () => save(true));
  $('[data-form-delete]', root)?.addEventListener('click', () => {
    removeRow('sales', sale.id);
    closeSheet();
    renderWithFlip();
    toast('تم حذف عملية البيع', {
      action: 'تراجع',
      onAction() {
        upsert('sales', [sale]);
        renderWithFlip(sale.id);
      },
    });
  });

  paint();
}

/* ------------------------------- Expense sheet ------------------------------ */

function openExpenseSheet(expense = null) {
  const form = {
    itemId: expense?.item_id ?? null,
    amount: expense?.amount ?? 0,
    date: expense?.spent_on ?? today(),
  };
  // In edit mode a chip opens its rename and delete panel instead of being selected.
  let editing = false;
  let editingId = null;

  const root = openSheet({
    title: expense ? 'تعديل المصروف' : 'مصروف جديد',
    body: `
      <div class="field">
        <div class="label-row">
          <span class="label" id="f-items-label"></span>
          <button type="button" class="label-btn" id="f-items-edit"></button>
        </div>
        <div class="chip-wrap" id="f-items"></div>
        <div id="f-item-panel"></div>
      </div>
      <div class="field">
        <label class="label" for="f-amount">المبلغ</label>
        ${moneyInput('f-amount', true)}
      </div>
      ${dateField()}
      ${noteField('مثال: 5 كيلو')}`,
    foot: saveButtons(Boolean(expense)),
    onSubmit: () => save(false),
  });

  const amountInput = $('#f-amount', root);
  const noteInput = $('#f-note', root);
  const chips = $('#f-items', root);
  const panel = $('#f-item-panel', root);
  const editToggle = $('#f-items-edit', root);
  amountInput.value = form.amount ? fmt(form.amount) : '';
  noteInput.value = expense?.note ?? '';

  function drawChips() {
    const list = expenseItems();
    const current = form.itemId && findRow('expense_items', form.itemId);
    if (current?.archived && !editing) list.push(current);
    chips.innerHTML = editing
      ? list.map((item) => `<button type="button" class="chip chip-edit ${item.id === editingId ? 'editing' : ''}" data-id="${item.id}" data-flip="${item.id}">${icon('pencil')}${esc(item.name)}</button>`).join('')
      : `${list.map((item) => `<button type="button" class="chip ${item.id === form.itemId ? 'on' : ''}" data-id="${item.id}" data-flip="${item.id}">${esc(item.name)}</button>`).join('')}
        <button type="button" class="chip chip-add" data-new data-flip="new">${icon('plus')}صنف جديد</button>`;
    $('#f-items-label', root).textContent = editing ? 'اضغط على صنف لتعديله أو حذفه' : 'الصنف';
    editToggle.innerHTML = editing ? 'تم' : `${icon('pencil')}تعديل`;
    editToggle.setAttribute('aria-pressed', String(editing));
    editToggle.hidden = !expenseItems().length;
  }

  const paintChips = () => glide(() => $$('.chip', chips), drawChips);

  function selectItem(id) {
    form.itemId = id;
    paintChips();
    if (!form.amount) amountInput.focus();
  }

  function closeItemPanel() {
    panel.textContent = '';
    editingId = null;
    $$('.chip', chips).forEach((chip) => chip.classList.remove('editing'));
  }

  function openItemEditor(id) {
    const item = findRow('expense_items', id);
    editingId = id;
    $$('.chip', chips).forEach((chip) => chip.classList.toggle('editing', chip.dataset.id === id));
    panel.innerHTML = `
      <div class="inline-add">
        <input class="input" type="text" aria-label="اسم الصنف" autocomplete="off" enterkeyhint="done">
        <button type="button" class="btn btn-primary" data-rename>حفظ</button>
        <button type="button" class="btn btn-danger" data-remove aria-label="حذف الصنف">${icon('trash')}</button>
      </div>
      <p class="panel-note">حذف الصنف لا يؤثر على المصاريف المسجلة سابقًا.</p>`;
    const input = $('input', panel);
    input.value = item.name;
    const rename = () => {
      const saved = saveNamedRow('expense_items', { id, name: input.value });
      if (!saved) {
        shake(input);
        input.focus();
        return;
      }
      closeItemPanel();
      paintChips();
      render();
      toast('تم حفظ الصنف');
    };
    onEnter(input, rename);
    $('[data-rename]', panel).addEventListener('click', rename);
    $('[data-remove]', panel).addEventListener('click', () => {
      const wasSelected = form.itemId === id;
      if (wasSelected) form.itemId = null;
      closeItemPanel();
      archiveRow('expense_items', item, 'تم حذف الصنف', {
        keepSheet: true,
        onUndo() {
          if (wasSelected && !form.itemId) form.itemId = id;
          paintChips();
        },
      });
      if (!expenseItems().length) editing = false;
      paintChips();
    });
    panel.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }

  editToggle.addEventListener('click', () => {
    editing = !editing;
    closeItemPanel();
    paintChips();
  });

  chips.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    if (editing) {
      if (chip.dataset.id === editingId) closeItemPanel();
      else openItemEditor(chip.dataset.id);
      return;
    }
    if (chip.dataset.id) {
      selectItem(chip.dataset.id);
      return;
    }
    if (panel.firstChild) {
      closeItemPanel();
      return;
    }
    panel.innerHTML = `
      <div class="inline-add">
        <input class="input" type="text" placeholder="اسم الصنف" aria-label="اسم الصنف" autocomplete="off" enterkeyhint="done">
        <button type="button" class="btn btn-primary">إضافة</button>
      </div>`;
    const input = $('input', panel);
    const add = () => {
      const item = saveNamedRow('expense_items', { name: input.value });
      if (!item) {
        shake(input);
        input.focus();
        return;
      }
      closeItemPanel();
      selectItem(item.id);
    };
    onEnter(input, add);
    $('button', panel).addEventListener('click', add);
    input.focus();
  });

  bindNumberInput(amountInput, (value) => {
    form.amount = value;
  });

  const paintDate = bindDateField(root, form);

  function save(again) {
    if (!form.itemId) {
      shake(chips);
      return;
    }
    if (form.amount <= 0) {
      shake(amountInput.parentElement);
      amountInput.focus();
      return;
    }
    const row = {
      id: expense?.id ?? uuid(),
      item_id: form.itemId,
      amount: form.amount,
      spent_on: form.date,
      note: noteInput.value.trim() || null,
      created_at: expense?.created_at ?? new Date().toISOString(),
    };
    upsert('expenses', [row]);
    toast(savedMessage('تم حفظ المصروف', row.spent_on));
    navigator.vibrate?.(12);
    if (again) {
      Object.assign(form, { itemId: null, amount: 0 });
      editing = false;
      closeItemPanel();
      amountInput.value = '';
      noteInput.value = '';
      paintChips();
      paintDate();
      $('.sheet-body', root).scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      closeSheet();
    }
    renderWithFlip(row.id);
  }

  $('[data-form-again]', root)?.addEventListener('click', () => save(true));
  $('[data-form-delete]', root)?.addEventListener('click', () => {
    removeRow('expenses', expense.id);
    closeSheet();
    renderWithFlip();
    toast('تم حذف المصروف', {
      action: 'تراجع',
      onAction() {
        upsert('expenses', [expense]);
        renderWithFlip(expense.id);
      },
    });
  });

  paintChips();
}

/* ------------------------- Products and expense items ----------------------- */

const cleanName = (name) => name.trim().replace(/\s+/g, ' ');
const sameName = (a, b) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();

// Removed names stay in the table so old records keep them, and adding one again
// brings it back, which keeps a month's totals on a single row.
function saveNamedRow(table, { id, name, price }) {
  const clean = cleanName(name);
  if (!clean) return null;
  const rows = db[table];
  if (rows.some((row) => !row.archived && row.id !== id && sameName(row.name, clean))) {
    toast('هذا الاسم موجود مسبقًا', { tone: 'error' });
    return null;
  }
  const withPrice = (row) => (price === undefined ? row : { ...row, price });
  const archivedTwin = id ? null : rows.find((row) => row.archived && sameName(row.name, clean));
  const nextOrder = rows.reduce((highest, row) => Math.max(highest, row.sort_order), -1) + 1;
  let row;
  if (id) row = withPrice({ ...findRow(table, id), name: clean });
  else if (archivedTwin) row = withPrice({ ...archivedTwin, name: clean, archived: false, sort_order: nextOrder });
  else row = withPrice({ id: uuid(), name: clean, sort_order: nextOrder, archived: false, created_at: new Date().toISOString() });
  upsert(table, [row]);
  return row;
}

function archiveRow(table, row, message, { keepSheet = false, onUndo } = {}) {
  upsert(table, [{ ...row, archived: true }]);
  if (!keepSheet) closeSheet();
  renderWithFlip();
  toast(message, {
    action: 'تراجع',
    onAction() {
      upsert(table, [row]);
      renderWithFlip(row.id);
      onUndo?.();
    },
  });
}

function openProductSheet(product = null) {
  let price = product?.price ?? 0;
  const root = openSheet({
    title: product ? 'تعديل المنتج' : 'منتج جديد',
    body: `
      <div class="field">
        <label class="label" for="f-name">اسم المنتج</label>
        <input id="f-name" class="input" type="text" autocomplete="off" enterkeyhint="next" placeholder="مثال: عصير 500 مل">
      </div>
      <div class="field">
        <label class="label" for="f-price">سعر البيع</label>
        ${moneyInput('f-price', true)}
      </div>`,
    foot: product
      ? `<button type="button" class="btn btn-danger" data-form-delete aria-label="حذف">${icon('trash')}</button><button type="submit" class="btn btn-primary">حفظ</button>`
      : '<button type="submit" class="btn btn-primary">حفظ</button>',
    onSubmit() {
      const row = saveNamedRow('products', { id: product?.id, name: nameInput.value, price });
      if (!row) {
        shake(nameInput);
        nameInput.focus();
        return;
      }
      closeSheet();
      renderWithFlip(row.id);
      toast('تم حفظ المنتج');
    },
  });
  const nameInput = $('#f-name', root);
  const priceInput = $('#f-price', root);
  nameInput.value = product?.name ?? '';
  priceInput.value = price ? fmt(price) : '';
  bindNumberInput(priceInput, (value) => {
    price = value;
  });
  $('[data-form-delete]', root)?.addEventListener('click', () => archiveRow('products', product, 'تم حذف المنتج'));
  if (!product) nameInput.focus();
}

function openItemSheet(item = null) {
  const root = openSheet({
    title: item ? 'تعديل الصنف' : 'صنف جديد',
    body: `
      <div class="field">
        <label class="label" for="f-name">اسم الصنف</label>
        <input id="f-name" class="input" type="text" autocomplete="off" enterkeyhint="done" placeholder="مثال: مانجو">
      </div>`,
    foot: item
      ? `<button type="button" class="btn btn-danger" data-form-delete aria-label="حذف">${icon('trash')}</button><button type="submit" class="btn btn-primary">حفظ</button>`
      : '<button type="submit" class="btn btn-primary">حفظ</button>',
    onSubmit() {
      const row = saveNamedRow('expense_items', { id: item?.id, name: nameInput.value });
      if (!row) {
        shake(nameInput);
        nameInput.focus();
        return;
      }
      closeSheet();
      renderWithFlip(row.id);
      toast('تم حفظ الصنف');
    },
  });
  const nameInput = $('#f-name', root);
  nameInput.value = item?.name ?? '';
  $('[data-form-delete]', root)?.addEventListener('click', () => archiveRow('expense_items', item, 'تم حذف الصنف'));
  if (!item) nameInput.focus();
}

function moveRow(id, delta) {
  const onProducts = state.manage === 'products';
  const table = onProducts ? 'products' : 'expense_items';
  const list = onProducts ? products() : expenseItems();
  const from = list.findIndex((row) => row.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to], list[from]];
  const changed = list.flatMap((row, index) => (row.sort_order === index ? [] : [{ ...row, sort_order: index }]));
  if (changed.length) upsert(table, changed);
  renderWithFlip();
}

/* ---------------------------------- Actions --------------------------------- */

const actions = {
  tab(el) {
    const { tab } = el.dataset;
    // The tab bar always opens the full list; only a tap on a summary row filters it.
    if (tab !== state.tab && tab in state.filter) state.filter[tab] = null;
    setTab(tab);
  },
  mode: (el) => setMode(el.dataset.mode),
  shift(el) {
    const delta = Number(el.dataset.delta);
    shiftPeriod(delta);
    render({ slide: delta });
  },
  'open-period': (el) => {
    const { key } = el.dataset;
    state.period.year = Number(key.slice(0, 4));
    if (key.length > 4) {
      state.period.month = Number(key.slice(5));
      state.period.mode = 'month';
    } else {
      state.period.mode = 'year';
    }
    render({ slide: 0, keepScroll: false });
  },
  drill(el) {
    state.filter[el.dataset.tab] = el.dataset.id;
    setTab(el.dataset.tab);
  },
  filter(el) {
    const scroll = $('.chips').scrollLeft;
    state.filter[el.dataset.tab] = el.dataset.id || null;
    render();
    $('.chips').scrollLeft = scroll;
  },
  'manage-tab': (el) => {
    state.manage = el.dataset.manage;
    render({ slide: 0 });
  },
  move: (el) => moveRow(el.dataset.id, Number(el.dataset.delta)),
  'new-sale': () => openSaleSheet(),
  'edit-sale': (el) => openSaleSheet(findRow('sales', el.dataset.id)),
  'new-expense': () => openExpenseSheet(),
  'edit-expense': (el) => openExpenseSheet(findRow('expenses', el.dataset.id)),
  'new-product': () => openProductSheet(),
  'edit-product': (el) => openProductSheet(findRow('products', el.dataset.id)),
  'new-item': () => openItemSheet(),
  'edit-item': (el) => openItemSheet(findRow('expense_items', el.dataset.id)),
  logout() {
    lock();
    state.tab = 'summary';
    db = emptyDb();
    store.del('fg.db');
  },
};

document.addEventListener('click', (event) => {
  const el = event.target.closest('[data-act]');
  if (el && !el.disabled) actions[el.dataset.act]?.(el);
});

/* ----------------------------------- Gate ---------------------------------- */

// Capital and small letters do not matter: only this tidied-up lowercase form is
// ever sent to Supabase, and the password itself is not stored in this file.
const tidyPassword = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();

function showGate() {
  const gate = $('#gate');
  gate.classList.remove('leaving');
  gate.hidden = false;
  $('#app').hidden = true;
  $('#gate-input').value = '';
  $('#gate-error').textContent = IS_CONNECTED ? '' : 'لم يتم ربط قاعدة البيانات بعد.';
}

function lock() {
  session = null;
  store.del('fg.session');
  closeSheet();
  showGate();
}

function enterApp() {
  const app = $('#app');
  app.hidden = false;
  shownNet = 0;
  render({ slide: 0, keepScroll: false });
  pull();
  flush();
}

$('#gate-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = tidyPassword($('#gate-input').value);
  const card = $('#gate-form');
  const error = $('#gate-error');
  const button = $('#gate-submit');
  if (!IS_CONNECTED) return;
  if (!password) {
    shake(card);
    return;
  }
  button.disabled = true;
  error.textContent = '';
  try {
    await requestToken('password', { email: ADMIN_EMAIL, password });
    const gate = $('#gate');
    gate.classList.add('leaving');
    enterApp();
    setTimeout(() => { gate.hidden = true; }, 420);
  } catch (failure) {
    error.textContent = failure instanceof AuthError ? 'كلمة المرور غير صحيحة' : 'تعذّر الاتصال، تحقق من الإنترنت';
    shake(card);
  } finally {
    button.disabled = false;
  }
});

/* ----------------------------------- Boot ---------------------------------- */

window.addEventListener('online', () => {
  paintSync();
  flush();
  pull();
});

window.addEventListener('offline', paintSync);

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !session) return;
  flush();
  if (Date.now() - lastPull > 30000) pull();
});

if (session && IS_CONNECTED) enterApp();
else showGate();
