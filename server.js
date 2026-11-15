'use strict';
/*
 * Quản lí chi tiêu gia đình — standalone server (bản triển khai).
 * Node.js built-in modules only (http, fs, path, crypto). No dependencies.
 * Run: node server.js   (PORT and DATA_FILE via environment)
 *
 * Multi-family: every account is one family's ledger. All data rows carry
 * an accountId and every query is scoped to the signed-in account, so
 * families can never see or affect each other's data.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ---------------------------------------------------------------- defaults
const DEFAULT_INCOME_CATEGORIES = ['Lương', 'Thưởng', 'Thu nhập khác'];
const DEFAULT_EXPENSE_CATEGORIES = [
  'Ăn uống/siêu thị', 'Tiền nhà', 'Điện-gas-nước', 'Đi lại',
  'Điện thoại/internet', 'Y tế', 'Mua sắm', 'Giải trí', 'Gửi về nhà', 'Khác',
];
const DEFAULT_PERSONS = ['Đoàn', 'Vợ'];
const DEFAULT_PAYMENT_METHODS = ['Tiền mặt', 'Ngân hàng', 'PayPay', 'Thẻ tín dụng'];

// Payment methods that are "pay next month" unless the family changes it.
function defaultSettlement(methodName) {
  const n = String(methodName || '').toLowerCase();
  if (n.includes('paypay') || n.includes('thẻ tín dụng') || n.includes('credit')) return 'next';
  return 'now';
}

// ---------------------------------------------------------------- database
function emptyDb() {
  return {
    accounts: [],
    sessions: {}, // token -> { accountId, createdAt, expiresAt }
    transactions: [],
    budgets: [],
    options: [], // { id, accountId, kind, name, hidden, settlement }
    recurringItems: [],
    recurringApplications: [], // { id, accountId, recurringItemId, month, transactionId }
    nextIds: { account: 1, transaction: 1, budget: 1, option: 1, recurringItem: 1, recurringApplication: 1 },
  };
}

function loadDb() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const base = emptyDb();
    for (const k of Object.keys(base)) if (db[k] === undefined) db[k] = base[k];
    db.nextIds = Object.assign(base.nextIds, db.nextIds || {});
    return db;
  } catch (e) {
    return emptyDb();
  }
}

let db = loadDb();

function saveDb() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
}

// ---------------------------------------------------------------- passwords
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, account) {
  const candidate = crypto.scryptSync(String(password), account.salt, 64);
  const stored = Buffer.from(account.passwordHash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

// ---------------------------------------------------------------- sessions
function createSession(accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = { accountId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS };
  saveDb();
  return token;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function requestToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return parseCookies(req.headers.cookie || '').sid || null;
}

function getSessionAccount(req) {
  const token = requestToken(req);
  if (!token) return null;
  const session = db.sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) { delete db.sessions[token]; saveDb(); return null; }
  return db.accounts.find((a) => a.id === session.accountId) || null;
}

function sessionCookie(token) {
  return `sid=${token}; HttpOnly; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}; SameSite=Lax`;
}
function clearSessionCookie() {
  return 'sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax';
}

// ---------------------------------------------------------------- http utils
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function publicAccount(a) {
  return { id: a.id, familyName: a.familyName, username: a.username, createdAt: a.createdAt };
}

function requireAuth(req, res) {
  const account = getSessionAccount(req);
  if (!account) { sendJson(res, 401, { error: 'unauthorized' }); return null; }
  return account;
}

// ---------------------------------------------------------------- options
// Effective (visible) values for a list: defaults + the family's custom rows,
// minus hidden rows. A stored row with the same name as a default overrides it
// (hidden flag / settlement), which is how defaults can be deleted or re-set.
function defaultNames(kind) {
  if (kind === 'incomeCategory') return DEFAULT_INCOME_CATEGORIES;
  if (kind === 'expenseCategory') return DEFAULT_EXPENSE_CATEGORIES;
  if (kind === 'person') return DEFAULT_PERSONS;
  if (kind === 'paymentMethod') return DEFAULT_PAYMENT_METHODS;
  return [];
}

function findOption(accountId, kind, name) {
  const n = String(name || '').trim().toLowerCase();
  return db.options.find(
    (o) => o.accountId === accountId && o.kind === kind && o.name.trim().toLowerCase() === n
  );
}

function ensureOption(accountId, kind, name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  let opt = findOption(accountId, kind, clean);
  if (opt) {
    if (opt.hidden) { opt.hidden = false; } // re-typing a deleted name revives it
    return opt;
  }
  opt = {
    id: db.nextIds.option++,
    accountId, kind, name: clean, hidden: false,
    settlement: kind === 'paymentMethod' ? defaultSettlement(clean) : undefined,
  };
  db.options.push(opt);
  return opt;
}

// Remember names used in the entry form so they appear in the pickers later.
function rememberEntryNames(accountId, body) {
  ensureOption(accountId, body.type === 'income' ? 'incomeCategory' : 'expenseCategory', body.category);
  ensureOption(accountId, 'person', body.person);
  ensureOption(accountId, 'paymentMethod', body.paymentMethod);
}

function effectiveSettlement(accountId, methodName) {
  const opt = findOption(accountId, 'paymentMethod', methodName);
  if (opt && opt.settlement) return opt.settlement;
  return defaultSettlement(methodName);
}

function listOptions(accountId, kind) {
  const rows = db.options.filter((o) => o.accountId === accountId && o.kind === kind);
  const out = [];
  for (const name of defaultNames(kind)) {
    const row = rows.find((o) => o.name.trim().toLowerCase() === name.toLowerCase());
    if (row && row.hidden) continue;
    out.push({
      id: row ? row.id : null, name,
      settlement: kind === 'paymentMethod' ? (row && row.settlement) || defaultSettlement(name) : undefined,
      isDefault: true,
    });
  }
  for (const row of rows) {
    if (defaultNames(kind).some((d) => d.toLowerCase() === row.name.trim().toLowerCase())) continue;
    if (row.hidden) continue;
    out.push({
      id: row.id, name: row.name,
      settlement: kind === 'paymentMethod' ? row.settlement || defaultSettlement(row.name) : undefined,
      isDefault: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------- recurring
function daysInMonth(month) { // month = 'YYYY-MM'
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function applyRecurring(accountId, month) {
  let created = 0;
  for (const item of db.recurringItems.filter((r) => r.accountId === accountId)) {
    if (item.startMonth > month) continue;
    const already = db.recurringApplications.some(
      (a) => a.accountId === accountId && a.recurringItemId === item.id && a.month === month
    );
    if (already) continue;
    const day = Math.min(Math.max(1, item.settlementDay || 1), daysInMonth(month));
    const tx = {
      id: db.nextIds.transaction++,
      accountId,
      type: item.type,
      amount: item.amount,
      date: `${month}-${String(day).padStart(2, '0')}`,
      category: item.category,
      note: 'Cố định hàng tháng',
      person: item.person,
      paymentMethod: item.paymentMethod,
      recurringItemId: item.id,
      createdAt: new Date().toISOString(),
    };
    db.transactions.push(tx);
    db.recurringApplications.push({
      id: db.nextIds.recurringApplication++,
      accountId, recurringItemId: item.id, month, transactionId: tx.id,
    });
    created++;
  }
  if (created) saveDb();
  return created;
}

// ---------------------------------------------------------------- validation
function sanitizeTransaction(accountId, body, existing) {
  const type = body.type === 'income' ? 'income' : 'expense';
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'invalid_amount' };
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'invalid_date' };
  const category = String(body.category || '').trim();
  if (!category) return { error: 'invalid_category' };
  return {
    id: existing ? existing.id : undefined,
    accountId,
    type, amount, date, category,
    note: String(body.note || ''),
    person: String(body.person || '').trim(),
    paymentMethod: String(body.paymentMethod || '').trim(),
    recurringItemId: existing ? existing.recurringItemId : null,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
}

function sanitizeRecurring(accountId, body, existing) {
  const type = body.type === 'income' ? 'income' : 'expense';
  const amount = Math.floor(Number(body.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'invalid_amount' };
  const name = String(body.name || '').trim();
  if (!name) return { error: 'invalid_name' };
  const day = Math.floor(Number(body.settlementDay));
  if (!Number.isFinite(day) || day < 1 || day > 31) return { error: 'invalid_day' };
  const startMonth = String(body.startMonth || '');
  if (!/^\d{4}-\d{2}$/.test(startMonth)) return { error: 'invalid_start_month' };
  return {
    id: existing ? existing.id : undefined,
    accountId, name, type, amount,
    settlementDay: day,
    category: String(body.category || '').trim(),
    person: String(body.person || '').trim(),
    paymentMethod: String(body.paymentMethod || '').trim(),
    startMonth,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
  };
}

function normalizeLoose(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .trim().toLowerCase();
}

// ---------------------------------------------------------------- API
async function handleApi(req, res, url) {
  const p = url.pathname;

  // ---- auth ----
  if (p === '/api/status' && req.method === 'GET') {
    const account = getSessionAccount(req);
    return sendJson(res, 200, { user: account ? publicAccount(account) : null });
  }

  if (p === '/api/register' && req.method === 'POST') {
    const body = await readBody(req);
    const familyName = String(body.familyName || '').trim();
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!familyName || !username || password.length < 6) {
      return sendJson(res, 400, { error: 'invalid_input' });
    }
    if (db.accounts.some((a) => a.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 400, { error: 'username_taken' });
    }
    const { salt, hash } = hashPassword(password);
    const account = {
      id: db.nextIds.account++, familyName, username,
      salt, passwordHash: hash, createdAt: new Date().toISOString(),
    };
    db.accounts.push(account);
    const token = createSession(account.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    return sendJson(res, 201, { user: publicAccount(account), token });
  }

  if (p === '/api/login' && req.method === 'POST') {
    const body = await readBody(req);
    const account = db.accounts.find(
      (a) => a.username.toLowerCase() === String(body.username || '').trim().toLowerCase()
    );
    if (!account || !verifyPassword(body.password || '', account)) {
      return sendJson(res, 401, { error: 'invalid_credentials' });
    }
    const token = createSession(account.id);
    res.setHeader('Set-Cookie', sessionCookie(token));
    return sendJson(res, 200, { user: publicAccount(account), token });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    const token = requestToken(req);
    if (token && db.sessions[token]) { delete db.sessions[token]; saveDb(); }
    res.setHeader('Set-Cookie', clearSessionCookie());
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/me' && req.method === 'GET') {
    const account = requireAuth(req, res);
    if (!account) return;
    return sendJson(res, 200, { user: publicAccount(account) });
  }

  if (p === '/api/change-password' && req.method === 'POST') {
    const account = requireAuth(req, res);
    if (!account) return;
    const body = await readBody(req);
    if (!verifyPassword(body.currentPassword || '', account)) {
      return sendJson(res, 401, { error: 'invalid_credentials' });
    }
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 6) return sendJson(res, 400, { error: 'invalid_input' });
    const { salt, hash } = hashPassword(newPassword);
    account.salt = salt;
    account.passwordHash = hash;
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- state (everything the signed-in family sees, scoped to them) ----
  if (p === '/api/state' && req.method === 'GET') {
    const account = requireAuth(req, res);
    if (!account) return;
    const aid = account.id;
    return sendJson(res, 200, {
      user: publicAccount(account),
      transactions: db.transactions.filter((t) => t.accountId === aid),
      budgets: db.budgets.filter((b) => b.accountId === aid),
      recurringItems: db.recurringItems.filter((r) => r.accountId === aid),
      options: {
        incomeCategory: listOptions(aid, 'incomeCategory'),
        expenseCategory: listOptions(aid, 'expenseCategory'),
        person: listOptions(aid, 'person'),
        paymentMethod: listOptions(aid, 'paymentMethod'),
      },
    });
  }

  // ---- transactions ----
  if (p === '/api/transactions' && req.method === 'POST') {
    const account = requireAuth(req, res);
    if (!account) return;
    const body = await readBody(req);
    const tx = sanitizeTransaction(account.id, body, null);
    if (tx.error) return sendJson(res, 400, { error: tx.error });
    tx.id = db.nextIds.transaction++;
    rememberEntryNames(account.id, tx);
    db.transactions.push(tx);
    saveDb();
    return sendJson(res, 201, { transaction: tx });
  }

  const txMatch = p.match(/^\/api\/transactions\/(\d+)$/);
  if (txMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const account = requireAuth(req, res);
    if (!account) return;
    const id = parseInt(txMatch[1], 10);
    const idx = db.transactions.findIndex((t) => t.id === id && t.accountId === account.id);
    if (idx === -1) return sendJson(res, 404, { error: 'not_found' });
    if (req.method === 'DELETE') {
      db.transactions.splice(idx, 1);
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
    const body = await readBody(req);
    const tx = sanitizeTransaction(account.id, body, db.transactions[idx]);
    if (tx.error) return sendJson(res, 400, { error: tx.error });
    rememberEntryNames(account.id, tx);
    db.transactions[idx] = tx;
    saveDb();
    return sendJson(res, 200, { transaction: tx });
  }

  // ---- budgets ----
  if (p === '/api/budgets' && req.method === 'POST') {
    const account = requireAuth(req, res);
    if (!account) return;
    const body = await readBody(req);
    const category = String(body.category || '').trim();
    const amount = Math.floor(Number(body.amount));
    let threshold = Math.floor(Number(body.alertThreshold));
    if (!Number.isFinite(threshold)) threshold = 80;
    threshold = Math.min(100, Math.max(1, threshold));
    if (!category || !Number.isFinite(amount) || amount <= 0) {
      return sendJson(res, 400, { error: 'invalid_input' });
    }
    let budget = db.budgets.find(
      (b) => b.accountId === account.id && b.category.toLowerCase() === category.toLowerCase()
    );
    if (budget) {
      budget.amount = amount;
      budget.alertThreshold = threshold;
    } else {
      budget = { id: db.nextIds.budget++, accountId: account.id, category, amount, alertThreshold: threshold };
      db.budgets.push(budget);
    }
    ensureOption(account.id, 'expenseCategory', category);
    saveDb();
    return sendJson(res, 200, { budget });
  }

  const budgetMatch = p.match(/^\/api\/budgets\/(\d+)$/);
  if (budgetMatch && req.method === 'DELETE') {
    const account = requireAuth(req, res);
    if (!account) return;
    const id = parseInt(budgetMatch[1], 10);
    const idx = db.budgets.findIndex((b) => b.id === id && b.accountId === account.id);
    if (idx === -1) return sendJson(res, 404, { error: 'not_found' });
    db.budgets.splice(idx, 1);
    saveDb();
    return sendJson(res, 200, { ok: true });
  }

  // ---- options (customisable lists) ----
  if (p === '/api/options' && req.method === 'POST') {
    const account = requireAuth(req, res);
    if (!account) return;
    const body = await readBody(req);
    const kind = body.kind;
    if (!['incomeCategory', 'expenseCategory', 'person', 'paymentMethod'].includes(kind)) {
      return sendJson(res, 400, { error: 'invalid_kind' });
    }
    const name = String(body.name || '').trim();
    if (!name) return sendJson(res, 400, { error: 'invalid_input' });
    const opt = ensureOption(account.id, kind, name);
    saveDb();
    return sendJson(res, 201, { option: { id: opt.id, name: opt.name, settlement: opt.settlement } });
  }

  const optMatch = p.match(/^\/api\/options\/(\d+)$/);
  if (optMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const account = requireAuth(req, res);
    if (!account) return;
    const id = parseInt(optMatch[1], 10);
    let opt = db.options.find((o) => o.id === id && o.accountId === account.id);
    if (req.method === 'DELETE') {
      // Deleting hides the value from pickers; old transactions keep their text.
      // A default value gets a hidden override row so it can be deleted too.
      const body = await readBody(req).catch(() => ({}));
      if (!opt && body && body.kind && body.name) {
        opt = ensureOption(account.id, body.kind, body.name);
      }
      if (!opt) return sendJson(res, 404, { error: 'not_found' });
      opt.hidden = true;
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
    if (!opt) return sendJson(res, 404, { error: 'not_found' });
    const body = await readBody(req);
    const newName = String(body.name || '').trim();
    if (!newName) return sendJson(res, 400, { error: 'invalid_input' });
    opt.name = newName;
    opt.hidden = false;
    saveDb();
    return sendJson(res, 200, { option: { id: opt.id, name: opt.name, settlement: opt.settlement } });
  }

  // Payment settlement: set a method to "now" (Trả ngay) or "next" (Tháng sau).
  if (p === '/api/payment-settlement' && req.method === 'POST') {
    const account = requireAuth(req, res);
    if (!account) return;
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    const settlement = body.settlement === 'next' ? 'next' : 'now';
    if (!name) return sendJson(res, 400, { error: 'invalid_input' });
    const opt = ensureOption(account.id, 'paymentMethod', name);
    opt.settlement = settlement;
    saveDb();
    return sendJson(res, 200, { name: opt.name, settlement });
  }

  // ---- recurring items ----
  if (p === '/api/recurring-items' && req.method === 'POST') {
    const account = requireAuth(req, res);
    if (!account) return;
    const body = await readBody(req);
    const item = sanitizeRecurring(account.id, body, null);
    if (item.error) return sendJson(res, 400, { error: item.error });
    item.id = db.nextIds.recurringItem++;
    rememberEntryNames(account.id, item);
    db.recurringItems.push(item);
    saveDb();
    return sendJson(res, 201, { item });
  }

  if (p === '/api/recurring-items/apply' && req.method === 'POST') {
    const account = requireAuth(req, res);
    if (!account) return;
    const body = await readBody(req);
    const month = String(body.month || '');
    if (!/^\d{4}-\d{2}$/.test(month)) return sendJson(res, 400, { error: 'invalid_month' });
    const created = applyRecurring(account.id, month);
    return sendJson(res, 200, {
      created,
      transactions: db.transactions.filter((t) => t.accountId === account.id),
    });
  }

  const recMatch = p.match(/^\/api\/recurring-items\/(\d+)$/);
  if (recMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
    const account = requireAuth(req, res);
    if (!account) return;
    const id = parseInt(recMatch[1], 10);
    const idx = db.recurringItems.findIndex((r) => r.id === id && r.accountId === account.id);
    if (idx === -1) return sendJson(res, 404, { error: 'not_found' });
    if (req.method === 'DELETE') {
      db.recurringItems.splice(idx, 1);
      // Generation records for months already created stay with their
      // transactions; removing the item stops all future generation.
      saveDb();
      return sendJson(res, 200, { ok: true });
    }
    const body = await readBody(req);
    const item = sanitizeRecurring(account.id, body, db.recurringItems[idx]);
    if (item.error) return sendJson(res, 400, { error: item.error });
    rememberEntryNames(account.id, item);
    db.recurringItems[idx] = item;
    saveDb();
    return sendJson(res, 200, { item });
  }

  // ---- reset (only the signed-in family's data) ----
  if (p === '/api/reset/counts' && req.method === 'GET') {
    const account = requireAuth(req, res);
    if (!account) return;
    const aid = account.id;
    return sendJson(res, 200, {
      counts: {
        transactions: db.transactions.filter((t) => t.accountId === aid).length,
        budgets: db.budgets.filter((b) => b.accountId === aid).length,
        recurringItems: db.recurringItems.filter((r) => r.accountId === aid).length,
        options: db.options.filter((o) => o.accountId === aid).length,
      },
    });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    const account = requireAuth(req, res);
    if (!account) return;
    const body = await readBody(req);
    if (normalizeLoose(body.confirmText) !== 'xoa het') {
      return sendJson(res, 400, { error: 'confirmation_required' });
    }
    const aid = account.id;
    const counts = {
      transactions: db.transactions.filter((t) => t.accountId === aid).length,
      budgets: db.budgets.filter((b) => b.accountId === aid).length,
      recurringItems: db.recurringItems.filter((r) => r.accountId === aid).length,
      options: db.options.filter((o) => o.accountId === aid).length,
    };
    db.transactions = db.transactions.filter((t) => t.accountId !== aid);
    db.budgets = db.budgets.filter((b) => b.accountId !== aid);
    db.recurringItems = db.recurringItems.filter((r) => r.accountId !== aid);
    db.recurringApplications = db.recurringApplications.filter((a) => a.accountId !== aid);
    db.options = db.options.filter((o) => o.accountId !== aid);
    saveDb();
    return sendJson(res, 200, { ok: true, deleted: counts });
  }

  return sendJson(res, 404, { error: 'not_found' });
}

// ---------------------------------------------------------------- static
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, idx) => {
        if (err2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(idx);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (path.basename(filePath) === 'sw.js') headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    res.end(data);
  });
}

// ---------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: 'server_error', detail: String((e && e.message) || e) });
  }
});

server.listen(PORT, () => {
  console.log(`Chi tieu gia dinh server listening on http://localhost:${PORT}`);
  console.log(`Data file: ${DATA_FILE}`);
});
