/* 「查美国价格，却列出只做仓库的渠道」（v2.21）
 *
 * 现象：按国家「美国」查价，结果里混进一堆只送某个仓库/某个城市的渠道
 *      （631 卡派表里 dests = ONT8 / Bolingbrook / 4101 West Ann Lurie Place… 那些）。
 *
 * 成因（两条叠加）：
 *  1) v2.19 为了让「只写城市或仓号」的渠道也能按国家搜到，给渠道补了推导出的 country，
 *     matchChannels 在目的地文本不匹配时用 country 兜底 → 这些仓点渠道全被「美国」命中。
 *  2) 仓号拦截 isWhChannel 只能认 ONT8 / LMB8 这类代码，认不出 Bolingbrook（城市）、
 *     乐歌仓（仓库名）、4101 West Ann Lurie Place（街道地址），于是漏网。
 *
 * 期望：按**国家/大区**查价时，只到具体仓点/城市的渠道默认不参与；
 *      但用户填了仓号、填了城市，或显式勾选「包含只送指定仓库的渠道」时照旧能查到。
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

/* 目录里真实出现的四类渠道：
 *  - 全国/区域级：目的地写「美国」「美西（邮编8 9开头）」
 *  - 邮编分区：目的地写「邮编 90-91」（覆盖一片区域，按国家查应命中）
 *  - 只送仓点：目的地写仓号 ONT8、城市 Bolingbrook、仓库名 乐歌仓、街道地址
 * 全部已经被补上 country='美国'（v2.19 的行为），正是它们被「美国」搜出来的原因。 */
function sampleChannels() {
  return [
    { id: 'us', carrier: '088', type: 'air', name: 'US01 美国空运普货', dests: '美西（邮编8 9开头）', country: '美国', priceKg: 30 },
    { id: 'zip', carrier: '088', type: 'sea', name: 'US40 商卡经济线', dests: '邮编 90-91', country: '美国', priceKg: 8 },
    { id: 'wh', carrier: '631', type: 'sea', name: '洛杉矶普船28日达', dests: 'ONT8', country: '美国', priceKg: 9 },
    { id: 'city', carrier: '631', type: 'sea', name: '芝加哥海铁28日达', dests: 'Bolingbrook', country: '美国', priceKg: 7 },
    { id: 'cang', carrier: '631', type: 'sea', name: '美西90-92邮编系列', dests: '乐歌仓', country: '美国', priceKg: 7.5 },
    { id: 'addr', carrier: '631', type: 'sea', name: '芝加哥海铁32日达', dests: '4101 West Ann Lurie Place Chicago IL 60632', country: '美国', priceKg: 6.8 },
    { id: 'ca', carrier: '628', type: 'sea', name: '多伦多专线', dests: '加拿大 多伦多', country: '加拿大', priceKg: 12 }
  ];
}

const baseQ = { dest: '', type: 'all', weight: 10, pcs: 1, len: 0, wid: 0, hgt: 0, factor: 6000, remote: 0, other: 0, cargo: '', amazon: 'no', whCode: '', zip: '', includePoint: false };

/* ============ 1. 判定：什么是「只送指定仓库/城市」 ============ */

test('isPointOnly：仓号/城市/仓库名/街道地址算点对点，国家与邮编分区不算', () => {
  const C = global.App.calc;
  assert.strictEqual(C.isPointOnly({ dests: 'ONT8' }), true, '仓号应算点对点');
  assert.strictEqual(C.isPointOnly({ dests: 'Bolingbrook' }), true, '城市名应算点对点');
  assert.strictEqual(C.isPointOnly({ dests: '乐歌仓' }), true, '仓库名应算点对点');
  assert.strictEqual(C.isPointOnly({ dests: '4101 West Ann Lurie Place Chicago IL 60632' }), true, '街道地址应算点对点');

  assert.strictEqual(C.isPointOnly({ dests: '美国' }), false, '国家不算');
  assert.strictEqual(C.isPointOnly({ dests: '美西（邮编8 9开头）' }), false, '大区+邮编分区不算');
  assert.strictEqual(C.isPointOnly({ dests: '邮编 90-91' }), false, '邮编分区不算');
  assert.strictEqual(C.isPointOnly({ dests: '07-08' }), false, '邮编前两位区间不算');
  assert.strictEqual(C.isPointOnly({ dests: '加拿大 多伦多' }), false, '写了国家+城市的不算（国家已说明范围）');
  assert.strictEqual(C.isPointOnly({ dests: '' }), false, '没写目的地不归为点对点');
});

/* ============ 2. 按国家查价：仓点渠道默认不参与 ============ */

test('查「美国」：只送仓点/城市的渠道默认不出现（其余照常）', () => {
  const C = global.App.calc;
  const list = sampleChannels();
  const hit = C.matchChannels(list, Object.assign({}, baseQ, { dest: '美国' }));
  const ids2 = hit.map(c => c.id).sort();
  assert.deepStrictEqual(ids2, ['us', 'zip'],
    '按国家查价只该留下全国/区域级与邮编分区的渠道，实际：' + ids2.join(','));
});

test('查「美国」：仓号和城市渠道不再靠补出来的 country 混进来', () => {
  const C = global.App.calc;
  const list = sampleChannels();
  const hit = C.matchChannels(list, Object.assign({}, baseQ, { dest: '美国' }));
  assert.ok(!hit.some(c => c.id === 'city'), 'Bolingbrook 那条不该出现');
  assert.ok(!hit.some(c => c.id === 'cang'), '乐歌仓那条不该出现');
  assert.ok(!hit.some(c => c.id === 'wh'), 'ONT8 那条不该出现');
});

test('查「美国」：显式勾选「包含只送指定仓库的渠道」后，城市/仓库名/地址类要回来', () => {
  const C = global.App.calc;
  const list = sampleChannels();
  const hit = C.matchChannels(list, Object.assign({}, baseQ, { dest: '美国', includePoint: true }));
  const ids2 = hit.map(c => c.id).sort();
  // 仓号渠道（ONT8）不回来：它必须填仓号才查询，这是原有规则
  assert.deepStrictEqual(ids2, ['addr', 'cang', 'city', 'us', 'zip'],
    '勾选后应包含城市/仓库名/地址类渠道（不含加拿大的），实际：' + ids2.join(','));
});

/* ============ 3. 但用户指定了具体地点时，必须查得到 ============ */

test('填具体地点（Bolingbrook）：点对点渠道照旧命中，不隐藏', () => {
  const C = global.App.calc;
  const list = sampleChannels();
  const hit = C.matchChannels(list, Object.assign({}, baseQ, { dest: 'Bolingbrook' }));
  assert.deepStrictEqual(hit.map(c => c.id), ['city'],
    '按具体城市查就该出这个城市的渠道，实际：' + hit.map(c => c.id).join(','));
});

test('填了仓号时，仓号渠道要出来，而其他仓点渠道仍被折叠', () => {
  const C = global.App.calc;
  const list = sampleChannels();
  const hit = C.matchChannels(list, Object.assign({}, baseQ, { dest: '美国', whCode: 'ONT8' }));
  const ids2 = hit.map(c => c.id).sort();
  assert.deepStrictEqual(ids2, ['us', 'wh', 'zip'],
    '「美国 + ONT8」应是全国级 + 该仓渠道，实际：' + ids2.join(','));
});

test('填邮编查询：邮编分区渠道照旧命中', () => {
  const C = global.App.calc;
  const list = sampleChannels();
  const hit = C.matchChannels(list, Object.assign({}, baseQ, { dest: '美国', zip: '90012' }));
  const ids2 = hit.map(c => c.id).sort();
  assert.deepStrictEqual(ids2, ['us', 'zip'], '邮编 90 开头应命中国家级与 90-91 分区，实际：' + ids2.join(','));
});

/* ============ 4. 要如实告诉用户「还有多少条被折叠」 ============ */

test('matchChannelsEx：返回被折叠的仓点渠道条数，供界面提示', () => {
  const C = global.App.calc;
  const list = sampleChannels();
  const r = C.matchChannelsEx(list, Object.assign({}, baseQ, { dest: '美国' }));
  assert.strictEqual(r.list.length, 2);
  assert.strictEqual(r.skippedPoint, 3, '应有 3 条城市/仓库名/地址类渠道被折叠，实际 ' + r.skippedPoint);
  // 兼容：matchChannels 仍然只返回数组
  assert.ok(Array.isArray(C.matchChannels(list, Object.assign({}, baseQ, { dest: '美国' }))));
});

/* ============ 5. 界面：默认不出卡，但要有提示与开关 ============ */

function openFreight(channels) {
  global.App.store.instance.getState().channels = channels;
  global.App.router.show('freight');
  const content = ids.content;
  const dest = findBy(content, n => n.tagName === 'INPUT' && /如 US/.test(n.placeholder || ''));
  const weight = findBy(content, n => n.tagName === 'INPUT' && /实重/.test(n.placeholder || ''));
  const box = findBy(content, n => n.tagName === 'INPUT' && n.attrs && n.attrs.type === 'checkbox');
  const run = () => findAll(content, n => n.tagName === 'BUTTON').find(b => b.textContent === '开始试算比价').click();
  const cards = () => findAll(content, n => /quote-card/.test(n.className || ''));
  return { content, dest, weight, box, run, cards };
}

test('比价页：默认不显示仓点渠道，并提示「另有 N 条」+ 一键包含', async () => {
  assert.ok(await waitFor(() => global.App.store && global.App.store.instance), '应完成 store 初始化');
  const p = openFreight(sampleChannels());
  assert.ok(p.box, '应有「包含只送指定仓库的渠道」勾选框');
  assert.strictEqual(p.box.checked, false, '默认不勾选');

  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();

  assert.strictEqual(p.cards().length, 2, '默认只应出 2 张全国级/邮编分区卡片，实际 ' + p.cards().length);
  const tip = findAll(p.content, n => /point-tip/.test(n.className || ''));
  assert.ok(tip.length > 0, '应提示还有多少条仓点渠道被折叠');
  assert.match(tip[0].textContent, /3/, '提示里要写清条数，实际：' + tip[0].textContent);
  assert.match(tip[0].textContent, /仓库|仓点/, '提示要说清折叠的是哪类渠道');

  const btn = findAll(tip[0], n => n.tagName === 'BUTTON')[0];
  assert.ok(btn, '提示里应有「包含这些渠道」按钮');
  btn.click();
  assert.strictEqual(p.box.checked, true, '点按钮应勾上开关');
  assert.strictEqual(p.cards().length, 5, '勾选后应出 5 张卡片，实际 ' + p.cards().length);
});

test('比价页：勾选状态在重新试算后保留（用户显式选择不该被重置）', async () => {
  const p = openFreight(sampleChannels());
  p.box.checked = true;
  p.dest.value = '美国';
  p.weight.value = '10';
  p.run();
  assert.strictEqual(p.cards().length, 5);
  p.run();
  assert.strictEqual(p.cards().length, 5, '再点一次试算不该又缩回 2 张');
});
