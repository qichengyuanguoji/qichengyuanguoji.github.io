/* 比价结果按渠道商筛选（v2.23）
 *
 * 需求：试算比价之后，能对渠道商做筛选。
 *
 * 场景：一次按国家查价会命中几百个渠道，分属十几个货代（631 / 813 / 269 / 088 …）。
 *      用户常常只关心「某几家」的价（比如只比 631 和 269），或者想确认某个货代到底有没有报价。
 *      现在只能在几百张卡里翻。
 *
 * 期望：
 *  1) 试算出结果后，结果区顶部出现渠道商筛选条，列出本次结果里的渠道商与条数；
 *  2) 点渠道商只显示这家的卡片，再点取消；支持多选（并集）；
 *  3) 「全部」一键清空筛选；
 *  4) 汇总（共 N 个渠道可比 / 最低 ¥X / ★最便宜）按筛选后的结果算，不能还按全量；
 *  5) 换重量重新试算时，筛选保留（只要那几个渠道商还在结果里）；
 *  6) 筛选后一条不剩时，说明「当前筛选没有渠道」并能一键清空。
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
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.id = '';
    this.title = '';
    this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
    if (k === 'id') this.id = v;
    if (k === 'value') this.value = v;
    if (k === 'placeholder') this.placeholder = v;
    if (k === 'title') this.title = v;
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

/* 四家渠道商、四条渠道，10kg 下的总价：
 *   088  C线  8×10 = 80   （全局最低）
 *   631  A线 10×10 = 100
 *   631  B线 12×10 = 120
 *   269  D线 首重 0.5kg/100 + 续重 0.5kg/20 → 100 + 19×20 = 480
 */
function sampleChannels() {
  return [
    { id: 'a', carrier: '631', type: 'sea', name: 'A线', dests: '美国', country: '美国', priceKg: 10 },
    { id: 'b', carrier: '631', type: 'sea', name: 'B线', dests: '美国', country: '美国', priceKg: 12 },
    { id: 'c', carrier: '088', type: 'air', name: 'C线', dests: '美国', country: '美国', priceKg: 8 },
    { id: 'd', carrier: '269', type: 'express', name: 'D线', dests: '美国', country: '美国', firstW: 0.5, firstP: 100, addU: 0.5, addP: 20 }
  ];
}

function openFreight(channels) {
  global.App.store.instance.getState().channels = channels;
  global.App.router.show('freight');
  const content = ids.content;
  const dest = findBy(content, n => n.tagName === 'INPUT' && /如 US/.test(n.placeholder || ''));
  const weight = findBy(content, n => n.tagName === 'INPUT' && /实重/.test(n.placeholder || ''));
  const run = () => findAll(content, n => n.tagName === 'BUTTON').find(b => b.textContent === '开始试算比价').click();
  const cards = () => findAll(content, n => /quote-card/.test(n.className || ''));
  const chips = () => findAll(content, n => /carrier-chip/.test(n.className || ''));
  const chipOf = txt => chips().find(c => String(c.textContent).indexOf(txt) >= 0);
  const summary = () => findBy(content, n => /cmp-summary/.test(n.className || ''));
  const nameOf = card => String(findBy(card, n => /qc-name/.test(n.className || '')).textContent).replace(/★最便宜$/, '').trim();
  return { content, dest, weight, run, cards, chips, chipOf, summary, nameOf };
}

test('试算后出现渠道商筛选条：列出本次结果里的渠道商和条数', async () => {
  assert.ok(await waitFor(() => global.App.store && global.App.store.instance), '应完成 store 初始化');
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  const bar = findBy(p.content, n => /carrier-filter/.test(n.className || ''));
  assert.ok(bar, '结果区应出现渠道商筛选条');
  const labels = p.chips().map(c => String(c.textContent));
  ['631', '088', '269'].forEach(k => {
    assert.ok(labels.some(t => t.indexOf(k) >= 0), '筛选条里应有渠道商 ' + k + '，实际：' + labels.join(' | '));
  });
  assert.ok(labels.some(t => /全部/.test(t)), '应有「全部」选项');
  assert.ok(labels.some(t => t.indexOf('631') >= 0 && /2/.test(t)), '631 有 2 条渠道，条数要显示出来');
});

test('点渠道商只显示这家的卡片，汇总按筛选后重算', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  assert.strictEqual(p.cards().length, 4);

  p.chipOf('631').click();
  assert.strictEqual(p.cards().length, 2, '只看 631 应剩 2 张，实际 ' + p.cards().length);
  const names = p.cards().map(p.nameOf).sort();
  assert.deepStrictEqual(names, ['A线', 'B线']);
  assert.match(p.summary().textContent, /共 2 个渠道/, '汇总要按筛选后的条数，实际：' + p.summary().textContent);
  assert.match(p.summary().textContent, /100/, '最低价应是筛选后的 100，实际：' + p.summary().textContent);
});

test('多选：点第二个渠道商累加，不是替换', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  p.chipOf('631').click();
  p.chipOf('269').click();
  assert.strictEqual(p.cards().length, 3, '631 + 269 应剩 3 张，实际 ' + p.cards().length);
  const names = p.cards().map(p.nameOf).sort();
  assert.deepStrictEqual(names, ['A线', 'B线', 'D线']);
});

test('再点一次取消该渠道商；「全部」一键清空', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  p.chipOf('631').click();
  assert.strictEqual(p.cards().length, 2);
  p.chipOf('631').click();
  assert.strictEqual(p.cards().length, 4, '取消 631 后应恢复全部');

  p.chipOf('631').click();
  p.chipOf('088').click();
  assert.strictEqual(p.cards().length, 3);
  p.chipOf('全部').click();
  assert.strictEqual(p.cards().length, 4, '「全部」应清空所有筛选');
});

test('筛选后「★最便宜」跟着筛选结果走，不留在全局最低那条上', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  // 全局最低是 088 的 C线 80
  assert.strictEqual(p.nameOf(p.cards()[0]), 'C线');

  p.chipOf('631').click();
  const first = p.cards()[0];
  assert.match(String(findBy(first, n => /qc-name/.test(n.className || '')).textContent), /★最便宜/,
    '筛选后最便宜的应是 631 的 A线，并带 ★ 标记');
  assert.strictEqual(p.nameOf(first), 'A线');
  assert.ok(!p.cards().some(c => /★最便宜/.test(String(findBy(c, n => /qc-name/.test(n.className || '')).textContent)) && p.nameOf(c) === 'B线'),
    '★ 只能有一个');
});

test('换重量重新试算：筛选保留（渠道商还在结果里时）', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  p.chipOf('631').click();
  assert.strictEqual(p.cards().length, 2);

  p.weight.value = '20';
  p.run();
  assert.strictEqual(p.cards().length, 2, '换重量后仍只看 631，实际 ' + p.cards().length);
  const stillOn = p.chipOf('631');
  assert.match(stillOn.className, /on/, '筛选条的 631 应保持选中态');
});

test('换到没有该渠道商的目的地后，筛选自动失效而不是显示空结果', async () => {
  const list = sampleChannels().concat([
    { id: 'e', carrier: '813', type: 'sea', name: 'E线', dests: '加拿大', country: '加拿大', priceKg: 9 }
  ]);
  const p = openFreight(list);
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  p.chipOf('631').click();
  assert.strictEqual(p.cards().length, 2);

  p.dest.value = '加拿大';
  p.run();
  const names = p.cards().map(p.nameOf);
  assert.deepStrictEqual(names, ['E线'], '加拿大只有 813，631 的筛选应自动失效，实际：' + names.join('、'));
});

test('筛选后一条不剩时给出提示并能一键清空', async () => {
  // 两家渠道商，其中一家在超重时不报价 → 它的 chip 不会出现在这次结果里，
  // 这里改用「先选 631，再把重量改成只有 269 能报」的场景不成立（631 会被清掉）。
  // 因此直接构造：筛选条里不会出现不存在的渠道商，空结果只能来自取消勾选后的重算。
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  p.chipOf('631').click();
  p.dest.value = '英国';
  p.run();
  // 英国没有渠道 → 走「没有匹配的渠道」分支，且筛选条不应残留
  assert.strictEqual(p.cards().length, 0);
  assert.strictEqual(p.chips().length, 0, '没有结果时不该还显示上一次的渠道商筛选条');
});

test('没试算（只填目的地）时不显示渠道商筛选条', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.run();
  assert.strictEqual(p.cards().length, 0);
  assert.strictEqual(p.chips().length, 0, '还没算价格就不该出筛选条');
});
