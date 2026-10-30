(function (root) {
  'use strict';

  function num(v, def) {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(String(v).replace(/[,，\s]/g, ''));
    return isFinite(n) ? n : def;
  }

  // 渠道字段 → 中文/英文别名（移植云端 MAP_ALIASES，精简）
  const MAP_ALIASES = {
    name: ['渠道名称', '渠道', '渠道名', '产品', '产品名称', '线路', '线路名称', '服务', '方案', '名称', 'channel', 'name', 'product', 'service', 'route', 'line'],
    type: ['类型', '渠道类型', '运输方式', '物流方式', '方式', '业务类型', '类别', 'type', 'mode', 'method', 'shipping method', 'ship by'],
    carrier: ['承运商', '货代', '物流商', '承运', '物流公司', '供应商', '服务商', '快递公司', '航空公司', '船公司', '代理', 'carrier', 'courier', 'agent', 'forwarder', 'vendor', 'company'],
    origin: ['起运地', '起运港', '出发地', '发货地', '起始地', '起运', '发货', '仓库', 'origin', 'from', 'departure', 'pol', 'port of loading', 'ship from'],
    dests: ['目的地', '目的国', '目的港', '国家', '地区', '分区', '区域', '到达地', '收货地', '目的国家', '流向', '目的', '国别', '目的地区', '美国分区', '目的分区', '适用目的地', 'destination', 'dest', 'country', 'to', 'pod', 'port of discharge', 'arrival', 'ship to'],
    firstW: ['首重', '首重重量', '首重kg', '起重', '起重重量', 'first weight', 'first wt', 'min weight', 'minimum chargeable weight'],
    firstP: ['首重价', '首重价格', '首重费用', '首重费', '首重单价', '首重金额', 'first price', 'first rate', 'first cost'],
    minW: ['最低计费重', '最低重', '最低重量', '最小计费重', '计费起点', '起步重量', '最小重量', '起重kg', 'minimum weight', 'chargeable min'],
    addU: ['续重单位', '续重步进', '续重步长', '加重量', '续重基数', '续重单位kg', 'add weight unit', 'weight step'],
    addP: ['续重价', '续重价格', '续重费用', '续重费', '续重单价', '续重金额', '续重', 'additional weight price', 'add weight price', 'per add weight'],
    priceKg: ['重量价', '单价kg', '每公斤', '公斤价', 'kg价', '重货价', '计费单价', '运输单价', '价格kg', '单价重量', '重量单价', '每kg', 'rate per kg', 'price per kg', 'kg rate', 'air rate', 'weight rate', 'rate/kg', '单价', '价格', '运费', '报价', '运价', '费率', '单价/kg', '每公斤价格', '元/kg', '元kg', 'rmb/kg', '¥/kg', '单价元', '计费价', '干线价', '单价人民币'],
    priceCbm: ['体积价', '体积单价', 'cbm价', '立方价', '每方', '每立方', '方价', '材积价', '立方单价', '每cbm', '每立方米', 'rate per cbm', 'cbm rate', 'volume rate', 'per cbm', 'rate/cbm', '单价cbm', '元/cbm', 'rmb/cbm', '单价立方'],
    minCharge: ['最低收费', '最低消费', '起步价', '最低费用', '最低运费', '最低', '起步费', '最低计费', '最低收费额', 'min charge', 'minimum charge', 'minimum', 'floor'],
    fuel: ['燃油', '燃油费', '燃油附加费', '燃油fee', 'fuel', 'fuel surcharge', 'fuel%'],
    discount: ['折扣', '打折', '折扣率', '系数', 'discount', '折扣%', 'discount%'],
    regFee: ['挂号费', '操作费', '挂号', '操作', '处理费', '手续费', '挂号操作费', 'handling', 'registration', 'reg fee', 'operation fee'],
    remoteFee: ['偏远费', '偏远', '偏远地区', '区域费', '附加费', '远程费', '地区附加费', 'remote', 'remote area', 'remote fee'],
    transit: ['时效', '运输时效', '天数', '时效天', '船期', '航期', 'delivery', 'transit', '时效天数', 'transit time', 'lead time', 'delivery time', 'days'],
    validFrom: ['有效期起', '报价有效期起', '有效期起始', '生效日期', '生效时间', '起始日期', '开始日期', '报价日期', '价格日期', '有效起始', 'valid from', 'valid from date', 'effective from', 'start date', 'from'],
    validUntil: ['有效期止', '有效期截止', '报价有效期止', '有效期', '报价有效期', '有效至', '截止', '到期', '报价截止', '失效日期', '报价到期', 'valid until', 'valid to', 'expiry', 'expiration', 'expiry date', 'effective until', 'validity'],
    note: ['备注', '说明', '注释', 'remark', 'note', '描述', '备注说明', 'comment', 'description'],
    selfPickup: ['自提', '自提价', '自提单价', '自提费率']
  };

  const NUMERIC_FIELDS = ['firstW', 'firstP', 'minW', 'addU', 'addP', 'priceKg', 'priceCbm', 'minCharge', 'fuel', 'discount', 'regFee', 'remoteFee', 'selfPickup'];

  function normCol(s) {
    s = String(s || '').toLowerCase().trim();
    s = s.replace(/[（(].*?[)）]/g, '').replace(/[\s　]/g, '');
    return s;
  }
  function detectDelim(text) {
    const first = (text.split(/\r?\n/)[0] || '');
    const c = (first.match(/,/g) || []).length;
    const sc = (first.match(/;/g) || []).length;
    const t = (first.match(/\t/g) || []).length;
    const fc = (first.match(/，/g) || []).length;
    if (fc >= c && fc >= sc && fc >= t) return '，';
    if (t >= c && t >= sc) return '\t';
    if (sc >= c) return ';';
    return ',';
  }
  function parseCSV(text, delim) {
    delim = delim || detectDelim(text);
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (!lines.length) return { headers: [], rows: [] };
    const split = (line) => line.split(delim).map(c => c.trim());
    const headers = split(lines[0]);
    const rows = lines.slice(1).map(split);
    return { headers, rows };
  }
  // strict=true 时不返回兜底值（用于「工作表名/标题推断类型」，让调用方自己决定兜底）
  function typeFromText(t, strict) {
    t = String(t || '').toLowerCase();
    if (t.indexOf('express') >= 0 || t.indexOf('快递') >= 0 || t.indexOf('小包') >= 0) return 'express';
    if (t.indexOf('air') >= 0 || t.indexOf('空') >= 0) return 'air';
    if (t.indexOf('sea') >= 0 || t.indexOf('海') >= 0 || t.indexOf('卡派') >= 0) return 'sea';
    return strict ? '' : 'express';
  }

  // 自动将表头映射到字段；返回 { headerIndex: field }
  // rows 可选：用于兜底启发式（未匹配且表头像价格、该列基本为数值 → 归到单价）
  // excludeIdx 可选：这些列是重量分段价（tiers），不应被启发式误判为单价
  function autoMapHeaders(headers, rows, excludeIdx) {
    const map = {};
    const used = {};
    headers.forEach((h, i) => {
      const n = normCol(h);
      for (const field in MAP_ALIASES) {
        if (used[field]) continue;
        if (MAP_ALIASES[field].indexOf(n) >= 0) { map[i] = field; used[field] = true; break; }
      }
    });
    // 兜底：未匹配且表头含价格关键词、且抽样基本为数值的列 → 重量单价 / 体积单价
    if (rows && rows.length) {
      const priceKw = /(价|单价|rate|price|kg|运费|报价|运价|费率|元|rmb|金额)/;
      const cbmKw = /(cbm|方|立方|体积|volume)/;
      headers.forEach((h, i) => {
        if (map[i]) return;
        if (excludeIdx && excludeIdx.has(i)) return;
        const n = normCol(h);
        if (!priceKw.test(n) && !cbmKw.test(n)) return;
        const sample = rows.slice(0, 5).map(r => (r[i] === undefined ? '' : String(r[i]).trim())).filter(v => v !== '');
        if (!sample.length) return;
        const numeric = sample.filter(v => num(v.replace(/[^0-9.\-]/g, ''), null) !== null).length;
        if (numeric / sample.length >= 0.6) {
          const field = cbmKw.test(n) ? 'priceCbm' : 'priceKg';
          if (!used[field]) { map[i] = field; used[field] = true; }
        }
      });
    }
    return map;
  }

  // 将一行按映射转为渠道对象（字段级转数值）
  function rowToChannel(map, headerArr, row, defaultType) {
    const ch = { type: defaultType || 'express' };
    for (const idx in map) {
      const field = map[idx];
      let v = row[idx];
      if (v === undefined) continue;
      v = String(v).trim();
      if (field === 'type') { ch.type = typeFromText(v); continue; }
      if (NUMERIC_FIELDS.indexOf(field) >= 0) {
        if (field === 'selfPickup') {
          // “自提”列常为 “14/KG 出库费17USD/板” 这类文本，取首个数字
          const m = v.match(/(\d+(?:\.\d+)?)/);
          ch[field] = m ? num(m[1], '') : '';
        } else {
          ch[field] = num(v, '');
        }
        continue;
      }
      if (field === 'dests') {
        // 目的地常写成「美东 (邮编0,1,2,3，4)」这类混排，统一成全角标点后显示更整齐，
        // 也让同一分区的文本在不同文件之间更容易被判为同一条（覆盖判定用）。
        ch[field] = v.replace(/\s+/g, ' ')
          .replace(/\s+([（(])/g, '（')
          .replace(/\(/g, '（').replace(/\)/g, '）')
          .replace(/,/g, '，')
          .trim();
        continue;
      }
      ch[field] = v.replace(/\s+/g, ' ').trim();
    }
    return ch;
  }

  // 识别“重量分段单价”列：表头形如 12KG+ / 71kg以上 / 100公斤+ → { index, wMin }
  function detectTierCols(headers) {
    const out = [];
    headers.forEach((h, i) => {
      const m = /(\d+(?:\.\d+)?)\s*(?:kg|公斤|千克)\s*\+?/i.exec(String(h || ''));
      if (m) out.push({ index: i, wMin: Number(m[1]) });
    });
    out.sort((a, b) => a.wMin - b.wMin);
    return out;
  }

  function buildChannels(headers, rows, defaultType) {
    const tierCols = detectTierCols(headers);
    const excludeIdx = new Set(tierCols.map(t => t.index));
    const map = autoMapHeaders(headers, rows, excludeIdx);
    // 文件中存在“时效/自提”列时，用它来甄别真正的渠道行：
    // 说明/附加费行通常把长描述放在分区列、且时效/自提为空，应排除。
    const hasTransitCol = Object.keys(map).some(k => map[k] === 'transit');
    const hasSelfPickupCol = Object.keys(map).some(k => map[k] === 'selfPickup');
    const out = [];
    rows.forEach(r => {
      const ch = rowToChannel(map, headers, r, defaultType);
      const hasVal = (x) => x !== undefined && x !== null && x !== '';
      let isChannel = hasVal(ch.name) && hasVal(ch.dests);
      if (isChannel && (hasTransitCol || hasSelfPickupCol)) {
        // 文件含“时效/自提”列时，用它甄别真正的渠道行：
        // 说明/附加费行通常把长描述放分区列、且时效/自提为空，只在第一档价有数字，应排除。
        // 真正的渠道行至少满足：有时效/自提，或≥2 个分段价，或存在首重/续重/重量/体积单价。
        const hasPrice = (ch.tiers && ch.tiers.length >= 2) ||
          hasVal(ch.priceKg) || hasVal(ch.firstP) || hasVal(ch.addP) || hasVal(ch.priceCbm);
        isChannel = !!(hasVal(ch.transit) || hasVal(ch.selfPickup) || hasPrice);
      }
      // 无时效/自提列时，保持原规则：名称 + 目的地 即可（兼容性，如导出 CSV 回环）
      if (!isChannel) return;
      if (tierCols.length) {
        const tiers = tierCols
          .map((tc, i) => ({
            wMin: tc.wMin,
            wMax: (i + 1 < tierCols.length) ? tierCols[i + 1].wMin : null,
            price: num(r[tc.index], '')
          }))
          .filter(t => num(t.price, '') !== '');
        if (tiers.length) ch.tiers = tiers;
      }
      out.push(ch);
    });
    return { map, channels: out };
  }

  /* =========================================================================
   * 分块价目表解析（如「088美国空海VIP价格表」这类模板）：
   *   一张工作表里有多组「渠道标题行 + 表头行 + 若干分区价格行」，
   *   表头形如：国家/分区 | 12+ | 51+ | 71+ | 101+ | 301+ | 1000-99999 | 提取时效
   *   或：     渠道分类 | 国家/分区 | 12-100KG | 101KG-999999 | 提取时效
   *   或：     服务区域 | 包税(12KG+) | 包税（1CBM+) | 预计入仓时间
   * ======================================================================= */

  // 表头单元格 → 分段定义：12+ / 12KG+ / 100公斤以上 / 12-100KG / 3001-99999 / 包税（1CBM+）
  function tierOfCell(text) {
    let s = String(text == null ? '' : text).replace(/[\s　]+/g, '');
    if (!s || s.length > 24) return null;
    if (!/\d/.test(s)) return null;
    const isCbm = /cbm|立方|方/i.test(s);
    s = s.replace(/[（(]/g, '(').replace(/[)）]/g, ')');
    // 单位大小写不定（KG/kg/Kg、CBM/cbm），统一用 i 标志
    let m = /(\d+(?:\.\d+)?)(?:kg|公斤|千克|cbm|立方|方)?[-~—–至](\d+(?:\.\d+)?)/i.exec(s);
    if (m) {
      let lo = Number(m[1]), hi = Number(m[2]);
      if (lo > hi) { const t = lo; lo = hi; hi = t; }
      if (hi >= 99999) hi = null; // 999999/99999 这类是「以上」的哨兵值
      return { kind: isCbm ? 'cbm' : 'w', min: lo, max: hi };
    }
    m = /(\d+(?:\.\d+)?)(?:kg|公斤|千克|cbm|立方|方)?(?:\+|以上)/i.exec(s);
    if (m) return { kind: isCbm ? 'cbm' : 'w', min: Number(m[1]), max: null };
    return null;
  }

  function cellText(v) { return String(v == null ? '' : v).replace(/[\s　]+/g, ' ').trim(); }
  function cellNum(v) {
    const s = String(v == null ? '' : v).replace(/[,，\s]/g, '');
    if (!s) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }

  // 识别一行是否为「表头行」：至少 2 个分段列
  function blockHeaderOf(row) {
    if (!row) return null;
    const tiers = [];
    row.forEach((c, i) => {
      const t = tierOfCell(c);
      if (t) tiers.push({ index: i, kind: t.kind, min: t.min, max: t.max });
    });
    if (tiers.length < 2) return null;
    let zoneIdx = -1, nameIdx = -1, transitIdx = -1, noteIdx = -1;
    row.forEach((c, i) => {
      const s = cellText(c);
      if (!s) return;
      if (tierOfCell(s)) return;
      if (zoneIdx < 0 && /国家|分区|区域|目的地|目的港|邮编|州|港口/.test(s)) zoneIdx = i;
      else if (nameIdx < 0 && /渠道|产品|线路|方案|航线/.test(s)) nameIdx = i;
      else if (transitIdx < 0 && /时效|入仓|提取|开船|航期/.test(s)) transitIdx = i;
      else if (noteIdx < 0 && /派送账号|派送|账号|操作费|附加|比重|备注/.test(s)) noteIdx = i;
    });
    if (zoneIdx < 0 && nameIdx >= 0 && row.length > nameIdx + 1) zoneIdx = nameIdx + 1;
    if (zoneIdx < 0) return null;
    tiers.sort((a, b) => a.min - b.min);
    return { tiers, zoneIdx, nameIdx, transitIdx, noteIdx };
  }

  function typeFromRowText(t) {
    t = String(t || '');
    if (/空|air/i.test(t)) return 'air';
    if (/海|sea|卡派|卡航|卡运/i.test(t)) return 'sea';
    if (/快递|express|小包|专线/i.test(t)) return 'express';
    return '';
  }

  // 标题行：表头上方连续的纯文本行里最靠上的一行（跳过「普通产品免附加费…」这类说明）
  const TITLE_BAD = /^(特别说明|郑重声明|说明|备注|产品描述|类型|返回目录|附加|收费|以上|注意)/;
  const TITLE_BAD2 = /不能超过|不得超过|最长边|单件|汇总|不含|以下|详见|请咨询/;
  function blockTitleAbove(rows, headerIdx, zoneIdx) {
    let best = null;
    let j = headerIdx - 1;
    for (let steps = 0; steps < 4 && j >= 0; steps++, j--) {
      const row = rows[j] || [];
      const cells = row.map(cellText).filter(Boolean);
      if (!cells.length) continue;                       // 空行跳过，继续往上找
      if (cells.length > 2) break;                       // 多列 → 已经是上一条的数据行
      if (cells.some(c => cellNum(c) !== null)) break;    // 有纯数字 → 数据行
      const txt = cellText(row[zoneIdx] !== undefined && row[zoneIdx] !== '' ? row[zoneIdx] : cells[0]);
      if (!txt || TITLE_BAD.test(txt) || TITLE_BAD2.test(txt)) continue; // 说明行：继续往上找真正的标题
      if (txt.length > 26) continue;                     // 过长的一律视作说明，不做渠道名
      best = txt;
    }
    return best;
  }

  // 解析一张「分块」工作表 → 渠道数组
  function parseBlockSheet(rows, opts) {
    opts = opts || {};
    const sheetName = opts.sheetName || '';
    const baseType = opts.defaultType || 'express';
    const out = [];
    let i = 0;
    while (i < rows.length) {
      const h = blockHeaderOf(rows[i]);
      if (!h) { i++; continue; }
      const title = blockTitleAbove(rows, i, h.zoneIdx);
      const blockName = sheetName;
      // 收集数据行
      let j = i + 1;
      let blockRows = 0;
      let lastName = '';
      const seenRow = {};
      for (; j < rows.length; j++) {
        const row = rows[j] || [];
        if (blockHeaderOf(row)) break;                    // 下一块开始了
        const zone = cellText(row[h.zoneIdx]);
        if (!zone) { if (blockRows === 0) break; else continue; }
        const prices = h.tiers.map(t => ({ t, v: cellNum(row[t.index]) }));
        const hit = prices.filter(p => p.v !== null && p.v > 0);
        if (!hit.length) { if (blockRows === 0) break; else continue; } // 说明/附加费行
        // 名称：优先「渠道分类」列（空则沿用上一条的，价格表常用合并/留空表示同一渠道），
        // 其次分块标题，最后工作表名
        let name = h.nameIdx >= 0 ? cellText(row[h.nameIdx]) : '';
        if (name) lastName = name;
        else name = lastName || title || blockName;
        const dests = normDests(zone);
        const rowKey = name + '\u0001' + dests;
        if (seenRow[rowKey]) continue;                    // 同块内重复的分区行（如两段报价）只保留第一条
        seenRow[rowKey] = 1;
        const wTiers = [], cTiers = [];
        const usedW = h.tiers.filter(t => t.kind === 'w');
        h.tiers.forEach((t, k) => {
          const v = cellNum(row[t.index]);
          if (v === null || v <= 0) return;
          if (t.kind === 'cbm') {
            cTiers.push({ cMin: t.min, cMax: (t.max == null ? null : t.max), price: v });
          } else {
            const next = usedW.find(x => x.min > t.min);
            const max = (t.max != null) ? t.max : (next ? next.min : null);
            wTiers.push({ wMin: t.min, wMax: max, price: v });
          }
        });
        const ch = { type: baseType, name: name, dests: normDests(zone) };
        const tt = typeFromRowText(name) || typeFromRowText(sheetName);
        if (tt) ch.type = tt;
        if (wTiers.length) ch.tiers = wTiers;
        if (cTiers.length) ch.cbmTiers = cTiers;
        if (h.transitIdx >= 0) {
          // 时效单元格里常带一大段报关/赔付说明，只取第一行做「时效」，避免把说明塞进列表
          const raw = String(row[h.transitIdx] == null ? '' : row[h.transitIdx]);
          const firstLine = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || '';
          if (firstLine) ch.transit = firstLine.slice(0, 40);
        }
        if (h.noteIdx >= 0) {
          const nt = cellText(row[h.noteIdx]);
          if (nt && nt.length <= 40) ch.note = nt;
        }
        out.push(ch);
        blockRows++;
      }
      i = Math.max(j, i + 1);
    }
    return out;
  }

  function normDests(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ')
      .replace(/\s+([（(])/g, '（')
      .replace(/\(/g, '（').replace(/\)/g, '）')
      .replace(/,/g, '，')
      .trim();
  }

  const CSV_COLS = [
    ['type', '类型'], ['name', '渠道名称'], ['carrier', '承运商'], ['origin', '起运地'],
    ['dests', '适用目的地'], ['firstW', '首重kg'], ['firstP', '首重价'], ['minW', '起重kg'],
    ['addU', '续重单位kg'], ['addP', '续重价'], ['priceKg', '重量价'], ['priceCbm', '体积价'],
    ['minCharge', '最低收费'], ['fuel', '燃油%'], ['discount', '折扣%'], ['regFee', '挂号费'],
    ['remoteFee', '偏远费'], ['transit', '时效'], ['validFrom', '有效期起'], ['validUntil', '有效期止'], ['note', '备注']
  ];
  function csvCell(v) {
    if (v === undefined || v === null) v = '';
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function exportChannelsCsv(channels) {
    const head = CSV_COLS.map(c => c[1]).join(',');
    const lines = [head];
    channels.forEach(c => {
      lines.push(CSV_COLS.map(col => {
        let v = c[col[0]];
        if (col[0] === 'type') v = (v === 'express' ? '国际快递/专线小包' : (v === 'air' ? '空运' : '海运'));
        return csvCell(v);
      }).join(','));
    });
    return '﻿' + lines.join('\n');
  }

  const api = {
    num, normCol, detectDelim, parseCSV, typeFromText, autoMapHeaders, rowToChannel,
    buildChannels, detectTierCols, CSV_COLS, exportChannelsCsv, MAP_ALIASES, NUMERIC_FIELDS,
    parseBlockSheet, blockHeaderOf, tierOfCell, normDests
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.csv = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
