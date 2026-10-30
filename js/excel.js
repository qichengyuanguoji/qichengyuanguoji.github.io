(function (root) {
  'use strict';

  // 纯前端、零依赖的 Excel(.xlsx) 读取器。
  // .xlsx 本质是 ZIP 包（ZIP 内是 XML）。本模块在不引入任何第三方库的前提下：
  //   1) 解析 ZIP 中央目录，定位工作表与共享字符串；
  //   2) 用轻量 XML 提取（而非完整 DOM）还原表格；
  //   3) 复用 csv.js 的列名→字段映射，把行转成渠道对象。
  // .xls（旧版二进制）不在此范围内，将在 UI 层给出友好提示。

  function utf8Decode(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    // 退化方案（仅 ASCII/基本多字节，测试与浏览器均走 TextDecoder）
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* ============ 报价有效期：以「文件时间」为起始，止 = 起始 + 7 天 ============ */
  const VALID_DAYS = 7;

  function ymd(d) {
    const p = n => (n < 10 ? '0' + n : '' + n);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function safeDate(y, m, d) {
    if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    const t = new Date(y, m - 1, d);
    if (t.getFullYear() !== y || t.getMonth() !== m - 1 || t.getDate() !== d) return null;
    return t;
  }
  // 从文件名里取日期：2026.10.13 / 2026-10-13 / 2026_10_13 / 2026年10月13日 / 20261013
  function dateFromName(name) {
    const s = String(name || '');
    let m = /(20\d{2})\s*[.\-_年\/]\s*(\d{1,2})\s*[.\-_月\/]\s*(\d{1,2})/.exec(s);
    if (m) { const d = safeDate(+m[1], +m[2], +m[3]); if (d) return d; }
    m = /(20\d{2})(\d{2})(\d{2})/.exec(s);
    if (m) { const d = safeDate(+m[1], +m[2], +m[3]); if (d) return d; }
    return null;
  }
  // 文件时间：优先文件名里的报价日期，其次文件最后修改时间
  function fileDate(file) {
    const byName = dateFromName(file && file.name);
    if (byName) return byName;
    const lm = file && file.lastModified;
    if (lm) { const t = new Date(lm); if (!isNaN(t.getTime())) return t; }
    return null;
  }
  function addDays(d, n) { const t = new Date(d.getTime()); t.setDate(t.getDate() + n); return t; }
  // 从文件名取「渠道商」编号：文件名开头的数字，如 436美国海运敏感VIP价格表…xlsx → 436
  // 规则：去掉扩展名后，取开头（可跳过最多 8 个非数字字符，容忍「№」「【」这类前缀）的第一段 2~6 位数字；
  // 若这串数字是年份（20xx）或紧跟 年/月/日/号/KG/吨 等量词，视为日期或规格，不当作渠道商编号。
  function carrierFromName(name) {
    const base = String(name || '').replace(/\.[^.\\/]+$/, '');
    const m = /^[^\d]{0,8}(\d{2,6})([\s\S]{0,2})/.exec(base);
    if (!m) return '';
    const num = m[1];
    const tail = m[2] || '';
    if (/^20\d{2}$/.test(num)) return ''; // 年份，不是编号
    if (/^\s*(年|月|日|号|個|个|kg|KG|Kg|吨)/.test(tail)) return ''; // 12月 / 15号 / 20kg 之类
    return num;
  }
  // 给渠道补上 有效期起 / 有效期止（止 = 起 + days 天，days 默认 7，可由「更新天数」设置覆盖）
  // force=true：导入场景，用「导入时间」覆盖表内原有的有效期列（保证刚导入就是有效的）
  function applyValidity(ch, d, force, days) {
    if (!ch || !d) return ch;
    const n = (days != null && isFinite(Number(days)) && Number(days) > 0) ? Math.round(Number(days)) : VALID_DAYS;
    if (force || !ch.validFrom) ch.validFrom = ymd(d);
    if (force || !ch.validUntil) {
      const base = ch.validFrom ? new Date(ch.validFrom + 'T00:00:00') : d;
      if (!isNaN(base.getTime())) ch.validUntil = ymd(addDays(base, n));
    }
    return ch;
  }

  function decodeXmlEntities(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
      .replace(/&amp;/g, '&'); // 放到最后，避免二次解码
  }

  // ---- 共享字符串表 ----
  function parseSharedStrings(xmlText) {
    const out = [];
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRegex.exec(xmlText))) {
      const inner = m[1];
      let text = '';
      const tRegex = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
      let tm;
      while ((tm = tRegex.exec(inner))) text += decodeXmlEntities(tm[1]);
      out.push(text);
    }
    return out;
  }

  function colToIndex(letters) {
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); // A=1
    return n - 1;
  }
  function cellRefToCol(ref) {
    const m = /^([A-Za-z]+)\d+$/.exec(ref || '');
    return m ? m[1].toUpperCase() : null;
  }

  // ---- 工作表 -> 二维数组 ----
  function parseWorksheet(xmlText, sharedStrings) {
    const rows = [];
    const rowNos = []; // rows 下标 -> 真实行号（用于合并单元格定位）
    const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
    let rm;
    while ((rm = rowRegex.exec(xmlText))) {
      const inner = rm[2];
      const rAttr = /\br="(\d+)"/.exec(rm[1] || '');
      const cells = {};
      // 注意：自闭合 <c .../> 必须优先匹配。否则「成对标签」分支会从 '<c r="A10"/>' 一路吃到
      // 下一个 '</c>'，把后一个单元格的值（如「美中」）错记到前一个空单元格上。
      const cRegex = /<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
      let cm;
      while ((cm = cRegex.exec(inner))) {
        const attrs = cm[1] != null ? cm[1] : (cm[2] || '');
        const body = cm[1] != null ? '' : (cm[3] || '');
        const rMatch = /\br="([^"]+)"/.exec(attrs);
        const tMatch = /\bt="([^"]+)"/.exec(attrs);
        const col = cellRefToCol(rMatch ? rMatch[1] : null);
        if (!col) continue;
        const type = tMatch ? tMatch[1] : null;
        let value = '';
        if (type === 'inlineStr') {
          const tm2 = /<t\b[^>]*>([\s\S]*?)<\/t>/.exec(body);
          value = tm2 ? decodeXmlEntities(tm2[1]) : '';
        } else {
          const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
          const raw = vm ? vm[1] : '';
          if (type === 's') {
            const idx = parseInt(raw, 10);
            value = (sharedStrings && sharedStrings[idx] != null) ? sharedStrings[idx] : '';
          } else {
            value = decodeXmlEntities(raw);
          }
        }
        cells[colToIndex(col)] = value;
      }
      const idxs = Object.keys(cells).map(Number);
      if (!idxs.length) { rows.push([]); rowNos.push(rAttr ? +rAttr[1] : 0); continue; }
      const maxIdx = Math.max.apply(null, idxs);
      const arr = new Array(maxIdx + 1);
      for (let i = 0; i <= maxIdx; i++) arr[i] = cells[i] != null ? cells[i] : '';
      rows.push(arr);
      rowNos.push(rAttr ? +rAttr[1] : 0);
    }
    fillMergedCells(xmlText, rows, rowNos);
    return rows;
  }

  // 合并单元格填充：把左上角的值铺满整个合并区域。
  // 价格表常用「渠道名」纵向合并跨多行（美西/美中/美东各占一行），
  // 不填充就会把后面几行当成「缺渠道名」丢掉——这正是美中/美东价格读不到的原因。
  function fillMergedCells(xmlText, rows, rowNos) {
    const block = /<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/.exec(xmlText);
    if (!block) return;
    const byRowNo = {};
    rowNos.forEach((n, i) => { if (n) byRowNo[n] = i; });
    const refRe = /<mergeCell\b[^>]*ref="([^"]+)"[^>]*\/?>/g;
    let mm;
    while ((mm = refRe.exec(block[1]))) {
      const range = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/.exec(mm[1].toUpperCase());
      if (!range) continue;
      const c1 = colToIndex(range[1]);
      const c2 = colToIndex(range[3]);
      const r1 = +range[2];
      const r2 = +range[4];
      // 只处理「同一列跨多行」的纵向合并（渠道名/自提/时效这种重复值）。
      // 横向合并（如 B12:G12）是把一句说明文字铺满整行，扩散到价格/时效列会污染数据，故跳过。
      if (c2 > c1) continue;
      const topIdx = byRowNo[r1];
      if (topIdx == null) continue;
      const top = rows[topIdx] || [];
      const val = top[c1] != null ? top[c1] : '';
      if (val === '') continue;
      for (let r = r1; r <= r2; r++) {
        const ri = byRowNo[r];
        if (ri == null) continue;
        const row = rows[ri];
        for (let c = c1; c <= c2; c++) {
          while (row.length <= c) row.push('');
          if (row[c] == null || row[c] === '') row[c] = val;
        }
      }
    }
  }

  // ---- ZIP（仅解析中央目录） ----
  function parseZipEntries(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('不是有效的 Excel(.xlsx) 文件：找不到 ZIP 中央目录');
    const cdOffset = dv.getUint32(eocd + 16, true);
    let p = cdOffset;
    const entries = [];
    while (p + 4 <= buf.byteLength && dv.getUint32(p, true) === 0x02014b50) {
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const fnLen = dv.getUint16(p + 28, true);
      const exLen = dv.getUint16(p + 30, true);
      const cmLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = utf8Decode(new Uint8Array(buf, p + 46, fnLen));
      entries.push({ name: name.replace(/\\/g, '/'), method, compSize, localOffset });
      p += 46 + fnLen + exLen + cmLen;
    }
    return entries;
  }

  // 自动识别“真正的表头行”：跳过合并大标题 / 空行 / 说明行
  const HEADER_HINTS = ['渠道', '名称', '线路', '产品', '分区', '目的地', '目的国', '国家', '地区', '类型', '方式', '首重', '续重', '重量', '单价', '价', 'kg', 'cbm', '方', '体积', '时效', '有效期', '备注', '承运', '起运', '邮编', '重量'];
  function isHeaderRow(row) {
    if (!row) return false;
    let nonEmpty = 0, score = 0;
    for (const c of row) {
      const s = String(c == null ? '' : c).trim();
      if (!s) continue;
      nonEmpty++;
      const low = s.toLowerCase();
      if (HEADER_HINTS.some(h => low.indexOf(h.toLowerCase()) >= 0)) score++;
    }
    return nonEmpty >= 2 && score >= 2;
  }
  function detectHeaderIndex(rows) {
    for (let i = 0; i < rows.length; i++) if (isHeaderRow(rows[i])) return i;
    return 0;
  }

  async function inflate(slice, method) {
    if (method === 0) return slice; // 存储（未压缩）
    if (typeof DecompressionStream !== 'undefined') {
      const input = slice instanceof Uint8Array ? slice : new Uint8Array(slice);
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(input);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const out = new Uint8Array(total);
      let pos = 0;
      for (const c of chunks) { out.set(c, pos); pos += c.length; }
      return out;
    }
    throw new Error('当前环境不支持解压 Excel 文件（缺少 DecompressionStream，请使用较新版本的 Chrome/Edge）');
  }

  async function getEntryBytes(buf, entries, name) {
    const lc = name.toLowerCase();
    const e = entries.find(x => x.name.toLowerCase() === lc ||
      x.name.toLowerCase().endsWith('/' + lc) ||
      x.name.toLowerCase().replace(/^\//, '') === lc);
    if (!e) return null;
    const dv = new DataView(buf);
    const lo = e.localOffset;
    const fnLen = dv.getUint16(lo + 26, true);
    const exLen = dv.getUint16(lo + 28, true);
    const dataStart = lo + 30 + fnLen + exLen;
    const slice = buf.slice(dataStart, dataStart + e.compSize);
    const inflated = await inflate(slice, e.method);
    return utf8Decode(inflated instanceof Uint8Array ? inflated : new Uint8Array(inflated));
  }

  // 通过 workbook.xml + rels 定位第一个工作表路径
  async function firstSheetTarget(buf, entries) {
    const wb = await getEntryBytes(buf, entries, 'xl/workbook.xml');
    const rels = await getEntryBytes(buf, entries, 'xl/_rels/workbook.xml.rels');
    if (wb) {
      const sheetRegex = /<sheet\b[^>]*>/g;
      let sm, rid = null;
      while ((sm = sheetRegex.exec(wb))) {
        const r = /\br:id="([^"]+)"/.exec(sm[0]);
        if (r) { rid = r[1]; break; }
      }
      if (rid && rels) {
        const tm = new RegExp('<Relationship\\b[^>]*Id="' + escapeRegExp(rid) + '"[^>]*Target="([^"]+)"').exec(rels);
        if (tm) {
          let target = tm[1];
          if (target[0] === '/') target = target.slice(1);
          else if (!/^xl\//i.test(target)) target = 'xl/' + target;
          return target;
        }
      }
    }
    const sheets = entries
      .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return sheets.length ? sheets[0].name : null;
  }

  async function parseXlsx(arrayBuffer) {
    const buf = (arrayBuffer instanceof Uint8Array) ? arrayBuffer.buffer
      : (arrayBuffer instanceof ArrayBuffer ? arrayBuffer : (arrayBuffer.buffer || arrayBuffer));
    if (!(buf instanceof ArrayBuffer)) throw new Error('无效的 Excel 数据');
    const entries = parseZipEntries(buf);
    const target = await firstSheetTarget(buf, entries);
    if (!target) throw new Error('Excel 文件中未找到工作表');
    const sheetXml = await getEntryBytes(buf, entries, target);
    const ssXml = await getEntryBytes(buf, entries, 'xl/sharedStrings.xml');
    const shared = ssXml ? parseSharedStrings(ssXml) : [];
    const rows = parseWorksheet(sheetXml, shared);
    if (!rows.length) return { headers: [], rows: [] };
    const hi = detectHeaderIndex(rows);
    const headers = rows[hi].map(h => String(h || '').trim());
    return { headers, rows: rows.slice(hi + 1) };
  }

  // 列出工作簿中所有工作表：返回 [{ target, name }]（按 workbook.xml 的 sheet 顺序）
  // name 为工作表显示名（如“美森”），取不到时退回文件名
  async function allSheetTargets(buf, entries) {
    const wb = await getEntryBytes(buf, entries, 'xl/workbook.xml');
    const rels = await getEntryBytes(buf, entries, 'xl/_rels/workbook.xml.rels');
    const map = {};
    if (rels) {
      // 属性顺序各家不同：Office 常写 Id 在前，openpyxl / LibreOffice 写 Type、Target 在前，
      // 先把整个标签切出来再分别取 Id 与 Target，否则会读不到工作表名（退回 Sheet1/Sheet2）。
      const rm = /<Relationship\b([^>]*)\/?>/g;
      let x;
      while ((x = rm.exec(rels))) {
        const id = /\bId="([^"]+)"/.exec(x[1]);
        const tg = /\bTarget="([^"]+)"/.exec(x[1]);
        if (id && tg && !map[id[1]]) map[id[1]] = tg[1];
      }
    }
    const order = [];
    if (wb) {
      const sm = /<sheet\b[^>]*>/g; let m;
      while ((m = sm.exec(wb))) {
        const rid = /\br:id="([^"]+)"/.exec(m[0]);
        const nm = /\bname="([^"]*)"/.exec(m[0]);
        if (rid && map[rid[1]]) order.push({ target: map[rid[1]], name: nm ? decodeXmlEntities(nm[1]) : '' });
      }
    }
    let targets = order.map(o => {
      let t = o.target;
      if (t[0] === '/') t = t.slice(1);
      else if (!/^xl\//i.test(t)) t = 'xl/' + t;
      return { target: t, name: o.name || '' };
    });
    if (!targets.length) {
      targets = entries
        .filter(e => /^xl\/worksheets\/sheet\d+\.xml$/i.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .map(e => ({ target: e.name, name: '' }));
    }
    targets.forEach((t, i) => { if (!t.name) t.name = 'Sheet' + (i + 1); });
    return targets;
  }

  // 解析整个工作簿：返回 [{ name, headers, rows }]，每个工作表自动定位表头
  async function parseWorkbook(arrayBuffer) {
    const buf = (arrayBuffer instanceof Uint8Array) ? arrayBuffer.buffer
      : (arrayBuffer instanceof ArrayBuffer ? arrayBuffer : (arrayBuffer.buffer || arrayBuffer));
    if (!(buf instanceof ArrayBuffer)) throw new Error('无效的 Excel 数据');
    const entries = parseZipEntries(buf);
    const targets = await allSheetTargets(buf, entries);
    const ssXml = await getEntryBytes(buf, entries, 'xl/sharedStrings.xml');
    const shared = ssXml ? parseSharedStrings(ssXml) : [];
    const out = [];
    for (const t of targets) {
      const xml = await getEntryBytes(buf, entries, t.target);
      if (!xml) continue;
      const rows = parseWorksheet(xml, shared);
      if (!rows.length) continue;
      const hi = detectHeaderIndex(rows);
      const headers = rows[hi].map(h => String(h || '').trim());
      // rawRows：完整原始网格（含表头行）。某些价目表把「渠道名」写成表头之上一行的分块标题，
      // 且一张表里有多组「标题 + 表头 + 数据行」，只有保留原网格才能按块切分。
      out.push({ name: t.name, target: t.target, headers, rows: rows.slice(hi + 1), rawRows: rows });
    }
    return out;
  }

  // 老解析器（buildChannels）的结果是否可信：
  //  - 名称/目的地不能是纯数字（说明列错位，把价格当成了目的地）
  //  - 至少有一个价格字段
  //  - 同一渠道的阶梯价档位不能重复（重复 = 起运仓/包装那一列没被拆出去）
  // 只要 90% 以上可信就沿用老结果，避免改动已验证好的模板（436 / 088 等）。
  function trustedChannels(list) {
    if (!list || !list.length) return false;
    let ok = 0;
    for (const c of list) {
      const name = String(c.name == null ? '' : c.name).trim();
      const dests = String(c.dests == null ? '' : c.dests).trim();
      if (!name || /^[\d.\s%]+$/.test(name)) continue;
      if (!dests || /^[\d.\s%]+$/.test(dests)) continue;
      const hasPrice = (c.tiers && c.tiers.length) || (c.wTiers && c.wTiers.length) ||
        c.priceKg !== undefined || c.priceCbm !== undefined ||
        c.firstP !== undefined || c.addP !== undefined;
      if (!hasPrice) continue;
      const mins = (c.tiers || []).map(t => t.wMin);
      if (mins.length >= 2 && new Set(mins).size < mins.length) continue;
      ok++;
    }
    return ok / list.length >= 0.9;
  }

  // 根据扩展名分发：CSV 直接走 csv.js，xlsx 走解析器
  async function readWorkbookFile(file) {
    const name = (file && file.name) || '';
    const lower = name.toLowerCase();
    if (lower.endsWith('.csv')) {
      const text = await file.text();
      return App.csv.parseCSV(text);
    }
    if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
      const buf = await file.arrayBuffer();
      return await parseXlsx(buf);
    }
    if (lower.endsWith('.xls')) {
      throw new Error('暂不支持旧版 .xls 格式，请在 Excel 中“另存为 .xlsx”或 CSV 后导入');
    }
    throw new Error('不支持的文件类型（请使用 .xlsx / .csv）');
  }

  // 批量解析多个文件并聚合为渠道对象（供导入按钮复用）
  // 返回 { channels, skipped, errors }：channels 为有效渠道数组；
  // skipped 为所有文件中因缺名称/目的地被跳过的行数；errors 为出问题的文件名+原因
  // 说明：xlsx 会解析其全部工作表并合并；文件名含「海/sea」默认按海运、「空/air」按空运，否则快递。
  // opts.importDate：导入时刻（默认取当前时间），作为「报价有效期起」；止 = 起 + opts.validDays（默认 7）天。
  async function aggregateChannels(fileList, opts) {
    const files = Array.isArray(fileList) ? fileList : Array.from(fileList || []);
    const importDate = (opts && opts.importDate) ? new Date(opts.importDate) : new Date();
    const validDays = (opts && opts.validDays != null && isFinite(Number(opts.validDays)) && Number(opts.validDays) > 0)
      ? Math.round(Number(opts.validDays)) : VALID_DAYS;
    const channels = [];
    let skipped = 0;
    const errors = [];
    for (const file of files) {
      try {
        const name = file && file.name ? file.name : '';
        const lower = name.toLowerCase();
        const defaultType = /海|sea/i.test(name) ? 'sea' : (/空|air/i.test(name) ? 'air' : 'express');
        const fileCarrier = carrierFromName(name); // 渠道商 = 文件名开头的编号（如 436）
        let sheets = [];
        if (lower.endsWith('.csv')) {
          const text = await file.text();
          const { headers, rows } = App.csv.parseCSV(text);
          // rawRows 保留原始网格（含表头行），CSV 若也是「分块价目表」同样走分块解析
          sheets = [{ headers, rows, rawRows: [headers].concat(rows) }];
        } else if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
          const buf = await file.arrayBuffer();
          sheets = await parseWorkbook(buf);
        } else if (lower.endsWith('.xls')) {
          throw new Error('暂不支持旧版 .xls 格式，请在 Excel 中“另存为 .xlsx”或 CSV 后导入');
        } else {
          throw new Error('不支持的文件类型（请使用 .xlsx / .csv）');
        }
        for (const sh of sheets) {
          if (!sh.headers || !sh.headers.length) continue;
          // 运输方式优先按工作表名判断（同一个工作簿常把空运/海运/卡派分表）：
          // 如「088美国空海VIP价格表」里既有「美国空运普货」也有「美国海运（快递派）」。
          const sheetType = App.csv.typeFromText(sh.name || '', true) || defaultType;
          const res = App.csv.buildChannels(sh.headers, sh.rows || [], sheetType);
          let list = res.channels;
          // 单表结构解析不出渠道时，回退到「分块价目表」解析：
          // 这类模板把渠道名写在表头上方的一行标题里，一张表有多组「标题 + 表头 + 分区价格」。
          if (!list.length && sh.rawRows && sh.rawRows.length && App.csv.parseBlockSheet) {
            list = App.csv.parseBlockSheet(sh.rawRows, { defaultType: sheetType, sheetName: sh.name || '' });
          }
          // 通用解析器（js/grid.js）：处理「转置 / 长表聚合 / 多层表头网格 / 首重续重」等排版。
          // 老解析器的结果要「可信」才留下——若档位重复（同一 wMin 出现多次，说明起运仓/包装那一维
          // 没被拆开）或目的地/名称是纯数字，就交给通用解析器重解析，避免把错位的数据写进价格库。
          let g = null;
          if (App.grid && sh.rawRows && sh.rawRows.length) {
            g = App.grid.parseSheet(sh.rawRows, { sheetName: sh.name || '', defaultType: sheetType });
          }
          if (list.length && !trustedChannels(list) && g && g.channels.length) {
            list = g.channels;
          } else if (!list.length && g && g.channels.length) {
            list = g.channels;
          }
          if (!list.length) continue;
          // 渠道商：文件名开头的数字优先（如 436美国海运… → 436）；文件名无编号才沿用表内值
          // 报价有效期起 = 导入时间（用户导入这份文档的时刻），止 = 起 + validDays 天（默认 7，可在首页「设置更新天数」里改）
          list.forEach(c => {
            c._sheet = sh.name || '';
            if (fileCarrier) c.carrier = fileCarrier;
            applyValidity(c, importDate, true, validDays);
          });
          channels.push.apply(channels, list);
          // skipped 只统计「数据行里没解析成渠道的行数」，别把表头/标题行算进去
          const dataRows = (sh.rows ? sh.rows.length : (sh.rawRows ? sh.rawRows.length : 0));
          skipped += Math.max(0, dataRows - list.length);
        }
      } catch (e) {
        errors.push((file && file.name ? file.name : '文件') + '（' + (e && e.message ? e.message : '读取失败') + '）');
      }
    }
    // 去重 + 同名消歧：同一工作簿里多张表常常是不同渠道组合，
    // 会出现“同名同目的地但价格不同”的行——保留但用工作表名区分，避免导入后无法分辨。
    const seen = new Set();
    const uniq = [];
    let duplicates = 0;
    for (const c of channels) {
      // 一个价格都没有的「渠道」是目录页/导航页的残留，写进价格库只会添乱
      if (!hasAnyPrice(c)) continue;
      const key = [c.name, c.dests, c.origin || '', c.type, JSON.stringify(c.tiers || ''),
        JSON.stringify(c.wTiers || ''), c.priceKg, c.firstP, c.addP, c.priceCbm, c.selfPickup, c.transit].join('\u0001');
      if (seen.has(key)) { duplicates++; continue; }
      seen.add(key);
      uniq.push(c);
    }
    // 同名消歧：仅当「同名 + 同目的地 + 同起运仓」真冲突时才用起运仓/工作表名区分；
    // 同名但目的地不同（美西/美中/美东）是正常的按分区报价，保持原名更清晰。
    const nameCount = {};
    uniq.forEach(c => {
      const k = [c.name, c.dests || '', c.origin || ''].join('\u0001');
      nameCount[k] = (nameCount[k] || 0) + 1;
    });
    uniq.forEach(c => {
      const k = [c.name, c.dests || '', c.origin || ''].join('\u0001');
      if (nameCount[k] > 1) {
        const tag = c.origin || c._sheet;
        if (tag) c.name = c.name + '（' + tag + '）';
      }
      delete c._sheet;
    });
    return { channels: uniq, skipped, errors, duplicates };
  }

  // 判断渠道是否带着可用价格（元/kg、元/CBM、阶梯价、整票价、首重价任一）
  function hasAnyPrice(c) {
    if (!c) return false;
    const pos = (v) => v != null && isFinite(Number(v)) && Number(v) > 0;
    if (pos(c.priceKg) || pos(c.priceCbm) || pos(c.firstP) || pos(c.minCharge)) return true;
    const arrs = [c.tiers, c.wTiers, c.cbmTiers];
    for (const a of arrs) {
      if (Array.isArray(a) && a.some(t => t && pos(t.price))) return true;
    }
    return false;
  }

  const api = { parseXlsx, parseWorkbook, readWorkbookFile, parseSharedStrings, parseWorksheet, colToIndex, parseZipEntries, aggregateChannels, detectHeaderIndex, dateFromName, fileDate, carrierFromName, applyValidity, ymd, VALID_DAYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.excel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
