/* 「快捷运费测算」只按国家名搜索（v2.19）
 *
 * 需求：首页「快捷运费测算」的目的地只认国家名（美国 / 德国 / 日本…），
 *      城市（芝加哥）、仓号、邮编片段都不能当搜索条件。
 *
 * 为什么这么定：
 *  - 价格表里的目的地写法极不统一（「美国」「美西」「美西（邮编8 9开头）」「US」），
 *    用户记不住也无从选；国家名是唯一稳定的一层。
 *  - 按国家匹配，一份渠道在全国各仓的价格都能被比出来；按城市/仓号匹配反而漏渠道。
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

/* 真实价格表里混杂的目的地写法 */
function mixedChannels() {
  const rows = [
    ['美国', '芝加哥', '1号仓', '邮编90000-90036'],
    ['美国', '洛杉矶', '2号仓', '邮编90001-90010'],
    ['美国', '纽约', '3号仓', '邮编10001-10010'],
    ['美西（邮编8 9开头）', '', '', ''],
    ['德国', '法兰克福', '', '邮编60000-60999'],
    ['德国', '柏林', '', '邮编10000-10999'],
    ['日本', '东京', '', '邮编100-0001'],
    ['英国', '伦敦', '', '邮编EC1A'],
    ['印度尼西亚', '雅加达', '', '邮编10110'],
    ['邮编1开头', '', '', '']
  ];
  const out = [];
  rows.forEach((r, i) => {
    for (let k = 0; k < 3; k++) {
      out.push({
        id: 'c' + i + '_' + k,
        name: '包税卡派-' + i + '-' + k,
        carrier: '436',
        dests: [r[0], r[1], r[2], r[3]].filter(Boolean).join(' '),
        type: 'sea',
        priceKg: 8 + i + k
      });
    }
  });
  return out;
}

/* ============ 1. 国家名识别（纯函数） ============ */

test('国家名：中文名 / 英文缩写 / 区域写法都能规整成标准国家名', () => {
  const C = global.App.calc;
  assert.strictEqual(C.countryName('美国'), '美国');
  assert.strictEqual(C.countryName(' us '), '美国', '英文缩写应被接受');
  assert.strictEqual(C.countryName('USA'), '美国');
  assert.strictEqual(C.countryName('美西'), '美国', '区域写法应归到国家');
  assert.strictEqual(C.countryName('美东'), '美国');
  assert.strictEqual(C.countryName('澳洲'), '澳大利亚');
  assert.strictEqual(C.countryName('印尼'), '印度尼西亚');
  assert.strictEqual(C.countryName('英国'), '英国');
  assert.strictEqual(C.countryName('德国'), '德国');
});

test('国家名：城市 / 仓号 / 邮编 / 乱输都不算国家', () => {
  const C = global.App.calc;
  ['芝加哥', '洛杉矶', '法兰克福', '1号仓', '邮编90000-90036', '美国芝加哥', '美', '', null].forEach(v => {
    assert.strictEqual(C.countryName(v), '', '「' + v + '」不该被当成国家名');
    assert.strictEqual(C.isCountryName(v), false, '「' + v + '」不该通过国家名校验');
  });
});

test('从目的地文字里认国家：能把「美西（邮编8 9开头）」认成美国，认不出就不硬猜', () => {
  const C = global.App.calc;
  assert.strictEqual(C.countryOfText('美国 芝加哥 1号仓 邮编90000-90036'), '美国');
  assert.strictEqual(C.countryOfText('美西（邮编8 9开头）'), '美国');
  assert.strictEqual(C.countryOfText('德国 法兰克福'), '德国');
  assert.strictEqual(C.countryOfText('印度尼西亚 雅加达'), '印度尼西亚', '不能被「印度」截走');
  assert.strictEqual(C.countryOfText('印度 孟买'), '印度');
  assert.strictEqual(C.countryOfText('邮编1开头'), '');
  assert.strictEqual(C.countryOfText(''), '');
});

test('国家候选：只出国家名，按渠道数从多到少，且不是所有国家都出现', () => {
  const C = global.App.calc;
  const list = C.countryHints(mixedChannels());
  assert.ok(list.length > 0, '应识别出国家');
  assert.strictEqual(list[0], '美国', '美国渠道最多，应排第一，实际：' + list.join('|'));
  ['德国', '日本', '英国', '印度尼西亚'].forEach(n => {
    assert.ok(list.indexOf(n) >= 0, '应包含「' + n + '」，实际：' + list.join('|'));
  });
  assert.ok(list.indexOf('芝加哥') < 0, '城市不能出现在国家候选里');
  assert.ok(list.indexOf('美西') < 0, '区域写法应合并成国家名「美国」');
  assert.ok(list.indexOf('US') < 0, '英文缩写不单独作为候选');
});

/* ============ 2. 首页「快捷运费测算」的候选与校验 ============ */

function openHome() {
  global.App.router.show('home');
  const content = ids.content;
  const dl = all.filter(n => n.tagName === 'DATALIST').pop();
  const country = findBy(content, n => n.tagName === 'INPUT' && /目的国|国家/.test(n.placeholder || ''));
  const weight = findBy(content, n => n.tagName === 'INPUT' && /重量/.test(n.placeholder || ''));
  const go = () => findAll(content, n => n.tagName === 'BUTTON').find(b => /前往测算|开始测算/.test(b.textContent)).click();
  return { dl, country, weight, go };
}

test('首页快捷测算：候选项全部是国家名', async () => {
  assert.ok(await waitFor(() => global.App.store && global.App.store.instance), '应完成 store 初始化');
  global.App.store.instance.getState().channels = mixedChannels();
  const p = openHome();
  assert.ok(p.dl, '应有目的地候选');
  const vals = p.dl.children.map(o => String(o.getAttribute('value') || o.value || ''));
  assert.ok(vals.length > 0, '应给出候选');
  vals.forEach(v => {
    assert.ok(global.App.calc.isCountryName(v), '候选「' + v + '」不是国家名，候选应为：' + vals.join('|'));
  });
  assert.ok(vals.indexOf('美国') >= 0);
});

test('首页快捷测算：输入城市会挡住，不跳到比价页', async () => {
  global.App.store.instance.getState().channels = mixedChannels();
  const p = openHome();
  let got = null;
  const orig = global.App.pages.freight.setQuick;
  global.App.pages.freight.setQuick = function (c, w) { got = { c, w }; };
  try {
    p.country.value = '芝加哥';
    p.weight.value = '10';
    p.go();
  } finally {
    global.App.pages.freight.setQuick = orig;
  }
  assert.strictEqual(got, null, '不该带着城市名跳转');
  assert.notStrictEqual(global.App.router.current, 'freight', '不应跳到比价页');
  assert.ok(/国家/.test(ids.content.textContent), '应提示只支持按国家名搜索');
});

test('首页快捷测算：输入英文缩写会规整成中文国家名再带过去', async () => {
  global.App.store.instance.getState().channels = mixedChannels();
  const p = openHome();
  let got = null;
  const orig = global.App.pages.freight.setQuick;
  global.App.pages.freight.setQuick = function (c, w) { got = { c, w }; };
  try {
    p.country.value = 'us';
    p.weight.value = '10';
    p.go();
  } finally {
    global.App.pages.freight.setQuick = orig;
  }
  assert.ok(got, '合法国家名应放行');
  assert.strictEqual(got.c, '美国', '应规整成「美国」，实际 ' + (got && got.c));
});

test('首页快捷测算：什么都不填就点「前往测算」给提示，不跳转', async () => {
  global.App.store.instance.getState().channels = mixedChannels();
  const p = openHome();
  p.country.value = '';
  p.go();
  assert.notStrictEqual(global.App.router.current, 'freight');
  assert.ok(/国家/.test(ids.content.textContent), '应提示填写国家名');
});

/* ============ 3. 按国家搜能覆盖该国所有渠道（含只写在渠道名里的） ============ */

test('按国家比价：渠道名写了国家、dests 只写邮编的，也能被国家名匹配到', () => {
  const C = global.App.calc;
  const channels = [
    { id: '1', name: '美国空运普货', dests: '邮编90000-90036', type: 'air' },
    { id: '2', name: '德国专线', dests: '邮编10000-10999', type: 'air' },
    { id: '3', name: '日本专线', dests: '邮编100-0001', type: 'air' }
  ];
  const us = C.matchChannels(channels, { dest: '美国', type: 'all' });
  assert.strictEqual(us.length, 1, '「美国空运普货」应能按国家名匹配到，实际 ' + us.length);
  assert.strictEqual(us[0].name, '美国空运普货');
  const de = C.matchChannels(channels, { dest: '德国', type: 'all' });
  assert.strictEqual(de.length, 1);
  assert.strictEqual(C.matchChannels(channels, { dest: '法国', type: 'all' }).length, 0);
});

/* ============ 4. 缺国家的老渠道要能被「按国家」搜到 ============ */

test('补国家：同一货代只涉及一个国家时，缺国家的渠道按组补上', () => {
  const C = global.App.calc;
  const list = [
    { id: '1', carrier: '631', type: 'sea', name: '洛杉矶普船28日达', dests: '美国 洛杉矶' },
    { id: '2', carrier: '631', type: 'sea', name: '芝加哥海铁28日达', dests: 'Bolingbrook' },
    { id: '3', carrier: '631', type: 'sea', name: '洛杉矶普船28日达', dests: 'ONT8' }
  ];
  const n = C.fillMissingCountries(list);
  assert.strictEqual(n, 2, '应补 2 条，实际 ' + n);
  assert.strictEqual(list[1].country, '美国');
  assert.strictEqual(list[2].country, '美国');
  // dests 不能被改：城市/仓号还要用来按城市、按仓号搜
  assert.strictEqual(list[1].dests, 'Bolingbrook');
  assert.strictEqual(list[2].dests, 'ONT8');
  assert.strictEqual(C.matchChannels(list, { dest: '美国', type: 'all' }).length,
    C.matchChannels(list, { dest: '美国', type: 'all' }).length);
});

test('补国家：多国混表的货代一律不猜（宁可空着也不补错）', () => {
  const C = global.App.calc;
  const list = [
    { id: '1', carrier: '923', type: 'express', name: '欧洲专线', dests: '德国 法兰克福' },
    { id: '2', carrier: '923', type: 'express', name: '欧洲专线', dests: '法国 巴黎' },
    { id: '3', carrier: '923', type: 'express', name: '欧洲专线', dests: '某某仓' }
  ];
  const n = C.fillMissingCountries(list);
  assert.strictEqual(n, 0, '多国混表不该补，实际补了 ' + n);
  assert.ok(!list[2].country, '认不出国家的渠道应保持空着');
});

test('补国家：没有货代号的渠道不猜（没有分组依据）', () => {
  const C = global.App.calc;
  const list = [
    { id: '1', name: '美国专线', dests: '美国' },
    { id: '2', name: '某某专线', dests: 'Bolingbrook' }
  ];
  assert.strictEqual(C.fillMissingCountries(list), 0);
  assert.ok(!list[1].country);
});

test('补国家后：快捷测算的候选与按国家匹配都覆盖到这些渠道', () => {
  const C = global.App.calc;
  const list = [
    { id: '1', carrier: '631', type: 'sea', name: '洛杉矶普船28日达', dests: '美国 洛杉矶', priceKg: 9 },
    { id: '2', carrier: '631', type: 'sea', name: '芝加哥海铁28日达', dests: 'Bolingbrook', priceKg: 8 },
    { id: '3', carrier: '628', type: 'sea', name: '多伦多专线', dests: '加拿大 多伦多', priceKg: 12 },
    { id: '4', carrier: '628', type: 'sea', name: '温哥华专线', dests: 'Richmond', priceKg: 13 }
  ];
  C.fillMissingCountries(list);
  const hints = C.countryHints(list);
  assert.ok(hints.indexOf('美国') >= 0, '候选应含美国，实际：' + hints.join('|'));
  assert.ok(hints.indexOf('加拿大') >= 0, '候选应含加拿大，实际：' + hints.join('|'));
  // v2.21 起：只写城市（Bolingbrook）的渠道算「只送指定仓库/城市」，按国家查价时折叠，
  // 但仍要算在「另有 N 条」里并可由开关包含——不是丢失。
  const us = C.matchChannels(list, { dest: '美国', type: 'all' });
  assert.strictEqual(us.length, 1, '按国家查价只出全国级渠道，实际 ' + us.length);
  const ex = C.matchChannelsEx(list, { dest: '美国', type: 'all' });
  assert.strictEqual(ex.skippedPoint, 1, '只写城市的 1 条应被折叠，实际 ' + ex.skippedPoint);
  const all2 = C.matchChannels(list, { dest: '美国', type: 'all', includePoint: true });
  assert.strictEqual(all2.length, 2, '勾选包含后应回到 2 条，实际 ' + all2.length);
});

/* ============ 5. 导入时按表补国家（grid.fillTableCountry） ============ */

test('导入补国家：整张表只涉及一个国家时，只写城市/仓号的行也归到这个国家', () => {
  const list = [
    { name: '芝加哥海铁28日达', dests: 'Bolingbrook' },
    { name: '洛杉矶普船28日达', dests: 'ONT8' },
    { name: '美西90-92邮编系列', dests: '美西90-92邮编' }
  ];
  global.App.grid.fillTableCountry(list, { sheetName: '美国卡派价目表' });
  assert.strictEqual(list[0].country, '美国');
  assert.strictEqual(list[1].country, '美国');
  assert.strictEqual(list[0].dests, 'Bolingbrook', 'dests 不能被改写（城市还要能按城市搜）');
});

test('导入补国家：多国混表不补，认不出就空着', () => {
  const list = [
    { name: '欧洲专线', dests: '德国 法兰克福' },
    { name: '欧洲专线', dests: '法国 巴黎' },
    { name: '欧洲专线', dests: '某某仓' }
  ];
  global.App.grid.fillTableCountry(list, { sheetName: '欧洲空派' });
  assert.ok(!list[2].country, '多国混表不能硬猜');
});

/* ============ 6. 国家字段不能因为改价格而被抹掉 ============ */

test('编辑已有渠道（弹窗不带国家字段）时，补出来的国家要保留', async () => {
  const store = global.App.store.instance;
  const bak = store.getState().channels;
  store.getState().channels = [
    { id: 'k1', createdAt: '2026-10-01T00:00:00.000Z', carrier: '631', type: 'sea', name: '芝加哥海铁28日达', dests: 'Bolingbrook', country: '美国', priceKg: 10.78 }
  ];
  try {
    await store.upsertChannels([
      { carrier: '631', type: 'sea', name: '芝加哥海铁28日达', dests: 'Bolingbrook', priceKg: 11.2 }
    ]);
    const c = store.getState().channels[0];
    assert.strictEqual(c.priceKg, 11.2, '价格应更新');
    assert.strictEqual(c.country, '美国', '国家不能被编辑弄丢');
  } finally {
    store.getState().channels = bak;
  }
});
