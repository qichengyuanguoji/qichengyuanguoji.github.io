const test = require('node:test');
const assert = require('node:assert');

const fsio = require('../js/fsio.js');
const storeMod = require('../js/store.js');

function memPersistence(initial) {
  let data = initial != null ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    read: async () => (data == null ? fsio.defaultData() : JSON.parse(JSON.stringify(data))),
    write: async (obj) => { data = JSON.parse(JSON.stringify(obj)); }
  };
}

// 同一渠道商 + 同名渠道 → 覆盖；否则新增
test('upsertChannel: 无冲突时新增', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  const r = await s.upsertChannel({ name: '中美专线', carrier: '以星', type: 'sea', priceKg: 20 });
  assert.strictEqual(r.updated, false);
  assert.strictEqual(s.getState().channels.length, 1);
});

test('upsertChannel: 同渠道商同名渠道 → 覆盖旧价且不新增条目', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  const first = await s.upsertChannel({ name: '中美专线', carrier: '以星', type: 'sea', priceKg: 20, dests: '美西' });
  const oldId = first.ch.id;
  const r = await s.upsertChannel({ name: '中美专线', carrier: '以星', type: 'sea', priceKg: 25, dests: '美西' });
  assert.strictEqual(r.updated, true, '应识别为覆盖更新');
  assert.strictEqual(s.getState().channels.length, 1, '不应新增重复条目');
  assert.strictEqual(s.getState().channels[0].priceKg, 25, '价格应被覆盖为新价');
  assert.strictEqual(s.getState().channels[0].id, oldId, '应保留原 id');
});

test('upsertChannel: 渠道商不同 → 视为两条', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  await s.upsertChannel({ name: '中美专线', carrier: '以星', priceKg: 20 });
  await s.upsertChannel({ name: '中美专线', carrier: '合德', priceKg: 19 });
  assert.strictEqual(s.getState().channels.length, 2);
});

test('upsertChannel: 名称相同但渠道/承运商都不填 → 视为同一条', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  await s.upsertChannel({ name: '欧洲空运', priceKg: 30 });
  await s.upsertChannel({ name: '欧洲空运', priceKg: 32 });
  assert.strictEqual(s.getState().channels.length, 1);
  assert.strictEqual(s.getState().channels[0].priceKg, 32);
});

test('upsertChannel: 名称/承运商的大小写与空格不影响判重', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  await s.upsertChannel({ name: ' 中美 专线 ', carrier: 'ZIM' });
  await s.upsertChannel({ name: '中美 专线', carrier: 'zim ' });
  assert.strictEqual(s.getState().channels.length, 1);
});

test('upsertChannels: 批量返回新增/覆盖条数，dryRun 不落数据', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  await s.upsertChannel({ name: 'A线', carrier: 'X', priceKg: 10 });

  const list = [
    { name: 'A线', carrier: 'X', priceKg: 12 }, // 覆盖
    { name: 'B线', carrier: 'X', priceKg: 15 }  // 新增
  ];
  const pv = await s.upsertChannels(list, { dryRun: true });
  assert.strictEqual(pv.updated, 1);
  assert.strictEqual(pv.added, 1);
  assert.strictEqual(s.getState().channels.length, 1, 'dryRun 不应改动数据');
  assert.strictEqual(s.getState().channels[0].priceKg, 10);

  const res = await s.upsertChannels(list);
  assert.strictEqual(res.updated, 1);
  assert.strictEqual(res.added, 1);
  assert.strictEqual(s.getState().channels.length, 2);
  assert.strictEqual(s.getState().channels.find(c => c.name === 'A线').priceKg, 12);
});

test('upsertChannels: 同一批里重复出现时后者覆盖前者，只留一条', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  const res = await s.upsertChannels([
    { name: 'C线', carrier: 'Y', priceKg: 10 },
    { name: 'C线', carrier: 'Y', priceKg: 11 }
  ]);
  assert.strictEqual(s.getState().channels.length, 1);
  assert.strictEqual(s.getState().channels[0].priceKg, 11);
  assert.strictEqual(res.added, 1);
  assert.strictEqual(res.updated, 1);
});

test('dedupeChannels: 合并历史重复渠道，保留最后一条的价格', async () => {
  const p = memPersistence({
    version: 1,
    settings: {},
    records: [],
    channels: [
      { id: 'id_1', name: '中美专线', carrier: '以星', priceKg: 20 },
      { id: 'id_2', name: '中美专线', carrier: '以星', priceKg: 26 },
      { id: 'id_3', name: '欧洲空运', carrier: '汉莎', priceKg: 30 }
    ]
  });
  const s = storeMod.createStore(p);
  await s.load();
  const removed = await s.dedupeChannels();
  assert.strictEqual(removed, 1);
  assert.strictEqual(s.getState().channels.length, 2);
  const merged = s.getState().channels.find(c => c.name === '中美专线');
  assert.strictEqual(merged.priceKg, 26, '应保留最后提交的价格');
  assert.strictEqual(merged.id, 'id_1', '保留最早那条的 id，避免外部引用失效');
});

test('upsertChannel 覆盖后会落盘（重新 load 能读到新价）', async () => {
  const p = memPersistence(null);
  const s1 = storeMod.createStore(p);
  await s1.load();
  await s1.upsertChannel({ name: 'D线', carrier: 'Z', priceKg: 18 });
  await s1.upsertChannel({ name: 'D线', carrier: 'Z', priceKg: 22 });

  const s2 = storeMod.createStore(p);
  await s2.load();
  assert.strictEqual(s2.getState().channels.length, 1);
  assert.strictEqual(s2.getState().channels[0].priceKg, 22);
});

test('upsertChannel: 同渠道商同名但目的地不同（美西/美中/美东）→ 三条并存', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  await s.upsertChannel({ name: '以星限时达', carrier: '436', dests: '美西', priceKg: 25 });
  await s.upsertChannel({ name: '以星限时达', carrier: '436', dests: '美中', priceKg: 26 });
  await s.upsertChannel({ name: '以星限时达', carrier: '436', dests: '美东', priceKg: 27 });
  const chs = s.getState().channels;
  assert.strictEqual(chs.length, 3, '不同分区必须各自保留');
  assert.deepStrictEqual(chs.map(c => c.dests), ['美西', '美中', '美东']);
  assert.deepStrictEqual(chs.map(c => c.priceKg), [25, 26, 27]);

  // 再导一次同一批（价格微调）→ 仍是三条，价格被覆盖
  await s.upsertChannel({ name: '以星限时达', carrier: '436', dests: '美西', priceKg: 24 });
  assert.strictEqual(s.getState().channels.length, 3);
  assert.strictEqual(s.getState().channels[0].priceKg, 24);
});

test('upsertChannel: 目的地空白差异不影响同一性（不会重复新增）', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  await s.upsertChannel({ name: '以星限时达', carrier: '436', dests: '美 西', priceKg: 25 });
  const r = await s.upsertChannel({ name: '以星限时达', carrier: '436', dests: '美西', priceKg: 24 });
  assert.strictEqual(r.updated, true);
  assert.strictEqual(s.getState().channels.length, 1);
  assert.strictEqual(s.getState().channels[0].priceKg, 24);
});

test('updateChannels: 批量改同一批渠道同一字段，一次落盘，返回值=改动条数', async () => {
  const s = storeMod.createStore(memPersistence(null));
  await s.load();
  await s.addChannel({ name: 'A', validUntil: '2026-10-01' });
  await s.addChannel({ name: 'B', validUntil: '2026-10-02' });
  await s.addChannel({ name: 'C', validUntil: '2026-12-31' });
  const ids = s.getState().channels.slice(0, 2).map(c => c.id);
  const n = await s.updateChannels(ids, { validUntil: '2026-11-05' });
  assert.strictEqual(n, 2);
  assert.deepStrictEqual(s.getState().channels.map(c => c.validUntil), ['2026-11-05', '2026-11-05', '2026-12-31']);

  // 不存在的 id 不报错、不改动
  assert.strictEqual(await s.updateChannels(['nope'], { validUntil: '2026-12-01' }), 0);
  assert.strictEqual(s.getState().channels[2].validUntil, '2026-12-31');
});
