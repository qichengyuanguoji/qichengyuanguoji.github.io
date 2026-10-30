const test = require('node:test');
const assert = require('node:assert');
const calc = require('../js/calc.js');

const Q = (o) => Object.assign({ dest: 'US', type: 'all', weight: 2, pcs: 1, len: 0, wid: 0, hgt: 0, factor: 5000, remote: 0, other: 0, cargo: '', whCode: '', zip: '' }, o);

test('express: 首重+续重 计费', () => {
  const ch = { type: 'express', firstW: 1, firstP: 50, addU: 0.5, addP: 20, divisor: 5000, discount: 100, fuel: 0, regFee: 0, remoteFee: 0 };
  const r = calc.computeQuote(ch, Q({ weight: 2 }));
  // cw=2; base = 50 + ceil((2-1)/0.5)*20 = 50+40=90
  assert.strictEqual(r.cw, 2);
  assert.strictEqual(r.base, 90);
  assert.strictEqual(r.total, 90);
});

test('express: 阶梯价低于快递算法时取阶梯价', () => {
  const ch = { type: 'express', firstW: 1, firstP: 50, addU: 0.5, addP: 20, divisor: 5000, tiers: [{ wMin: 21, wMax: null, price: 15 }] };
  const r = calc.computeQuote(ch, Q({ weight: 30 }));
  // 快递: 50 + ceil(29/0.5)*20 = 50+1160=1210; 阶梯: 30*15=450 -> 取450
  assert.strictEqual(r.base, 450);
  assert.ok(r.mode.indexOf('阶梯价') >= 0);
});

test('express: 重量不足起重时补到起重', () => {
  const ch = { type: 'express', firstW: 1, firstP: 30, addU: 1, addP: 10, minW: 5, divisor: 5000 };
  const r = calc.computeQuote(ch, Q({ weight: 2 }));
  // cw = max(2,0,5)=5; base=30 + ceil((5-1)/1)*10 = 30+40=70
  assert.strictEqual(r.cw, 5);
  assert.strictEqual(r.base, 70);
});

test('air: 按体积重计费（体积重>实重）', () => {
  const ch = { type: 'air', priceKg: 30, priceCbm: 0, minCharge: 0, divisor: 6000 };
  // 100x100x100cm, pcs=1 -> 体积重=1000000/6000=166.67; cbm=1.0
  const r = calc.computeQuote(ch, Q({ weight: 10, len: 100, wid: 100, hgt: 100, factor: 6000 }));
  assert.ok(Math.abs(r.volW - 166.67) < 0.01);
  assert.ok(Math.abs(r.cw - 166.67) < 0.01);
  assert.ok(Math.abs(r.cbm - 1.0) < 0.0001);
  // byW=166.67*30=5000, byV=0 -> base=5000
  assert.ok(Math.abs(r.base - 5000) < 0.5);
  assert.ok(r.mode.indexOf('按重') >= 0);
});

test('sea: 按体积(CBM)计费', () => {
  const ch = { type: 'sea', priceKg: 0, priceCbm: 100, minCharge: 0, divisor: 5000 };
  const r = calc.computeQuote(ch, Q({ weight: 10, len: 100, wid: 100, hgt: 100, factor: 5000 }));
  // cbm=1.0, byV=100, byW=0 -> base=100
  assert.ok(Math.abs(r.base - 100) < 0.5);
  assert.ok(r.mode.indexOf('按体积') >= 0);
});

test('air: 重量阶梯价取段单价', () => {
  const ch = { type: 'air', priceKg: 40, priceCbm: 0, minCharge: 0, tiers: [{ wMin: 0, wMax: 100, price: 40 }, { wMin: 100, wMax: null, price: 25 }] };
  const r = calc.computeQuote(ch, Q({ weight: 200, len: 0, wid: 0, hgt: 0 }));
  // cw=200; 阶梯 -> 25/kg; byW=200*25=5000
  assert.ok(Math.abs(r.base - 5000) < 0.5);
  assert.ok(r.mode.indexOf('阶梯价') >= 0);
});

test('附加费: 折扣+燃油+挂号+偏远+杂费 叠加', () => {
  const ch = { type: 'express', firstW: 1, firstP: 50, addU: 0.5, addP: 20, discount: 90, fuel: 10, regFee: 5, remoteFee: 0, divisor: 5000 };
  const r = calc.computeQuote(ch, Q({ weight: 2, remote: 3, other: 2 }));
  // base=90; disc=90*0.9=81; fuel=81*0.1=8.1; reg=5; remote=0+3=3; other=2; total=81+8.1+5+3+2=99.1
  assert.ok(Math.abs(r.disc - 81) < 1e-6);
  assert.ok(Math.abs(r.fuel - 8.1) < 1e-6);
  assert.ok(Math.abs(r.total - 99.1) < 1e-6);
});

test('渠道自带 divisor 优先于查询 factor', () => {
  const ch = { type: 'air', priceKg: 10, priceCbm: 0, minCharge: 0, divisor: 5000 };
  const r = calc.computeQuote(ch, Q({ weight: 1, len: 50, wid: 50, hgt: 50, factor: 6000 }));
  // 用 5000: 体积重=125000/5000=25; factor 6000 应被忽略
  assert.ok(Math.abs(r.volW - 25) < 0.01);
});

test('matchChannels: 类型过滤 + 目的地模糊匹配', () => {
  const chs = [
    { type: 'express', dests: 'US 美国', name: 'A' },
    { type: 'air', dests: 'US 美国', name: 'B' },
    { type: 'express', dests: 'DE 德国', name: 'C' }
  ];
  const onlyAir = calc.matchChannels(chs, Q({ type: 'air', dest: 'US' }));
  assert.strictEqual(onlyAir.length, 1);
  assert.strictEqual(onlyAir[0].name, 'B');
  const usAll = calc.matchChannels(chs, Q({ dest: '美国' }));
  assert.strictEqual(usAll.length, 2);
});

test('matchChannels: 仅派仓渠道需填仓库代码', () => {
  const chs = [{ type: 'express', dests: 'ONT8 LAX9', name: '卡派' }];
  assert.strictEqual(calc.matchChannels(chs, Q({ dest: 'US', whCode: '' })).length, 0);
  assert.strictEqual(calc.matchChannels(chs, Q({ dest: 'US', whCode: 'ONT8' })).length, 1);
});

test('validState: 已过期/将到期/有效 分类', () => {
  const over = { validUntil: '2026-10-20' };
  const soon = { validUntil: '2026-11-02' }; // 距 2026-10-28 约5天
  const ok = { validUntil: '2027-01-01' };
  const none = {};
  assert.strictEqual(calc.validState(over, '2026-10-28').st, 'over');
  assert.strictEqual(calc.validState(soon, '2026-10-28').st, 'soon');
  assert.strictEqual(calc.validState(ok, '2026-10-28').st, 'ok');
  assert.strictEqual(calc.validState(none, '2026-10-28').st, 'none');
});

test('todayTodos: 三类分类', () => {
  const chs = [
    { name: 'a', dests: 'US', validUntil: '2026-10-20' },     // over
    { name: 'b', dests: 'US', validUntil: '2026-11-02' },     // soon
    { name: 'c', dests: '' },                                  // noDest
    { name: 'd', dests: 'US', validUntil: '2027-01-01' }       // ok
  ];
  const t = calc.todayTodos(chs, '2026-10-28');
  assert.strictEqual(t.over.length, 1);
  assert.strictEqual(t.soon.length, 1);
  assert.strictEqual(t.noDest.length, 1);
});

test('computeProfit v2: 含币种/汇率/佣金', () => {
  const p = { ship: 100, cost: 200, cur: 'USD', price: 50, rate: 7, fee: 15, other: 10, qty: 2 };
  const r = calc.computeProfit(p);
  // revenue=50*7*2=700; cGoods=400; cOther=20; fee=105; total=400+100+105+20=625; profit=75; margin=10.714%
  assert.ok(Math.abs(r.revenue - 700) < 1e-6);
  assert.ok(Math.abs(r.total - 625) < 1e-6);
  assert.ok(Math.abs(r.profit - 75) < 1e-6);
  assert.ok(Math.abs(r.margin - 10.7142857) < 0.001);
  assert.ok(Math.abs(r.breakEven - 44.642857) < 0.001); // 625/2/7
});

test('computeProfit v2: CNY 汇率=1', () => {
  const p = { ship: 0, cost: 100, cur: 'CNY', price: 200, rate: 1, fee: 10, other: 0, qty: 1 };
  const r = calc.computeProfit(p);
  // revenue=200; fee=20; total=100+0+20+0=120; profit=80; margin=40%
  assert.ok(Math.abs(r.revenue - 200) < 1e-6);
  assert.ok(Math.abs(r.profit - 80) < 1e-6);
  assert.ok(Math.abs(r.margin - 40) < 1e-6);
});

test('matchChannels: 目的地同义词（价格表写“美西”，用户输“美国/US”也能匹配）', () => {
  const chs = [
    { type: 'sea', name: '海运A', dests: '美西（邮编8，9）' },
    { type: 'air', name: '空运B', dests: 'DE EU' }
  ];
  const names = (q) => calc.matchChannels(chs, Q(q)).map(c => c.name);
  assert.deepStrictEqual(names({ dest: '美国', type: 'all', zip: '' }), ['海运A']);
  assert.deepStrictEqual(names({ dest: 'US', type: 'all', zip: '' }), ['海运A']);
  assert.deepStrictEqual(names({ dest: '美西', type: 'all', zip: '' }), ['海运A']);
  assert.deepStrictEqual(names({ dest: '德国', type: 'all', zip: '' }), ['空运B']);
  // 不应因缩写误匹配（sea 不应命中 seattle）
  assert.deepStrictEqual(names({ dest: 'seattle', type: 'all', zip: '' }), []);
});

test('海运卡派：同时有「重量阶梯 + 体积阶梯」，小货按重量计费不硬抬 1CBM', () => {
  // 088 价格表卡派页的典型结构：包税(12KG+) = 12.419 元/kg，包税(1CBM+) = 2483.8 元/CBM
  const ch = {
    type: 'sea', tiers: [{ wMin: 12, wMax: null, price: 12.419 }],
    cbmTiers: [{ cMin: 1, cMax: null, price: 2483.8 }], divisor: 6000
  };
  // 20kg / 0.1CBM：byW=248.38，若把体积抬到 1CBM 会变成 2483.8（错误）
  const r = calc.computeQuote(ch, Q({ weight: 20, len: 100, wid: 100, hgt: 10 }));
  assert.ok(Math.abs(r.base - 248.38) < 0.5, '应按重量 248.38，实际 ' + r.base);
  assert.ok(r.mode.indexOf('按重') >= 0);

  // 100kg / 1.2CBM：体积重 200 → byW=2483.8，byV=1.2*2483.8=2980.56 → 取大
  const r2 = calc.computeQuote(ch, Q({ weight: 100, len: 120, wid: 100, hgt: 100 }));
  assert.ok(Math.abs(r2.base - 2980.56) < 1, '应取体积 2980.56，实际 ' + r2.base);
  assert.ok(r2.mode.indexOf('按体积') >= 0);
});

test('纯体积报价：体积不足首档时按首档兜底（≥1CBM 起计）', () => {
  const ch = { type: 'sea', priceCbm: 2000, cbmTiers: [{ cMin: 1, cMax: null, price: 2000 }], divisor: 6000 };
  // 0.5CBM 且无重量价 → 按 1CBM 计 = 2000
  const r = calc.computeQuote(ch, Q({ weight: 1, len: 100, wid: 100, hgt: 50 }));
  assert.ok(Math.abs(r.base - 2000) < 1, '纯体积报价应兜底到 1CBM，实际 ' + r.base);
});

/* ============ 价格更新计划（几天后更新价格表） ============ */
test('normUpdateDays: 非法值回落到默认，合法值限幅 1~365', () => {
  assert.strictEqual(calc.normUpdateDays(15), 15);
  assert.strictEqual(calc.normUpdateDays('10'), 10);
  assert.strictEqual(calc.normUpdateDays(7.4), 7, '小数四舍五入');
  assert.strictEqual(calc.normUpdateDays(''), 7, '空值用默认 7');
  assert.strictEqual(calc.normUpdateDays('abc'), 7);
  assert.strictEqual(calc.normUpdateDays(0), 7, '0 天无意义，回落默认');
  assert.strictEqual(calc.normUpdateDays(-3), 7);
  assert.strictEqual(calc.normUpdateDays(999), 365, '上限 365');
  assert.strictEqual(calc.normUpdateDays('abc', 20), 20, '可指定默认值');
});

test('updateDueDate: 今天 + N 天（跨月进位、指定基准日）', () => {
  assert.strictEqual(calc.updateDueDate(7, '2026-10-29'), '2026-11-05');
  assert.strictEqual(calc.updateDueDate(1, '2026-10-31'), '2026-11-01', '跨月');
  assert.strictEqual(calc.updateDueDate(30, '2026-12-15'), '2027-01-14', '跨年');
  assert.strictEqual(calc.updateDueDate(15, '2026-10-29'), '2026-11-13');
  assert.strictEqual(calc.updateDueDate(0, '2026-10-29'), '2026-11-05', '非法天数按 7 天');
});

test('dueChannels: 只含已过期 + 即将到期，未设有效期/正常的不进；同渠道不重复', () => {
  const list = [
    { id: 'a', name: 'A', validUntil: '2026-10-20' }, // 已过期
    { id: 'b', name: 'B', validUntil: '2026-11-02' }, // 4 天后 → 临期
    { id: 'c', name: 'C', validUntil: '2026-12-30' }, // 正常
    { id: 'd', name: 'D', validUntil: '' },           // 未设有效期
    { id: 'e', name: 'E', validUntil: '2026-10-01' }  // 已过期
  ];
  const due = calc.dueChannels(list, '2026-10-29');
  assert.deepStrictEqual(due.map(c => c.id), ['e', 'a', 'b'], '按到期日从早到晚');
  assert.strictEqual(calc.dueChannels([], '2026-10-29').length, 0);
});
