const test = require('node:test');
const assert = require('node:assert');
require('../js/calc.js');
const csv = require('../js/csv.js');

test('detectDelim: 中文逗号被识别', () => {
  assert.strictEqual(csv.detectDelim('渠道名称，目的地，类型'), '，');
  assert.strictEqual(csv.detectDelim('a,b,c'), ',');
  assert.strictEqual(csv.detectDelim('a;b;c'), ';');
});

test('parseCSV: 按行拆分表头与数据', () => {
  const t = '渠道名称,适用目的地,类型\nDHL,US,快递\nUPS,UK,空运';
  const { headers, rows } = csv.parseCSV(t);
  assert.deepStrictEqual(headers, ['渠道名称', '适用目的地', '类型']);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows[0], ['DHL', 'US', '快递']);
});

test('autoMapHeaders: 中英文别名映射', () => {
  const headers = ['渠道名称', '目的国', '运输方式', '首重价', '重量价(¥/kg)', '燃油附加费', '报价有效期'];
  const map = csv.autoMapHeaders(headers);
  // map: index -> field
  const byField = {};
  for (const k in map) byField[map[k]] = headers[k];
  assert.strictEqual(byField.name, '渠道名称');
  assert.strictEqual(byField.dests, '目的国');
  assert.strictEqual(byField.type, '运输方式');
  assert.strictEqual(byField.firstP, '首重价');
  assert.strictEqual(byField.priceKg, '重量价(¥/kg)');
  assert.strictEqual(byField.fuel, '燃油附加费');
  assert.strictEqual(byField.validUntil, '报价有效期');
});

test('buildChannels: 中文表头正确构造渠道对象', () => {
  const text = [
    '渠道名称,适用目的地,类型,首重kg,首重价,续重单位kg,续重价,重量价,体积价,燃油%,折扣%,挂号费,偏远费,报价有效期',
    'DHL,US 美国,国际快递/专线小包,1,30,0.5,8,,,,,,0,2026-12-31',
    '美森海运,US,海运,,,,,5,800,,100,,,2026-12-31',
    '空运A,UK,空运,0,0,0,0,10,0,0,100,0,0,2026-12-31'
  ].join('\n');
  const { headers, rows } = csv.parseCSV(text);
  const { channels } = csv.buildChannels(headers, rows);
  assert.strictEqual(channels.length, 3);
  const dhl = channels[0];
  assert.strictEqual(dhl.name, 'DHL');
  assert.strictEqual(dhl.dests, 'US 美国');
  assert.strictEqual(dhl.type, 'express');
  assert.strictEqual(dhl.firstW, 1);   // 数值型
  assert.strictEqual(dhl.firstP, 30);
  assert.strictEqual(dhl.addU, 0.5);
  assert.strictEqual(dhl.addP, 8);
  const sea = channels[1];
  assert.strictEqual(sea.type, 'sea');
  assert.strictEqual(sea.priceKg, 5);
  assert.strictEqual(sea.priceCbm, 800);
  assert.strictEqual(sea.discount, 100);
  const air = channels[2];
  assert.strictEqual(air.type, 'air');
  assert.strictEqual(air.priceKg, 10);
});

test('buildChannels: 缺名称或目的地的行被跳过', () => {
  const text = [
    '渠道名称,适用目的地',
    '仅名称,',
    ',仅目的地',
    'DHL,US'
  ].join('\n');
  const { headers, rows } = csv.parseCSV(text);
  const { channels } = csv.buildChannels(headers, rows);
  assert.strictEqual(channels.length, 1);
  assert.strictEqual(channels[0].name, 'DHL');
});

test('exportChannelsCsv: 含 BOM 且可回环解析', () => {
  const channels = [
    { type: 'express', name: 'DHL', carrier: 'DHL', dests: 'US', firstW: 1, firstP: 30, addU: 0.5, addP: 8, discount: 100, fuel: 0, regFee: 0, remoteFee: 0, validUntil: '2026-12-31' },
    { type: 'sea', name: '美森海运', dests: 'US', priceKg: 5, priceCbm: 800, minCharge: 0, discount: 100, validUntil: '2026-12-31' }
  ];
  const out = csv.exportChannelsCsv(channels);
  assert.ok(out.charCodeAt(0) === 0xFEFF, '应有 UTF-8 BOM');
  assert.ok(out.indexOf('渠道名称') >= 0);
  assert.ok(out.indexOf('国际快递/专线小包') >= 0); // express 反向映射
  assert.ok(out.indexOf('海运') >= 0);              // sea 反向映射
  // 回环：去掉 BOM 后重新解析
  const { headers, rows } = csv.parseCSV(out.replace(/^﻿/, ''));
  const re = csv.buildChannels(headers, rows);
  assert.strictEqual(re.channels.length, 2);
  assert.strictEqual(re.channels[0].name, 'DHL');
  assert.strictEqual(re.channels[0].type, 'express');
});

test('typeFromText: 中英文类型解析', () => {
  assert.strictEqual(csv.typeFromText('国际快递'), 'express');
  assert.strictEqual(csv.typeFromText('空运'), 'air');
  assert.strictEqual(csv.typeFromText('sea'), 'sea');
  assert.strictEqual(csv.typeFromText(''), 'express'); // 缺省
});

test('buildChannels: “单价/价格”等通用名称也能映射到重量单价', () => {
  const text = [
    '渠道名称,适用目的地,类型,单价,体积单价',
    '中美专线,US,快递,12.5,900',
    '欧洲空运,DE,空运,9,0'
  ].join('\n');
  const { headers, rows } = csv.parseCSV(text);
  const { channels } = csv.buildChannels(headers, rows);
  assert.strictEqual(channels.length, 2);
  const a = channels.find(c => c.name === '中美专线');
  assert.strictEqual(a.priceKg, 12.5, '“单价”应映射到重量单价');
  assert.strictEqual(a.priceCbm, 900, '“体积单价”应映射到体积单价');
  assert.strictEqual(a.firstP === undefined ? '' : a.firstP, ''); // 未误填首重价
});

test('buildChannels: 兜底启发式——未匹配的数值价格列自动归单价', () => {
  const text = [
    '名称,国家,方式,RMB单价,每CBM费用',
    '专线A,CN,快递,13,6',
    '专线B,CN,空运,20,8'
  ].join('\n');
  const { headers, rows } = csv.parseCSV(text);
  const { channels } = csv.buildChannels(headers, rows);
  assert.strictEqual(channels.length, 2);
  const a = channels.find(c => c.name === '专线A');
  assert.strictEqual(a.priceKg, 13, '“RMB单价”含单价且数值，应兜底映射到重量单价');
  assert.strictEqual(a.priceCbm, 6, '“每CBM费用”含 cbm 且数值，应兜底到体积单价');
});

test('buildChannels: 重量分段列(12KG+/71KG+/101KG+)→tiers，自提→selfPickup，且排除无时效的说明行', () => {
  const headers = ['渠道', '美国分区', '12KG+', '71KG+', '101KG+', '自提', '时效', '备注'];
  const rows = [
    ['以星限时达', '美西（邮编8，9）', '25', '21', '19', '14/KG 出库费17USD/板', '六截三开', '可接仿牌'],
    ['外形包装', '包装过软圆形非纸箱', '20', '', '', '', '', ''] // 说明/附加费行：无时效/自提 → 排除
  ];
  const { channels } = csv.buildChannels(headers, rows, 'sea');
  assert.strictEqual(channels.length, 1, '说明/附加费行不应被当作渠道');
  const c = channels[0];
  assert.strictEqual(c.name, '以星限时达');
  assert.strictEqual(c.type, 'sea', '应继承文件名推断的海运类型');
  assert.strictEqual(c.dests, '美西（邮编8，9）', '美国分区应映射到目的地');
  assert.strictEqual(c.selfPickup, 14, '自提“14/KG...”应提取数字 14');
  assert.ok(c.transit.indexOf('六截三开') >= 0);
  assert.deepStrictEqual(c.tiers, [
    { wMin: 12, wMax: 71, price: 25 },
    { wMin: 71, wMax: 101, price: 21 },
    { wMin: 101, wMax: null, price: 19 }
  ]);
});

test('detectTierCols: 识别 Xkg+ 分段列并按 wMin 升序', () => {
  const sorted = csv.detectTierCols(['渠道', '101KG+', '12KG+', '71KG+', '时效']);
  assert.deepStrictEqual(sorted, [
    { index: 2, wMin: 12 },
    { index: 3, wMin: 71 },
    { index: 1, wMin: 101 }
  ]);
});

test('报价有效期起/止：导出后能回环解析到 validFrom / validUntil', () => {
  const channels = [{
    type: 'sea', name: '以星限时达', carrier: '以星', dests: '美西',
    priceKg: 25, validFrom: '2026-10-13', validUntil: '2026-10-20'
  }];
  const out = csv.exportChannelsCsv(channels);
  assert.ok(out.indexOf('有效期起') >= 0, '导出应包含“有效期起”列');
  assert.ok(out.indexOf('有效期止') >= 0, '导出应包含“有效期止”列');
  const { headers, rows } = csv.parseCSV(out.replace(/^\ufeff/, ''));
  const re = csv.buildChannels(headers, rows);
  assert.strictEqual(re.channels.length, 1);
  assert.strictEqual(re.channels[0].validFrom, '2026-10-13');
  assert.strictEqual(re.channels[0].validUntil, '2026-10-20');
});

test('列名“有效期起/报价有效期起/生效日期”都映射到 validFrom', () => {
  ['有效期起', '报价有效期起', '生效日期', '报价日期'].forEach(h => {
    const { headers, rows } = csv.parseCSV(h + ',渠道名称,适用目的地\n2026-10-13,以星限时达,美西');
    const { channels } = csv.buildChannels(headers, rows);
    assert.strictEqual(channels[0].validFrom, '2026-10-13', h + ' 应映射到 validFrom');
  });
});
