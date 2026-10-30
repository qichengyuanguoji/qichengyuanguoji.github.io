const test = require('node:test');
const assert = require('node:assert');
require('../js/util.js');
const rec = require('../js/pages/records.js');

function iso(daysAgo) { return new Date(Date.now() - daysAgo * 86400000).toISOString(); }

const records = [
  { id: '1', type: 'freight', createdAt: iso(0), country: 'US', weight: 2, channelName: 'DHL', freight: 54 },
  { id: '2', type: 'freight', createdAt: iso(10), country: 'UK', weight: 3, channelName: 'FedEx', freight: 40 },
  { id: '3', type: 'profit', createdAt: iso(0), country: 'US', weight: 2, channelName: 'UPS', freight: 49, profit: 18 }
];

test('filterRecords: 按目的地筛选', () => {
  assert.strictEqual(rec.filterRecords(records, { country: 'US' }).length, 2);
  assert.strictEqual(rec.filterRecords(records, { country: 'UK' }).length, 1);
});

test('filterRecords: 按渠道筛选', () => {
  assert.strictEqual(rec.filterRecords(records, { channel: 'DHL' }).length, 1);
  assert.strictEqual(rec.filterRecords(records, { channel: 'UPS' }).length, 1);
});

test('filterRecords: 日期范围筛选', () => {
  const today = require('../js/util.js').formatDate(new Date());
  const from3 = require('../js/util.js').formatDate(new Date(Date.now() - 3 * 86400000));
  assert.strictEqual(rec.filterRecords(records, { from: from3, to: today }).length, 2); // 排除10天前的
  assert.strictEqual(rec.filterRecords(records, { from: today, to: today }).length, 2); // 仅今天两条
});

test('filterRecords: 组合条件', () => {
  const today = require('../js/util.js').formatDate(new Date());
  assert.strictEqual(rec.filterRecords(records, { country: 'US', from: today, to: today }).length, 2);
});

test('options: 去重排序', () => {
  assert.deepStrictEqual(rec.countryOptions(records), ['UK', 'US']);
  assert.deepStrictEqual(rec.channelOptions(records), ['DHL', 'FedEx', 'UPS']);
});
