const test = require('node:test');
const assert = require('node:assert');
require('../js/util.js');
require('../js/calc.js');
const pr = require('../js/pages/profit.js');

test('calcProfitFor: 运费+货值+汇率+佣金 → 收入/成本/利润/毛利率', () => {
  const r = pr.calcProfitFor({ ship: 46, cost: 100, cur: 'CNY', price: 200, rate: 1, fee: 10, other: 6, qty: 1 });
  assert.strictEqual(r.revenue, 200);   // 200*1*1
  assert.strictEqual(r.fee, 20);        // 200*10%
  assert.strictEqual(r.cGoods, 100);    // 100*1
  assert.strictEqual(r.cOther, 6);      // 6*1
  assert.strictEqual(r.total, 172);     // 100+46+20+6
  assert.strictEqual(r.profit, 28);     // 200-172
  assert.ok(Math.abs(r.margin - 14) < 1e-6);     // 28/200*100
  assert.ok(Math.abs(r.shipRate - 23) < 1e-6);   // 46/200*100
});

test('calcProfitFor: 外币售价按汇率折算收入', () => {
  const r = pr.calcProfitFor({ ship: 0, cost: 0, cur: 'USD', price: 100, rate: 7, fee: 0, other: 0, qty: 1 });
  assert.strictEqual(r.revenue, 700);   // 100*7
  assert.strictEqual(r.profit, 700);
});

test('calcProfitFor: CNY 强制汇率=1（忽略传入的汇率）', () => {
  const r = pr.calcProfitFor({ ship: 0, cost: 0, cur: 'CNY', price: 100, rate: 7, fee: 0, other: 0, qty: 1 });
  assert.strictEqual(r.revenue, 100);   // 即使 rate=7 也按 1 算
});

test('calcProfitFor: 多件数按件数放大货值与收入，运费按整单计', () => {
  const r = pr.calcProfitFor({ ship: 10, cost: 50, cur: 'CNY', price: 100, rate: 1, fee: 0, other: 5, qty: 3 });
  assert.strictEqual(r.revenue, 300);   // 100*1*3
  assert.strictEqual(r.cGoods, 150);    // 50*3
  assert.strictEqual(r.cOther, 15);     // 5*3
  assert.strictEqual(r.total, 175);     // (50+5)*3 + 10(整单运费) + 0
  assert.strictEqual(r.profit, 125);
});

test('calcProfitFor: 亏损时毛利为负', () => {
  const r = pr.calcProfitFor({ ship: 100, cost: 200, cur: 'CNY', price: 100, rate: 1, fee: 0, other: 0, qty: 1 });
  assert.strictEqual(r.total, 300);
  assert.strictEqual(r.profit, -200);
  assert.strictEqual(r.margin, -200);   // -200/100*100 = -200
});

test('prefill: setPrefill 后 getPrefill 返回并清零', () => {
  pr.setPrefill(46);
  assert.strictEqual(pr.getPrefill(), 46);
  pr.setPrefill(null);
  assert.strictEqual(pr.getPrefill(), null);
});

test('prefill: 0 也能带入', () => {
  pr.setPrefill(0);
  assert.strictEqual(pr.getPrefill(), 0);
  pr.setPrefill(null);
});
