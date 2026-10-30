const test = require('node:test');
const assert = require('node:assert');
require('../js/util.js');
require('../js/calc.js');
const ch = require('../js/pages/channels.js');

const sample = [
  { id: '1', name: 'DHL', carrier: 'DHL', type: 'express', dests: 'US', firstW: 1, firstP: 30, addU: 0.5, addP: 8, validUntil: '2026-11-30' },
  { id: '2', name: 'UPS红单', carrier: 'UPS', type: 'express', dests: 'US', firstW: 1, firstP: 28, addU: 0.5, addP: 7, validUntil: '2026-11-30' },
  { id: '3', name: 'FedEx', carrier: 'FedEx', type: 'air', dests: 'UK', priceKg: 35, validUntil: '2026-11-30' },
  { id: '4', name: '欧洲专线', carrier: '专线', type: 'express', dests: 'DE', firstW: 1, firstP: 20, addU: 0.5, addP: 5, validUntil: '2026-11-30' }
];

test('filterChannels: 按目的地(dests)筛选', () => {
  assert.strictEqual(ch.filterChannels(sample, { dest: 'US' }).length, 2);
  assert.strictEqual(ch.filterChannels(sample, { dest: 'UK' }).length, 1);
  assert.strictEqual(ch.filterChannels(sample, { dest: 'JP' }).length, 0);
});

test('filterChannels: 按承运商筛选', () => {
  assert.strictEqual(ch.filterChannels(sample, { carrier: 'DHL' }).length, 1);
  assert.strictEqual(ch.filterChannels(sample, { carrier: '专线' }).length, 1);
});

test('filterChannels: 搜索覆盖名称/承运商/目的地', () => {
  assert.strictEqual(ch.filterChannels(sample, { search: 'ups' }).length, 1);
  assert.strictEqual(ch.filterChannels(sample, { search: 'us' }).length, 2);
});

test('filterChannels: 组合条件', () => {
  assert.strictEqual(ch.filterChannels(sample, { dest: 'US', carrier: 'UPS' }).length, 1);
});

test('options: 目的地去重并排序', () => {
  assert.deepStrictEqual(ch.destOptions(sample), ['DE', 'UK', 'US']);
  assert.deepStrictEqual(ch.carrierOptions(sample), ['DHL', 'FedEx', 'UPS', '专线']);
});

test('rowClass: 临近到期底色分类（按 validUntil）', () => {
  const U = require('../js/util.js');
  const in5 = U.formatDate(new Date(Date.now() + 5 * 86400000));
  const in10 = U.formatDate(new Date(Date.now() + 10 * 86400000));
  const in30 = U.formatDate(new Date(Date.now() + 30 * 86400000));
  assert.strictEqual(ch.rowClass(in5), 'row-red');
  assert.strictEqual(ch.rowClass(in10), 'row-orange');
  assert.strictEqual(ch.rowClass(in30), '');
  assert.strictEqual(ch.rowClass(''), '');
  assert.strictEqual(ch.rowClass(U.formatDate(new Date(Date.now() - 86400000))), 'row-red');
});

/* ---- 表头筛选 / 排序（v2.9）---- */
function ymdPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const p = n => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
const sortable = [
  { id: 'a', name: '乙渠道', carrier: '436', dests: '美西', validUntil: ymdPlus(-3) },   // 已过期
  { id: 'b', name: '甲渠道', carrier: '', dests: '美中', validUntil: ymdPlus(3) },      // 7天内
  { id: 'c', name: '丙渠道', carrier: '1288', dests: '美东', validUntil: ymdPlus(10) },  // 15天内
  { id: 'd', name: '丁渠道', carrier: '436', dests: '欧洲', validUntil: ymdPlus(40) },   // 正常
  { id: 'e', name: '戊渠道', carrier: '1288', dests: '日本', validUntil: '' }            // 未设置
];

test('expiryState: 已过期 / 7天内 / 15天内 / 正常 / 未设置', () => {
  assert.strictEqual(ch.expiryState(ymdPlus(-1)), 'expired');
  assert.strictEqual(ch.expiryState(ymdPlus(2)), 'red');
  assert.strictEqual(ch.expiryState(ymdPlus(9)), 'orange');
  assert.strictEqual(ch.expiryState(ymdPlus(30)), 'normal');
  assert.strictEqual(ch.expiryState(''), 'none');
});

test('filterChannels: 渠道商多选（含未填渠道商）', () => {
  assert.strictEqual(ch.filterChannels(sortable, { carriers: ['436'] }).length, 2);
  assert.strictEqual(ch.filterChannels(sortable, { carriers: ['436', '1288'] }).length, 4);
  assert.strictEqual(ch.filterChannels(sortable, { carriers: [''] }).length, 1);
  assert.strictEqual(ch.filterChannels(sortable, { carriers: [] }).length, 5, '空数组=不限');
});

test('filterChannels: 有效期/状态多选', () => {
  assert.deepStrictEqual(ch.filterChannels(sortable, { expiry: ['expired'] }).map(c => c.id), ['a']);
  assert.deepStrictEqual(ch.filterChannels(sortable, { expiry: ['red', 'orange'] }).map(c => c.id), ['b', 'c']);
  assert.deepStrictEqual(ch.filterChannels(sortable, { expiry: ['none'] }).map(c => c.id), ['e']);
});

test('filterChannels: 渠道商 + 状态 + 搜索 组合', () => {
  const r = ch.filterChannels(sortable, { carriers: ['436'], expiry: ['expired', 'normal'] });
  assert.deepStrictEqual(r.map(c => c.id), ['a', 'd']);
  assert.deepStrictEqual(ch.filterChannels(sortable, { carriers: ['436'], search: '欧洲' }).map(c => c.id), ['d']);
});

test('sortChannels: 渠道商升序 / 降序，空值始终最后', () => {
  assert.deepStrictEqual(ch.sortChannels(sortable, 'carrier', 'asc').map(c => c.carrier), ['1288', '1288', '436', '436', '']);
  assert.deepStrictEqual(ch.sortChannels(sortable, 'carrier', 'desc').map(c => c.carrier), ['436', '436', '1288', '1288', '']);
});

test('sortChannels: 有效期升序 / 降序，未设置始终最后', () => {
  assert.deepStrictEqual(ch.sortChannels(sortable, 'validUntil', 'asc').map(c => c.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(ch.sortChannels(sortable, 'validUntil', 'desc').map(c => c.id), ['d', 'c', 'b', 'a', 'e']);
});

test('sortChannels: 状态按紧迫度排序（已过期→正常→未设置）', () => {
  assert.deepStrictEqual(ch.sortChannels(sortable, 'status', 'asc').map(c => c.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(ch.sortChannels(sortable, 'status', 'desc').map(c => c.id), ['d', 'c', 'b', 'a', 'e']);
});

test('sortChannels: 不排序时保持原顺序，且不修改原数组', () => {
  const copy = sortable.slice();
  assert.deepStrictEqual(ch.sortChannels(sortable, '', '').map(c => c.id), ['a', 'b', 'c', 'd', 'e']);
  assert.deepStrictEqual(sortable.map(c => c.id), copy.map(c => c.id));
  const sorted = ch.sortChannels(sortable, 'carrier', 'asc');
  assert.notStrictEqual(sorted, sortable);
});

test('排序 + 筛选 可叠加', () => {
  const flt = ch.filterChannels(sortable, { carriers: ['436', '1288'] });
  assert.deepStrictEqual(ch.sortChannels(flt, 'validUntil', 'desc').map(c => c.id), ['d', 'c', 'a', 'e']);
});
