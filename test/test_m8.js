const test = require('node:test');
const assert = require('node:assert');

// 按浏览器加载顺序引入所有模块，捕获任何加载期错误（语法/引用）
require('../js/util.js');
require('../js/db.js');
require('../js/fsio.js');
require('../js/store.js');
require('../js/calc.js');
require('../js/router.js');
require('../js/pages/home.js');
require('../js/pages/freight.js');
require('../js/pages/channels.js');
require('../js/pages/profit.js');
require('../js/pages/records.js');
require('../js/pages/settings.js');
require('../js/app.js');

const App = global.App;

function memStore() {
  let d = null;
  return {
    read: async () => (d == null ? App.fsio.defaultData() : JSON.parse(JSON.stringify(d))),
    write: async (o) => { d = JSON.parse(JSON.stringify(o)); }
  };
}

const baseQ = { dest: '', type: 'all', weight: 2, pcs: 1, len: 30, wid: 20, hgt: 20, factor: 6000, remote: 0, other: 0, cargo: '', amazon: 'no', whCode: '', zip: '' };

test('所有模块成功加载且页面导出齐全', () => {
  assert.ok(App.util && App.fsio && App.store && App.calc && App.router, '核心模块缺失');
  for (const p of ['home', 'freight', 'channels', 'profit', 'records', 'settings']) {
    assert.ok(App.pages[p] && typeof App.pages[p].render === 'function', '页面缺失或无可渲染: ' + p);
  }
});

test('集成：渠道→运费比价→利润→首页聚合 全链路一致', async () => {
  const storeMod = require('../js/store.js');
  const store = storeMod.createStore(memStore());
  await store.load();
  App.store.instance = store;
  const settings = store.getSettings();

  const dhl = await store.addChannel({ name: 'DHL', carrier: 'DHL', type: 'express', dests: 'US', firstW: 1, firstP: 30, addU: 0.5, addP: 8, divisor: 6000 });
  const q = Object.assign({}, baseQ, { dest: 'US' });
  const res = App.pages.freight.computeAll([dhl], q);
  assert.strictEqual(res.length, 1);
  assert.strictEqual(res[0].total, 46); // DHL express: 30 + ceil(1/0.5)*8
  assert.strictEqual(res[0].cheapest, true);

  await store.addRecord({ type: 'freight', dest: 'US', country: 'US', weight: 2, pcs: 1, cbm: res[0].cbm, type2: res[0].ch.type, channelId: dhl.id, channelName: dhl.name, freight: res[0].total });
  const prof = App.pages.profit.calcProfitFor({ ship: res[0].total, cost: 60, cur: 'CNY', price: 150, rate: 1, fee: 10, other: 0, qty: 1 });
  assert.strictEqual(prof.revenue, 150);  // 150*1
  assert.strictEqual(prof.fee, 15);       // 150*10%
  assert.strictEqual(prof.total, 121);    // 60 + 46 + 15 + 0
  assert.strictEqual(prof.profit, 29);    // 150-121

  const vm = App.pages.home.homeVM(store.getState(), settings);
  assert.strictEqual(vm.summaries.channelCount, 1);
  assert.strictEqual(vm.summaries.recent7, 1);
  assert.strictEqual(vm.recentRecords.length, 1);
});

test('集成：比价与筛选在全链路中保持正确', async () => {
  const storeMod = require('../js/store.js');
  const store = storeMod.createStore(memStore());
  await store.load();
  await store.addChannel({ name: 'DHL', carrier: 'DHL', type: 'express', dests: 'US', firstW: 1, firstP: 30, addU: 0.5, addP: 8, divisor: 6000 });
  await store.addChannel({ name: 'UPS', carrier: 'UPS', type: 'express', dests: 'US', firstW: 1, firstP: 28, addU: 0.5, addP: 7, divisor: 6000 });
  await store.addChannel({ name: 'FedEx', carrier: 'FedEx', type: 'express', dests: 'UK', firstW: 1, firstP: 35, addU: 0.5, addP: 9, divisor: 6000 });

  const q = Object.assign({}, baseQ, { dest: 'US' });
  const cmp = App.pages.freight.computeAll(store.getState().channels, q);
  assert.strictEqual(cmp[0].ch.name, 'UPS');   // 42 最便宜
  assert.strictEqual(cmp[0].total, 42);     // 28 + ceil(1/0.5)*7

  const filtered = App.pages.channels.filterChannels(store.getState().channels, { dest: 'UK' });
  assert.strictEqual(filtered.length, 1);
});
