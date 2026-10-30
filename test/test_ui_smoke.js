/* UI 冒烟测试：用最小 DOM 桩按 index.html 顺序加载全部脚本并渲染 6 个页面。
 * 目的：在无浏览器环境下，验证页面渲染不抛错、关键交互（仓库代码→邮编/国家回填、仓库表搜索）接线正确。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const { xlsxOf, fileStub } = require('./_xlsx_fixture.js');

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
    this.classList = {
      add() {}, remove() {}, contains() { return false; }, toggle() {}
    };
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
  const all = []; // 所有 createElement 出来的节点，供 getElementById 兜底查找
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

// 仓库表测试数据：v2.25 起不再内置亚马逊仓地址，用例自己往 settings.fbaWh 里放几条
async function seedFbaWh() {
  await global.App.store.instance.updateSettings({ fbaWh: [
    { code: 'ONT8', city: 'Moreno Valley', state: 'CA', zip: '92551', country: 'US' },
    { code: 'YYZ1', city: 'Mississauga', state: 'ON', zip: 'L5S 1P7', country: 'CA' },
    { code: 'YVR1', city: 'Delta', state: 'BC', zip: 'V3M 6R9', country: 'CA' }
  ] });
}

const dom = installDom();
const srcs = loadScripts();

test('index.html 的脚本顺序可完整加载（含 fba.js）', () => {
  assert.ok(srcs.indexOf('js/fba.js') >= 0, '应引入 fba.js');
  assert.ok(srcs.indexOf('js/fba.js') < srcs.indexOf('js/calc.js'), 'fba.js 应在 calc.js 之前');
  assert.ok(global.App && global.App.fba && global.App.calc && global.App.pages.settings);
});

test('启动后自动进入首页并完成渲染', async () => {
  const ok = await waitFor(() => global.App.store && global.App.store.instance);
  assert.ok(ok, '应完成 store 初始化');
  const content = dom.ids.content;
  assert.ok(content.textContent.length > 0, '首页应有内容');
});

test('六个页面逐一渲染不抛错', async () => {
  const pages = ['home', 'freight', 'channels', 'profit', 'records', 'settings'];
  for (const p of pages) {
    assert.doesNotThrow(() => global.App.router.show(p), p + ' 渲染不应抛错');
    assert.ok(dom.ids.content.children.length > 0, p + ' 应渲染出节点');
  }
});

test('设置页展示 FBA 仓库表并可搜索', async () => {
  await seedFbaWh();
  global.App.router.show('settings');
  const content = dom.ids.content;
  assert.ok(content.textContent.indexOf('FBA 仓库表') >= 0, '应有 FBA 仓库表卡片');
  assert.ok(content.textContent.indexOf('ONT8') >= 0, '列表应含自己加的 ONT8');
  assert.ok(content.textContent.indexOf('仓库 3 个') >= 0, '统计行应显示仓库数量');

  const kw = findBy(content, n => n.tagName === 'INPUT' && /搜索代码/.test(n.placeholder || ''));
  assert.ok(kw, '应有搜索框');
  kw.value = 'YYZ1';
  kw.dispatch('input');
  const txt = content.textContent;
  assert.ok(txt.indexOf('YYZ1') >= 0, '搜索 YYZ1 应命中');
  assert.ok(txt.indexOf('ONT8') < 0, '搜索 YYZ1 不应再显示 ONT8');
});

test('设置页：FBA 仓库表可直接导入 .xlsx（多工作表一起读入）', async () => {
  const store = global.App.store.instance;
  await store.updateSettings({ fbaWh: [] });
  global.App.router.show('settings');
  // 仓库表的文件框 accept 里有 .tsv（价格表的没有），据此定位
  const input = findAll(dom.ids.content, n => n.tagName === 'INPUT' && /\.tsv/.test(n.attrs.accept || ''))[0];
  assert.ok(input, '仓库表应有文件选择框');
  assert.ok(/\.xlsx/.test(input.attrs.accept), 'accept 应含 .xlsx');
  assert.ok(/\.xlsm/.test(input.attrs.accept), 'accept 应含 .xlsm');
  assert.strictEqual(input.attrs.multiple, true, '应支持一次选多个文件');

  input.files = [fileStub('FBA仓库.xlsx', {
    buffer: xlsxOf([
      { name: '美国', rows: [['仓库代码', '城市', '州', '邮编', '国家'], ['ONT8', 'Moreno Valley', 'CA', 92551, '美国']] },
      { name: '加拿大', rows: [['仓库代码', '邮编', '国家'], ['YYZ1', 'L5S 1P7', '加拿大']] }
    ])
  })];
  input.dispatch('change');

  const ok = await waitFor(() => (store.getSettings().fbaWh || []).length === 2);
  assert.ok(ok, '应导入两个工作表的仓库');
  const got = store.getSettings().fbaWh;
  const ont = got.find(x => x.code === 'ONT8');
  assert.ok(ont, '应含 ONT8');
  assert.strictEqual(ont.zip, '92551', '数字邮编应还原成 92551');
  assert.strictEqual(ont.country, 'US', '中文国家应转成 US');
  assert.ok(got.some(x => x.code === 'YYZ1'), '第二个工作表也要导入');
  // 导入后列表立即刷新
  assert.ok(dom.ids.content.textContent.indexOf('ONT8') >= 0, '导入后列表应显示 ONT8');
});

test('设置页：FBA 仓库表导入 CSV 覆盖同码、新增新码', async () => {
  const store = global.App.store.instance;
  await store.updateSettings({ fbaWh: [{ code: 'ONT8', city: 'Old', state: 'CA', zip: '00000', country: 'US' }] });
  global.App.router.show('settings');
  const input = findAll(dom.ids.content, n => n.tagName === 'INPUT' && /\.tsv/.test(n.attrs.accept || ''))[0];
  input.files = [fileStub('wh.csv', {
    text: '仓库代码,城市,州,邮编,国家\nONT8,Moreno Valley,CA,92551,US\nFTW1,Dallas,TX,75241,US'
  })];
  input.dispatch('change');

  const ok = await waitFor(() => (store.getSettings().fbaWh || []).length === 2);
  assert.ok(ok, '应变成 2 条（1 条覆盖 + 1 条新增）');
  const got = store.getSettings().fbaWh;
  assert.strictEqual(got.find(x => x.code === 'ONT8').zip, '92551', '同码应被新地址覆盖');
  assert.ok(got.some(x => x.code === 'FTW1'), '新码应追加');
});

test('设置页：FBA 仓库表「一键删除」清空全部仓库', async () => {
  const store = global.App.store.instance;
  const U = global.App.util;
  const oldConfirm = U.confirmDialog;
  U.confirmDialog = async () => true;
  try {
    await seedFbaWh();
    global.App.router.show('settings');
    assert.ok(dom.ids.content.textContent.indexOf('ONT8') >= 0, '初始应有 3 条仓库');

    const bulk = () => findAll(dom.ids.content, n => n.tagName === 'BUTTON').find(b => /^一键删除/.test(b.textContent));
    assert.ok(bulk(), 'FBA 仓库表应有一键删除按钮');
    assert.strictEqual(bulk().textContent, '一键删除（3）', '按钮应带当前命中条数');

    bulk().click();
    await waitFor(() => store.getSettings().fbaWh.length === 0);
    assert.ok(dom.ids.content.textContent.indexOf('ONT8') < 0, '删除后列表不应再有 ONT8');
    assert.ok(dom.ids.content.textContent.indexOf('仓库 0 个') >= 0, '统计行应显示 0 个');
    assert.ok(dom.ids.content.textContent.indexOf('仓库表是空的') >= 0, '应提示仓库表为空');
  } finally {
    U.confirmDialog = oldConfirm;
    await seedFbaWh();
  }
});

test('设置页：FBA 仓库表一键删除可只删搜索命中的部分', async () => {
  const store = global.App.store.instance;
  const U = global.App.util;
  const oldConfirm = U.confirmDialog;
  U.confirmDialog = async () => true;
  try {
    await seedFbaWh();
    global.App.router.show('settings');
    const kw = findBy(dom.ids.content, n => n.tagName === 'INPUT' && /搜索代码/.test(n.placeholder || ''));
    kw.value = 'Moreno Valley';
    kw.dispatch('input');

    const bulk = findAll(dom.ids.content, n => n.tagName === 'BUTTON').find(b => /^一键删除/.test(b.textContent));
    assert.strictEqual(bulk.textContent, '一键删除（1）', '只命中 ONT8 一条');
    bulk.click();
    await waitFor(() => store.getSettings().fbaWh.length === 2);
    assert.ok(!store.getSettings().fbaWh.some(x => x.code === 'ONT8'), '命中的 ONT8 应被删掉');
    // 未命中的不受影响
    global.App.router.show('settings');
    assert.ok(dom.ids.content.textContent.indexOf('YYZ1') >= 0, '未命中的 YYZ1 应保留');
  } finally {
    U.confirmDialog = oldConfirm;
    await seedFbaWh();
  }
});

test('运费页：输入仓库代码自动回填邮编与国家', async () => {
  await seedFbaWh();
  global.App.router.show('freight');
  const content = dom.ids.content;
  const whInput = findBy(content, n => n.tagName === 'INPUT' && /仓库代码/.test(n.placeholder || ''));
  assert.ok(whInput, '应有仓库代码输入框');
  const zipInput = findBy(content, n => n.tagName === 'INPUT' && /^邮编/.test(n.placeholder || ''));
  const destInput = findBy(content, n => n.tagName === 'INPUT' && /目的地|美国/.test(n.placeholder || ''));
  assert.ok(zipInput && destInput, '应有邮编与目的地输入框');

  whInput.value = 'ont8';
  whInput.dispatch('input');

  assert.strictEqual(zipInput.value, '92551', '应回填 ONT8 邮编');
  assert.strictEqual(destInput.value, 'US', '目的地为空时应回填国家');
  assert.ok(content.textContent.indexOf('已识别') >= 0, '应显示识别提示');
  assert.ok(content.textContent.indexOf('Moreno Valley') >= 0, '提示应含城市');
});

test('运费页：未知仓库代码给出补充提示而非报错', async () => {
  await seedFbaWh();
  global.App.router.show('freight');
  const content = dom.ids.content;
  const whInput = findBy(content, n => n.tagName === 'INPUT' && /仓库代码/.test(n.placeholder || ''));
  whInput.value = 'ZZZ9';
  whInput.dispatch('input');
  assert.ok(content.textContent.indexOf('仓库表里没有 ZZZ9') >= 0);
});

test('运费页：已有目的地不被仓库国家覆盖', async () => {
  await seedFbaWh();
  global.App.router.show('freight');
  const content = dom.ids.content;
  const whInput = findBy(content, n => n.tagName === 'INPUT' && /仓库代码/.test(n.placeholder || ''));
  const destInput = findBy(content, n => n.tagName === 'INPUT' && /目的地|美国/.test(n.placeholder || ''));
  destInput.value = 'CA';
  whInput.value = 'YVR1';
  whInput.dispatch('input');
  assert.strictEqual(destInput.value, 'CA', '用户已填目的地不应被覆盖');
});

test('渠道价格库：表头筛选/排序 + 表头批量操作入口', async () => {
  const store = global.App.store.instance;
  await store.upsertChannel({ name: '甲线', carrier: '436', dests: '美西', type: 'sea', validFrom: '2026-10-01', validUntil: '2026-10-05' });
  await store.upsertChannel({ name: '乙线', carrier: '1288', dests: '美东', type: 'sea', validFrom: '2026-10-01', validUntil: '2026-11-30' });

  global.App.router.show('channels');
  const content = dom.ids.content;

  // 1) 一键编辑 / 一键删除在「操作」列表头，不在每行里
  const thead = findBy(content, n => n.tagName === 'THEAD');
  const tbody0 = findBy(content, n => n.tagName === 'TBODY');
  const opsTh = findAll(thead, n => n.tagName === 'TH').find(th => th.textContent.indexOf('操作') >= 0);
  assert.ok(opsTh, '应有「操作」列表头');
  const headBtns = findAll(opsTh, n => n.tagName === 'BUTTON').map(b => b.textContent);
  assert.ok(headBtns.indexOf('一键编辑') >= 0, '操作列表头应有一键编辑');
  assert.ok(headBtns.indexOf('一键删除') >= 0, '操作列表头应有一键删除');
  assert.ok(findBy(opsTh, n => /sel-all/.test(n.className || '')), '操作列表头应有全选勾选框');
  assert.strictEqual(findAll(tbody0, n => n.tagName === 'BUTTON').length, 0, '行内不应再有操作按钮');
  assert.strictEqual(findAll(tbody0, n => /sel-row/.test(n.className || '')).length,
    findAll(tbody0, n => n.tagName === 'TR').length, '每行应有一个勾选框');

  // 2) 渠道商表头有排序 + 筛选控件
  const thOf = label => findAll(content, n => n.tagName === 'TH').find(th => th.textContent.indexOf(label) >= 0);
  const carrierTh = thOf('渠道商');
  assert.ok(carrierTh, '应有渠道商表头');
  const sortBtn = findBy(carrierTh, n => n.tagName === 'BUTTON' && /th-sort/.test(n.className || ''));
  const fltBtn = findBy(carrierTh, n => n.tagName === 'BUTTON' && /th-filter/.test(n.className || ''));
  assert.ok(sortBtn && fltBtn, '渠道商列应有排序与筛选按钮');
  const filterBtns = findAll(content, n => n.tagName === 'BUTTON' && /th-filter/.test(n.className || ''));
  assert.strictEqual(filterBtns.length, 4, '渠道商 / 起运仓 / 有效期 / 状态 四列都应有筛选按钮');
  const originTh = thOf('起运仓');
  assert.ok(originTh, '应有起运仓表头（FBA 卡派按起运仓分列报价，需要单独一列）');
  assert.ok(findBy(originTh, n => n.tagName === 'BUTTON' && /th-filter/.test(n.className || '')), '起运仓列应有筛选按钮');
  const resetBtn = findAll(content, n => n.tagName === 'BUTTON' && /th-reset/.test(n.className || ''));
  assert.strictEqual(resetBtn.length, 1, '操作列表头应有「清除筛选/排序」按钮');

  const firstCarrier = () => {
    const tbody = findBy(dom.ids.content, n => n.tagName === 'TBODY');
    return tbody.children[0].children[2].textContent;
  };

  // 3) 点排序：升序 → 1288 在前；再点：降序 → 436 在前；再点：取消
  sortBtn.click();
  assert.strictEqual(firstCarrier(), '1288', '升序应按渠道商排');
  findBy(dom.ids.content, n => n.tagName === 'BUTTON' && /th-sort/.test(n.className || '')).click();
  assert.strictEqual(firstCarrier(), '436', '降序应反转');

  // 4) 点漏斗出现筛选面板，勾选后过滤生效
  const fltBtn2 = findBy(dom.ids.content, n => n.tagName === 'BUTTON' && /th-filter/.test(n.className || ''));
  fltBtn2.click();
  const menu = findBy(dom.ids.content, n => /th-menu/.test(n.className || ''));
  assert.ok(menu, '应弹出筛选面板');
  const boxes = findAll(menu, n => n.tagName === 'INPUT');
  assert.strictEqual(boxes.length, 2, '两个渠道商各一项（默认全选）');
  boxes[0].checked = true;
  // 先取消另一项，只留一项
  boxes[1].checked = false;
  boxes[1].dispatch('change');
  const rows = findAll(findBy(dom.ids.content, n => n.tagName === 'TBODY'), n => n.tagName === 'TR');
  assert.strictEqual(rows.length, 1, '筛选后只剩一个渠道商的行');
});

test('渠道价格库：勾选后点表头「一键删除」批量删除', async () => {
  const store = global.App.store.instance;
  for (const c of store.getState().channels.slice()) await store.deleteChannel(c.id);
  await store.upsertChannel({ name: '批量甲', carrier: '436', dests: '美西', type: 'sea', validUntil: '2026-11-30' });
  await store.upsertChannel({ name: '批量乙', carrier: '436', dests: '美中', type: 'sea', validUntil: '2026-11-30' });
  await store.upsertChannel({ name: '批量丙', carrier: '436', dests: '美东', type: 'sea', validUntil: '2026-11-30' });

  global.App.router.show('channels');
  const content = dom.ids.content;
  const rowBoxes = () => findAll(findBy(dom.ids.content, n => n.tagName === 'TBODY'), n => /sel-row/.test(n.className || ''));
  assert.strictEqual(rowBoxes().length, 3, '应有 3 行');

  // 未勾选时点「一键删除」：只提示，不删
  global.App.util.confirmDialog = async () => true;
  const delBtnOf = () => findAll(dom.ids.content, n => n.tagName === 'BUTTON').find(b => b.textContent === '一键删除');
  delBtnOf().click();
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(store.getState().channels.length, 3, '未勾选时不应删除任何渠道');

  // 勾选前两行（每次勾选都会重绘，需重新取节点）
  let boxes = rowBoxes();
  boxes[0].checked = true;
  boxes[0].dispatch('change');
  boxes = rowBoxes();
  boxes[1].checked = true;
  boxes[1].dispatch('change');
  assert.ok(dom.ids.content.textContent.indexOf('已勾选 2 条') >= 0, '统计条应显示已勾选数量');

  delBtnOf().click();
  await new Promise(r => setTimeout(r, 20));
  const left = store.getState().channels;
  assert.strictEqual(left.length, 1, '应删掉勾选的两条');
  assert.strictEqual(left[0].dests, '美东', '未勾选的那条应保留');
});

test('渠道价格库：表头全选勾选框可一次勾选 / 取消全部', async () => {
  const store = global.App.store.instance;
  await store.upsertChannel({ name: '全选甲', carrier: '999', dests: '美西', type: 'sea', validUntil: '2026-11-30' });
  global.App.router.show('channels');
  const rowBoxes = () => findAll(findBy(dom.ids.content, n => n.tagName === 'TBODY'), n => /sel-row/.test(n.className || ''));
  const total = rowBoxes().length;
  assert.strictEqual(total, 2, '此时共 2 条');

  let all = findBy(dom.ids.content, n => /sel-all/.test(n.className || ''));
  all.checked = true;
  all.dispatch('change');
  assert.strictEqual(rowBoxes().filter(b => b.attrs && b.attrs.checked).length, total, '全选后每行都应为已勾选');
  assert.ok(dom.ids.content.textContent.indexOf('已勾选 ' + total + ' 条') >= 0, '统计条应显示全选数量');

  all = findBy(dom.ids.content, n => /sel-all/.test(n.className || ''));
  all.checked = false;
  all.dispatch('change');
  assert.strictEqual(rowBoxes().filter(b => b.attrs && b.attrs.checked).length, 0, '取消全选后应清空勾选');
});

test('渠道价格库：勾选多条点表头「一键编辑」弹出批量编辑', async () => {
  global.App.router.show('channels');
  const rowBoxes = () => findAll(findBy(dom.ids.content, n => n.tagName === 'TBODY'), n => /sel-row/.test(n.className || ''));
  let boxes = rowBoxes();
  assert.ok(boxes.length >= 2, '至少需要两条才能验证批量编辑');
  boxes[0].checked = true;
  boxes[0].dispatch('change');
  boxes = rowBoxes();
  boxes[1].checked = true;
  boxes[1].dispatch('change');

  const editBtn = findAll(dom.ids.content, n => n.tagName === 'BUTTON').find(b => b.textContent === '一键编辑');
  editBtn.click();
  const overlay = findBy(dom.doc.body, n => /modal-overlay/.test(n.className || ''));
  assert.ok(overlay, '应弹出批量编辑弹窗');
  assert.ok(overlay.textContent.indexOf('批量编辑 2 条渠道') >= 0, '标题应带条数');
  assert.ok(overlay.textContent.indexOf('渠道商/货代') >= 0, '应有渠道商字段');
  assert.ok(overlay.textContent.indexOf('报价有效期起') >= 0 && overlay.textContent.indexOf('报价有效期止') >= 0, '应有有效期字段');
  assert.ok(overlay.textContent.indexOf('留空') >= 0, '应说明留空字段保持不变');
});

test('首页今日待办：有「设置更新天数」按钮与更新周期提示', async () => {
  const store = global.App.store.instance;
  for (const c of store.getState().channels.slice()) await store.deleteChannel(c.id);
  // 造一条已过期 + 一条正常的渠道
  await store.upsertChannel({ name: '过期线', carrier: '436', dests: '美西', type: 'sea', validUntil: '2026-10-20' });
  await store.upsertChannel({ name: '正常线', carrier: '436', dests: '美东', type: 'sea', validUntil: '2026-12-31' });
  await store.updateSettings({ updateDays: 7 });

  global.App.router.show('home');
  const content = dom.ids.content;
  assert.ok(content.textContent.indexOf('今日待办（价格有效性）') >= 0, '应有今日待办卡片');
  const updBtn = findAll(content, n => n.tagName === 'BUTTON').find(b => b.textContent === '设置更新天数');
  assert.ok(updBtn, '待办卡片应有「设置更新天数」按钮');
  assert.ok(content.textContent.indexOf('每 7 天更新') >= 0, '应显示当前更新周期');
  assert.ok(content.textContent.indexOf('建议更新日') >= 0, '临期行应给出建议更新日');

  // 点开弹窗
  updBtn.click();
  // 桩里的 node.remove() 是空实现，旧弹窗不会消失，取最后一个即本次新开的
  const overlays = findAll(dom.doc.body, n => /modal-overlay/.test(n.className || ''));
  const overlay = overlays[overlays.length - 1];
  assert.ok(overlay, '应弹出设置弹窗');
  assert.ok(overlay.textContent.indexOf('设置价格表更新天数') >= 0);
  const dateBox = findBy(overlay, n => /upd-date/.test(n.className || ''));
  assert.ok(dateBox && /（7 天后）/.test(dateBox.textContent), '应回显 7 天后的日期');

  // 点「15 天」快捷按钮 → 输入框与日期提示同步
  const chip15 = findAll(overlay, n => n.tagName === 'BUTTON').find(b => b.textContent === '15 天');
  assert.ok(chip15, '应有 15 天快捷按钮');
  chip15.click();
  const dayInp = findBy(overlay, n => /upd-days/.test(n.className || ''));
  assert.strictEqual(dayInp.value, '15', '快捷按钮应写入输入框');
  assert.ok(/（15 天后）/.test(dateBox.textContent), '日期提示应同步为 15 天后');

  // 保存：设置被记住，已过期渠道的有效期改到更新日，正常渠道不动
  const saveBtn = findAll(overlay, n => n.tagName === 'BUTTON').find(b => b.textContent === '保存');
  saveBtn.click();
  await new Promise(r => setTimeout(r, 30));
  assert.strictEqual(store.getSettings().updateDays, 15, '应记住 15 天');
  const chs = store.getState().channels;
  const expired = chs.find(c => c.name === '过期线');
  const normal = chs.find(c => c.name === '正常线');
  assert.strictEqual(expired.validUntil, global.App.calc.updateDueDate(15), '已过期渠道应改到更新日');
  assert.strictEqual(normal.validUntil, '2026-12-31', '正常渠道不应被改动');
  assert.ok(dom.ids.content.textContent.indexOf('每 15 天更新') >= 0, '首页提示应刷新为 15 天');
});
