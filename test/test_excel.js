'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');

const excel = require('../js/excel.js');
const csv = require('../js/csv.js');

// 在全局挂上 App.csv，供 excel.readWorkbookFile 的 CSV 分支使用
global.App = global.App || {};
global.App.csv = csv;

// ---- 构造一个最小可用、且为“存储(未压缩)”方式的 .xlsx(ZIP) ----
function strBytes(s) {
  // 必须用 TextEncoder 得到正确的 UTF-8 字节（直接 charCodeAt & 0xff 会破坏中文等多字节字符）
  return new TextEncoder().encode(s);
}
// 注意：必须用“字节长度”而非字符串长度作为压缩前后尺寸，否则含中文的多字节内容会被截断。
function makeZip(files, opts) {
  const compress = !!(opts && opts.compress);
  const entries = files.map(f => {
    const raw = strBytes(f.data);
    const payload = compress ? new Uint8Array(zlib.deflateRawSync(Buffer.from(raw))) : raw;
    return { name: f.name, payload, compSize: payload.length, uncompSize: raw.length, method: compress ? 8 : 0 };
  });
  const locals = [];
  let offset = 0;
  const cd = [];
  entries.forEach(e => {
    const nameBytes = strBytes(e.name);
    const local = new Uint8Array(30 + nameBytes.length + e.payload.length);
    const ld = new DataView(local.buffer);
    ld.setUint32(0, 0x04034b50, true);
    ld.setUint16(8, e.method, true);
    ld.setUint32(18, e.compSize, true);
    ld.setUint32(22, e.uncompSize, true);
    ld.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(e.payload, 30 + nameBytes.length);
    const cdh = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cdh.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, e.method, true);
    cv.setUint32(20, e.compSize, true);
    cv.setUint32(24, e.uncompSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cdh.set(nameBytes, 46);
    locals.push(local); cd.push(cdh);
    offset += local.length;
  });
  const cdSize = cd.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  locals.forEach(l => { out.set(l, pos); pos += l.length; });
  cd.forEach(c => { out.set(c, pos); pos += c.length; });
  out.set(eocd, pos);
  return out.buffer;
}

const SHARED = '<sst><si><t>渠道名称</t></si><si><t>类型</t></si><si><t>适用目的地</t></si>' +
  '<si><t>重量价</t></si><si><t>首重价</t></si><si><t>中美专线</t></si><si><t>express</t></si>' +
  '<si><t>US</t></si><si><t>欧洲空运</t></si><si><t>air</t></si><si><t>DE EU</t></si></sst>';

const SHEET = '<worksheet><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>' +
  '<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2" t="s"><v>7</v></c><c r="D2"><v>12.5</v></c><c r="E2"><v>30</v></c></row>' +
  '<row r="3"><c r="A3" t="s"><v>8</v></c><c r="B3" t="s"><v>9</v></c><c r="C3" t="s"><v>10</v></c><c r="D3"><v>9</v></c></row>' +
  '</sheetData></worksheet>';

const XLSX_BUF = makeZip([
  { name: '[Content_Types].xml', data: '<Types/>' },
  { name: '_rels/.rels', data: '<Relationships/>' },
  { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
  { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
  { name: 'xl/sharedStrings.xml', data: SHARED },
  { name: 'xl/worksheets/sheet1.xml', data: SHEET }
]);

test('colToIndex 列字母->索引', () => {
  assert.strictEqual(excel.colToIndex('A'), 0);
  assert.strictEqual(excel.colToIndex('Z'), 25);
  assert.strictEqual(excel.colToIndex('AA'), 26);
  assert.strictEqual(excel.colToIndex('AB'), 27);
});

test('parseSharedStrings 解析共享字符串', () => {
  const ss = excel.parseSharedStrings('<sst><si><t>甲</t></si><si><t>乙</t></si></sst>');
  assert.deepStrictEqual(ss, ['甲', '乙']);
});

test('parseWorksheet 支持 inlineStr 内联字符串', () => {
  const xml = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Hello</t></is></c></row></sheetData></worksheet>';
  const rows = excel.parseWorksheet(xml, []);
  assert.strictEqual(rows[0][0], 'Hello');
});

test('parseWorksheet 共享字符串 + 数值 + 稀疏列', () => {
  const xml = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
    '<row r="2"><c r="B2"><v>42</v></c></row></sheetData></worksheet>';
  const rows = excel.parseWorksheet(xml, ['名称', '国家']);
  assert.deepStrictEqual(rows[0], ['名称', '', '国家']);
  assert.deepStrictEqual(rows[1], ['', '42']); // 仅 B 列有值，第二行只有 2 列
});

test('parseXlsx 解析最小 xlsx -> 表头与数据行', async () => {
  const { headers, rows } = await excel.parseXlsx(XLSX_BUF);
  assert.deepStrictEqual(headers, ['渠道名称', '类型', '适用目的地', '重量价', '首重价']);
  // 第 3 行在测试夹具中无 E 列单元格，故仅 4 列（解析器按每行最大列填充，符合真实表格行为）
  assert.deepStrictEqual(rows, [
    ['中美专线', 'express', 'US', '12.5', '30'],
    ['欧洲空运', 'air', 'DE EU', '9']
  ]);
});

test('parseXlsx + buildChannels 映射为渠道对象', async () => {
  const { headers, rows } = await excel.parseXlsx(XLSX_BUF);
  const { channels } = csv.buildChannels(headers, rows);
  assert.strictEqual(channels.length, 2);
  assert.deepStrictEqual(channels[0], { type: 'express', name: '中美专线', dests: 'US', priceKg: 12.5, firstP: 30 });
  assert.deepStrictEqual(channels[1], { type: 'air', name: '欧洲空运', dests: 'DE EU', priceKg: 9 });
});

test('readWorkbookFile .xls 给出友好报错', async () => {
  await assert.rejects(
    () => excel.readWorkbookFile({ name: 'book.xls' }),
    /旧版 .xls/
  );
});

test('readWorkbookFile .csv 走 csv.js 路径', async () => {
  const fakeFile = { name: 'p.csv', text: async () => '渠道名称,类型,适用目的地\n中美专线,express,US' };
  const { headers, rows } = await excel.readWorkbookFile(fakeFile);
  assert.deepStrictEqual(headers, ['渠道名称', '类型', '适用目的地']);
  assert.deepStrictEqual(rows, [['中美专线', 'express', 'US']]);
});

test('parseXlsx 支持 deflate 压缩（真实 Excel 常见，走 DecompressionStream）', async () => {
  if (typeof DecompressionStream === 'undefined') {
    console.warn('当前环境无 DecompressionStream，跳过 deflate 路径测试');
    return;
  }
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: '<sst><si><t>渠道名称</t></si><si><t>适用目的地</t></si><si><t>中美专线</t></si><si><t>US</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c></row></sheetData></worksheet>' }
  ], { compress: true });
  const { headers, rows } = await excel.parseXlsx(buf);
  assert.deepStrictEqual(headers, ['渠道名称', '适用目的地']);
  assert.deepStrictEqual(rows, [['中美专线', 'US']]);
});

test('aggregateChannels 批量聚合多个文件', async () => {
  function fileOf(name, text) { return { name, text: async () => text }; }
  // 渠道必须带价格才进价格库（目录页/导航页那种「只有名字没有价」的行会被过滤），
  // 所以夹具里给出单价列
  const f1 = fileOf('a.csv', '渠道名称,适用目的地,类型,单价\n中美专线,US,express,12.5');
  const f2 = fileOf('b.csv', '渠道名称,适用目的地,类型,单价\n欧洲空运,DE EU,air,9');
  const { channels, skipped, errors } = await excel.aggregateChannels([f1, f2]);
  assert.strictEqual(channels.length, 2);
  assert.strictEqual(skipped, 0);
  assert.strictEqual(errors.length, 0);
  const names = channels.map(c => c.name).sort();
  assert.deepStrictEqual(names, ['中美专线', '欧洲空运']);
});

test('aggregateChannels 部分文件失败会被跳过且汇总 error', async () => {
  function fileOf(name, text) { return { name, text: async () => text }; }
  const good = fileOf('good.csv', '渠道名称,适用目的地,类型,单价\n中美专线,US,express,12.5');
  const bad = { name: 'bad.xls', arrayBuffer: async () => new ArrayBuffer(0) };
  const { channels, skipped, errors } = await excel.aggregateChannels([good, bad]);
  assert.strictEqual(channels.length, 1);
  assert.strictEqual(errors.length, 1);
  assert.ok(/bad\.xls/.test(errors[0]));
});

test('aggregateChannels 过滤「只有名字没有价格」的目录页残留', async () => {
  function fileOf(name, text) { return { name, text: async () => text }; }
  // 目录/导航页那种只有渠道名、没有任何价格的行不能进价格库（113 的「…（目录）」就是）
  const f = fileOf('nav.csv', '渠道名称,适用目的地\nOCK标准-墨西哥-普货,墨西哥\nOCK标准-墨西哥-带电,墨西哥');
  const { channels } = await excel.aggregateChannels([f]);
  assert.strictEqual(channels.length, 0, '没有价格的渠道应被丢弃');
});

test('parseXlsx 自动跳过合并大标题/空行并定位真表头', async () => {
  const SHARED = '<sst><si><t>美国敏感海运</t></si><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si><si><t>以星限时达</t></si><si><t>美西</t></si><si><t>六截三开</t></si></sst>';
  const SHEET = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
    '<row r="2"></row><row r="3"></row>' +
    '<row r="4"><c r="A4" t="s"><v>1</v></c><c r="B4" t="s"><v>2</v></c><c r="C4" t="s"><v>3</v></c><c r="D4" t="s"><v>4</v></c></row>' +
    '<row r="5"><c r="A5" t="s"><v>5</v></c><c r="B5" t="s"><v>6</v></c><c r="C5"><v>25</v></c><c r="D5" t="s"><v>7</v></c></row>' +
    '</sheetData></worksheet>';
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET }
  ], { compress: true });
  const { headers, rows } = await excel.parseXlsx(buf);
  assert.deepStrictEqual(headers, ['渠道', '美国分区', '12KG+', '时效']);
  assert.deepStrictEqual(rows, [['以星限时达', '美西', '25', '六截三开']]);
});

test('aggregateChannels 按文件名推断渠道类型(含“海”→海运)', async () => {
  function fileOf(name, text) { return { name, text: async () => text }; }
  const f = fileOf('美国海运价格表.csv', '渠道,美国分区,12KG+,时效\n以星限时达,美西,25,六截三开');
  const { channels, errors } = await excel.aggregateChannels([f]);
  assert.strictEqual(channels.length, 1, '有“时效”列时说明行应被排除，仅保留真实渠道');
  assert.strictEqual(channels[0].type, 'sea');
  assert.strictEqual(channels[0].dests, '美西');
  assert.deepStrictEqual(channels[0].tiers, [{ wMin: 12, wMax: null, price: 25 }]);
});

test('parseWorkbook 返回工作表真实名称（取自 workbook.xml）', async () => {
  const SHARED = '<sst><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>时效</t></si><si><t>甲渠道</t></si><si><t>美西</t></si><si><t>六截三开</t></si></sst>';
  function sheetXml(nameIdx) {
    return '<worksheet><sheetData>' +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>' +
      '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="s"><v>4</v></c><c r="C2" t="s"><v>5</v></c></row>' +
      '</sheetData></worksheet>';
  }
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="美国海运敏感渠道" sheetId="1" r:id="rId1"/><sheet name="美国海运食品渠道" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXml() },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXml() }
  ], { compress: true });
  const sheets = await excel.parseWorkbook(buf);
  assert.strictEqual(sheets.length, 2);
  assert.deepStrictEqual(sheets.map(s => s.name), ['美国海运敏感渠道', '美国海运食品渠道']);
});

test('aggregateChannels 多表同名渠道：精确重复去重、同名不同价用表名消歧', async () => {
  // 两个工作表同名渠道；表1与表2完全同价（应去重），表2另有一条不同价（应保留并加表名）
  const SHARED = '<sst>' +
    '<si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si>' +
    '<si><t>以星限时达</t></si><si><t>美西</t></si><si><t>六截三开</t></si>' +
    '</sst>';
  const sheetA = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>25</v></c><c r="D2" t="s"><v>6</v></c></row>' +
    '</sheetData></worksheet>';
  const sheetB = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>23</v></c><c r="D2" t="s"><v>6</v></c></row>' +
    '</sheetData></worksheet>';
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="敏感渠道" sheetId="1" r:id="rId1"/><sheet name="食品渠道" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: sheetA },
    { name: 'xl/worksheets/sheet2.xml', data: sheetB }
  ], { compress: true });
  const file = { name: '美国海运价格表.xlsx', arrayBuffer: async () => buf };
  const { channels, duplicates } = await excel.aggregateChannels([file]);
  assert.strictEqual(channels.length, 2, '两条不同价的同名渠道都应保留');
  assert.strictEqual(duplicates, 0);
  assert.deepStrictEqual(channels.map(c => c.name), ['以星限时达（敏感渠道）', '以星限时达（食品渠道）']);
  assert.deepStrictEqual(channels.map(c => c.tiers[0].price), [25, 23]);
  assert.deepStrictEqual(channels.map(c => c.type), ['sea', 'sea']);
});

/* ============ 报价有效期：文件时间 → 有效期起，止 = 起 + 7 天 ============ */
test('dateFromName: 从文件名解析报价日期（多种写法）', () => {
  assert.strictEqual(excel.ymd(excel.dateFromName('436美国海运敏感VIP价格表2026.10.13.xlsx')), '2026-10-13');
  assert.strictEqual(excel.ymd(excel.dateFromName('美国海运价格 2026-10-13.xlsx')), '2026-10-13');
  assert.strictEqual(excel.ymd(excel.dateFromName('价格表2026_10_13.xlsx')), '2026-10-13');
  assert.strictEqual(excel.ymd(excel.dateFromName('美线报价2026年10月13日.xlsx')), '2026-10-13');
  assert.strictEqual(excel.ymd(excel.dateFromName('报价20261013.xlsx')), '2026-10-13');
  assert.strictEqual(excel.dateFromName('无日期价格表.xlsx'), null);
  // 非法日期不应被接受
  assert.strictEqual(excel.dateFromName('价格表2026.13.45.xlsx'), null);
});

test('fileDate: 文件名无日期时退回文件修改时间', () => {
  const lm = new Date(2026, 9, 13, 10, 30).getTime(); // 2026-10-13
  const d = excel.fileDate({ name: '无日期价格表.xlsx', lastModified: lm });
  assert.strictEqual(excel.ymd(d), '2026-10-13');
  // 两者都没有 → null
  assert.strictEqual(excel.fileDate({ name: 'x.xlsx' }), null);
});

test('applyValidity: 止 = 起 + 7 天，已有值不覆盖', () => {
  const base = new Date(2026, 9, 13);
  const a = excel.applyValidity({ name: 'A' }, base);
  assert.strictEqual(a.validFrom, '2026-10-13');
  assert.strictEqual(a.validUntil, '2026-10-20');

  // 跨月
  const b = excel.applyValidity({ name: 'B' }, new Date(2026, 9, 28));
  assert.strictEqual(b.validFrom, '2026-10-28');
  assert.strictEqual(b.validUntil, '2026-11-04');

  // 行内已给出有效期止 → 尊重原值
  const c = excel.applyValidity({ name: 'C', validUntil: '2026-12-31' }, base);
  assert.strictEqual(c.validFrom, '2026-10-13');
  assert.strictEqual(c.validUntil, '2026-12-31');
});

test('aggregateChannels: 有效期起=导入时间（而非文件名日期），止=+7天', async () => {
  const SHARED = '<sst><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si>' +
    '<si><t>以星限时达</t></si><si><t>美西</t></si><si><t>六截三开</t></si></sst>';
  const SHEET = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>25</v></c><c r="D2" t="s"><v>6</v></c></row>' +
    '</sheetData></worksheet>';
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="敏感渠道" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET }
  ], { compress: true });
  // 文件名带 2026.10.13，但有效期起应取导入时间（注入 2026-10-29）
  const file = { name: '436美国海运敏感VIP价格表2026.10.13.xlsx', arrayBuffer: async () => buf };
  const { channels } = await excel.aggregateChannels([file], { importDate: new Date(2026, 9, 29) });
  assert.strictEqual(channels.length, 1);
  assert.strictEqual(channels[0].validFrom, '2026-10-29');
  assert.strictEqual(channels[0].validUntil, '2026-11-05');
});

test('aggregateChannels: 不传 importDate 时默认取今天', async () => {
  const SHARED = '<sst><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si>' +
    '<si><t>以星限时达</t></si><si><t>美西</t></si><si><t>六截三开</t></si></sst>';
  const SHEET = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>25</v></c><c r="D2" t="s"><v>6</v></c></row>' +
    '</sheetData></worksheet>';
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET }
  ], { compress: true });
  const file = { name: '价格表.xlsx', arrayBuffer: async () => buf };
  const { channels } = await excel.aggregateChannels([file]);
  const today = new Date();
  const p = n => (n < 10 ? '0' + n : '' + n);
  assert.strictEqual(channels[0].validFrom, today.getFullYear() + '-' + p(today.getMonth() + 1) + '-' + p(today.getDate()));
});

test('aggregateChannels: CSV 文件同样按导入时间设置有效期', async () => {
  const file = {
    name: '美国海运价格表2026.11.02.csv',
    text: async () => '渠道,美国分区,12KG+,时效\n以星限时达,美西,25,六截三开'
  };
  const { channels } = await excel.aggregateChannels([file], { importDate: new Date(2026, 10, 2) });
  assert.strictEqual(channels[0].validFrom, '2026-11-02');
  assert.strictEqual(channels[0].validUntil, '2026-11-09');
});

test('aggregateChannels: 表内已有有效期列时，导入仍以导入时间为起（覆盖旧值）', async () => {
  const SHARED = '<sst><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si>' +
    '<si><t>有效期起</t></si><si><t>有效期止</t></si>' +
    '<si><t>以星限时达</t></si><si><t>美西</t></si><si><t>六截三开</t></si></sst>';
  const SHEET = '<worksheet><sheetData>' +
    '<row r="1">' +
    ['A', 'B', 'C', 'D', 'E', 'F'].map((col, i) => '<c r="' + col + '1" t="s"><v>' + i + '</v></c>').join('') +
    '</row>' +
    '<row r="2">' +
    '<c r="A2" t="s"><v>6</v></c><c r="B2" t="s"><v>7</v></c><c r="C2"><v>25</v></c><c r="D2" t="s"><v>8</v></c>' +
    '<c r="E2" t="s"><v>4</v></c><c r="F2" t="s"><v>5</v></c>' +
    '</row>' +
    '</sheetData></worksheet>';
  // E2/F2 用字符串索引指向「有效期起」「有效期止」文本而非日期值——这里改用内联文本模拟真实日期
  const SHEET2 = SHEET
    .replace('<c r="E2" t="s"><v>4</v></c><c r="F2" t="s"><v>5</v></c>',
      '<c r="E2" t="inlineStr"><is><t>2026-10-13</t></is></c><c r="F2" t="inlineStr"><is><t>2026-10-20</t></is></c>');
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET2 }
  ], { compress: true });
  const file = { name: '价格表2026.10.13.xlsx', arrayBuffer: async () => buf };
  const { channels } = await excel.aggregateChannels([file], { importDate: new Date(2026, 9, 29) });
  assert.strictEqual(channels.length, 1);
  assert.strictEqual(channels[0].validFrom, '2026-10-29');
  assert.strictEqual(channels[0].validUntil, '2026-11-05');
});

test('carrierFromName: 取文件名开头编号，年份/日期/规格不误判', () => {
  assert.strictEqual(excel.carrierFromName('436美国海运敏感VIP价格表2026.10.13.xlsx'), '436');
  assert.strictEqual(excel.carrierFromName('№436 美国海运价格表.xlsx'), '436');
  assert.strictEqual(excel.carrierFromName('【436】美线报价.xlsx'), '436');
  assert.strictEqual(excel.carrierFromName('1288美线报价.csv'), '1288');
  assert.strictEqual(excel.carrierFromName('价格表2026.10.13.xlsx'), '');
  assert.strictEqual(excel.carrierFromName('2026.10.13美国海运.xlsx'), '');
  assert.strictEqual(excel.carrierFromName('12月价格表.xlsx'), '');
  assert.strictEqual(excel.carrierFromName('20kg以上报价.xlsx'), '');
  assert.strictEqual(excel.carrierFromName('美国海运价格.xlsx'), '');
  assert.strictEqual(excel.carrierFromName(''), '');
});

test('aggregateChannels: 渠道商取文件名开头编号（436）', async () => {
  const SHARED = '<sst><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si>' +
    '<si><t>以星限时达</t></si><si><t>美西</t></si><si><t>六截三开</t></si></sst>';
  const SHEET = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>25</v></c><c r="D2" t="s"><v>6</v></c></row>' +
    '</sheetData></worksheet>';
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="敏感渠道" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET }
  ], { compress: true });

  // 有编号：carrier = 文件名编号
  const withNum = { name: '436美国海运敏感VIP价格表2026.10.13.xlsx', arrayBuffer: async () => buf };
  const r1 = await excel.aggregateChannels([withNum], { importDate: new Date(2026, 9, 29) });
  assert.strictEqual(r1.channels[0].carrier, '436');

  // 无编号：不硬塞，保留空（表内无承运商列）
  const noNum = { name: '美国海运价格表2026.10.13.xlsx', arrayBuffer: async () => buf };
  const r2 = await excel.aggregateChannels([noNum], { importDate: new Date(2026, 9, 29) });
  assert.strictEqual(r2.channels[0].carrier || '', '');
});

test('aggregateChannels: 文件名编号覆盖表内承运商列', async () => {
  const SHARED = '<sst><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si>' +
    '<si><t>承运商</t></si><si><t>以星限时达</t></si><si><t>美西</t></si><si><t>六截三开</t></si><si><t>某货代</t></si></sst>';
  const SHEET = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>5</v></c><c r="B2" t="s"><v>6</v></c><c r="C2"><v>25</v></c><c r="D2" t="s"><v>7</v></c><c r="E2" t="s"><v>8</v></c></row>' +
    '</sheetData></worksheet>';
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET }
  ], { compress: true });
  const file = { name: '436美国海运.xlsx', arrayBuffer: async () => buf };
  const { channels } = await excel.aggregateChannels([file], { importDate: new Date(2026, 9, 29) });
  assert.strictEqual(channels[0].carrier, '436');
});

test('parseWorksheet: 纵向合并单元格自动填充（渠道名跨多行）', () => {
  const xml = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>以星限时达</t></is></c><c r="B1" t="inlineStr"><is><t>美西</t></is></c><c r="C1"><v>25</v></c></row>' +
    '<row r="2"><c r="A2"/><c r="B2" t="inlineStr"><is><t>美中</t></is></c><c r="C2"><v>26</v></c></row>' +
    '<row r="3"><c r="A3"/><c r="B3" t="inlineStr"><is><t>美东</t></is></c><c r="C3"><v>27</v></c></row>' +
    '</sheetData><mergeCells count="1"><mergeCell ref="A1:A3"/></mergeCells></worksheet>';
  const rows = excel.parseWorksheet(xml, []);
  assert.deepStrictEqual(rows.map(r => r.slice(0, 3)), [
    ['以星限时达', '美西', '25'],
    ['以星限时达', '美中', '26'],
    ['以星限时达', '美东', '27']
  ]);
});

test('parseWorksheet: 横向合并（说明文字铺满整行）不扩散到价格/时效列', () => {
  const xml = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>地址</t></is></c><c r="B1" t="inlineStr"><is><t>FBA地址无附加</t></is></c></row>' +
    '</sheetData><mergeCells count="1"><mergeCell ref="B1:G1"/></mergeCells></worksheet>';
  const rows = excel.parseWorksheet(xml, []);
  assert.deepStrictEqual(rows[0], ['地址', 'FBA地址无附加'], 'G 列不应被说明文字填满');
});

test('parseWorksheet: 自闭合单元格不会吞掉后一个单元格的值', () => {
  // 真实价格表的写法：A 列为空的自闭合 <c r="A2"/>，紧跟 B2 是「美中」
  const xml = '<worksheet><sheetData><row r="2">' +
    '<c r="A2" s="27"/><c r="B2" t="s"><v>1</v></c><c r="C2"><v>26</v></c>' +
    '</row></sheetData></worksheet>';
  const rows = excel.parseWorksheet(xml, ['占位', '美中']);
  assert.deepStrictEqual(rows[0], ['', '美中', '26']);
});

test('aggregateChannels: 渠道名合并跨行时，美西/美中/美东三档价都导入', async () => {
  const SHARED = '<sst><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si>' +
    '<si><t>以星限时达</t></si><si><t>美西（邮编8，9）</t></si><si><t>美中（邮编5,6,7）</t></si><si><t>美东（邮编0,1,2,3,4）</t></si>' +
    '<si><t>六截三开</t></si></sst>';
  const SHEET = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>25</v></c><c r="D2" t="s"><v>8</v></c></row>' +
    '<row r="3"><c r="A3"/><c r="B3" t="s"><v>6</v></c><c r="C3"><v>26</v></c><c r="D3"/></row>' +
    '<row r="4"><c r="A4"/><c r="B4" t="s"><v>7</v></c><c r="C4"><v>27</v></c><c r="D4"/></row>' +
    '</sheetData><mergeCells count="2"><mergeCell ref="A2:A4"/><mergeCell ref="D2:D4"/></mergeCells></worksheet>';
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="敏感渠道" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET }
  ], { compress: true });
  const file = { name: '436美国海运敏感VIP价格表2026.10.13.xlsx', arrayBuffer: async () => buf };
  const { channels } = await excel.aggregateChannels([file], { importDate: new Date(2026, 9, 29) });
  assert.strictEqual(channels.length, 3, '三个分区应各成一条渠道');
  assert.deepStrictEqual(channels.map(c => c.dests), ['美西（邮编8，9）', '美中（邮编5，6，7）', '美东（邮编0，1，2，3，4）']);
  assert.deepStrictEqual(channels.map(c => (c.tiers && c.tiers[0] ? c.tiers[0].price : null)), [25, 26, 27]);
  assert.deepStrictEqual(channels.map(c => c.carrier), ['436', '436', '436']);
});

/* ============ 分块价目表模板（如「088美国空海VIP价格表」） ============ */
test('tierOfCell: 12+ / 12-100KG / 101KG-999999 / 包税（1CBM+) 都识别为分段', () => {
  assert.deepStrictEqual(csv.tierOfCell('12+'), { kind: 'w', min: 12, max: null });
  assert.deepStrictEqual(csv.tierOfCell('12KG+'), { kind: 'w', min: 12, max: null });
  assert.deepStrictEqual(csv.tierOfCell('12-100KG'), { kind: 'w', min: 12, max: 100 });
  assert.deepStrictEqual(csv.tierOfCell('101KG-999999'), { kind: 'w', min: 101, max: null });
  assert.deepStrictEqual(csv.tierOfCell('1001KG+'), { kind: 'w', min: 1001, max: null });
  assert.deepStrictEqual(csv.tierOfCell('3001KG-99999'), { kind: 'w', min: 3001, max: null });
  assert.deepStrictEqual(csv.tierOfCell('包税(12KG+)'), { kind: 'w', min: 12, max: null });
  assert.deepStrictEqual(csv.tierOfCell('包税（1CBM+)'), { kind: 'cbm', min: 1, max: null });
  // 不是分段的：列标题、时效、比例说明
  assert.strictEqual(csv.tierOfCell('国家 / 重量(KG)'), null);
  assert.strictEqual(csv.tierOfCell('提取时效'), null);
  assert.strictEqual(csv.tierOfCell('1:200 优惠0.5'), null);
  assert.strictEqual(csv.tierOfCell(''), null);
});

test('parseBlockSheet: 表头上方的标题行 = 渠道名（空运多块表）', () => {
  const grid = [
    ['', 'US01 美国空运普货（快线）'],
    ['', '国家 / 重量(KG)', '', '12+', '51+', '1001-99999', '提取时效'],
    ['', '美西（邮编8 9开头）', '', '68', '65', '62', '3-5个工作日提取\n不接带电 带磁需做磁检'],
    ['', '美中（邮编5 6 7开头）', '', '68', '66', '63', ''],
    ['', 'US02 美国空运普货（经济线）'],
    ['', '国家 / 重量(KG)', '', '12+', '51+', '1001-99999', '提取时效'],
    ['', '美西（邮编8 9开头）', '', '65', '63', '59', '5-7个工作日提取']
  ];
  const list = csv.parseBlockSheet(grid, { sheetName: '美国空运普货', defaultType: 'sea' });
  assert.strictEqual(list.length, 3);
  assert.deepStrictEqual(list.map(c => c.name), ['US01 美国空运普货（快线）', 'US01 美国空运普货（快线）', 'US02 美国空运普货（经济线）']);
  assert.deepStrictEqual(list.map(c => c.type), ['air', 'air', 'air'], '标题含「空运」→ 空运');
  assert.deepStrictEqual(list[0].tiers.map(t => t.wMin), [12, 51, 1001]);
  assert.deepStrictEqual(list[0].tiers.map(t => t.wMax), [51, 1001, null]);
  assert.deepStrictEqual(list[0].tiers.map(t => t.price), [68, 65, 62]);
  assert.strictEqual(list[0].dests, '美西（邮编8 9开头）');
  assert.strictEqual(list[0].transit, '3-5个工作日提取', '时效只取第一行，不带报关说明');
  assert.strictEqual(list[2].tiers[0].price, 65);
});

test('parseBlockSheet: 卡派表（服务区域 + 包税12KG+ + 包税1CBM+），重量/体积两条价都进', () => {
  const grid = [
    ['', '美森卡派正班'],
    ['', '普通产品免附加费 材积/60', '', '', '', '', '返回目录'],
    ['服务区域', '包税(12KG+)', '包税（1CBM+)', '预计入仓时间'],
    ['ONT8 LGB8 LAX9', '12.419', '2483.8', '开船到签收15天左右超19天赔付'],
    ['SCK4 SMF3', '13.299', '2659.8', '开船到签收16天左右超20天']
  ];
  const list = csv.parseBlockSheet(grid, { sheetName: '美森卡派', defaultType: 'sea' });
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].name, '美森卡派正班', '说明行不应被当成渠道名');
  assert.strictEqual(list[0].type, 'sea');
  assert.deepStrictEqual(list[0].tiers, [{ wMin: 12, wMax: null, price: 12.419 }]);
  assert.deepStrictEqual(list[0].cbmTiers, [{ cMin: 1, cMax: null, price: 2483.8 }]);
  assert.strictEqual(list[0].transit, '开船到签收15天左右超19天赔付');
  assert.strictEqual(list[0].dests, 'ONT8 LGB8 LAX9');
});

test('parseBlockSheet: 渠道分类留空沿用上一条；同块内重复分区只留第一条', () => {
  const grid = [
    ['渠道分类', '服务区域', '301-500KG', '501-1000KG'],
    ['US40商卡经济线统配', '邮编 90-91', '9.24', '8.58'],
    ['', '邮编 92', '9.68', '9.02'],
    ['US40商卡经济线统配', '邮编 90-91', '9.46', '8.80'],
    ['', '特别说明：拒收侵权货物', ''],
    ['US51商卡坦帕直航', '邮编32600-34999', '*', '*']
  ];
  const list = csv.parseBlockSheet(grid, { sheetName: '美国海卡纸箱货', defaultType: 'sea' });
  assert.deepStrictEqual(list.map(c => c.name), ['US40商卡经济线统配', 'US40商卡经济线统配']);
  assert.deepStrictEqual(list.map(c => c.dests), ['邮编 90-91', '邮编 92']);
  assert.deepStrictEqual(list[0].tiers.map(t => t.price), [9.24, 8.58], '重复分区保留第一条（带完整信息的那条）');
  assert.strictEqual(list[0].tiers[0].wMax, 500);
});

test('aggregateChannels: 088 类模板整本导入（空运块 + 卡派块），渠道商取文件名编号', async () => {
  function colName(i) {
    let s = ''; i++;
    while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
    return s;
  }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function sheetXmlFrom(grid) {
    return '<worksheet><sheetData>' + grid.map((row, ri) => {
      const cells = row.map((v, ci) => {
        if (v === '' || v == null) return '';
        const ref = colName(ci) + (ri + 1);
        return /^-?\d+(\.\d+)?$/.test(String(v))
          ? '<c r="' + ref + '"><v>' + v + '</v></c>'
          : '<c r="' + ref + '" t="inlineStr"><is><t>' + esc(v) + '</t></is></c>';
      }).join('');
      return '<row r="' + (ri + 1) + '">' + cells + '</row>';
    }).join('') + '</sheetData></worksheet>';
  }
  const airGrid = [
    ['', 'US01 美国空运普货（快线）'],
    ['', '国家 / 重量(KG)', '', '12+', '51+', '101-99999', '提取时效'],
    ['', '美西（邮编8 9开头）', '', '68', '65', '62', '3-5个工作日提取'],
    ['', '美东（邮编0 1 2 3 4开头）', '', '68', '66', '63', '3-5个工作日提取']
  ];
  const seaGrid = [
    ['', '美森卡派正班'],
    ['服务区域', '包税(12KG+)', '包税（1CBM+)', '预计入仓时间'],
    ['ONT8 LGB8', '12.419', '2483.8', '开船到签收15天左右']
  ];
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="美国空运普货" sheetId="1" r:id="rId1"/><sheet name="美森卡派" sheetId="2" r:id="rId2"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>' },
    { name: 'xl/worksheets/sheet1.xml', data: sheetXmlFrom(airGrid) },
    { name: 'xl/worksheets/sheet2.xml', data: sheetXmlFrom(seaGrid) }
  ], { compress: true });
  const file = { name: '088美国空海VIP价格表10.12.xlsx', arrayBuffer: async () => buf };
  const { channels, errors } = await excel.aggregateChannels([file], { importDate: new Date(2026, 9, 29) });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(channels.length, 3);
  assert.deepStrictEqual(channels.map(c => c.type), ['air', 'air', 'sea'], '运输方式按工作表名判断');
  assert.deepStrictEqual(channels.map(c => c.carrier), ['088', '088', '088']);
  assert.deepStrictEqual(channels.map(c => c.validFrom), ['2026-10-29', '2026-10-29', '2026-10-29']);
  assert.deepStrictEqual(channels.map(c => c.validUntil), ['2026-11-05', '2026-11-05', '2026-11-05']);
  assert.strictEqual(channels[0].name, 'US01 美国空运普货（快线）');
  assert.deepStrictEqual(channels[0].tiers, [
    { wMin: 12, wMax: 51, price: 68 },
    { wMin: 51, wMax: 101, price: 65 },
    { wMin: 101, wMax: null, price: 62 }
  ]);
  assert.deepStrictEqual(channels[2].cbmTiers, [{ cMin: 1, cMax: null, price: 2483.8 }]);
});

/* ============ 「几天后更新价格表」：有效期天数可配置 ============ */
test('applyValidity: 第 4 个参数可指定更新天数（非法值回落 7 天）', () => {
  const a = {};
  excel.applyValidity(a, new Date(2026, 9, 29), true, 15);
  assert.strictEqual(a.validFrom, '2026-10-29');
  assert.strictEqual(a.validUntil, '2026-11-13', '15 天后');

  const b = {};
  excel.applyValidity(b, new Date(2026, 9, 29), true);
  assert.strictEqual(b.validUntil, '2026-11-05', '不传仍是 7 天');

  const c = {};
  excel.applyValidity(c, new Date(2026, 9, 29), true, 0);
  assert.strictEqual(c.validUntil, '2026-11-05', '0 天非法，回落 7 天');
});

test('aggregateChannels: opts.validDays 决定有效期止（导入时用「更新天数」）', async () => {
  const SHARED = '<sst><si><t>渠道</t></si><si><t>美国分区</t></si><si><t>12KG+</t></si><si><t>时效</t></si>' +
    '<si><t>以星限时达</t></si><si><t>美西</t></si><si><t>六截三开</t></si></sst>';
  const SHEET = '<worksheet><sheetData>' +
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>4</v></c><c r="B2" t="s"><v>5</v></c><c r="C2"><v>25</v></c><c r="D2" t="s"><v>6</v></c></row>' +
    '</sheetData></worksheet>';
  const buf = makeZip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns:r="x"><sheets><sheet name="敏感渠道" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', data: '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', data: SHARED },
    { name: 'xl/worksheets/sheet1.xml', data: SHEET }
  ], { compress: true });
  const file = { name: '436美国海运.xlsx', arrayBuffer: async () => buf };

  const r15 = await excel.aggregateChannels([file], { importDate: new Date(2026, 9, 29), validDays: 15 });
  assert.strictEqual(r15.channels[0].validFrom, '2026-10-29');
  assert.strictEqual(r15.channels[0].validUntil, '2026-11-13');

  const r3 = await excel.aggregateChannels([file], { importDate: new Date(2026, 9, 29), validDays: 3 });
  assert.strictEqual(r3.channels[0].validUntil, '2026-11-01');

  const rDef = await excel.aggregateChannels([file], { importDate: new Date(2026, 9, 29) });
  assert.strictEqual(rDef.channels[0].validUntil, '2026-11-05', '不传仍按 7 天');
});
