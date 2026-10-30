/* 报价卡片上的「渠道商」行（v2.20）
 *
 * 需求：试算比价时，在「计费重」前面加一行渠道商，把渠道商代码或名字打进去。
 *
 * 为什么单独立一个文件：卡片细节（行顺序、占位文案）以前没人盯，
 * 一改渲染就容易悄悄丢掉一行；这里把「渠道商」这一行的位置和取值钉死。
 *
 * 用最小 DOM 桩按 index.html 顺序加载全部脚本（与 test_quickperf 同套路）。
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

/* 三张卡片的典型情况：
 *  - 价目表按货代编号导入（carrier = 631，最常见的形态）
 *  - 手工/CSV 导入的货代有名字（carrier = 顺丰，carrierName = 顺丰国际）
 *  - 老数据可能根本没有渠道商字段 */
function sampleChannels() {
  return [
    { id: 'a', carrier: '631', type: 'sea', name: '包税卡派-芝加哥', dests: '美国 芝加哥', priceKg: 9 },
    { id: 'b', carrier: '顺丰', carrierName: '顺丰国际', type: 'express', name: '顺丰美国专线', dests: '美国 US', firstW: 0.5, firstP: 98, addU: 0.5, addP: 45 },
    { id: 'c', type: 'sea', name: '无渠道商海运', dests: '美国 洛杉矶', priceKg: 12 }
  ];
}

function openFreightWith(channels) {
  global.App.store.instance.getState().channels = channels;
  global.App.router.show('freight');
  const content = ids.content;
  const dest = findBy(content, n => n.tagName === 'INPUT' && /如 US/.test(n.placeholder || ''));
  const weight = findBy(content, n => n.tagName === 'INPUT' && /实重/.test(n.placeholder || ''));
  dest.value = '美国';
  weight.value = '10';
  findAll(content, n => n.tagName === 'BUTTON').find(b => b.textContent === '开始试算比价').click();
  const cards = findAll(content, n => /quote-card/.test(n.className || ''));
  const linesOf = card => findAll(card, n => /(^|\s)line(\s|$)/.test(n.className || ''));
  const textOf = el => String(el.textContent || '').replace(/\s+/g, '');
  return { cards, linesOf, textOf, content };
}

test('渠道商文案：有代码显示代码，有名字显示名字，都有就都显示，没有写「未标注」', () => {
  const C = global.App.calc;
  assert.strictEqual(C.carrierText({ carrier: '631' }), '631', '价目表按货代编号导入时应显示编号');
  assert.strictEqual(C.carrierText({ carrier: '顺丰' }), '顺丰', '渠道商是名字时直接显示名字');
  assert.strictEqual(C.carrierText({ carrier: '631', carrierName: '顺丰国际' }), '顺丰国际（631）',
    '名字和编号都有时应两者都给，便于对照价目表');
  assert.strictEqual(C.carrierText({ carrier: '  ' }), '未标注', '空值要明确写出来，不能留一行空白');
  assert.strictEqual(C.carrierText({ carrier: 'DHL', carrierName: 'DHL' }), 'DHL', '名字与编号相同时不要重复成「DHL（DHL）」');
  assert.strictEqual(C.carrierText(null), '未标注');
});

test('报价卡片：每张卡都有一行「渠道商」，且排在「计费重」前面', async () => {
  assert.ok(await waitFor(() => global.App.store && global.App.store.instance), '应完成 store 初始化');
  const p = openFreightWith(sampleChannels());
  assert.strictEqual(p.cards.length, 3, '应有 3 张报价卡片，实际 ' + p.cards.length);

  p.cards.forEach((card, i) => {
    const lines = p.linesOf(card);
    assert.ok(lines.length >= 2, '第 ' + (i + 1) + ' 张卡片应有多行明细');
    const keys = lines.map(l => p.textOf(findBy(l, n => n.tagName === 'SPAN')) || p.textOf(l).slice(0, 3));
    assert.strictEqual(p.textOf(findBy(lines[0], n => n.tagName === 'SPAN')), '渠道商',
      '第一行明细必须是「渠道商」，实际是「' + p.textOf(lines[0]).slice(0, 12) + '」');
    assert.ok(p.textOf(findBy(lines[1], n => n.tagName === 'SPAN')) === '计费重',
      '第二行明细必须紧跟「计费重」，实际是「' + keys[1] + '」');
  });
});

test('报价卡片：渠道商的值就是渠道上的代码/名字（不是卡片里的渠道名列）', async () => {
  const store = global.App.store.instance;
  const p = openFreightWith(sampleChannels());

  const carrierOf = card => {
    const lines = p.linesOf(card);
    const first = lines[0];
    const spans = findAll(first, n => n.tagName === 'SPAN');
    return p.textOf(spans[spans.length - 1]);
  };
  const nameOf = card => p.textOf(findBy(card, n => /qc-name/.test(n.className || ''))).replace(/★最便宜$/, '');

  const byName = {};
  p.cards.forEach(c => { byName[nameOf(c)] = carrierOf(c); });

  assert.strictEqual(byName['包税卡派-芝加哥'], '631', '按货代编号导入的渠道应显示编号');
  assert.strictEqual(byName['顺丰美国专线'], '顺丰国际（顺丰）', '带名字的渠道应显示名字（附编号）');
  assert.strictEqual(byName['无渠道商海运'], '未标注', '老数据没有渠道商时也要有占位文案');
});

test('报价卡片：渠道商为空不影响比价本身（价格与排序不变）', async () => {
  const p = openFreightWith(sampleChannels());
  const totals = p.cards.map(c => p.textOf(findBy(c, n => /qc-total/.test(n.className || ''))));
  assert.strictEqual(totals.length, 3);
  // 9 元/kg × 10kg = 90；98 + ceil(9.5/0.5)×45 = 953；12 × 10 = 120 → 升序
  assert.ok(p.textOf(p.cards[0]).indexOf('90') >= 0, '最便宜的应是 631 的 90 元，实际 ' + totals[0]);
  assert.strictEqual(p.cards.length, 3, '加一行明细不应改变卡片数量');
});
