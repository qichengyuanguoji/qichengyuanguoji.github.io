/* 通用价目表解析器（js/grid.js）：
 * 覆盖 5 种真实排版 —— 转置（重量行×渠道列）、首重续重、长表聚合（渠道×重量段）、
 * 多层表头网格（目的地×起运仓×重量档）、以及「地址表/目录页」误判防护。
 * 另外验证 calc 的重量档整票价（wTiers）与 store 的 channelKey 含起运仓。
 */
const test = require('node:test');
const assert = require('node:assert');
require('../js/util.js');
require('../js/fsio.js');
require('../js/csv.js');
const grid = require('../js/grid.js');
const calc = require('../js/calc.js');
const storeMod = require('../js/store.js');

const names = (res) => res.channels.map(c => c.name);
const find = (res, n) => res.channels.find(c => c.name === n);

test('tierOfLabel: 各种重量档写法都能识别，说明文字不误判', () => {
  assert.deepStrictEqual(grid.tierOfLabel('21KG+'), { kind: 'w', min: 21, max: null });
  assert.deepStrictEqual(grid.tierOfLabel('12-70KG'), { kind: 'w', min: 12, max: 70 });
  assert.deepStrictEqual(grid.tierOfLabel('0.1-12kg(100克进位)'), { kind: 'w', min: 0.1, max: 12 });
  assert.deepStrictEqual(grid.tierOfLabel('包税-50kg+ （WM仓库）'), { kind: 'w', min: 50, max: null });
  assert.deepStrictEqual(grid.tierOfLabel('0Kg≤包裹重量≤0.15kg'), { kind: 'w', min: 0, max: 0.15 });
  assert.deepStrictEqual(grid.tierOfLabel('包税（1CBM+)'), { kind: 'cbm', min: 1, max: null });
  assert.strictEqual(grid.tierOfLabel('单票低消20KG'), null, '「低消 20KG」是说明，不是「20KG+」档');
  assert.strictEqual(grid.tierOfLabel('备注'), null);
  assert.strictEqual(grid.tierOfLabel('0.5'), null, '纯数字不是档标签');
});

test('isNonPriceSheet: 地址表 / 目录页被挡掉，价格表不受影响', () => {
  const addr = [
    ['', 'FC', 'Address', 'City', 'State', 'ZIP Code'],
    ['', 'ABE2', '705 Boulder Dr', 'Breinigsville', 'PA', '18031'],
    ['', 'ABE3', '650 Boulder Dr', 'Breinigsville', 'PA', '18036']
  ];
  assert.strictEqual(grid.isNonPriceSheet(addr, 'FBA代码+地址'), true, '英文地址表应被识别为非价格表');
  assert.strictEqual(grid.isNonPriceSheet(addr, '任意表名'), true, 'sheet 名无关，靠表头也能判');

  const price = [
    ['美转加正班海派'],
    ['亚马逊仓库代码', '义乌仓（上海/宁波+0.5/KG）', '深圳/广州仓（泉州/福州+0.5/KG）'],
    ['亚马逊仓库代码', '21KG+', '21KG+'],
    ['多伦多 (YYZ1)', '21.34', '21.89']
  ];
  assert.strictEqual(grid.isNonPriceSheet(price, '美转加UPS派'), false, '含「广州仓」不能被当成地址表');

  assert.strictEqual(grid.parseSheet(addr, { sheetName: '地址' }), null, '地址表不应产出渠道');
});

test('transpose: 行=重量、列=渠道，数值递增 → 重量档整票价 wTiers', () => {
  const rows = [
    ['美国空派小货'],
    ['重量KG', '渠道A', '渠道B'],
    ['0.5', 100, 120],
    ['1', 140, 160],
    ['1.5', 180, 200]
  ];
  const res = grid.parseSheet(rows, { sheetName: '美国空派集运' });
  assert.ok(res, '应识别为转置表');
  assert.strictEqual(res.kind, 'transpose');
  assert.deepStrictEqual(names(res), ['渠道A', '渠道B']);
  const a = find(res, '渠道A');
  assert.strictEqual(a.dests, '美国', '目的地从标题推断');
  assert.strictEqual(a.wTiers.length, 3);
  assert.strictEqual(a.wTiers[0].wMin, 0.5);
  assert.strictEqual(a.wTiers[0].wMax, 1, '下一档下限自动补成上一档上限');
  assert.strictEqual(a.wTiers[2].price, 180);
  assert.ok(!a.tiers, '整票价不应该再写进单价阶梯');
});

test('transpose: 单价随重量递减 → 普通单价阶梯 tiers', () => {
  const rows = [
    ['澳洲空运'],
    ['重量', '普货'],
    ['12', 33],
    ['50', 30],
    ['100', 28]
  ];
  const res = grid.parseSheet(rows, { sheetName: '澳洲空运' });
  const c = find(res, '普货');
  assert.ok(c.tiers && c.tiers.length === 3, '递减表按单价阶梯');
  assert.strictEqual(c.priceKg, 33);
});

test('firstAdd: 首重 / 续重 + 大货每 kg 档', () => {
  const rows = [
    ['澳邮空运集运双清（含税）'],
    ['', '首重0.5KG', '续重0.5KG', '11-22KG'],
    ['普货', 48, 19, 33],
    ['敏感', 48, 19, 33]
  ];
  const res = grid.parseSheet(rows, { sheetName: '澳洲空运集运价格', defaultType: 'air' });
  assert.strictEqual(res.kind, 'firstAdd');
  const p = find(res, '澳邮空运集运双清（含税）-普货');
  assert.ok(p, '渠道名应为「标题-货物类型」：' + names(res).join(','));
  assert.strictEqual(p.firstW, 0.5);
  assert.strictEqual(p.firstP, 48);
  assert.strictEqual(p.addU, 0.5);
  assert.strictEqual(p.addP, 19);
  assert.deepStrictEqual(p.tiers, [{ wMin: 11, wMax: 22, price: 33 }]);
  assert.strictEqual(p.dests, '澳洲');
});

test('longTable: 同一渠道多重量段聚合成阶梯价，挂号费/时效带出', () => {
  const rows = [
    ['美国专线'],
    ['渠道名称', '重量段', '运费（元/KG）', '挂号费', '时效'],
    ['USPS-普货', '0.1-0.2KG', 115, 36, '6-9个工作日'],
    ['USPS-普货', '0.2-0.45KG', 115, 37, '6-9个工作日'],
    ['USPS-敏感', '0-0.2KG', 136, 43, '5-9个工作日']
  ];
  const res = grid.parseSheet(rows, { sheetName: '美国专线' });
  assert.strictEqual(res.kind, 'longTable');
  assert.deepStrictEqual(names(res), ['USPS-普货', 'USPS-敏感'], '按表里出现顺序，不重排');
  const p = find(res, 'USPS-普货');
  assert.strictEqual(p.tiers.length, 2, '两行应合并成两档，而不是两条渠道');
  assert.deepStrictEqual(p.tiers.map(t => t.wMin), [0.1, 0.2]);
  assert.strictEqual(p.regFee, 36);
  assert.strictEqual(p.transit, '6-9个工作日');
  assert.strictEqual(p.dests, '美国', '没有国家列时从工作表名推断');
});

test('longTable: 块标题当渠道名（表里没有渠道名称列时）', () => {
  const rows = [
    ['OCK标准-墨西哥-普货'],
    ['对接代码', '限重', '运费（RMB/KG）', '处理费（RMB/件）'],
    ['OCKBZ-MXG-PH', '0.05-0.25', 101, 20],
    ['OCKBZ-MXG-PH', '0.251-0.5', 101, 20]
  ];
  const res = grid.parseSheet(rows, { sheetName: 'OCK标准-墨西哥' });
  assert.strictEqual(res.kind, 'longTable');
  assert.strictEqual(res.channels[0].name, 'OCK标准-墨西哥-普货', '没有名称列时用上方块标题');
  assert.strictEqual(res.channels[0].dests, '墨西哥');
  assert.strictEqual(res.channels[0].tiers.length, 2);
});

test('grid: 目的地行 × 起运仓 × 重量档 → 各仓独立渠道', () => {
  const rows = [
    ['美转加正班海派（美森正班CLX）'],
    ['亚马逊仓库代码', '义乌仓（上海/宁波+0.5/KG）', '', '深圳/广州仓（泉州/福州+0.5/KG）', '', '航线'],
    ['亚马逊仓库代码', '21KG+', '101KG+', '21KG+', '101KG+', '航线'],
    ['多伦多 (YYZ1)', 21.34, 18.04, 21.89, 18.59, 'CLX'],
    ['温哥华 (YVR1)', 22.44, 19.14, 22.99, 19.69, 'CLX']
  ];
  const res = grid.parseSheet(rows, { sheetName: '美转加UPS派', defaultType: 'sea' });
  assert.strictEqual(res.kind, 'grid');
  assert.strictEqual(res.channels.length, 4, '2 个目的地 × 2 个起运仓');
  const c = res.channels.find(x => x.dests === '多伦多 (YYZ1)' && x.origin === '义乌仓（上海/宁波+0.5/KG）');
  assert.ok(c, '应能按目的地 + 起运仓定位：' + JSON.stringify(res.channels.map(x => [x.dests, x.origin])));
  assert.deepStrictEqual(c.tiers.map(t => t.wMin + ':' + t.price), ['21:21.34', '101:18.04']);
  assert.strictEqual(c.name, '美转加正班海派（美森正班CLX）');
});

test('grid: 行是渠道名（表头写「下单渠道」）时，目的地取工作表名', () => {
  const rows = [
    ['英国集运皇邮'],
    ['下单渠道', '单件0.05-20KG', '', '一票多件，单票低消20KG'],
    ['下单渠道', '运费/KG', '处理费RMB/票', '20-50KG', '101KG+'],
    ['英国空派P价-RM', 49, 16, 52, 49],
    ['英国空派F价-RM', 50, 16, 53, 50]
  ];
  const res = grid.parseSheet(rows, { sheetName: '英国集运皇邮', defaultType: 'air' });
  assert.strictEqual(res.kind, 'grid');
  assert.deepStrictEqual(names(res), ['英国空派P价-RM', '英国空派F价-RM']);
  const p = find(res, '英国空派P价-RM');
  assert.strictEqual(p.dests, '英国', '行是渠道时，目的地从工作表名取');
  assert.deepStrictEqual(p.tiers.map(t => t.wMin + ':' + t.price), ['0.05:49', '20:52', '101:49']);
  assert.strictEqual(p.regFee, 16, '处理费列应成为挂号费，而不是价格档');
});

test('calc: 重量档整票价按计费重落档，不乘重量', () => {
  assert.strictEqual(calc.tierTotalForWeight([{ wMin: 0.5, wMax: 1, price: 98.9 }, { wMin: 1, wMax: 1.5, price: 134.38 }], 0.5), 98.9);
  assert.strictEqual(calc.tierTotalForWeight([{ wMin: 0.5, wMax: 1, price: 98.9 }, { wMin: 1, wMax: 1.5, price: 134.38 }], 1.2), 134.38);
  assert.strictEqual(calc.tierTotalForWeight([{ wMin: 0.5, wMax: 1, price: 98.9 }], 0.2), 98.9, '不足首档按首档');

  const ch = {
    type: 'express', name: '美国空派小货', dests: '美国',
    wTiers: [{ wMin: 0.5, wMax: 1, price: 98.9 }, { wMin: 1, wMax: 1.5, price: 134.38 }]
  };
  const q1 = calc.computeQuote(ch, { weight: 0.5 });
  assert.strictEqual(q1.base, 98.9, '0.5kg 就是 98.9 元/票，不能算成 0.5×98.9');
  const q2 = calc.computeQuote(ch, { weight: 1.2 });
  assert.strictEqual(q2.base, 134.38);
  assert.ok(/整票价/.test(q1.mode), '计费说明应标出整票价');
});

function memPersistence() {
  let data = null;
  return {
    read: async () => (data == null ? require('../js/fsio.js').defaultData() : JSON.parse(JSON.stringify(data))),
    write: async (obj) => { data = JSON.parse(JSON.stringify(obj)); }
  };
}

test('store: 起运仓参与渠道唯一键，同渠道不同仓不会互相覆盖', async () => {
  const st = storeMod.createStore(memPersistence());
  await st.load();
  await st.upsertChannel({ name: 'CLX', carrier: '628', dests: '多伦多', origin: '义乌仓', priceKg: 21.34 });
  await st.upsertChannel({ name: 'CLX', carrier: '628', dests: '多伦多', origin: '深圳仓', priceKg: 21.89 });
  assert.strictEqual(st.getState().channels.length, 2, '两个起运仓应是两条');

  const r = await st.upsertChannel({ name: 'CLX', carrier: '628', dests: '多伦多', origin: '义乌仓', priceKg: 19.9 });
  assert.strictEqual(r.updated, true, '同仓同目的地应覆盖');
  assert.strictEqual(st.getState().channels.length, 2);
  assert.strictEqual(st.getState().channels.find(c => c.origin === '义乌仓').priceKg, 19.9);
});
