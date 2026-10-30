const test = require('node:test');
const assert = require('node:assert');
require('../js/util.js');
require('../js/calc.js');
const fr = require('../js/pages/freight.js');

const channels = [
  { id: 'dhl', name: 'DHL', carrier: 'DHL', type: 'express', dests: 'US', firstW: 1, firstP: 30, addU: 0.5, addP: 8, discount: 100, fuel: 0, regFee: 0, remoteFee: 0, divisor: 6000 },
  { id: 'ups', name: 'UPS红单', carrier: 'UPS', type: 'express', dests: 'US', firstW: 1, firstP: 28, addU: 0.5, addP: 7, discount: 100, fuel: 0, regFee: 0, remoteFee: 0, divisor: 6000 },
  { id: 'fx', name: 'FedEx', carrier: 'FedEx', type: 'express', dests: 'UK', firstW: 1, firstP: 35, addU: 0.5, addP: 9, discount: 100, fuel: 0, regFee: 0, remoteFee: 0, divisor: 6000 },
  { id: 'sea1', name: '美森海运', carrier: '美森', type: 'sea', dests: 'US', priceKg: 5, priceCbm: 800, discount: 100, fuel: 0, regFee: 0, remoteFee: 0, divisor: 6000, minCharge: 0 }
];

const baseQ = { dest: '', type: 'all', weight: 2, pcs: 1, len: 30, wid: 20, hgt: 20, factor: 6000, remote: 0, other: 0, cargo: '', amazon: 'no', whCode: '', zip: '' };

test('computeAll: 同目的地按总价升序且标记最便宜', () => {
  const q = Object.assign({}, baseQ, { dest: 'US' });
  const res = fr.computeAll(channels, q);
  // US 匹配: 美森海运(10) < UPS红单(42) < DHL(46)
  assert.strictEqual(res.length, 3);
  assert.strictEqual(res[0].ch.name, '美森海运');
  assert.strictEqual(res[0].total, 10);
  assert.strictEqual(res[0].cheapest, true);
  assert.strictEqual(res[1].ch.name, 'UPS红单');
  assert.strictEqual(res[1].total, 42); // 28 + ceil(1/0.5)*7
  assert.strictEqual(res[2].ch.name, 'DHL');
  assert.strictEqual(res[2].total, 46); // 30 + ceil(1/0.5)*8
});

test('computeAll: 仅按目的地匹配（UK 仅 FedEx）', () => {
  const q = Object.assign({}, baseQ, { dest: 'UK' });
  const res = fr.computeAll(channels, q);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].ch.name, 'FedEx');
  assert.strictEqual(res[0].total, 53); // 35 + ceil(1/0.5)*9
  assert.strictEqual(res[0].cheapest, true);
});

test('computeAll: 无匹配目的地返回空', () => {
  const q = Object.assign({}, baseQ, { dest: 'JP' });
  assert.strictEqual(fr.computeAll(channels, q).length, 0);
});

test('computeAll: 类型过滤只返回该类型', () => {
  const q = Object.assign({}, baseQ, { dest: 'US', type: 'express' });
  const res = fr.computeAll(channels, q);
  assert.strictEqual(res.length, 2);
  assert.ok(res.every(r => r.ch.type === 'express'));
  assert.strictEqual(res[0].ch.name, 'UPS红单');
  assert.strictEqual(res[0].cheapest, true);
});

test('computeAll: 体积重影响计费重（空运按体积重计费）', () => {
  // 60*50*40=120000 cm³，空运÷6000=20kg 体积重 vs 实重2kg → 计费重取20
  const air = { id: 'air1', name: '空运A', carrier: 'A', type: 'air', dests: 'US', priceKg: 10, discount: 100, fuel: 0, regFee: 0, remoteFee: 0, divisor: 6000 };
  const q = Object.assign({}, baseQ, { dest: 'US', weight: 2, len: 60, wid: 50, hgt: 40, type: 'all' });
  const res = fr.computeAll([air], q);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].cw, 20); // max(2, 20)
  assert.strictEqual(res[0].total, 200); // 20*10
});

test('computeAll: 仅一个 cheapest 标记', () => {
  const q = Object.assign({}, baseQ, { dest: 'US' });
  const res = fr.computeAll(channels, q);
  assert.strictEqual(res.filter(r => r.cheapest).length, 1);
});
