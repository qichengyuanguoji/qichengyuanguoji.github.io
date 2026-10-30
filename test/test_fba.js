const test = require('node:test');
const assert = require('node:assert');

const fba = require('../js/fba.js');
require('../js/calc.js');
const calc = globalThis.App.calc;

// v2.25 起内置仓库地址已从代码中删除，仓库表只保留用户自己新增/导入的条目（settings.fbaWh）。
// 所以这里用 extra 注入样例数据来验证查询/覆盖/搜索等能力，不再依赖 ONT8 这类内置行。
const ONT8 = { code: 'ONT8', city: 'Moreno Valley', state: 'CA', zip: '92551', country: 'US' };
const LAX9 = { code: 'LAX9', city: 'Fontana', state: 'CA', zip: '92337', country: 'US' };
const YVR1 = { code: 'YVR1', city: 'Delta', state: 'BC', zip: 'V3M 6R9', country: 'CA' };

test('内置仓库表已清空：默认查不到任何亚马逊仓地址', () => {
  assert.strictEqual(fba.SEED.length, 0, '代码里不应再内置仓库数据');
  assert.strictEqual(fba.lookup('ONT8'), null);
  assert.strictEqual(fba.search('', [], 0, []).length, 0);
});

test('自己新增的仓库可查到城市/州/邮编/国家', () => {
  const e = fba.lookup('ONT8', [ONT8]);
  assert.ok(e, 'ONT8 应能查到');
  assert.strictEqual(e.code, 'ONT8');
  assert.strictEqual(e.city, 'Moreno Valley');
  assert.strictEqual(e.state, 'CA');
  assert.strictEqual(e.zip, '92551');
  assert.strictEqual(e.country, 'US');
  assert.strictEqual(e.custom, true, '自己加的条目一律标 custom');
});

test('代码查询大小写与空格兼容', () => {
  const a = fba.lookup(' ont8 ', [ONT8]);
  const b = fba.lookup('Ont8', [ONT8]);
  assert.ok(a && b);
  assert.strictEqual(a.zip, b.zip);
  assert.strictEqual(a.zip, '92551');
});

test('未知仓库返回 null，不抛错', () => {
  assert.strictEqual(fba.lookup('ZZZ9', [ONT8]), null);
  assert.strictEqual(fba.lookup('', [ONT8]), null);
  assert.strictEqual(fba.lookup(null, [ONT8]), null);
});

test('同码重复保存时后一条覆盖前一条', () => {
  const extra = [ONT8, { code: 'ont8', zip: '90001', country: 'us', city: 'LA' }];
  const e = fba.lookup('ONT8', extra);
  assert.strictEqual(e.zip, '90001');
  assert.strictEqual(e.city, 'LA');
  assert.strictEqual(e.custom, true);
  // 只传第一条时应回落到原地址
  assert.strictEqual(fba.lookup('ONT8', [ONT8]).zip, '92551');
});

test('search 支持按代码/城市/邮编过滤，limit 生效', () => {
  const extra = [ONT8, LAX9, YVR1];
  assert.ok(fba.search('ont8', extra).some(e => e.code === 'ONT8'));
  assert.ok(fba.search('moreno valley', extra).some(e => e.code === 'ONT8'));
  assert.ok(fba.search('92551', extra).some(e => e.code === 'ONT8'));
  assert.strictEqual(fba.search('', extra, 2).length, 2);
  assert.ok(fba.search('没有这个仓库', extra).length === 0);
});

test('isWhCode 识别仓库代码形态（不再依赖内置表）', () => {
  assert.strictEqual(fba.isWhCode('ONT8'), true, '三位字母+数字按形态识别');
  assert.strictEqual(fba.isWhCode('YYZ1'), true);
  assert.strictEqual(fba.isWhCode('WMT-LAX1'), true);
  assert.strictEqual(fba.isWhCode('US'), false);
  assert.strictEqual(fba.isWhCode('ABC'), false, '纯字母代码不再靠内置表兜底');
  assert.strictEqual(fba.isWhCode('IUSP'), false, '内置表清空后 IUSP 这类纯字母仓无法识别');
  assert.strictEqual(fba.isWhCode(''), false);
});

test('desc 生成可读摘要（含代码与邮编）', () => {
  const s = fba.desc(fba.lookup('ONT8', [ONT8]));
  assert.ok(s.indexOf('ONT8') === 0, s);
  assert.ok(s.indexOf('92551') >= 0, s);
  assert.ok(s.indexOf('美国') >= 0, s);
});

test('parseWhCsv 解析中文表头', () => {
  const text = ['仓库代码,城市,州,邮编,国家', 'ONT8,Moreno Valley,CA,92551,US', 'YVR1,Delta,BC,V3M 6R9,CA'].join('\n');
  const { list, bad } = fba.parseWhCsv(text);
  assert.strictEqual(bad, 0);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].code, 'ONT8');
  assert.strictEqual(list[0].zip, '92551');
  assert.strictEqual(list[1].country, 'CA');
  assert.strictEqual(list[1].custom, true);
});

test('parseWhCsv 解析英文表头（大小写/空格无关）', () => {
  const text = ['Warehouse Code, ZIP Code ,Country,City', 'ABC1, 11111 , us ,Somewhere'].join('\n');
  const { list } = fba.parseWhCsv(text);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].code, 'ABC1');
  assert.strictEqual(list[0].zip, '11111');
  assert.strictEqual(list[0].country, 'US');
});

test('parseWhCsv 无表头时按 代码,城市,州,邮编,国家 兜底', () => {
  const text = ['ONT8,Moreno Valley,CA,92551,US'].join('\n');
  const { list } = fba.parseWhCsv(text);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].code, 'ONT8');
  assert.strictEqual(list[0].zip, '92551');
});

test('parseWhCsv 跳过空/无效行并计数', () => {
  const text = ['仓库代码,邮编', ',,', 'OK1,22222'].join('\n');
  const { list, bad } = fba.parseWhCsv(text);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(bad, 1);
});

test('parseWhCsv 容忍 BOM 与 CRLF', () => {
  const text = '\uFEFF仓库代码,邮编\r\nOK2,33333\r\n';
  const { list } = fba.parseWhCsv(text);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].code, 'OK2');
});

test('countryName 中文名映射', () => {
  assert.strictEqual(fba.countryName('us'), '美国');
  assert.strictEqual(fba.countryName('CA'), '加拿大');
  assert.strictEqual(fba.countryName('FR'), '法国');
  assert.strictEqual(fba.countryName('XX'), 'XX', '未知国家原样返回');
});

test('联动：仓库邮编可用于渠道邮编区间过滤', () => {
  const z = fba.lookup('ONT8', [ONT8]).zip; // 92551
  const chs = [
    { id: 'w', name: '西岸专线', type: 'express', dests: 'US 邮编 90000-92999', firstW: 1, firstP: 30, addU: 0.5, addP: 8 },
    { id: 'e', name: '东岸专线', type: 'express', dests: 'US 邮编 10000-19999', firstW: 1, firstP: 28, addU: 0.5, addP: 7 }
  ];
  const hit = calc.matchChannels(chs, { dest: 'US', type: 'all', zip: z });
  assert.strictEqual(hit.length, 1);
  assert.strictEqual(hit[0].id, 'w');
});

test('联动：仓库渠道按仓库代码精确匹配', () => {
  const ch = { id: 'wh1', name: '卡派', type: 'express', dests: 'ONT8 LAX9', firstW: 1, firstP: 30, addU: 0.5, addP: 8 };
  assert.strictEqual(calc.matchChannels([ch], { dest: 'US', type: 'all', whCode: 'ONT8' }).length, 1);
  assert.strictEqual(calc.matchChannels([ch], { dest: 'US', type: 'all', whCode: 'SNA4' }).length, 0);
  assert.strictEqual(calc.matchChannels([ch], { dest: 'US', type: 'all', whCode: '' }).length, 0);
});

test('联动：识别仓库后报价可用且总价为正', () => {
  const info = fba.lookup('LAX9', [LAX9]);
  const ch = { id: 'c', name: '空运A', type: 'air', dests: 'US', priceKg: 20, minCharge: 50, divisor: 6000 };
  const q = { dest: info.country, type: 'all', zip: info.zip, weight: 5, pcs: 1, len: 20, wid: 20, hgt: 20, factor: 6000 };
  const r = calc.computeQuote(ch, q);
  assert.ok(r.total > 0 && isFinite(r.total), '总价应为正数：' + r.total);
});

test('自定义仓库随设置持久化，重载后仍可查到', async () => {
  require('../js/fsio.js');
  const storeMod = require('../js/store.js');
  let disk = null;
  const p = {
    read: async () => (disk == null ? globalThis.App.fsio.defaultData() : JSON.parse(JSON.stringify(disk))),
    write: async (o) => { disk = JSON.parse(JSON.stringify(o)); }
  };
  const s1 = storeMod.createStore(p);
  await s1.load();
  await s1.updateSettings({ fbaWh: [ONT8] });

  const s2 = storeMod.createStore(p);
  await s2.load();
  const e = fba.lookup('ONT8', s2.getSettings().fbaWh);
  assert.strictEqual(e.zip, '92551', '仓库应随设置写入 data.json 并可重读');
  assert.strictEqual(s2.getSettings().fbaWh.length, 1);
});
