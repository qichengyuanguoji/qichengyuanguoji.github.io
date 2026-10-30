'use strict';
/* 测试用：构造最小可用的 .xlsx（ZIP + XML）
 * 用于 test_wh_xlsx.js（解析逻辑）与 test_ui_smoke.js（导入按钮接线）。
 * 注意：ZIP 头里的压缩前后尺寸必须用「字节长度」，不能用字符串长度，否则中文内容会被截断。
 */
const zlib = require('node:zlib');

function strBytes(s) { return new TextEncoder().encode(s); }

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

function colName(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// rows：二维数组；number 写成数值单元格，其余写成 inlineStr（免 sharedStrings）
function sheetXml(rows) {
  const body = rows.map((cells, ri) => {
    const cs = (cells || []).map((v, ci) => {
      if (v === '' || v == null) return '';
      const ref = colName(ci) + (ri + 1);
      if (typeof v === 'number') return '<c r="' + ref + '"><v>' + v + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr"><is><t>' + String(v) + '</t></is></c>';
    }).join('');
    return '<row r="' + (ri + 1) + '">' + cs + '</row>';
  }).join('');
  return '<worksheet><sheetData>' + body + '</sheetData></worksheet>';
}

// sheets: [{ name, rows }] → ArrayBuffer
function xlsxOf(sheets) {
  const files = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: '<Relationships/>' }
  ];
  const sheetTags = [];
  const relTags = [];
  sheets.forEach((s, i) => {
    const rid = 'rId' + (i + 1);
    sheetTags.push('<sheet name="' + (s.name || ('Sheet' + (i + 1))) + '" sheetId="' + (i + 1) + '" r:id="' + rid + '"/>');
    relTags.push('<Relationship Id="' + rid + '" Target="worksheets/sheet' + (i + 1) + '.xml"/>');
    files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s.rows) });
  });
  files.push({ name: 'xl/workbook.xml', data: '<workbook><sheets>' + sheetTags.join('') + '</sheets></workbook>' });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: '<Relationships>' + relTags.join('') + '</Relationships>' });
  return makeZip(files);
}

// 模拟浏览器 File：只需要 name / text() / arrayBuffer()
function fileStub(name, opts) {
  const o = opts || {};
  return {
    name: name,
    size: 0,
    text: async () => (o.text != null ? o.text : ''),
    arrayBuffer: async () => (o.buffer || new ArrayBuffer(0))
  };
}

module.exports = { makeZip, sheetXml, xlsxOf, fileStub };
