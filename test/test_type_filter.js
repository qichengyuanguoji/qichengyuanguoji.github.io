/* 比价结果按渠道类型筛选（v2.27）
 *
 * 需求：比价时能直接点按钮筛「空运 / 海运 / 快递小包」；如果自己也不确定是什么类型，
 *      有一个「全部」= 不筛类型（看全部）。
 *
 * 场景：按「美国 + 20kg」查价会命中几百条渠道，海运卡派、空运、快递小包混在一起。
 *      用户常常心里已经知道要走哪一类（或想知道「如果走空运要多少钱」），
 *      只能一张张卡片看右上角的类型标签，没有任何办法过滤。
 *
 * 期望：
 *  1) 试算出结果后，结果区顶部（渠道商筛选条之前）出现「渠道类型」筛选条，
 *     含「全部」（默认选中）+ 本次结果里实际出现的类型与条数；
 *  2) 点类型只看这一类，再点一次取消回到「全部」；
 *  3) 与渠道商筛选叠加生效（类型 ∩ 渠道商）；
 *  4) 汇总「共 N 个渠道可比 / 最低 ¥X」、分页、★最便宜 都按筛选后的结果算；
 *  5) 换重量保留类型筛选；换目的地后该类不再存在时自动回到「全部」，不留空结果。
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

/* 10kg 下：
 *   088  C线  air      8×10 = 80      （全局最低）
 *   631  A线  sea     10×10 = 100
 *   631  B线  sea     12×10 = 120
 *   269  D线  express 首重 0.5kg/100 + 续重 19×20 = 480
 *   631  E线  air     日本 20×10 = 200（不匹配「美国」）
 */
function sampleChannels() {
  return [
    { id: 'a', carrier: '631', type: 'sea', name: 'A线', dests: '美国', country: '美国', priceKg: 10 },
    { id: 'b', carrier: '631', type: 'sea', name: 'B线', dests: '美国', country: '美国', priceKg: 12 },
    { id: 'c', carrier: '088', type: 'air', name: 'C线', dests: '美国', country: '美国', priceKg: 8 },
    { id: 'd', carrier: '269', type: 'express', name: 'D线', dests: '美国', country: '美国', firstW: 0.5, firstP: 100, addU: 0.5, addP: 20 },
    { id: 'e', carrier: '631', type: 'air', name: 'E线', dests: '日本', country: '日本', priceKg: 20 }
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
  const typeChips = () => findAll(content, n => /(^|\s)type-chip(\s|$)/.test(n.className || ''));
  const typeChipOf = txt => typeChips().find(c => String(c.textContent).indexOf(txt) >= 0);
  const carrierChips = () => findAll(content, n => /(^|\s)carrier-chip(\s|$)/.test(n.className || ''));
  const carrierChipOf = txt => carrierChips().find(c => String(c.textContent).indexOf(txt) >= 0);
  const summary = () => findBy(content, n => /cmp-summary/.test(n.className || ''));
  const nameOf = card => String(findBy(card, n => /qc-name/.test(n.className || '')).textContent).replace(/★最便宜$/, '').trim();
  const typeOf = card => String(findBy(card, n => /qc-type/.test(n.className || '')).textContent).trim();
  return { content, dest, weight, run, cards, typeChips, typeChipOf, carrierChips, carrierChipOf, summary, nameOf, typeOf };
}

test('试算后出现「渠道类型」筛选条：全部 + 本次出现的类型与条数', async () => {
  assert.ok(await waitFor(() => global.App.store && global.App.store.instance), '应完成 store 初始化');
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  const labels = p.typeChips().map(c => String(c.textContent));
  assert.ok(labels.length >= 4, '应有 4 个类型选项，实际：' + labels.join(' | '));
  assert.ok(labels.some(t => /全部/.test(t)), '应有「全部」选项');
  assert.ok(!labels.some(t => /暂不确定/.test(t)), '不应再出现「暂不确定」字样：' + labels.join(' | '));
  assert.ok(/^全部/.test(labels[0]), '「全部」应排在最前：' + labels.join(' | '));
  assert.ok(labels.some(t => /空运/.test(t)), '应有空运');
  assert.ok(labels.some(t => /海运/.test(t)), '应有海运');
  assert.ok(labels.some(t => /快递小包/.test(t)), '应有快递小包');
  // 条数要带上：海运 2、空运 1、快递小包 1
  assert.ok(labels.some(t => /海运/.test(t) && /2/.test(t)), '海运转 2 条：' + labels.join(' | '));
  assert.ok(labels.some(t => /空运/.test(t) && /1/.test(t)), '空运 1 条：' + labels.join(' | '));
  // 类型条在渠道商筛选条之前
  const bars = findAll(p.content, n => /(type-filter|carrier-filter)/.test(n.className || ''));
  assert.match(bars[0].className, /type-filter/, '类型筛选条应排在渠道商筛选条之前');
});

test('默认「全部」是选中态，且不筛任何渠道', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  assert.strictEqual(p.cards().length, 4);
  assert.match(p.typeChipOf('全部').className, /on/, '默认应选中「全部」');
});

test('点「空运」只显示空运渠道，汇总按筛选后重算', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  p.typeChipOf('空运').click();
  assert.strictEqual(p.cards().length, 1, '美国空运只有 C线，实际 ' + p.cards().length);
  assert.deepStrictEqual(p.cards().map(p.nameOf), ['C线']);
  assert.deepStrictEqual(p.cards().map(p.typeOf), ['空运']);
  assert.match(p.summary().textContent, /共 1 个渠道/, '实际：' + p.summary().textContent);
  assert.match(p.summary().textContent, /80/, '最低应是 80，实际：' + p.summary().textContent);
  assert.ok(!/(^|\s)on(\s|$)/.test(p.typeChipOf('全部').className), '选了类型后「全部」不应再是选中态');
});

test('再点一次同一类型取消，回到「全部」与全部渠道', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  p.typeChipOf('海运').click();
  assert.strictEqual(p.cards().length, 2);
  p.typeChipOf('海运').click();
  assert.strictEqual(p.cards().length, 4, '取消后应恢复全部，实际 ' + p.cards().length);
  assert.match(p.typeChipOf('全部').className, /on/);
});

test('点「全部」一键回到不筛类型', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  p.typeChipOf('快递小包').click();
  assert.strictEqual(p.cards().length, 1);
  p.typeChipOf('全部').click();
  assert.strictEqual(p.cards().length, 4, '「全部」应清空类型筛选');
});

test('类型筛选与渠道商筛选叠加生效（交集）', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  p.typeChipOf('海运').click();
  assert.strictEqual(p.cards().length, 2);
  p.carrierChipOf('631').click();
  assert.strictEqual(p.cards().length, 2, '海运 ∩ 631 = A/B 两条，实际 ' + p.cards().length);
  assert.deepStrictEqual(p.cards().map(p.nameOf).sort(), ['A线', 'B线']);

  // 换成空运：088 的 C线，631 在这类里没有渠道 → 渠道商筛选自动失效，不能留空结果
  p.typeChipOf('空运').click();
  assert.strictEqual(p.cards().length, 1, '空运里没有 631，应只剩 C线，实际 ' + p.cards().length);
  assert.deepStrictEqual(p.cards().map(p.nameOf), ['C线']);
});

test('★最便宜跟着筛选后的结果走', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  assert.strictEqual(p.nameOf(p.cards()[0]), 'C线', '全局最低是空运 C线');

  p.typeChipOf('海运').click();
  const first = p.cards()[0];
  assert.strictEqual(p.nameOf(first), 'A线', '海运里最低是 A线');
  assert.match(String(findBy(first, n => /qc-name/.test(n.className || '')).textContent), /★最便宜/);
  const starred = p.cards().filter(c => /★最便宜/.test(String(findBy(c, n => /qc-name/.test(n.className || '')).textContent)));
  assert.strictEqual(starred.length, 1, '★ 只能有一个');
});

test('换重量重新试算时保留类型筛选', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  p.typeChipOf('海运').click();
  assert.strictEqual(p.cards().length, 2);

  p.weight.value = '20';
  p.run();
  assert.strictEqual(p.cards().length, 2, '20kg 仍只看海运，实际 ' + p.cards().length);
  assert.match(p.typeChipOf('海运').className, /on/, '海运应保持选中');
});

test('换目的地后该类不存在时自动回到「全部」，不留空结果', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  p.typeChipOf('海运').click();
  assert.strictEqual(p.cards().length, 2);

  p.dest.value = '日本';
  p.run();
  const names = p.cards().map(p.nameOf);
  assert.deepStrictEqual(names, ['E线'], '日本只有空运 E线，海运筛选应自动失效，实际：' + names.join('、'));
  assert.match(p.typeChipOf('全部').className, /on/, '应回到「全部」');
});

test('没试算时不显示类型筛选条', async () => {
  const p = openFreight(sampleChannels());
  p.dest.value = '美国';
  p.run();
  assert.strictEqual(p.cards().length, 0);
  assert.strictEqual(p.typeChips().length, 0, '还没算价格就不该出类型筛选条');
});

test('没有类型字段的老渠道归为「未标注类型」，也能单选查看', async () => {
  const list = sampleChannels().concat([
    { id: 'f', carrier: '813', name: 'F线', dests: '美国', country: '美国', priceKg: 15 } // 没有 type
  ]);
  const p = openFreight(list);
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  assert.strictEqual(p.cards().length, 5, '全部 5 条，实际 ' + p.cards().length);
  const chip = p.typeChipOf('未标注类型');
  assert.ok(chip, '类型条应有「未标注类型」，实际：' + p.typeChips().map(c => c.textContent).join(' | '));

  chip.click();
  assert.strictEqual(p.cards().length, 1, '只剩未标注类型的 F线，实际 ' + p.cards().length);
  assert.deepStrictEqual(p.cards().map(p.nameOf), ['F线']);
  assert.match(p.summary().textContent, /未标注类型/, '汇总里应写明按「未标注类型」筛过，实际：' + p.summary().textContent);

  // 再点一次取消
  p.typeChipOf('未标注类型').click();
  assert.strictEqual(p.cards().length, 5);
});
