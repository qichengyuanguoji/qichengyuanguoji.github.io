const test = require('node:test');
const assert = require('node:assert');

const fba = require('../js/fba.js');
require('../js/fsio.js');
const storeMod = require('../js/store.js');

// v2.25：内置亚马逊仓地址已从代码里删除，仓库表只剩用户自己维护的条目，
// 所以「删除」就是直接从 settings.fbaWh 里移除，不再有屏蔽名单。

const A = { code: 'ONT8', city: 'Moreno Valley', state: 'CA', zip: '92551', country: 'US' };
const B = { code: 'YYZ1', city: 'Mississauga', state: 'ON', zip: 'L5S 1P7', country: 'CA' };
const C = { code: 'YVR1', city: 'Delta', state: 'BC', zip: 'V3M 6R9', country: 'CA' };

test('仓库表默认是空的：代码里不再内置任何亚马逊仓地址', () => {
  assert.strictEqual(fba.SEED.length, 0);
  assert.strictEqual(fba.search('', [], 0).length, 0);
  assert.strictEqual(fba.lookup('ONT8'), null);
  assert.strictEqual(fba.lookup('ONT8', []), null);
});

test('removeEntries：删一条', () => {
  const plan = fba.removeEntries([A], [A, B, C]);
  assert.deepStrictEqual(plan.fbaWh.map(x => x.code), ['YYZ1', 'YVR1']);
  assert.strictEqual(plan.removedCount, 1);
});

test('removeEntries：一次删多条', () => {
  const plan = fba.removeEntries([A, C], [A, B, C]);
  assert.deepStrictEqual(plan.fbaWh.map(x => x.code), ['YYZ1']);
  assert.strictEqual(plan.removedCount, 2);
});

test('removeEntries：全删后表为空', () => {
  const plan = fba.removeEntries([A, B, C], [A, B, C]);
  assert.deepStrictEqual(plan.fbaWh, []);
  assert.strictEqual(plan.removedCount, 3);
  assert.strictEqual(fba.search('', plan.fbaWh, 0).length, 0);
});

test('removeEntries：空列表是安全的空操作', () => {
  const plan = fba.removeEntries([], [A, B]);
  assert.deepStrictEqual(plan.fbaWh.map(x => x.code), ['ONT8', 'YYZ1']);
  assert.strictEqual(plan.removedCount, 0);
});

test('removeEntries：代码大小写/空格容错', () => {
  const plan = fba.removeEntries([{ code: ' ont8 ' }], [A, B]);
  assert.deepStrictEqual(plan.fbaWh.map(x => x.code), ['YYZ1']);
});

test('removeEntries：删不存在的代码不影响其它条目', () => {
  const plan = fba.removeEntries([{ code: 'ZZZ9' }], [A, B]);
  assert.deepStrictEqual(plan.fbaWh.map(x => x.code), ['ONT8', 'YYZ1']);
});

test('删掉之后 lookup / search 都查不到', () => {
  const plan = fba.removeEntries([A], [A, B, C]);
  assert.strictEqual(fba.lookup('ONT8', plan.fbaWh), null);
  assert.strictEqual(fba.search('ONT8', plan.fbaWh, 0).length, 0);
  assert.ok(fba.lookup('YYZ1', plan.fbaWh), '其它仓不受影响');
});

test('删除不影响仓号形态识别（仓派渠道照旧按仓号匹配）', () => {
  assert.strictEqual(fba.isWhCode('ONT8'), true);
  assert.strictEqual(fba.isWhCode('YYZ1'), true);
  assert.strictEqual(fba.isWhCode('WMT-LAX1'), true);
  assert.strictEqual(fba.isWhCode('US'), false);
});

test('删除结果随设置持久化，重载后仍然是删掉的状态', async () => {
  let disk = null;
  const p = {
    read: async () => (disk == null ? globalThis.App.fsio.defaultData() : JSON.parse(JSON.stringify(disk))),
    write: async (o) => { disk = JSON.parse(JSON.stringify(o)); }
  };
  const s1 = storeMod.createStore(p);
  await s1.load();
  await s1.updateSettings({ fbaWh: [A, B] });
  const plan = fba.removeEntries([A], s1.getSettings().fbaWh);
  await s1.updateSettings({ fbaWh: plan.fbaWh });

  const s2 = storeMod.createStore(p);
  await s2.load();
  const st = s2.getSettings();
  assert.deepStrictEqual(st.fbaWh.map(x => x.code), ['YYZ1']);
  assert.strictEqual(fba.lookup('ONT8', st.fbaWh), null);
  assert.ok(fba.lookup('YYZ1', st.fbaWh));
});

test('旧数据里的 fbaWhRemoved 字段被忽略，不再影响展示', async () => {
  const disk = {
    version: 1,
    settings: { profitRate: 30, fbaWh: [A, B], fbaWhRemoved: ['ONT8'] },
    channels: [],
    records: []
  };
  const p = { read: async () => JSON.parse(JSON.stringify(disk)), write: async () => {} };
  const s = storeMod.createStore(p);
  await s.load();
  const st = s.getSettings();
  assert.ok(st.fbaWh.some(x => x.code === 'ONT8'), '条目还在表里');
  assert.strictEqual(fba.lookup('ONT8', st.fbaWh).zip, '92551', '不会因为旧屏蔽名单而查不到');
});
