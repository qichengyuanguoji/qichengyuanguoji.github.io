/* FBA 仓库表：仓库代码 → 城市/州/邮编/国家
 * 用途：运费试算选“FBA 仓库”后，输入仓库代码可自动带出邮编与国家，并用于仓派渠道匹配。
 * 说明：v2.25 起不再内置仓库地址，表里只有用户自己新增/导入的条目（数据与设置里维护）。
 */
(function (root) {
  'use strict';

  // 内置基线已清空（v2.25）：原 65 条常用 FBA 仓库地址从代码里删掉，仓库表只保留
  // 用户自己新增/导入的条目（settings.fbaWh）。需要某些仓可以直接新增或从 CSV 导入。
  const SEED = [];

  const COUNTRY_NAME = { US: '美国', CA: '加拿大', UK: '英国', DE: '德国', JP: '日本', FR: '法国', IT: '意大利', ES: '西班牙', AU: '澳大利亚', MX: '墨西哥' };

  // 国家列反查：表里写「美国 / 加拿大 / uk / United States」都要归一到代码，
  // 否则仓库条目会出现 country:'美国'，运费页按国家匹配仓派渠道就会漏。
  const COUNTRY_ALIAS = {
    '美国': 'US', '加拿大': 'CA', '英国': 'UK', '德国': 'DE', '日本': 'JP', '法国': 'FR',
    '意大利': 'IT', '西班牙': 'ES', '澳大利亚': 'AU', '墨西哥': 'MX',
    USA: 'US', AMERICA: 'US', UNITEDSTATES: 'US', 'UNITEDSTATESOFAMERICA': 'US',
    CANADA: 'CA',
    GB: 'UK', ENGLAND: 'UK', UNITEDKINGDOM: 'UK', GREATBRITAIN: 'UK',
    GERMANY: 'DE', DEUTSCHLAND: 'DE', JAPAN: 'JP', FRANCE: 'FR', ITALY: 'IT',
    SPAIN: 'ES', AUSTRALIA: 'AU', MEXICO: 'MX'
  };
  function normCountry(v) {
    const s = normCode(v);
    if (!s) return '';
    return COUNTRY_ALIAS[s] || s;
  }

  function normCode(v) {
    return String(v == null ? '' : v).trim().toUpperCase().replace(/\s+/g, '');
  }
  function normEntry(e) {
    if (!e) return null;
    const code = normCode(e.code);
    if (!code) return null;
    return {
      code: code,
      city: String(e.city || '').trim(),
      state: String(e.state || '').trim().toUpperCase(),
      zip: String(e.zip || '').trim(),
      country: normCountry(e.country) || 'US',
      custom: !!e.custom
    };
  }

  // 内置基线（v2.25 起为空数组，保留接口以便将来要补回时可直接填数据）
  function seedList() {
    return SEED.map(function (e) { return normEntry(e); });
  }

  // 合并：同码重复时后一条覆盖前一条（v2.25 起不再有内置表，表里全是用户自己的条目）
  function merge(extra) {
    const map = {};
    const order = [];
    (extra || []).forEach(function (raw) {
      const e = normEntry(raw);
      if (!e) return;
      e.custom = true;
      if (!map[e.code]) order.push(e.code);
      map[e.code] = e;
    });
    return order.map(function (c) { return map[c]; });
  }

  function lookup(code, extra) {
    const c = normCode(code);
    if (!c) return null;
    const list = merge(extra);
    for (let i = 0; i < list.length; i++) if (list[i].code === c) return list[i];
    return null;
  }

  // 是否像“仓库代码”（用于识别仓派渠道）：只看形态，不要求表里有这个仓
  function isWhCode(code) {
    const c = normCode(code);
    if (!c) return false;
    if (/^[A-Z]{3}\d{1,2}$/.test(c)) return true;             // ONT8 / LAX9 / YYZ1
    if (/^[A-Z]{2,4}-[A-Z]{3}\d$/.test(c)) return true;        // WMT-LAX1 之类
    return false;
  }

  function search(kw, extra, limit) {
    const k = String(kw || '').trim().toLowerCase();
    const list = merge(extra);
    const hit = !k ? list : list.filter(function (e) {
      return (e.code + ' ' + e.city + ' ' + e.state + ' ' + e.zip + ' ' + e.country).toLowerCase().indexOf(k) >= 0;
    });
    return limit ? hit.slice(0, limit) : hit;
  }

  // 删除一批仓库（v2.25）：仓库表里只有用户自己的条目，删掉就是从 fbaWh 里移除
  function removeEntries(list, extra) {
    const gone = {};
    (list || []).forEach(function (e) {
      const c = normCode(e && e.code);
      if (c) gone[c] = 1;
    });
    const nextExtra = (extra || []).filter(function (x) { return !gone[normCode(x.code)]; });
    return { fbaWh: nextExtra, removedCount: (list || []).length };
  }

  function countryName(c) { return COUNTRY_NAME[normCode(c)] || normCode(c); }

  // 展示用一行摘要：ONT8 · Moreno Valley, CA 92551 · 美国
  function desc(e) {
    if (!e) return '';
    const loc = [e.city, e.state].filter(Boolean).join(', ');
    const tail = [loc, e.zip].filter(Boolean).join(' ');
    return e.code + (tail ? ' · ' + tail : '') + (e.country ? ' · ' + countryName(e.country) : '');
  }

  // 解析仓库 CSV：支持 代码/邮编/国家/城市/州 等中英文表头；无表头时按 代码,城市,州,邮编,国家 顺序
  function splitLine(line) {
    if (line.indexOf('\t') >= 0) return line.split('\t');
    const out = [];
    let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
        } else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map(function (s) { return s.trim(); });
  }

  const COL_ALIAS = {
    code: ['仓库代码', '仓库', '仓码', '仓库编号', 'fba仓', 'fbacode', 'warehouse', 'warehousecode', 'wh', 'whcode', 'code'],
    zip: ['邮编', '邮政编码', 'zip', 'zipcode', 'postal', 'postalcode'],
    country: ['国家', '国别', '目的国', 'country', 'nation'],
    city: ['城市', '市', 'city', 'town'],
    state: ['州', '省', 'state', 'province', 'region']
  };
  function colKey(h) {
    const s = String(h || '').toLowerCase().replace(/[\s_\-()（）]/g, '');
    for (const k in COL_ALIAS) {
      const arr = COL_ALIAS[k];
      for (let i = 0; i < arr.length; i++) if (arr[i] === s) return k;
    }
    return null;
  }

  // 单元格 → 纯文本：xlsx 里邮编/仓号常是数字单元格（92551），
  // 少数情况会带小数点（"92551.0"），直接 String() 会把邮编弄脏。
  function cellText(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (/^-?\d+\.0+$/.test(s)) return s.replace(/\.0+$/, '');
    return s;
  }

  // 二维网格 → 仓库条目（CSV 与 XLSX 共用这一套，列名识别只写一次）
  // 表头可以在前 12 行的任意一行（价目表/仓库表上方常有标题行、空行）；
  // 找不到表头就按「代码,城市,州,邮编,国家」的老顺序兜底。
  const HEAD_SCAN = 12;
  function parseWhRows(rows) {
    const grid = [];
    (rows || []).forEach(function (r) {
      grid.push(Array.isArray(r) ? r.map(cellText) : [cellText(r)]);
    });
    if (!grid.length) return { list: [], bad: 0, headerAt: -1 };

    let headAt = -1;
    const limit = Math.min(grid.length, HEAD_SCAN);
    for (let i = 0; i < limit; i++) {
      let hit = 0, hasCode = false;
      grid[i].forEach(function (h) {
        const k = colKey(h);
        if (!k) return;
        hit++;
        if (k === 'code') hasCode = true;
      });
      // 有「仓库代码」列最稳；没有时至少要认出两列已知列，避免把数据行当表头。
      if (hasCode || hit >= 2) { headAt = i; break; }
    }

    const idx = {};
    let bodyStart = 0;
    if (headAt >= 0) {
      grid[headAt].forEach(function (h, i) {
        const k = colKey(h);
        if (k && idx[k] === undefined) idx[k] = i;
      });
      bodyStart = headAt + 1;
    } else {
      idx.code = 0; idx.city = 1; idx.state = 2; idx.zip = 3; idx.country = 4;
    }

    const list = [];
    let bad = 0;
    for (let i = bodyStart; i < grid.length; i++) {
      const cells = grid[i];
      if (!cells.join('').trim()) continue;   // 空行跳过，不算错误
      const code = normCode(cells[idx.code]);
      if (!code || !code.replace(/[^A-Z0-9\-]/g, '')) { bad++; continue; }
      list.push({
        code: code,
        city: idx.city !== undefined ? cellText(cells[idx.city]) : '',
        state: idx.state !== undefined ? cellText(cells[idx.state]).toUpperCase() : '',
        zip: idx.zip !== undefined ? cellText(cells[idx.zip]) : '',
        country: (idx.country !== undefined ? normCountry(cells[idx.country]) : '') || 'US',
        custom: true
      });
    }
    return { list: list, bad: bad, headerAt: headAt };
  }

  // 解析仓库 CSV：支持 代码/邮编/国家/城市/州 等中英文表头；无表头时按 代码,城市,州,邮编,国家 顺序
  function parseWhCsv(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    if (!lines.length) return { list: [], bad: 0, headerAt: -1 };
    const rows = [];
    let bad = 0;
    lines.forEach(function (ln) {
      const cells = splitLine(ln);
      // 「,,,」这类有分隔符但全空的残行：以前算「坏行」，沿用，避免静默吞掉格式问题
      if (!cells.join('').trim()) { bad++; return; }
      rows.push(cells);
    });
    const out = parseWhRows(rows);
    return { list: out.list, bad: out.bad + bad, headerAt: out.headerAt };
  }

  // xlsx 里常有多张表（仓库表 + 说明表 + 空白模板）。没有表头的表若列出来的
  // 根本不是仓号形态（说明文字、备注），整张表都不采信，避免把说明当仓库导进去。
  function looksLikeWhSheet(list) {
    if (!list || !list.length) return false;
    let ok = 0;
    list.forEach(function (e) {
      if (/^[A-Z]{2,6}\d{0,2}$/.test(e.code)) ok++;
    });
    return ok / list.length >= 0.6;
  }

  // 解析整个工作簿：sheets 为 Excel.parseWorkbook 的结果（[{name,headers,rows,rawRows}]），
  // 每个工作表各自定位表头后合并。返回用到的非空工作表数，供界面提示「导入了几个 sheet」。
  function parseWhSheets(sheets) {
    const list = [];
    let bad = 0, used = 0;
    (sheets || []).forEach(function (sh) {
      if (!sh) return;
      let rows = sh.rawRows;
      if (!rows || !rows.length) {
        if (!(sh.headers && sh.headers.length)) return;
        rows = [sh.headers].concat(sh.rows || []);
      }
      const one = parseWhRows(rows);
      if (!one.list.length) { bad += one.bad; return; }
      // 有表头的表按表头映射，可信；无表头（按列顺序兜底）的表再看一眼仓号形态
      if (one.headerAt < 0 && !looksLikeWhSheet(one.list)) return;
      used++;
      bad += one.bad;
      Array.prototype.push.apply(list, one.list);
    });
    return { list: list, bad: bad, sheets: used };
  }

  // 导入合并：同码后一条覆盖前一条（导入的都是最新地址），新码追加在后
  function mergeWh(extra, incoming) {
    const map = {};
    const order = [];
    (extra || []).concat(incoming || []).forEach(function (raw) {
      const e = normEntry(raw);
      if (!e) return;
      e.custom = true;
      if (!map[e.code]) order.push(e.code);
      map[e.code] = e;
    });
    return order.map(function (c) { return map[c]; });
  }

  const api = {
    SEED: SEED, COUNTRY_NAME: COUNTRY_NAME,
    normCode, normCountry, seedList, merge, lookup, isWhCode, search, countryName, desc,
    parseWhCsv, parseWhRows, parseWhSheets, mergeWh, removeEntries
  };

  root.App = root.App || {};
  root.App.fba = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
