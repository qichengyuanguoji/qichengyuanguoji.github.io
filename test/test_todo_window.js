/* 「显示 N 天内到期」窗口（todoDays）：
 * 1) 纯函数：validState / todayTodos / dueChannels 支持窗口参数，normTodoDays 规范化
 * 2) 首页 UI：按钮文案、统计条、弹窗回显、保存后刷新
 * 用最小 DOM 桩按 index.html 顺序加载全部脚本（与 test_ui_smoke 同套路）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.attrs = {};
    this._text = '';
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.id = '';
    this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === 'id') this.id = v;
    if (k === 'value') this.value = v;
    if (k === 'placeholder') this.placeholder = v;
  }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { if (c) this.children.push(c); return c; }
  append() { for (const c of arguments) this.appendChild(c); }
  prepend(c) { if (c) this.children.unshift(c); }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() {}
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  dispatch(t) { (this.listeners[t] || []).forEach(f => f({ target: this, preventDefault() {}, stopPropagation() {} })); }
  click() { this.dispatch('click'); }
  focus() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  set innerHTML(v) { if (v === '') { this.children = []; this._text = ''; } else this._text = String(v); }
  get innerHTML() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent || '').join(''); }
}

function findBy(node, pred) {
  if (!node) return null;
  if (pred(node)) return node;
  for (const c of node.children || []) {
    const r = findBy(c, pred);
    if (r) return r;
  }
  return null;
}
function findAll(node, pred, out) {
  out = out || [];
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}

function installDom() {
  const ids = {};
  const all = [];
  ['content', 'conn-dot', 'conn-text', 'data-path', 'nav', 'toast'].forEach(id => {
    const n = new El('div'); n.id = id; ids[id] = n;
  });
  const body = new El('body');
  const doc = {
    readyState: 'complete',
    body: body,
    createElement: t => { const n = new El(t); all.push(n); return n; },
    createTextNode: t => { const n = new El('#text'); n.textContent = t; return n; },
    getElementById: id => ids[id] || all.filter(n => n.id === id).pop() || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  global.window = {};
  global.document = doc;
  return { doc, ids };
}

function loadScripts() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const srcs = [];
  const re = /<script src="([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(html))) srcs.push(m[1]);
  srcs.forEach(src => {
    const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
    vm.runInThisContext(code, { filename: src });
  });
  return srcs;
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  const limit = ms || 1500;
  while (Date.now() - t0 < limit) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
}

const dom = installDom();
loadScripts();
const calc = global.App.calc;
const NOW = '2026-10-29';

/* ============ 纯函数 ============ */

test('normTodoDays: 默认 7 天，1~365 裁剪，非法值回落', () => {
  assert.strictEqual(calc.TODO_DAYS, 7);
  assert.deepStrictEqual(calc.TODO_CHOICES, [3, 7, 15, 30, 60]);
  assert.strictEqual(calc.normTodoDays(undefined), 7);
  assert.strictEqual(calc.normTodoDays(''), 7);
  assert.strictEqual(calc.normTodoDays('abc'), 7);
  assert.strictEqual(calc.normTodoDays(0), 7);
  assert.strictEqual(calc.normTodoDays(-5), 7);
  assert.strictEqual(calc.normTodoDays('30'), 30);
  assert.strictEqual(calc.normTodoDays(7.6), 8);
  assert.strictEqual(calc.normTodoDays(999), 365);
  assert.strictEqual(calc.normTodoDays('abc', 15), 15);
});

test('validState: 窗口天数决定「将到期」的边界（含当天）', () => {
  const c15 = { name: '15 天后', validUntil: '2026-11-13' }; // 与 10-29 相差 15 天
  assert.strictEqual(calc.validState(c15, NOW).st, 'ok', '默认 7 天窗口内不算临期');
  assert.strictEqual(calc.validState(c15, NOW, 14).st, 'ok', '14 天窗口仍差 1 天');
  assert.strictEqual(calc.validState(c15, NOW, 15).st, 'soon', '15 天窗口应含边界当天');
  assert.strictEqual(calc.validState(c15, NOW, 0).st, 'ok', '窗口非法（0）回落到默认 7 天，15 天仍算有效');
});

test('todayTodos: 窗口变大时更多渠道进入「将到期」，已过期/待补全不受影响', () => {
  const chs = [
    { id: 'a', name: '已过期', validUntil: '2026-10-20', dests: '美西' },
    { id: 'b', name: '5天后', validUntil: '2026-11-03', dests: '美西' },
    { id: 'c', name: '15天后', validUntil: '2026-11-13', dests: '美东' },
    { id: 'd', name: '40天后', validUntil: '2026-12-08', dests: '美东' },
    { id: 'e', name: '没目的地', validUntil: '2026-12-31', dests: '' }
  ];
  const w7 = calc.todayTodos(chs, NOW, 7);
  assert.deepStrictEqual(w7.over.map(c => c.id), ['a']);
  assert.deepStrictEqual(w7.soon.map(c => c.id), ['b']);
  assert.deepStrictEqual(w7.noDest.map(c => c.id), ['e']);

  const w30 = calc.todayTodos(chs, NOW, 30);
  assert.deepStrictEqual(w30.over.map(c => c.id), ['a'], '已过期不受窗口影响');
  assert.deepStrictEqual(w30.soon.map(c => c.id), ['b', 'c'], '30 天窗口应多出 15 天这条，且按天数升序');
  assert.deepStrictEqual(w30.noDest.map(c => c.id), ['e']);

  const w60 = calc.todayTodos(chs, NOW, 60);
  assert.deepStrictEqual(w60.soon.map(c => c.id), ['b', 'c', 'd']);
});

test('dueChannels: 跟随窗口，把「该更新报价」的渠道一起放大', () => {
  const chs = [
    { id: 'a', name: '已过期', validUntil: '2026-10-20' },
    { id: 'c', name: '15天后', validUntil: '2026-11-13' }
  ];
  assert.deepStrictEqual(calc.dueChannels(chs, NOW, 7).map(c => c.id), ['a']);
  assert.deepStrictEqual(calc.dueChannels(chs, NOW, 30).map(c => c.id), ['a', 'c']);
});

test('homeVM: todoDays 透传，待办与统计卡一起跟随', () => {
  const state = {
    channels: [
      { id: 'a', name: '已过期', validUntil: '2026-10-20', dests: '美西', createdAt: '2026-10-01' },
      { id: 'c', name: '15天后', validUntil: '2026-11-13', dests: '美东', createdAt: '2026-10-02' }
    ],
    records: []
  };
  const vm7 = global.App.pages.home.homeVM(state, { todoDays: 7, updateDays: 7 });
  assert.strictEqual(vm7.todoDays, 7);
  assert.strictEqual(vm7.todos.soon.length, 0);

  const vm30 = global.App.pages.home.homeVM(state, { todoDays: 30, updateDays: 7 });
  assert.strictEqual(vm30.todoDays, 30);
  assert.deepStrictEqual(vm30.todos.soon.map(c => c.id), ['c']);
  assert.ok(vm30.summaries.expiring >= 1, '统计卡应把窗口内的渠道算进快到期');
});

/* ============ 首页 UI ============ */

test('首页今日待办：有「显示 N 天内到期」按钮与统计条', async () => {
  const ok = await waitFor(() => global.App.store && global.App.store.instance);
  assert.ok(ok, '应完成 store 初始化');
  const store = global.App.store.instance;
  for (const c of store.getState().channels.slice()) await store.deleteChannel(c.id);

  await store.upsertChannel({ name: '窗口A', carrier: '436', dests: '美西', type: 'sea', validUntil: calc.shiftDay(15) });
  await store.upsertChannel({ name: '窗口B', carrier: '436', dests: '美东', type: 'sea', validUntil: calc.shiftDay(40) });
  await store.upsertChannel({ name: '过期C', carrier: '436', dests: '美中', type: 'sea', validUntil: calc.shiftDay(-3) });
  await store.updateSettings({ todoDays: 7 });

  global.App.router.show('home');
  const content = dom.ids.content;
  const winBtn = findAll(content, n => n.tagName === 'BUTTON').find(b => /显示 \d+ 天内到期/.test(b.textContent));
  assert.ok(winBtn, '待办卡片应有「显示 N 天内到期」按钮');
  assert.strictEqual(winBtn.textContent, '显示 7 天内到期', '按钮应回显当前窗口');
  assert.ok(content.textContent.indexOf('显示 7 天内到期（截至') >= 0, '应有窗口统计条');
  assert.ok(content.textContent.indexOf('已过期 1') >= 0, '统计条应含已过期条数');
  assert.ok(content.textContent.indexOf('将到期 0') >= 0, '7 天窗口内没有临期渠道');
});

test('右上角弹窗：改为 30 天后统计同步，保存后首页刷新', async () => {
  const store = global.App.store.instance;
  const content = dom.ids.content;
  const winBtn = findAll(content, n => n.tagName === 'BUTTON').find(b => /显示 \d+ 天内到期/.test(b.textContent));
  winBtn.click();

  const overlays = findAll(dom.doc.body, n => /modal-overlay/.test(n.className || ''));
  const overlay = overlays[overlays.length - 1];
  assert.ok(overlay, '应弹出到期提醒范围弹窗');
  assert.ok(overlay.textContent.indexOf('设置到期提醒范围') >= 0, '应有弹窗标题');
  assert.ok(overlay.textContent.indexOf('显示多少天内到期') >= 0, '应有天数输入');

  const dayInp = findBy(overlay, n => /todo-days/.test(n.className || ''));
  assert.ok(dayInp, '应有序号输入框');
  assert.strictEqual(dayInp.value, '7');

  const chip30 = findAll(overlay, n => n.tagName === 'BUTTON').find(b => b.textContent === '30 天');
  assert.ok(chip30, '应有 30 天快捷按钮');
  chip30.click();
  assert.strictEqual(dayInp.value, '30', '快捷按钮应写入输入框');

  const statBox = findBy(overlay, n => /todo-stat/.test(n.className || ''));
  assert.ok(statBox, '应有实时统计');
  assert.ok(statBox.textContent.indexOf('将到期 1 条') >= 0, '30 天窗口应把 15 天那条算进将到期');
  assert.ok(statBox.textContent.indexOf('已过期 1 条') >= 0);
  const rangeBox = findBy(overlay, n => /upd-date/.test(n.className || ''));
  assert.ok(rangeBox.textContent.indexOf(calc.shiftDay(30)) >= 0, '应回显截至日期');

  const saveBtn = findAll(overlay, n => n.tagName === 'BUTTON').find(b => b.textContent === '保存');
  saveBtn.click();
  await new Promise(r => setTimeout(r, 30));

  assert.strictEqual(store.getSettings().todoDays, 30, '应记住 30 天窗口');
  const after = dom.ids.content.textContent;
  assert.ok(after.indexOf('显示 30 天内到期') >= 0, '首页按钮应刷新为 30 天');
  assert.ok(after.indexOf('将到期 1') >= 0, '首页统计条应显示 1 条将到期');
});

test('直接输入天数：非法值不影响保存结果，序号越界被裁剪', async () => {
  const store = global.App.store.instance;
  global.App.router.show('home');
  const content = dom.ids.content;
  const winBtn = findAll(content, n => n.tagName === 'BUTTON').find(b => /显示 \d+ 天内到期/.test(b.textContent));
  winBtn.click();
  const overlays = findAll(dom.doc.body, n => /modal-overlay/.test(n.className || ''));
  const overlay = overlays[overlays.length - 1];
  const dayInp = findBy(overlay, n => /todo-days/.test(n.className || ''));

  dayInp.value = '9999';
  dayInp.dispatch('input');
  const saveBtn = findAll(overlay, n => n.tagName === 'BUTTON').find(b => b.textContent === '保存');
  saveBtn.click();
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(store.getSettings().todoDays, 365, '超过 365 应被裁剪为 365');

  global.App.router.show('home');
  assert.ok(dom.ids.content.textContent.indexOf('显示 365 天内到期') >= 0, '首页应显示 365 天');
});
