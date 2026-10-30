const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');

const util = require('../js/util.js');
const fsio = require('../js/fsio.js');
const storeMod = require('../js/store.js');

function memPersistence(initial) {
  let data = initial != null ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    read: async () => (data == null ? fsio.defaultData() : JSON.parse(JSON.stringify(data))),
    write: async (obj) => { data = JSON.parse(JSON.stringify(obj)); }
  };
}
function filePersistence(p) {
  return {
    read: async () => {
      try { return JSON.parse(await fs.readFile(p, 'utf8')); }
      catch (e) { if (e.code === 'ENOENT') return fsio.defaultData(); throw e; }
    },
    write: async (obj) => { await fs.writeFile(p, JSON.stringify(obj, null, 2), 'utf8'); }
  };
}

test('util: daysUntil 与 expiryStatus', () => {
  const in5 = util.formatDate(new Date(Date.now() + 5 * 86400000));
  const in10 = util.formatDate(new Date(Date.now() + 10 * 86400000));
  const in30 = util.formatDate(new Date(Date.now() + 30 * 86400000));
  assert.strictEqual(util.expiryStatus(in5), 'red');
  assert.strictEqual(util.expiryStatus(in10), 'orange');
  assert.strictEqual(util.expiryStatus(in30), 'normal');
  assert.strictEqual(util.expiryStatus(''), 'none');
  assert.strictEqual(util.expiryStatus(util.formatDate(new Date(Date.now() - 86400000))), 'expired');
});

test('util: computeSummaries 正确聚合', () => {
  const now = new Date();
  const twoDaysAgo = new Date(now.getTime() - 2 * 86400000).toISOString();
  const monthAgo = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString();
  const state = {
    channels: [
      { id: 'c1', validUntil: util.formatDate(new Date(Date.now() + 5 * 86400000)) },
      { id: 'c2', validUntil: '' }
    ],
    records: [
      { type: 'freight', createdAt: twoDaysAgo },
      { type: 'profit', createdAt: twoDaysAgo, profit: 20 },
      { type: 'profit', createdAt: monthAgo, profit: 100 }
    ]
  };
  const s = util.computeSummaries(state);
  assert.strictEqual(s.channelCount, 2);
  assert.strictEqual(s.recent7, 2);
  assert.strictEqual(s.expiring, 1); // 仅 c1 临近
  assert.strictEqual(s.monthProfit, 20); // 仅本月 profit
});

test('store: 默认值合并到 settings', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  assert.strictEqual(s.getSettings().currency, '¥');
  assert.strictEqual(s.getSettings().volRatio, 5000);
  assert.strictEqual(s.getSettings().weightStep, 0.5);
});

test('store: 渠道 CRUD 与持久化', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  const ch = await s.addChannel({ name: 'DHL', carrier: 'DHL', country: 'US', firstPrice: 30, addPrice: 8 });
  assert.ok(ch.id);
  assert.strictEqual(s.getState().channels.length, 1);
  await s.updateChannel(ch.id, { addPrice: 10 });
  assert.strictEqual(s.getState().channels[0].addPrice, 10);
  await s.deleteChannel(ch.id);
  assert.strictEqual(s.getState().channels.length, 0);
});

test('store: 记录 CRUD', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  const r = await s.addRecord({ type: 'freight', country: 'US', freight: 54 });
  assert.strictEqual(s.getState().records.length, 1);
  await s.deleteRecord(r.id);
  assert.strictEqual(s.getState().records.length, 0);
});

test('store: updateSettings 合并而非覆盖', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  const set = await s.updateSettings({ profitRate: 25 });
  assert.strictEqual(set.profitRate, 25);
  assert.strictEqual(set.currency, '¥');
});

test('store: 落盘到真实文件后重新加载一致', async () => {
  const p = path.join(os.tmpdir(), 'logi_m0_' + Date.now() + '.json');
  const s = storeMod.createStore(filePersistence(p));
  await s.load();
  await s.addChannel({ name: 'UPS', country: 'UK', firstPrice: 25, addPrice: 7 });
  await s.addRecord({ type: 'freight', country: 'UK', freight: 40 });
  const s2 = storeMod.createStore(filePersistence(p));
  await s2.load();
  assert.strictEqual(s2.getState().channels.length, 1);
  assert.strictEqual(s2.getState().records.length, 1);
  assert.strictEqual(s2.getState().channels[0].name, 'UPS');
  await fs.unlink(p);
});

test('fsio: defaultData 结构', () => {
  const d = fsio.defaultData();
  assert.strictEqual(d.version, 1);
  assert.strictEqual(d.settings.currency, '¥');
  assert.deepStrictEqual(d.channels, []);
  assert.deepStrictEqual(d.records, []);
});

test('fsio: parseData 处理空与非法', () => {
  assert.deepStrictEqual(fsio.parseData(''), fsio.defaultData());
  assert.throws(() => fsio.parseData('{bad'), /DATA_PARSE_ERROR/);
});

test('fsio: isFsSupported 随 window API 变化', () => {
  const orig = global.window;
  global.window = undefined;
  assert.strictEqual(fsio.isFsSupported(), false);
  global.window = { showSaveFilePicker: async () => {}, showOpenFilePicker: async () => [] };
  assert.strictEqual(fsio.isFsSupported(), true);
  global.window = orig;
});

test('fsio: FS 持久化读写往返（mock handle）', async () => {
  const fakeHandle = (() => { let t = ''; return {
    getFile: async () => ({ text: async () => t }),
    createWritable: async () => ({ write: async (x) => { t = x; }, close: async () => {} })
  }; })();
  global.window = { showSaveFilePicker: async () => fakeHandle, showOpenFilePicker: async () => [fakeHandle] };
  global.App = global.App || {};
  global.App.fsio = fsio;
  global.App.db = { getHandle: async () => null, persistHandle: async () => {} };
  const p = await fsio.createFsPersistence();
  await p.chooseFile(true); // 选择/创建数据文件（用户手势触发，不再由 read 自动弹窗）
  let data = await p.read();
  assert.strictEqual(data.channels.length, 0);
  data.channels.push({ id: 'c1', name: 'Test' });
  await p.write(data);
  const data2 = await p.read();
  assert.strictEqual(data2.channels.length, 1);
  delete global.window; delete global.App;
});
