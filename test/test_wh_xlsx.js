'use strict';
/* 仓库表导入：CSV 与 XLSX 共用同一套列映射（v2.26）
 * 背景：仓库表原来只能导 CSV，用户手上是 .xlsx，得先另存为 CSV 才能导。
 * 现改为：xlsx 走 js/excel.js 已有解析器读出二维网格，再交给 fba.parseWhRows 映射。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const fba = require('../js/fba.js');
const excel = require('../js/excel.js');

// xlsx 构造器与 File 桩放在 test/_xlsx_fixture.js，与 UI 冒烟测试共用
const { xlsxOf } = require('./_xlsx_fixture.js');

// ---------------- parseWhRows：纯二维数组 ----------------

test('parseWhRows 识别中文表头', () => {
  const { list, bad } = fba.parseWhRows([
    ['仓库代码', '城市', '州', '邮编', '国家'],
    ['ONT8', 'Moreno Valley', 'CA', '92551', 'US'],
    ['YVR1', 'Delta', 'BC', 'V3M 6R9', 'CA']
  ]);
  assert.strictEqual(bad, 0);
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].code, 'ONT8');
  assert.strictEqual(list[0].city, 'Moreno Valley');
  assert.strictEqual(list[0].state, 'CA');
  assert.strictEqual(list[0].zip, '92551');
  assert.strictEqual(list[0].country, 'US');
  assert.strictEqual(list[0].custom, true);
  assert.strictEqual(list[1].code, 'YVR1');
});

test('parseWhRows 表头不在第一行（上面有标题/空行）也能定位', () => {
  const { list } = fba.parseWhRows([
    ['FBA 仓库清单 2026'],
    [],
    ['仓库代码', '邮编', '国家'],
    ['FTW1', '75241', 'US']
  ]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].code, 'FTW1');
  assert.strictEqual(list[0].zip, '75241');
});

test('parseWhRows 无表头时按 代码,城市,州,邮编,国家 兜底', () => {
  const { list } = fba.parseWhRows([['LAX9', 'Fontana', 'CA', '92337', 'US']]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].city, 'Fontana');
  assert.strictEqual(list[0].zip, '92337');
});

test('parseWhRows 数字单元格：邮编 92551 不变形，92551.0 也能还原', () => {
  const { list } = fba.parseWhRows([
    ['仓库代码', '邮编'],
    ['ONT8', 92551],
    ['LGB8', '92551.0']
  ]);
  assert.strictEqual(list[0].zip, '92551');
  assert.strictEqual(list[1].zip, '92551');
});

test('parseWhRows 国家写中文或小写都归一到代码', () => {
  const { list } = fba.parseWhRows([
    ['仓库代码', '国家'],
    ['YYZ1', '加拿大'],
    ['BHX1', 'uk'],
    ['ONT8', 'United States']
  ]);
  assert.strictEqual(list[0].country, 'CA');
  assert.strictEqual(list[1].country, 'UK');
  assert.strictEqual(list[2].country, 'US');
});

test('parseWhRows 国家缺省 US、空行忽略、缺代码行计入 bad', () => {
  const { list, bad } = fba.parseWhRows([
    ['仓库代码', '邮编'],
    ['', ''],
    ['', '99999'],
    ['OK1', '22222']
  ]);
  assert.strictEqual(bad, 1);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].country, 'US');
});

test('parseWhRows 英文表头大小写与空格无关', () => {
  const { list } = fba.parseWhRows([
    ['Warehouse Code', ' ZIP Code ', 'Country', 'City'],
    ['ABC1', ' 11111 ', ' us ', 'Somewhere']
  ]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].zip, '11111');
  assert.strictEqual(list[0].country, 'US');
  assert.strictEqual(list[0].city, 'Somewhere');
});

// ---------------- parseWhSheets：整个工作簿 ----------------

test('parseWhSheets 合并多个工作表并统计', () => {
  const out = fba.parseWhSheets([
    { name: '美国', headers: ['仓库代码', '邮编'], rows: [['ONT8', '92551']], rawRows: [['仓库代码', '邮编'], ['ONT8', '92551']] },
    { name: '加拿大', headers: ['仓库代码', '邮编'], rows: [['YYZ1', 'L5S 1P7']], rawRows: [['仓库代码', '邮编'], ['YYZ1', 'L5S 1P7']] },
    { name: '空表', headers: [], rows: [], rawRows: [] }
  ]);
  assert.strictEqual(out.list.length, 2);
  assert.strictEqual(out.sheets, 2, '空工作表不计入');
  const codes = out.list.map(x => x.code).sort();
  assert.deepStrictEqual(codes, ['ONT8', 'YYZ1']);
});

test('parseWhSheets 只有 headers/rows（无 rawRows）时也能用', () => {
  const out = fba.parseWhSheets([
    { name: 'S1', headers: ['仓库代码', '城市'], rows: [['ONT8', 'Moreno Valley']] }
  ]);
  assert.strictEqual(out.list.length, 1);
  assert.strictEqual(out.list[0].city, 'Moreno Valley');
});

test('parseWhSheets 跳过没有表头、也不是仓号形态的「说明」表', () => {
  const out = fba.parseWhSheets([
    { name: '说明', rawRows: [
      ['说明'],
      ['本表收录常用 FBA 仓库地址，每月更新一次'],
      ['如需新增请联系运营']
    ] },
    { name: '仓库', rawRows: [['仓库代码', '邮编'], ['ONT8', '92551']] }
  ]);
  assert.strictEqual(out.list.length, 1, '说明表不应被当成仓库导入');
  assert.strictEqual(out.list[0].code, 'ONT8');
  assert.strictEqual(out.sheets, 1);
});

test('parseWhSheets 无表头但确实是仓号列表时照常导入', () => {
  const out = fba.parseWhSheets([
    { name: '无表头', rawRows: [['ONT8', 'Moreno Valley', 'CA', '92551', 'US'], ['YYZ1', 'Mississauga', 'ON', 'L5S 1P7', 'CA']] }
  ]);
  assert.strictEqual(out.list.length, 2);
  assert.strictEqual(out.list[0].city, 'Moreno Valley');
});

// ---------------- 真实 .xlsx（ZIP + XML）端到端 ----------------

test('真实 xlsx：解析工作簿后能直接导成仓库条目', async () => {
  const buf = xlsxOf([{
    name: '仓库',
    rows: [
      ['FBA 仓库表'],
      [],
      ['仓库代码', '城市', '州', '邮编', '国家'],
      ['ONT8', 'Moreno Valley', 'CA', 92551, '美国'],
      ['YYZ1', 'Mississauga', 'ON', 'L5S 1P7', '加拿大'],
      ['', '', '', '', ''],
      ['BAD', '', '', '', '']  // 代码形态不合法 → 仍收（表里只校验非空）
    ]
  }]);
  const sheets = await excel.parseWorkbook(buf);
  assert.ok(sheets.length >= 1, '应解析到工作表');
  assert.strictEqual(sheets[0].name, '仓库', '工作表名应从 workbook.xml 读到，而不是 Sheet1');
  const out = fba.parseWhSheets(sheets);
  assert.strictEqual(out.list.length, 3, '三条有效行');
  assert.strictEqual(out.list[0].code, 'ONT8');
  assert.strictEqual(out.list[0].zip, '92551');
  assert.strictEqual(out.list[0].country, 'US', '中文国家应转代码');
  assert.strictEqual(out.list[1].country, 'CA');
  assert.strictEqual(out.list[2].code, 'BAD');
});

test('真实 xlsx：两个工作表都导入', async () => {
  const buf = xlsxOf([
    { name: '美国', rows: [['仓库代码', '邮编'], ['ONT8', '92551']] },
    { name: '加拿大', rows: [['仓库代码', '邮编'], ['YVR1', 'V3M 6R9']] }
  ]);
  const out = fba.parseWhSheets(await excel.parseWorkbook(buf));
  assert.strictEqual(out.list.length, 2);
  assert.deepStrictEqual(out.list.map(x => x.code).sort(), ['ONT8', 'YVR1']);
});

// ---------------- 合并（同码覆盖） ----------------

test('mergeWh 同码覆盖旧条目、新码追加、保持原顺序', () => {
  const extra = [
    { code: 'ONT8', city: 'Old', state: 'CA', zip: '00000', country: 'US' },
    { code: 'FTW1', city: 'Dallas', state: 'TX', zip: '75241', country: 'US' }
  ];
  const incoming = [
    { code: 'ONT8', city: 'Moreno Valley', state: 'CA', zip: '92551', country: 'US', custom: true },
    { code: 'YYZ1', city: 'Mississauga', state: 'ON', zip: 'L5S 1P7', country: 'CA', custom: true }
  ];
  const merged = fba.mergeWh(extra, incoming);
  assert.strictEqual(merged.length, 3);
  assert.strictEqual(merged[0].code, 'ONT8');
  assert.strictEqual(merged[0].zip, '92551', '同码应用新地址覆盖');
  assert.strictEqual(merged[1].code, 'FTW1');
  assert.strictEqual(merged[2].code, 'YYZ1');
});

test('mergeWh 大小写/空格不同的同码视为同一个仓', () => {
  const merged = fba.mergeWh(
    [{ code: 'ONT8', zip: '00000' }],
    [{ code: ' ont8 ', zip: '92551' }]
  );
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].zip, '92551');
});

// ---------------- CSV 回归：走新的共享映射 ----------------

test('parseWhCsv 与 parseWhRows 走同一套映射（CSV 不回归）', () => {
  const text = '仓库代码,城市,州,邮编,国家\nONT8,Moreno Valley,CA,92551,US\nYVR1,Delta,BC,V3M 6R9,CA';
  const a = fba.parseWhCsv(text);
  const b = fba.parseWhRows([
    ['仓库代码', '城市', '州', '邮编', '国家'],
    ['ONT8', 'Moreno Valley', 'CA', '92551', 'US'],
    ['YVR1', 'Delta', 'BC', 'V3M 6R9', 'CA']
  ]);
  assert.deepStrictEqual(a.list, b.list);
  assert.strictEqual(a.bad, b.bad);
});

test('parseWhCsv 仍兼容制表符分隔（从 Excel 直接复制粘贴）', () => {
  const text = '仓库代码\t城市\t邮编\nONT8\tMoreno Valley\t92551';
  const { list } = fba.parseWhCsv(text);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].zip, '92551');
});
