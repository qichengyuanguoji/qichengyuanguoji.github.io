const test = require('node:test');
const assert = require('node:assert');
require('../js/util.js');
require('../js/calc.js');
const home = require('../js/pages/home.js');

function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }
const inDays = (n) => require('../js/util.js').formatDate(new Date(Date.now() + n * 86400000));

const state = {
  channels: [
    { id: 'a', name: 'DHL', dests: 'US', createdAt: isoDaysAgo(1), validUntil: inDays(5) },
    { id: 'b', name: 'UPS', dests: 'US', createdAt: isoDaysAgo(3), validUntil: inDays(-3) },
    { id: 'c', name: 'FedEx', dests: 'UK', createdAt: isoDaysAgo(5), validUntil: inDays(30) },
    { id: 'd', name: '专线', dests: '', createdAt: isoDaysAgo(10), validUntil: '' }
  ],
  records: [
    { id: 'r1', type: 'freight', dest: 'US', freight: 42, createdAt: isoDaysAgo(2) },
    { id: 'r2', type: 'profit', dest: 'US', profit: 18, createdAt: isoDaysAgo(0) },
    { id: 'r3', type: 'profit', dest: 'UK', profit: 100, createdAt: isoDaysAgo(40) }
  ]
};

test('homeVM: 摘要聚合正确', () => {
  const vm = home.homeVM(state, {});
  assert.strictEqual(vm.summaries.channelCount, 4);
  assert.strictEqual(vm.summaries.recent7, 2); // r1(2天前), r2(今天)
  // expiring = over + soon = UPS(已过期) + DHL(5天后) = 2
  assert.strictEqual(vm.summaries.expiring, 2);
});

test('homeVM: 今日待办三类正确（over/soon/noDest）', () => {
  const vm = home.homeVM(state, {});
  assert.strictEqual(vm.todos.over.length, 1);
  assert.strictEqual(vm.todos.over[0].name, 'UPS');   // 已过期
  assert.strictEqual(vm.todos.soon.length, 1);
  assert.strictEqual(vm.todos.soon[0].name, 'DHL');   // 5天后到期
  assert.strictEqual(vm.todos.noDest.length, 1);
  assert.strictEqual(vm.todos.noDest[0].name, '专线'); // 未填目的地
});

test('homeVM: 最近记录取前3且按时间倒序', () => {
  const vm = home.homeVM(state, {});
  assert.strictEqual(vm.recentRecords.length, 3);
  assert.strictEqual(vm.recentRecords[0].id, 'r2'); // 今天
  assert.strictEqual(vm.recentRecords[1].id, 'r1'); // 2天前
});

test('homeVM: 最近渠道取前3按创建时间倒序', () => {
  const vm = home.homeVM(state, {});
  assert.strictEqual(vm.recentChannels.length, 3);
  assert.strictEqual(vm.recentChannels[0].id, 'a'); // 最近创建(1天前)
});

test('homeVM: 待办计数与首页卡片一致', () => {
  const vm = home.homeVM(state, {});
  const card = vm.todos.over.length + vm.todos.soon.length + vm.todos.noDest.length;
  assert.strictEqual(card, 3); // 1+1+1
});
