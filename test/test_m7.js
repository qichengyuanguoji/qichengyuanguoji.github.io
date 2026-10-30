const test = require('node:test');
const assert = require('node:assert');
require('../js/util.js');
require('../js/fsio.js');
const storeMod = require('../js/store.js');
const settings = require('../js/pages/settings.js');

function memPersistence(initial) {
  let data = initial != null ? JSON.parse(JSON.stringify(initial)) : null;
  return {
    read: async () => (data == null ? require('../js/fsio.js').defaultData() : JSON.parse(JSON.stringify(data))),
    write: async (obj) => { data = JSON.parse(JSON.stringify(obj)); }
  };
}

test('withDefaults: 合并默认参数（v2 含 factor 体积系数 / updateDays 更新周期 / todoDays 待办窗口）', () => {
  assert.deepStrictEqual(settings.withDefaults({ profitRate: 40 }),
    { profitRate: 40, volRatio: 5000, factor: 6000, currency: '¥', weightStep: 0.5, firstWeight: 1, fbaWh: [], updateDays: 7, todoDays: 7 });
  assert.deepStrictEqual(settings.withDefaults(), settings.withDefaults({}));
});

test('applySettings: 写入 store 并保留其它默认值', async () => {
  const st = storeMod.createStore(memPersistence(null));
  await st.load();
  global.App = global.App || {};
  global.App.store = global.App.store || {};
  global.App.store.instance = st;
  const result = await settings.applySettings({ profitRate: 22, factor: 7000, volRatio: 6000 });
  assert.strictEqual(result.profitRate, 22);
  assert.strictEqual(result.factor, 7000);
  assert.strictEqual(result.volRatio, 6000);
  assert.strictEqual(result.currency, '¥');
});

test('parseImported: 空/非法处理', () => {
  assert.deepStrictEqual(settings.parseImported(''), require('../js/fsio.js').defaultData());
  assert.throws(() => settings.parseImported('{bad'), /DATA_PARSE_ERROR/);
});
