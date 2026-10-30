/* 报价表覆盖范围（v2.22）
 *
 * 现象：269 这类货代下有一批「只有小货 / 只有箱型价」的渠道
 *      （文件封 0.5-1kg、PAK 5kg 起、小箱/中箱/大箱 11kg 起、空派小货 12kg 起），
 *      报价表最后一档 wMax 写的是 null，系统就当成「无限重都这个价」：
 *      查 100kg 时文件封照样报 154.75 元，比所有大货渠道都便宜，直接排到第一。
 *
 * 另一处同源问题：air/sea 渠道的重档价存在 wTiers 里，但计价只读 tiers，
 *      269「美国FedEx空快」这类渠道被算成 0 元（比 154.75 更离谱）。
 *
 * 期望：
 *  1) 单价表（tiers，¥/kg）末档封顶 → 超出末档不报价，不再回退首档价；
 *  2) 整票价表（wTiers，¥/票）末档 wMax 为空只表示「最后一档没写上界」，
 *     覆盖到「末档起点 + 一个末档步长」为止，超出不报价；
 *  3) air/sea 也要认 wTiers，按整票价落档，不能乘重量也不能算成 0；
 *  4) 比价页把不报价的渠道剔除，并如实提示「另有 N 条报价表不覆盖这个重量」。
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

/* 269 的真实结构（data.json 摘录）：
 *  - 文件封：0.5-1kg 116.83，1kg 以上 154.75（末档 wMax 为 null）
 *  - PAK：0.5-1 … 4.5-5，5kg 以上 540.48
 *  - 小箱：0.5-1 … 10.5-11，11kg 以上 1051.48
 *  - 美国FedEx空快：type=air，重档价同样存在 wTiers 里（末档 20kg 起 1818.63）
 */
const FILE_ENVELOPE = [
  { wMin: 0.5, wMax: 1, price: 116.83 },
  { wMin: 1, wMax: null, price: 154.75 }
];
const PAK = [
  { wMin: 4.5, wMax: 5, price: 500.51 },
  { wMin: 5, wMax: null, price: 540.48 }
];
const SMALL_BOX = [
  { wMin: 10.5, wMax: 11, price: 1009.14 },
  { wMin: 11, wMax: null, price: 1051.48 }
];

function ch269(name, type, tiers, extra) {
  return Object.assign({ id: name, carrier: '269', name: name, dests: '美国', country: '美国', type: type, wTiers: tiers }, extra || {});
}

/* ============ 1. 整票价表：末档开放不等于无限重 ============ */

test('整票价表：末档 wMax 为空时只覆盖「末档起点 + 一个步长」', () => {
  const C = global.App.calc;
  assert.strictEqual(C.tierTotalForWeight(FILE_ENVELOPE, 0.8), 116.83, '0.8kg 落 0.5-1 档');
  assert.strictEqual(C.tierTotalForWeight(FILE_ENVELOPE, 1.2), 154.75, '1.2kg 落 1kg 以上那一档');
  assert.strictEqual(C.tierTotalForWeight(FILE_ENVELOPE, 1.5), null, '文件封 1.5kg 以上没有报价');
  assert.strictEqual(C.tierTotalForWeight(FILE_ENVELOPE, 100), null, '文件封不可能报 100kg');

  assert.strictEqual(C.tierTotalForWeight(PAK, 5.4), 540.48, 'PAK 5.4kg 落末档');
  assert.strictEqual(C.tierTotalForWeight(PAK, 5.6), null, 'PAK 只报到 5.5kg');

  assert.strictEqual(C.tierTotalForWeight(SMALL_BOX, 11.5), null, '小箱只报到 11.5kg');
});

test('整票价表：末档写了明确上限的，超出同样不报价', () => {
  const C = global.App.calc;
  const t = [{ wMin: 0.5, wMax: 1, price: 98.9 }, { wMin: 1, wMax: 2, price: 134.38 }];
  assert.strictEqual(C.tierTotalForWeight(t, 1.5), 134.38);
  assert.strictEqual(C.tierTotalForWeight(t, 2), null, '上限 2kg，2kg 已经超出');
});

test('整票价表：不足首档仍按首档（小包惯例不动）', () => {
  const C = global.App.calc;
  assert.strictEqual(C.tierTotalForWeight(FILE_ENVELOPE, 0.3), 116.83);
});

/* ============ 2. 单价表：末档封顶后不能回退首档价 ============ */

test('单价表：超出末档封顶返回 null，不再拿首档价顶上', () => {
  const C = global.App.calc;
  // 623「美国直邮小包-普货」：0.5-2kg 126、2-5kg 108，5kg 以上没有价
  const t = [{ wMin: 0.5, wMax: 2, price: 126 }, { wMin: 2, wMax: 5, price: 108 }];
  assert.strictEqual(C.tierPriceForWeight(t, 1), 126);
  assert.strictEqual(C.tierPriceForWeight(t, 3), 108);
  assert.strictEqual(C.tierPriceForWeight(t, 20), null, '20kg 不在小包表的报价范围内');
  assert.strictEqual(C.tierPriceForWeight(t, 0.3), 126, '不足首档按首档');
});

test('单价表：末档开放（wMax 为 null）依然无限覆盖，正常大货渠道不受影响', () => {
  const C = global.App.calc;
  const t = [{ wMin: 12, wMax: 51, price: 68 }, { wMin: 51, wMax: null, price: 65 }];
  assert.strictEqual(C.tierPriceForWeight(t, 300), 65, '300kg 仍按 65¥/kg');
});

/* ============ 3. computeQuote：不覆盖就不出价 ============ */

test('computeQuote：269 文件封查 100kg 直接不报价（不是 154.75）', () => {
  const C = global.App.calc;
  const r = C.computeQuote(ch269('文件封 ID：26185', 'express', FILE_ENVELOPE), { weight: 100, pcs: 1 });
  assert.strictEqual(r.noQuote, true, '应标记为不报价');
  assert.strictEqual(r.total, 0, '不能拿小货价凑出一个总价');
  assert.match(r.quoteNote, /1\.5/, '说明里要写清报价表只到多重，实际：' + r.quoteNote);
});

test('computeQuote：269 文件封查 1.2kg 照常报价 154.75', () => {
  const C = global.App.calc;
  const r = C.computeQuote(ch269('文件封 ID：26185', 'express', FILE_ENVELOPE), { weight: 1.2, pcs: 1 });
  assert.strictEqual(r.total, 154.75);
  assert.ok(!r.noQuote);
});

test('computeQuote：air 渠道的重档价存在 wTiers 里时要按整票价算，不能是 0 元', () => {
  const C = global.App.calc;
  const fed = ch269('美国FedEx空快-标准FED', 'air', [
    { wMin: 19.5, wMax: 20, price: 1781.45 },
    { wMin: 20, wMax: null, price: 1818.63 }
  ]);
  const r = C.computeQuote(fed, { weight: 20, pcs: 1 });
  assert.strictEqual(r.base, 1818.63, 'base 应取 20kg 档整票价，实际 ' + r.base);
  assert.strictEqual(r.total, 1818.63);
  assert.match(r.mode, /重量档整票价/, '要说明是按整票价落档');
  assert.strictEqual(r.cw, 20);
});

test('computeQuote：单价表封顶的小包渠道超重不出价', () => {
  const C = global.App.calc;
  const ch = { id: 'p', carrier: '623', type: 'air', name: '美国直邮小包-普货', dests: '美国', country: '美国',
    tiers: [{ wMin: 0.5, wMax: 2, price: 126 }, { wMin: 2, wMax: 5, price: 108 }] };
  assert.strictEqual(C.computeQuote(ch, { weight: 3 }).total, 324, '3kg 正常：108×3');
  const over = C.computeQuote(ch, { weight: 20 });
  assert.strictEqual(over.noQuote, true, '20kg 超出小包表，应不报价');
  assert.strictEqual(over.total, 0);
});

test('computeQuote：不报价的渠道不能因为 minCharge/燃油等再算出一个价', () => {
  const C = global.App.calc;
  const ch = ch269('文件封 ID：26185', 'express', FILE_ENVELOPE, { minCharge: 50, fuel: 20, regFee: 30 });
  const r = C.computeQuote(ch, { weight: 100 });
  assert.strictEqual(r.total, 0, '燃油/挂号费也不能把不报价的渠道救回来');
  assert.strictEqual(r.fuel, 0);
});

/* ============ 4. 比价页：剔除 + 提示 ============ */

function shopChannels() {
  return [
    // 只有小货/箱型价的三条（269）
    ch269('文件封 ID：26185', 'express', FILE_ENVELOPE),
    ch269('文件&防水袋=PAK=26161', 'express', PAK),
    ch269('包裹&纸箱= 小箱=ID26162', 'express', SMALL_BOX),
    // 真正能做 20kg 的两条
    ch269('美国FedEx空快-标准FED', 'air', [
      { wMin: 19.5, wMax: 20, price: 1781.45 },
      { wMin: 20, wMax: null, price: 1818.63 }
    ]),
    { id: 'sea', carrier: '631', type: 'sea', name: '包税卡派-洛杉矶', dests: '美国', country: '美国', priceKg: 12 }
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
  return { content, dest, weight, run, cards };
}

test('比价页：只有小货价的渠道不参与 20kg 比价，并提示条数与原因', async () => {
  assert.ok(await waitFor(() => global.App.store && global.App.store.instance), '应完成 store 初始化');
  const p = openFreight(shopChannels());
  p.dest.value = '美国';
  p.weight.value = '20';
  p.run();

  const names = p.cards().map(c => String(findBy(c, n => /qc-name/.test(n.className || '')).textContent).replace(/★最便宜$/, '').trim());
  assert.deepStrictEqual(names.sort(), ['包税卡派-洛杉矶', '美国FedEx空快-标准FED'].sort(),
    '20kg 只该剩这两条，实际：' + names.join('、'));

  const tip = findAll(p.content, n => /range-tip/.test(n.className || ''));
  assert.strictEqual(tip.length, 1, '应有一条「报价表不覆盖」的提示');
  assert.match(tip[0].textContent, /3/, '提示里要写清是 3 条，实际：' + tip[0].textContent);
  assert.match(tip[0].textContent, /小货|箱型|报价表/, '提示要说清为什么没算，实际：' + tip[0].textContent);
});

test('比价页：全部渠道都不覆盖该重量时，要说清是「没有这个重量的报价」', async () => {
  const p = openFreight([ch269('文件封 ID：26185', 'express', FILE_ENVELOPE)]);
  p.dest.value = '美国';
  p.weight.value = '50';
  p.run();
  assert.strictEqual(p.cards().length, 0);
  const box = p.content.textContent;
  assert.match(box, /50kg|50000/, '要提到本次重量');
  assert.match(box, /报价表|不覆盖|只到/, '要说明这些渠道的报价表不覆盖，而不是「没有匹配的渠道」');
});

test('比价页：同一条渠道在覆盖范围内仍然正常出卡', async () => {
  const p = openFreight([ch269('文件封 ID：26185', 'express', FILE_ENVELOPE)]);
  p.dest.value = '美国';
  p.weight.value = '1.2';
  p.run();
  assert.strictEqual(p.cards().length, 1, '1.2kg 在文件封报价范围内，应出卡');
});
