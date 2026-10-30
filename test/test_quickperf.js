/* 「渠道一多，快捷运费测算就特别卡」的性能回归（v2.17）
 *
 * 现象：导入几份大价目表（几千条渠道，且每条 dests 各不相同）后，
 *      首页「快捷运费测算」和「运费试算比价」都明显变卡。
 *
 * 定位到的四处放大器（本文件逐条钉住）：
 *  1) 首页快捷测算的目的地候选直接拿 c.dests 整串喂 datalist：
 *     「美国 芝加哥 1号仓 邮编90000-90036」这类整串每条唯一 → 几千个 <option>，
 *     既没法选（用户不会从这种长串里挑地区），又让首页每次渲染都建几千个节点。
 *  2) 首页同时为了「统计待办条数」和「渲染待办列表」把全部渠道算了两遍。
 *  3) 比价页 renderList() 先 computationAll 再判断「有没有填目的地」——
 *     没填目的地时全部渠道都算命中，进页面就先白算一遍全库。
 *  4) 用户点过「显示全部」后 showAllCards 永久为 true：之后每次试算都把
 *     几千张报价卡片全画出来（每张 10 来个节点）＝ 几万个 DOM 节点。
 *
 * 用最小 DOM 桩按 index.html 顺序加载全部脚本（与 test_perf 同套路）。
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

function findAll(node, pred, out) {
  out = out || [];
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}
function findBy(node, pred) {
  if (!node) return null;
  if (pred(node)) return node;
  for (const c of node.children || []) { const r = findBy(c, pred); if (r) return r; }
  return null;
}
function countNodes(n) { let k = 1; for (const c of n.children || []) k += countNodes(c); return k; }

const ids = {};
['content', 'conn-dot', 'conn-text', 'data-path', 'nav', 'toast'].forEach(id => { const n = new El('div'); n.id = id; ids[id] = n; });
const all = [];
global.window = {};
global.document = {
  readyState: 'complete',
  body: new El('body'),
  createElement: t => { const n = new El(t); all.push(n); return n; },
  createTextNode: t => { const n = new El('#text'); n.textContent = t; return n; },
  getElementById: id => ids[id] || all.filter(n => n.id === id).pop() || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {}
};

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const srcs = [];
const re = /<script src="([^"]+)"><\/script>/g;
let m;
while ((m = re.exec(html))) srcs.push(m[1]);
srcs.forEach(src => vm.runInThisContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), { filename: src }));

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) {
    if (fn()) return true;
    await new Promise(r => setTimeout(r, 5));
  }
  return false;
}

/* 造一份「大价目表导入后」的典型数据：
 * 5 个产品 × 200 个批次 × 5 个起运仓 = 5000 条，每条 dests 都是唯一的
 * 「美国 <城市> <批次>号仓 邮编9xxxx-9xxxx」（631 芝加哥系列的形态）。 */
function bigChannels(n) {
  n = n || 5000;
  const cities = ['芝加哥', '洛杉矶', '纽约', '休斯顿', '亚特兰大', '达拉斯', '西雅图', '迈阿密'];
  const origins = ['华南', '华东', '义乌', '青岛', '郑州'];
  const prods = ['包税卡派', '不包税卡派', '海派', '空派', '铁派'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const ci = i % 200;
    out.push({
      id: 'x' + i,
      name: prods[i % prods.length] + '-' + cities[ci % cities.length] + '-' + (i + 1),
      carrier: '436',
      dests: '美国 ' + cities[ci % cities.length] + ' ' + (i + 1) + '号仓 邮编' + (90000 + ci * 37) + '-' + (90036 + ci * 37),
      origin: origins[i % origins.length],
      type: 'sea',
      priceKg: 8 + (ci % 10) * 0.5
    });
  }
  return out;
}

// 重新渲染比价页（保证页面闭包拿到的是本轮造的数据，不沿用上一个用例的 DOM）
function openFreight() {
  global.App.router.show('freight');
  const content = ids.content;
  const dest = findBy(content, n => n.tagName === 'INPUT' && /如 US/.test(n.placeholder || ''));
  const weight = findBy(content, n => n.tagName === 'INPUT' && /实重/.test(n.placeholder || ''));
  const run = () => findAll(content, n => n.tagName === 'BUTTON')
    .find(b => b.textContent === '开始试算比价').click();
  const cards = () => findAll(content, n => /quote-card/.test(n.className || '')).length;
  return { dest, weight, run, cards };
}

/* ============ 1. 首页快捷测算：目的地候选不能随渠道数爆炸 ============ */

test('首页快捷测算：目的地候选不随渠道数线性增长（5000 条唯一 dests 也只需几十个候选）', async () => {
  assert.ok(await waitFor(() => global.App.store && global.App.store.instance), '应完成 store 初始化');
  const store = global.App.store.instance;
  store.getState().channels = bigChannels(5000);

  const t0 = Date.now();
  global.App.router.show('home');
  const cost = Date.now() - t0;

  const dl = all.filter(n => n.tagName === 'DATALIST').pop();
  assert.ok(dl, '首页应有目的地候选列表（datalist）');
  assert.ok(dl.children.length > 0, '应给出候选');
  assert.ok(dl.children.length <= 200,
    '候选数应受上限约束（当前 ' + dl.children.length + ' 个 option，5000 条渠道时不能逐个建）');
  // 整体节点数也要可控：几千个 option 是首页卡住的主因
  assert.ok(countNodes(ids.content) < 1200,
    '首页 DOM 节点应可控，实际 ' + countNodes(ids.content) + ' 个，耗时 ' + cost + 'ms');
});

test('首页快捷测算：候选是国家名，而不是整串目的地（v2.19 起只认国家）', async () => {
  const store = global.App.store.instance;
  const dl = all.filter(n => n.tagName === 'DATALIST').pop();
  assert.ok(dl, '应有 datalist');
  const vals = dl.children.map(o => String(o.getAttribute('value') || o.value || ''));
  assert.ok(vals.indexOf('美国') >= 0, '应识别出「美国」这类国家名，实际：' + vals.slice(0, 10).join('|'));
  assert.ok(vals.every(v => global.App.calc.isCountryName(v)),
    '候选必须全部是国家名，实际：' + vals.slice(0, 10).join('|'));
  assert.ok(!vals.some(v => v.length > 20),
    '不应把「美国 芝加哥 1号仓 邮编90000-90036」这种整串当候选');
  assert.ok(!vals.some(v => /\d/.test(v)), '候选中不应混入含数字的仓号/邮编片段');
});

/* ============ 2. 首页只遍历一遍渠道算待办 ============ */

test('首页：待办统计与待办列表复用同一次计算结果（不重复遍历全库）', async () => {
  const store = global.App.store.instance;
  store.getState().channels = bigChannels(3000);
  const orig = global.App.calc.todayTodos;
  let calls = 0;
  global.App.calc.todayTodos = function () { calls++; return orig.apply(null, arguments); };
  try {
    global.App.router.show('home');
  } finally {
    global.App.calc.todayTodos = orig;
  }
  assert.strictEqual(calls, 1, '首页一次渲染只应算一次今日待办，实际 ' + calls + ' 次');
});

/* ============ 3. 比价页：没填条件就别白算全库 ============ */

test('运费试算比价：未填目的地/重量时不计算任何报价', async () => {
  const store = global.App.store.instance;
  store.getState().channels = bigChannels(3000);
  const orig = global.App.calc.computeQuote;
  let calls = 0;
  global.App.calc.computeQuote = function () { calls++; return orig.apply(null, arguments); };
  try {
    global.App.router.show('freight');
  } finally {
    global.App.calc.computeQuote = orig;
  }
  assert.strictEqual(calls, 0, '没填目的地/重量时不该先算一遍全库报价，实际算了 ' + calls + ' 条');
  assert.ok(ids.content.textContent.indexOf('填写目的地后开始比价') >= 0, '应提示先填目的地');
});

test('运费试算比价：填了目的地才计算，且只算匹配上的', async () => {
  const store = global.App.store.instance;
  store.getState().channels = bigChannels(3000);
  const p = openFreight();
  assert.ok(p.weight, '应有实重输入框');
  const orig = global.App.calc.computeQuote;
  let calls = 0;
  global.App.calc.computeQuote = function () { calls++; return orig.apply(null, arguments); };
  try {
    p.dest.value = '美国';
    p.weight.value = '10';
    p.run();
  } finally {
    global.App.calc.computeQuote = orig;
  }
  assert.strictEqual(calls, 3000, '只算真正匹配上的 3000 条，实际 ' + calls);
  assert.ok(p.cards() > 0, '应渲染出报价卡片');
});

/* ============ 4. 「显示全部」必须有硬上限 ============ */

test('运费比价：点过「显示全部」后，几千条匹配也不能把卡片全画出来', async () => {
  const store = global.App.store.instance;
  store.getState().channels = bigChannels(2000);   // 2000 条全部命中「美国」
  const p = openFreight();
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  const first = p.cards();
  assert.ok(first > 0, '应渲染出报价卡片');
  assert.ok(first <= 60, '首屏卡片数应受上限约束，实际 ' + first);

  // 反复点「显示全部 / 再显示」若干次，卡片数必须有天花板
  for (let i = 0; i < 12; i++) {
    const btn = findAll(ids.content, n => n.tagName === 'BUTTON')
      .find(b => /显示全部|再显示|展开/.test(b.textContent));
    if (!btn) break;
    btn.click();
  }
  assert.ok(p.cards() <= 300,
    '连点「显示全部」后卡片数仍须有硬上限（300），实际 ' + p.cards());
  assert.ok(findAll(ids.content, n => /cmp-more/.test(n.className || '')).length > 0,
    '应保留收起 / 结果过多的提示');
});

test('运费比价：重新进页面时不沿用上次的「显示全部」', async () => {
  const store = global.App.store.instance;
  store.getState().channels = bigChannels(600);
  let p = openFreight();
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  // 先展开到最多
  for (let i = 0; i < 12; i++) {
    const btn = findAll(ids.content, n => n.tagName === 'BUTTON').find(b => /显示全部|再显示/.test(b.textContent));
    if (!btn) break;
    btn.click();
  }
  assert.ok(p.cards() >= 300, '展开后应到硬上限，实际 ' + p.cards());

  // 重新进页面 → 应回到首屏上限
  p = openFreight();
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  assert.ok(p.cards() <= 60, '重新进入页面后应回到首屏上限（60），实际 ' + p.cards());
});

/* ============ 5. 同一组输入不重复全库计算 ============ */

test('运费比价：同一组条件连点「开始试算」只算一遍（结果可复用）', async () => {
  const store = global.App.store.instance;
  store.getState().channels = bigChannels(1000);
  const p = openFreight();
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();                       // 第一次：真算

  const orig = global.App.calc.computeQuote;
  let calls = 0;
  global.App.calc.computeQuote = function () { calls++; return orig.apply(null, arguments); };
  try {
    p.run();                     // 再点一次同样的条件
    p.run();
  } finally {
    global.App.calc.computeQuote = orig;
  }
  assert.strictEqual(calls, 0, '同样的条件再点一次不该重算全库，实际又算了 ' + calls + ' 条');
  assert.ok(p.cards() > 0, '结果仍应正常显示');
});

test('运费比价：改了重量就要重算（不能拿旧结果糊弄）', async () => {
  const store = global.App.store.instance;
  store.getState().channels = bigChannels(1000);
  const p = openFreight();
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  const orig = global.App.calc.computeQuote;
  let calls = 0;
  global.App.calc.computeQuote = function () { calls++; return orig.apply(null, arguments); };
  try {
    p.weight.value = '55';
    p.run();
  } finally {
    global.App.calc.computeQuote = orig;
  }
  assert.strictEqual(calls, 1000, '换了重量应重算，实际算了 ' + calls + ' 条');
});
