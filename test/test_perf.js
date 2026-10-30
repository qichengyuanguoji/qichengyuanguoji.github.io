/* 大数据量下的性能回归：
 * 1) 落盘体积：工作副本用紧凑 JSON，不再 pretty-print（少一半字节）
 * 2) 批量写：合并同一时刻的多次保存；批量删除/批量编辑只落盘一次
 * 3) 首页「今日待办」：导入上千条后待办可能几千条，只渲染前 N 条（可展开）
 * 4) 运费比价：匹配几百条时只渲染前 N 张卡片（按总价升序，最便宜的都在前面）
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
  srcs.forEach(src => vm.runInThisContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), { filename: src }));
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

/* ============ 1. 落盘体积 ============ */

test('fsio.serialize：工作副本用紧凑 JSON（不再 pretty-print）', () => {
  const data = { version: 1, channels: [{ id: 'a', name: '甲', tiers: [{ wMin: 0, price: 1 }] }], records: [] };
  const txt = global.App.fsio.serialize(data);
  assert.ok(txt.indexOf('\n') < 0, '不应有换行缩进');
  assert.strictEqual(txt, JSON.stringify(data), '应等于紧凑序列化结果');
  assert.deepStrictEqual(JSON.parse(txt), data, '应可无损往返');
});

test('fsio.write 落盘内容与 serialize 一致（绑定文件时）', async () => {
  let written = '';
  const handle = {
    name: 'data.json',
    getFile: async () => ({ text: async () => written }),
    createWritable: async () => ({ write: async (t) => { written += t; }, close: async () => {} })
  };
  global.App.db.getHandle = async () => handle;
  const p = await global.App.fsio.createFsPersistence();
  const data = { version: 1, channels: [{ id: 'a', name: '甲' }], records: [] };
  await p.write(data);
  assert.strictEqual(written, global.App.fsio.serialize(data));
  global.App.db.getHandle = async () => null;
});

/* ============ 2. 批量写 ============ */

function makeStore(opt) {
  let writes = 0;
  const persistence = {
    read: async () => null,
    write: async () => { writes++; if (opt && opt.delay) await new Promise(r => setTimeout(r, opt.delay)); }
  };
  const store = global.App.store.createStore(persistence);
  return { store, writes: () => writes };
}

test('store.save：同一时刻的多次保存合并成更少的写盘', async () => {
  const { store, writes } = makeStore({ delay: 5 });
  await store.load();
  await Promise.all([store.save(), store.save(), store.save(), store.save()]);
  assert.ok(writes() <= 2, '并发保存应合并，实际写盘 ' + writes() + ' 次');
});

test('store.deleteChannels：批量删除只落盘一次', async () => {
  const { store, writes } = makeStore();
  await store.load();
  const list = [];
  for (let i = 0; i < 200; i++) {
    list.push({ id: 'c' + i, name: '渠道' + i, dests: '美西', type: 'sea', priceKg: 10 });
  }
  store.getState().channels = list;
  const before = writes();
  const n = await store.deleteChannels(list.slice(0, 100).map(c => c.id));
  assert.strictEqual(n, 100);
  assert.strictEqual(store.getState().channels.length, 100);
  assert.strictEqual(writes() - before, 1, '200 条里删 100 条不应逐条落盘');
});

test('store.updateChannels：批量改 200 条也只落盘一次', async () => {
  const { store, writes } = makeStore();
  await store.load();
  const list = [];
  for (let i = 0; i < 200; i++) list.push({ id: 'u' + i, name: '渠道' + i, dests: '美西', type: 'sea', priceKg: 10 });
  store.getState().channels = list;
  const before = writes();
  const n = await store.updateChannels(list.map(c => c.id), { carrier: '999' });
  assert.strictEqual(n, 200);
  assert.strictEqual(writes() - before, 1);
  assert.ok(store.getState().channels.every(c => c.carrier === '999'));
});

/* ============ 3. 首页待办只渲染前 N 条 ============ */

test('首页今日待办：几千条待办时只渲染前 N 条，点「显示全部」才全渲染', async () => {
  assert.ok(global.App.pages.home.TODO_LIMIT > 0, '应导出待办渲染上限');
  const LIMIT = global.App.pages.home.TODO_LIMIT;
  const ok = await waitFor(() => global.App.store && global.App.store.instance);
  assert.ok(ok, '应完成 store 初始化');
  const store = global.App.store.instance;
  for (const c of store.getState().channels.slice()) await store.deleteChannel(c.id);

  // 造 120 条「将到期」渠道（导入价格表后的典型状态：有效期止 = 导入日 + 7 天）
  const bulk = [];
  for (let i = 0; i < 120; i++) {
    bulk.push({ name: '压测线' + i, carrier: '436', dests: '美西', type: 'sea', priceKg: 10, validUntil: global.App.calc.shiftDay(3) });
  }
  store.getState().channels = bulk;
  await store.updateSettings({ todoDays: 7 });

  global.App.router.show('home');
  const content = dom.ids.content;
  const items = () => findAll(content, n => /todo-item/.test(n.className || ''));
  assert.ok(items().length <= LIMIT, '待办行数应被限制在 ' + LIMIT + ' 条，实际 ' + items().length);
  assert.ok(content.textContent.indexOf('共 120 条') >= 0, '应提示待办总数');

  const moreBtn = findAll(content, n => n.tagName === 'BUTTON').find(b => /显示全部|展开/.test(b.textContent));
  assert.ok(moreBtn, '应有「显示全部」按钮');
  moreBtn.click();
  global.App.router.show('home');
  const items2 = () => findAll(dom.ids.content, n => /todo-item/.test(n.className || ''));
  assert.strictEqual(items2().length, 120, '展开后应渲染全部 120 条');
});

/* ============ 4. 运费比价只渲染前 N 张卡片 ============ */

test('运费比价：匹配上百条渠道时只渲染前 N 张卡片（按总价升序）', async () => {
  assert.ok(global.App.pages.freight.MAX_CARDS > 0, '应导出比价卡片渲染上限');
  const LIMIT = global.App.pages.freight.MAX_CARDS;
  const store = global.App.store.instance;
  for (const c of store.getState().channels.slice()) await store.deleteChannel(c.id);
  const bulk = [];
  for (let i = 0; i < 100; i++) {
    bulk.push({ name: '比价线' + i, carrier: '436', dests: '美国', type: 'sea', priceKg: 8 + i, validUntil: global.App.calc.shiftDay(30) });
  }
  store.getState().channels = bulk;

  global.App.router.show('freight');
  const content = dom.ids.content;
  const dest = findBy(content, n => n.tagName === 'INPUT' && /如 US/.test(n.placeholder || ''));
  const weight = findBy(content, n => n.tagName === 'INPUT' && /实重/.test(n.placeholder || ''));
  assert.ok(dest && weight, '应有目的地与实重输入框');
  dest.value = '美国';
  weight.value = '10';
  findAll(content, n => n.tagName === 'BUTTON').find(b => b.textContent === '开始试算比价').click();

  const cards = () => findAll(dom.ids.content, n => /quote-card/.test(n.className || ''));
  assert.ok(cards().length <= LIMIT, '卡片数应被限制在 ' + LIMIT + '，实际 ' + cards().length);
  assert.ok(dom.ids.content.textContent.indexOf('共 100 个渠道可比') >= 0, '比价小结应给出全部匹配数');
  const moreBtn = findAll(dom.ids.content, n => n.tagName === 'BUTTON').find(b => /显示全部|展开/.test(b.textContent));
  assert.ok(moreBtn, '应有「显示全部」按钮');
  moreBtn.click();
  assert.strictEqual(cards().length, 100, '展开后应渲染全部 100 张');
});
