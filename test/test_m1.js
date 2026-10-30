const test = require('node:test');
const assert = require('node:assert');
const calc = require('../js/calc.js');

test('calcFreight: 体积重取大值 + 续重计费', () => {
  const r = calc.calcFreight({ actualWeight: 2, length: 30, width: 20, height: 20, volRatio: 5000, firstWeight: 1, firstPrice: 30, addPrice: 8, weightStep: 0.5 });
  assert.strictEqual(r.volWeight, 2.4);
  assert.strictEqual(r.chargeWeight, 2.4);
  assert.strictEqual(r.addUnits, 3); // ceil((2.4-1)/0.5)=ceil(2.8)=3
  assert.strictEqual(r.freight, 54); // 30 + 8*3
});

test('calcFreight: 无尺寸时体积重为0，按实际重量计费', () => {
  const r = calc.calcFreight({ actualWeight: 3, firstWeight: 1, firstPrice: 30, addPrice: 8, weightStep: 0.5 });
  assert.strictEqual(r.volWeight, 0);
  assert.strictEqual(r.chargeWeight, 3);
  assert.strictEqual(r.addUnits, 4); // ceil(2/0.5)=4
  assert.strictEqual(r.freight, 62); // 30 + 8*4
});

test('calcFreight: 实际重量大于体积重时按实际', () => {
  const r = calc.calcFreight({ actualWeight: 10, length: 10, width: 10, height: 10, volRatio: 5000, firstWeight: 1, firstPrice: 30, addPrice: 8, weightStep: 0.5 });
  assert.strictEqual(r.volWeight, 0.2);
  assert.strictEqual(r.chargeWeight, 10);
  assert.strictEqual(r.freight, 30 + 8 * 18); // ceil(9/0.5)=18
});

test('calcFreight: 默认值兜底（缺省参数不报错）', () => {
  const r = calc.calcFreight({ actualWeight: 1 });
  assert.strictEqual(r.chargeWeight, 1);
  assert.strictEqual(r.addUnits, 0);
  assert.strictEqual(r.freight, 0);
});

test('calcProfit: 成本+利润率 → 报价/利润/利润率', () => {
  const r = calc.calcProfit({ freightCost: 54, otherCost: 6, profitRate: 30 });
  assert.strictEqual(r.totalCost, 60);
  assert.strictEqual(r.quote, 78); // 60*1.3
  assert.strictEqual(r.profit, 18);
  assert.strictEqual(r.margin, 23.08); // 18/78
});

test('calcProfit: 零利润率时利润为零', () => {
  const r = calc.calcProfit({ freightCost: 50, otherCost: 10, profitRate: 0 });
  assert.strictEqual(r.totalCost, 60);
  assert.strictEqual(r.quote, 60);
  assert.strictEqual(r.profit, 0);
  assert.strictEqual(r.margin, 0);
});

test('calcProfit: 缺省参数不抛错', () => {
  const r = calc.calcProfit({});
  assert.strictEqual(r.totalCost, 0);
  assert.strictEqual(r.quote, 0);
  assert.strictEqual(r.profit, 0);
});
