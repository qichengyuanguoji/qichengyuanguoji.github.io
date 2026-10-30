(function (root) {
  'use strict';
  const App = root.App = root.App || {};

  /* =========================================================================
   * 通用价目表解析器（js/grid.js）
   * 现有 buildChannels 只擅长「一行一渠道、价格按列铺开」的扁平表；
   * 实际报价单大量是下面这些排版，需要专门拆解：
   *   transpose  行 = 重量档，列 = 渠道/包装/目的国（单元格多为整票总价 → wTiers）
   *   firstAdd   表头含「首重 / 续重」（顺带 11-22KG 这类大货单价档）
   *   longTable  每行一个「渠道 × 重量段」，同渠道多行 → 聚合成阶梯价
   *   grid       多层表头网格：行 = 目的地/仓库（或渠道），列 = 渠道块 × 起运仓 × 重量档
   * 输出统一为渠道对象数组，由 excel.aggregateChannels 补齐渠道商/有效期。
   * ======================================================================= */

  function csvMod() { return root.App && root.App.csv; }

  // Excel 公式错误值（#REF! / #N/A / #DIV/0!）会以字符串形式存在单元格里，
  // 一旦被当成渠道名/目的地写进价格库就很难清，直接按空值处理。
  const ERR_CELL_RE = /^#(ref|n\/a|value|div\/0|name|null|num|spill|calc)!?$/i;
  function txt(v) {
    const s = String(v == null ? '' : v).replace(/[\s　]+/g, ' ').trim();
    return ERR_CELL_RE.test(s) ? '' : s;
  }
  function numOf(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).replace(/[,，\s　]/g, '').replace(/^[¥￥$]/, '');
    if (!s || !/^-?\d+(?:\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    return isFinite(n) ? n : null;
  }
  function widthOf(rows) {
    let w = 0;
    (rows || []).forEach(r => { if (r && r.length > w) w = r.length; });
    return w;
  }
  function hasText(row) { return (row || []).some(v => txt(v)); }

  /* ===== 国家 / 起运仓 / 列语义 ===== */
  const COUNTRY_RE = /(美国|加拿大|墨西哥|英国|德国|法国|意大利|西班牙|荷兰|波兰|奥地利|比利时|捷克|葡萄牙|瑞典|瑞士|丹麦|挪威|芬兰|爱尔兰|希腊|匈牙利|罗马尼亚|斯洛伐克|斯洛文尼亚|保加利亚|克罗地亚|卢森堡|拉脱维亚|立陶宛|爱沙尼亚|日本|韩国|澳大利亚|澳洲|新西兰|越南|泰国|马来西亚|新加坡|菲律宾|印度尼西亚|印尼|印度|巴西|智利|秘鲁|哥伦比亚|阿根廷|欧盟|欧洲|东南亚)/;
  // 起运仓 / 发货地（价格表里同一渠道按起运仓分列）
  const ORIGIN_RE = /(义乌|宁波|杭州|台州|温州|广州|深圳|东莞|佛山|中山|珠海|汕头|厦门|泉州|福州|上海|苏州|南京|无锡|常州|青岛|郑州|天津|北京|济南|潍坊|沧州|保定|石家庄|南昌|合肥|武汉|长沙|成都|重庆|西安|华南|华东|华北|华中|西南|义乌仓|仓库)/;

  const NAME_COL_RE = /(渠道名称|渠道名|下单渠道|渠道|产品名称|产品|线路|方案|服务名称)/;
  const PRICE_COL_RE = /(运费|单价|价格|运价|报价|rate|price)/;
  const FEE_COL_RE = /(挂号|处理费|操作费|手续费|handling)/;
  const NOTE_COL_RE = /(备注|说明|尺寸|计泡|时效|赔偿|返回目录|优势|可接|走货属性|渠道代码|代码)/;
  // 长表表头判定用（要短、要以表头词开头），数据行不会命中
  const HDR_WORD = /^(渠道名称|渠道|产品名称|产品|线路|方案|国家\/地区|国家|目的地|目的港|区域|重量段|重量|限重|计费重|运费|单价|价格|运价|挂号费|处理费|操作费|手续费|时效|参考时效|船期|航程|起运|发货|仓库|备注|说明|包装|尺寸)/;
  const WEIGHT_COL_RE = /^(重量|weight|计费重量|重量kg|重量\/kg|weightkg|国家\/重量|重量\/国家)$/;
  const BAD_SEG_RE = /^(计费规则|计费方式|计费单位|一票多件|运费|单价|价格|处理费|挂号费|备注|说明|返回目录|重量|重量kg|国家|国家\/重量|邮编|区域)/;

  // 渠道特征词：含这些词的段是「渠道名/标题」，不是起运仓（923 的「欧盟FEDEX普货 广州直飞」含「广州」但不是仓）
  const NAMEISH_RE = /(空派|海派|空运|海运|专线|专运|普货|敏感|特货|报价|渠道|包税|派送|直飞|系列|小包|快递|卡派|卡航|快船|直航|特价|特惠|整柜|整箱|拼箱|直送)/;
  function isOriginSeg(s) {
    const t = txt(s);
    if (!t) return false;
    if (NAMEISH_RE.test(t)) return false;
    if (t.length <= 18 && ORIGIN_RE.test(t)) return true;
    // 多个仓挤在一格：「青岛/郑州/温州/台州/连云港/南京/合肥」
    if (t.length <= 40) {
      const parts = t.split(/[\/、,，\s]+/).filter(Boolean);
      if (parts.length >= 2) {
        const hit = parts.filter(p => ORIGIN_RE.test(p)).length;
        if (hit >= Math.max(2, Math.ceil(parts.length * 0.6))) return true;
      }
    }
    return false;
  }

  function countryOf() {
    for (let i = 0; i < arguments.length; i++) {
      const s = txt(arguments[i]);
      if (!s) continue;
      const m = COUNTRY_RE.exec(s);
      if (m) return m[1];
    }
    return '';
  }
  function normKey(s) { return txt(s).toLowerCase(); }

  // 表头单元格常把规格说明全塞进来（269 的「包裹&纸箱= 小箱=ID26162，1、纸箱规格：≤80cm…」），
  // 渠道名只取括号前的主名，再截断，避免渠道库里一列全是长段落。
  function shortName(s, n) {
    let t = txt(s).replace(/[（(][^)）]*[)）]/g, '').trim();
    if (!t) t = txt(s);
    // 「文件&防水袋=PAK=26161 1、PAK袋规格：…」这类把规格写在表头里的，切掉编号列表部分
    t = t.replace(/\s*\d+[、.．]\s*.*$/, '').replace(/[，,]\s*$/, '').trim();
    return t.slice(0, n || 20).trim();
  }

  /* ===== 重量档标签 → { kind, min, max } ===== */
  function tierOfLabel(s0) {
    const raw = txt(s0);
    if (!raw || raw.length > 60) return null;
    // 「近期火车延误预计10-15天」里的 10-15 是时效，不是重量档；误判会把整行表头
    // 沿合并单元格铺成几十个「价格列」（631 芝加哥表就这么炸过）
    if (/\d+\s*[天日]|工作日|时效/.test(raw)) return null;
    // 去掉括号里的补充说明：「0.1-12kg(100克进位)」「25KG以上 （单件包裹限重…）」
    let s = raw.replace(/[（(][^)）]*[)）]/g, '').replace(/[：:]/g, '').trim();
    if (!s || !/\d/.test(s)) {
      // 档位本身写在括号里时（「包税（1CBM+)」），只认括号里的内容；
      // 绝不能退回整串 —— 否则「义乌仓（上海/宁波+0.5/KG）」会被读成 0.5kg 档，
      // 起运仓列就会被当成价格列，整张网格表塌成一半。
      // 另外要有「单位/加号」才算档位：否则「邮编（X=0-9）」里的 0-9 会被读成 0~9kg 档位，
      // 邮编列就变成价格列，整张表（631 芝加哥 70 列）会炸成上千条
      if (/^(邮编|地址|区域|国家|仓库|渠道|销售|备注|说明|代码|重量|时效|货物)/.test(s)) return null;
      const inner = (/[（(]([^)）]*)[)）]/.exec(raw) || [])[1] || '';
      if (!/(cbm|kg|公斤|千克|立方|方|\+|＋|以上)/i.test(inner)) return null;
      const t = (csvMod() && csvMod().tierOfCell) ? csvMod().tierOfCell(inner) : null;
      return t || null;
    }
    const isCbm = /cbm|立方|方/i.test(s);
    const viaCsv = csvMod() && csvMod().tierOfCell ? csvMod().tierOfCell(s) : null;
    if (viaCsv) return viaCsv;
    // 「0Kg≤包裹重量≤0.15kg」「0.05至0.25」
    if (/[≤<≤]|至|到/.test(s)) {
      const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
      if (nums.length >= 2) {
        let a = nums[0], b = nums[nums.length - 1];
        if (a > b) { const t = a; a = b; b = t; }
        if (b <= 1000) return { kind: isCbm ? 'cbm' : 'w', min: a, max: b };
      }
      return null;
    }
    // 只有「+ / 以上」才算「XX 起」；避免「单票低消20KG」这类说明被当成档位
    if (/(\+|＋|以上)/.test(s)) {
      const m = /(\d+(?:\.\d+)?)/.exec(s);
      if (m) return { kind: isCbm ? 'cbm' : 'w', min: Number(m[1]), max: null };
    }
    return null;
  }

  /* ===== 表头行横向补齐（合并单元格只纵向填过，横向靠继承左值） ===== */
  function fillRow(row, width) {
    const out = new Array(width);
    let last = '';
    for (let c = 0; c < width; c++) {
      const s = txt((row || [])[c]);
      if (s) last = s;
      out[c] = last;
    }
    return out;
  }

  /* ===== 标题行 ===== */
  const TITLE_BAD = /^(特别说明|郑重声明|说明|备注|产品描述|类型|返回目录|附加|收费|以上|注意|目录|可接|①|②|③|④|⑤|1、|2、|3、|4、|5、)/;
  // 标题里常跟一段收费规则（「美国空派ORD（限时达）  单件计费重量12公斤起收…」），
  // 渠道名只要前半截主名，否则渠道库里会出现一整段说明文字。
  const TITLE_NOISE = /(单件|计费重量|计费|一票多件|不足\d|私人地址|指定打单|偏远|超长|超重|不含|以上价格|价格表|报价表|生效|备注|说明|拒接|不接受|不接|不承运|禁收)/;
  function cleanTitle(s) {
    let t = txt(s);
    if (!t) return '';
    t = t.split(/\s{2,}/)[0];                       // 两个以上空格 = 标题与说明的分界
    // 括号里是说明而不是名字：「卡派（开船可能有1-7天延时）」
    t = t.replace(/[（(]([^)）]*)[)）]/g, (m, inner) => (/可能|延时|预计|不含|具体|为准|说明|备注/.test(inner) ? '' : m));
    const m = TITLE_NOISE.exec(t);
    if (m && m.index >= 4) t = t.slice(0, m.index);
    // 「以星纽约快线FBA特价 义乌，宁波，杭州…为华东以星ZX2快线」：空格后是走货说明
    if (t.length > 18 && /\s/.test(t)) {
      let head = t.split(/\s+/)[0];
      // 别把括号切一半：「洛杉矶普船28日达直送-卡派（保舱保柜）」
      const opens = (head.match(/[（(]/g) || []).length, closes = (head.match(/[)）]/g) || []).length;
      if (opens > closes) {
        const idx = t.search(/[)）]/);
        if (idx > 0) head = t.slice(0, idx + 1);
      }
      if (head.length >= 4) t = head;
    }
    return t.replace(/[，,、;；\-–—\s]+$/, '').trim();
  }
  // 去掉空格后比较前缀：表里常把「标题 + 目的地」挤在同一格（813 海派、
  // 「美森CLX限时达(14天） 私人地址+1/kg 指定打单+1/kg美西（8，9）」）
  function noSpace(s) { return String(s == null ? '' : s).replace(/[\s　]+/g, ''); }
  function cutByNoSpace(label, title) {
    const nl = noSpace(label), nt = noSpace(title);
    if (!nl || nt.length < 4 || nl.indexOf(nt) !== 0) return '';
    let count = 0, i = 0;
    for (; i < label.length; i++) {
      if (!/\s/.test(label[i])) count++;
      if (count >= nt.length) { i++; break; }
    }
    return label.slice(i).replace(/^[\s　:：\-–—、,，/|]+/, '').trim();
  }
  // 标题行右侧常挂几列表头（「参考时效 / 船期 / 返回价格导航」），
  // 数进去会超过「≤3 段才算标题」的门槛，先把这类字段名剔掉
  const FIELDLIKE = /^(参考时效|时效|船期|航期|返回价格导航|返回目录|备注|说明|序号|总计|合计|合计金额)$/;
  function titleAbove(rows, idx) {
    for (let j = idx - 1, steps = 0; j >= 0 && steps < 5; j--, steps++) {
      const cells = (rows[j] || []).map(txt).filter(v => v && !FIELDLIKE.test(v));
      if (!cells.length) continue;
      if (cells.length > 3) continue;
      if (cells.every(c => numOf(c) !== null)) return '';
      const t = cells.find(c => !NUM_ONLY.test(c)) || '';
      if (!t || TITLE_BAD.test(t) || t.length > 80) continue;
      if (numOf(t) !== null) continue;
      if (tierOfLabel(t)) continue;                    // 「21-50kg」这类档位行不是标题
      if (/首重|续重|重量|单价|计算|以上|\d+\s*(kg|公斤)/i.test(t) && cells.length > 1) continue;
      const clean = cleanTitle(t);
      if (!clean || clean.length < 2) continue;
      return clean;
    }
    return '';
  }
  // 一页里有多个块时，块的标题常常就压在表头区里（813「亚马逊卡派特价」第 2 块起：
  // 「比重优惠…」说明行 → 「美森MAX船FBA卡派特价」标题行 → 「渠道代码/仓库代码」→ 数据），
  // 往上找是上一块的数据行，只能在表头区里再扫一遍
  function titleInBlock(rows, top, hr) {
    for (let r = hr; r >= top; r--) {
      const row = rows[r] || [];
      const cells = row.map(txt).filter(v => v && !FIELDLIKE.test(v));
      if (!cells.length) continue;
      if (cells.every(c => numOf(c) !== null)) continue;
      if (cells.length <= 2) {
        const t = cells.find(c => !NUM_ONLY.test(c)) || '';
        if (!t || t.length < 4) continue;
        if (numOf(t) !== null || tierOfLabel(t) || TITLE_BAD.test(t) || SEG_NOTE_RE.test(t)) continue;
        if (NAME_COL_RE.test(t) || PRICE_COL_RE.test(t) || FEE_COL_RE.test(t) || NOTE_COL_RE.test(t)) continue;
        return cleanTitle(t);
      }
      // 多段行里也常藏着产品名（「仓库代码 | 邮编 | 芝加哥海铁28日达」），只认像渠道名的那一段
      if (row.some(v => numOf(v) !== null)) continue;
      const nm = cells.find(c => TITLE_NAMEISH.test(c) && c.length >= 4 &&
        !tierOfLabel(c) && !/^(仓库|邮编|区域|渠道代码|销售代码|国家)/.test(c));
      if (nm) return cleanTitle(nm);
    }
    return '';
  }
  // 渠道名关键词：用来在「表头上方的标题」和「表头区里的标题」之间择优
  // （631 芝加哥表：上面一行是英文副标题「Central U.S. Business…」，真正产品名
  //  「芝加哥海铁28日达」在表头区里）
  const TITLE_NAMEISH = /(空派|海派|空运|海运|专线|卡派|卡航|海卡|空卡|海铁|海陆|铁运|铁路|快线|直航|直送|小包|快递|特价|包税|快船|限时|达$)/;
  function bestTitle(rows, top, hr) {
    const a = titleAbove(rows, top);
    const b = titleInBlock(rows, top, hr);
    if (a && b) return (TITLE_NAMEISH.test(b) && !TITLE_NAMEISH.test(a)) ? b : a;
    return a || b;
  }
  const NUM_ONLY = /^[\d.\-+%\s]+$/;

  function typeOf(parts, defaultType) {
    const c = csvMod();
    for (let i = 0; i < parts.length; i++) {
      const t = c && c.typeFromText ? c.typeFromText(parts[i], true) : '';
      if (t) return t;
    }
    return defaultType || 'express';
  }

  /* =========================================================================
   * 形态 1：转置（行 = 重量，列 = 渠道 / 包装 / 目的国）
   * 支持一行里有多组「重量列 + 若干价格列」的并排块（如 1910、269）
   * ======================================================================= */
  function tryTranspose(rows, opts) {
    const width = widthOf(rows);
    for (let r = 0; r < Math.min(rows.length, 16); r++) {
      const row = rows[r] || [];
      const wCols = [];
      for (let c = 0; c < width; c++) {
        const s = txt(row[c]).replace(/[\s　（）()]/g, '').toLowerCase();
        if (!s) continue;
        if (WEIGHT_COL_RE.test(s) || /^重量(kg|（kg）)?$/.test(s) || /^weight(kg)?$/.test(s) || s === '国家/重量' || s === '重量/国家') {
          wCols.push(c);
        }
      }
      if (!wCols.length) continue;

      const out = [];
      wCols.forEach((wc, wi) => {
        const nextW = (wi + 1 < wCols.length) ? wCols[wi + 1] : width;
        // 本块的列：重量列右侧到下一个重量列；遇到「备注/返回目录」停止
        const cols = [];
        for (let c = wc + 1; c < nextW; c++) {
          const nm = txt(row[c]);
          if (!nm) continue;
          if (/^(备注|说明|返回目录|时效|赔偿|可接|优势)/.test(nm)) continue;
          if (NOTE_COL_RE.test(nm) && !PRICE_COL_RE.test(nm)) continue;
          cols.push({ c: c, name: nm });
        }
        if (!cols.length) return;
        // 数据行：重量列是正数
        const data = [];
        for (let i = r + 1; i < rows.length; i++) {
          const rr = rows[i] || [];
          const w = numOf(rr[wc]);
          if (w === null || w <= 0) {
            if (data.length && !hasText(rr)) continue;
            continue;
          }
          data.push({ w: w, row: rr });
        }
        if (data.length < 2) return;

        const blockTitle = blockTitleAbove(rows, r, wc, cols[0].c);
        const destsDefault = countryOf(blockTitle, opts.sheetName);
        cols.forEach(col => {
          const vals = data
            .map(d => ({ w: d.w, v: numOf(d.row[col.c]) }))
            .filter(x => x.v !== null && x.v > 0);
          if (vals.length < 2) return;
          // 数值随重量递增 → 整票总价（wTiers）；递减 → 每公斤单价（tiers）
          let inc = 0;
          for (let k = 1; k < vals.length; k++) if (vals[k].v > vals[k - 1].v) inc++;
          const isTotal = vals.length >= 2 && inc / (vals.length - 1) >= 0.6;
          const colIsPrice = PRICE_COL_RE.test(col.name) || /^(价格|运费|单价|报价)$/.test(col.name);
          const colIsCountry = (!!countryOf(col.name) && col.name.replace(/\s/g, '').length <= 8) ||
            /^[A-Z]{2,3}$/.test(col.name.trim());
          const name = colIsPrice
            ? (blockTitle || opts.sheetName || '未命名渠道')
            : (colIsCountry ? (blockTitle || opts.sheetName) : shortName(col.name, 20));
          const dests = (colIsCountry ? (countryOf(col.name) || destsDefault) : destsDefault) || '';
          const ch = {
            type: typeOf([name, blockTitle, opts.sheetName], opts.defaultType),
            name: shortName(name, 40),
            dests: dests
          };
          const tierList = vals.map((x, k) => ({
            wMin: x.w, wMax: (k + 1 < vals.length ? vals[k + 1].w : null), price: x.v
          }));
          if (isTotal) ch.wTiers = tierList;
          else { ch.tiers = tierList; ch.priceKg = vals[0].v; }
          out.push(ch);
        });
      });
      if (out.length) return { kind: 'transpose', channels: out };
    }
    return null;
  }

  // 并排块的表头标题：表头行上方，落在本块列范围内的第一个非空文本
  // 标题位置上其实是「走货限制 / 收费规则」的说明行（1054「不接带电 食品 粉末…6-9天提取」），
  // 要跳过继续往上看，否则渠道名会变成一整句免责声明
  const TITLE_NOTE_RE = /(不接|禁出|违禁|罚款|赔偿|超重费|超长费|超偏远|提取|工作日|截单|计费|低消|投保|出险|实重|泡重|体积|装袋|装箱)/;
  function blockTitleAbove(rows, headerIdx, fromC, toC) {
    for (let j = headerIdx - 1, steps = 0; j >= 0 && steps < 4; j--, steps++) {
      const row = rows[j] || [];
      for (let c = fromC; c <= toC && c < row.length; c++) {
        const s = txt(row[c]);
        if (!s) continue;
        if (TITLE_BAD.test(s) || s.length > 40 || numOf(s) !== null) continue;
        if (TITLE_NOTE_RE.test(s)) continue;
        return cleanTitle(s) || s;
      }
      // 往上继续找（标题常在合并的大格子里，落在块左边界）
    }
    return '';
  }

  /* =========================================================================
   * 形态 2：首重 + 续重（可能带大货单价档）
   * ======================================================================= */
  function tryFirstAdd(rows, opts) {
    const width = widthOf(rows);
    for (let r = 0; r < Math.min(rows.length, 16); r++) {
      const row = rows[r] || [];
      let firstC = -1, addC = -1;
      const extra = [];
      for (let c = 0; c < width; c++) {
        const s = txt(row[c]);
        if (!s) continue;
        if (firstC < 0 && /首重/.test(s)) { firstC = c; continue; }
        if (addC < 0 && /续重/.test(s)) { addC = c; continue; }
        const t = tierOfLabel(s);
        if (t) extra.push({ c: c, t: t, label: s });
      }
      if (firstC < 0 || addC < 0) continue;
      // 首重/续重列头里的重量数字（首重0.5KG / 续重0.5KG）
      const firstW = (/(\d+(?:\.\d+)?)/.exec(txt(row[firstC])) || [])[1];
      const addU = (/(\d+(?:\.\d+)?)/.exec(txt(row[addC])) || [])[1];
      const title = titleAbove(rows, r);
      const destsDefault = countryOf(title, opts.sheetName);
      const out = [];
      for (let i = r + 1; i < rows.length; i++) {
        const rr = rows[i] || [];
        const fv = numOf(rr[firstC]);
        const av = numOf(rr[addC]);
        if (fv === null && av === null) continue;
        const label = txt(rr[0]) || txt(rr[1]);
        if (!label || numOf(label) !== null) continue;
        const name = (title ? title + '-' : '') + label;
        const ch = {
          type: typeOf([name, title, opts.sheetName], opts.defaultType),
          name: name.slice(0, 48),
          dests: destsDefault || title || ''
        };
        if (firstW) ch.firstW = Number(firstW);
        if (fv !== null) ch.firstP = fv;
        if (addU) ch.addU = Number(addU);
        if (av !== null) ch.addP = av;
        const tiers = [];
        extra.forEach(e => {
          const v = numOf(rr[e.c]);
          if (v === null || v <= 0) return;
          tiers.push({ wMin: e.t.min, wMax: e.t.max == null ? null : e.t.max, price: v });
        });
        if (tiers.length) ch.tiers = tiers;
        out.push(ch);
      }
      if (out.length) return { kind: 'firstAdd', channels: out };
    }
    return null;
  }

  /* =========================================================================
   * 形态 3：长表（每行一个「渠道 × 重量段」，运费/kg / 挂号费在列里）
   * 同渠道多行 → 合并为阶梯价；渠道名可来自「渠道名称」列或上方的块标题
   * ======================================================================= */
  function longHeaderOf(row) {
    const width = row ? row.length : 0;
    let nameIdx = -1, codeIdx = -1, zoneIdx = -1, originIdx = -1;
    let wIdx = -1, priceIdx = -1, feeIdx = -1, transitIdx = -1;
    const tierCols = [];
    for (let c = 0; c < width; c++) {
      const s = txt(row[c]);
      if (!s) continue;
      const n = s.replace(/[\s　（）()]/g, '').toLowerCase();
      const tier = tierOfLabel(s);
      if (tier) { tierCols.push({ c: c, t: tier, label: s }); continue; }
      if (wIdx < 0 && /^(重量段|重量区间|限重|重量|计费重|重量kg|重量\/kg|weight|weightkg|重量段\/kg)$/.test(n)) { wIdx = c; continue; }
      if (feeIdx < 0 && FEE_COL_RE.test(n)) { feeIdx = c; continue; }
      if (priceIdx < 0 && PRICE_COL_RE.test(n)) { priceIdx = c; continue; }
      // 「渠道代码」也含「渠道」二字，必须先判代码，否则会被当成渠道名称列（189 表里就出现了 name=ASD11）
      if (codeIdx < 0 && /(渠道代码|对接代码|api渠道代码|代码|code)/.test(n)) { codeIdx = c; continue; }
      if (nameIdx < 0 && NAME_COL_RE.test(n)) { nameIdx = c; continue; }
      if (zoneIdx < 0 && /(国家|目的国|目的地|地区|目的港)/.test(n)) { zoneIdx = c; continue; }
      if (transitIdx < 0 && /(时效|参考时效|航程|航期|运输时间|天数|工作日|transit)/.test(n)) { transitIdx = c; continue; }
      if (originIdx < 0 && /(起运|发货|仓库|起运地|origin)/.test(n)) { originIdx = c; continue; }
    }
    const ok = (priceIdx >= 0 || tierCols.length === 1) &&
      (wIdx >= 0 || tierCols.length === 1) &&
      (nameIdx >= 0 || codeIdx >= 0 || zoneIdx >= 0);
    if (!ok) return null;
    // 数据行长得也像表头（「美国 | 虚拟仓美东特快 | 3-5个工作日 | 0-5 | 88 | 备注长文」），
    // 不加门槛数据行会把真表头顶掉，整张表只剩 0 条（623 的 SHEIN 表就栽在这）。
    // 这里只认「以表头词开头且很短」的单元格，数据行一段都凑不出来。
    let kw = 0;
    for (let c = 0; c < width; c++) {
      const s2 = txt(row[c]);
      if (s2 && s2.length <= 14 && HDR_WORD.test(s2)) kw++;
    }
    if (kw < 2) return null;
    return { nameIdx, codeIdx, zoneIdx, originIdx, wIdx, priceIdx, feeIdx, transitIdx, tierCols };
  }

  function tryLongTable(rows, opts) {
    const width = widthOf(rows);
    const out = [];
    const seen = Object.create(null);
    let title = '';
    let header = null;

    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || [];
      const h = longHeaderOf(row);
      if (h) { header = h; title = titleAbove(rows, r) || title; if (root.__GRID_DBG) console.error('[LT hdr] r=' + r + ' title=' + JSON.stringify(title) + ' h=' + JSON.stringify(h)); continue; }
      if (!header) continue;

      const texts = row.map(txt).filter(Boolean);
      const nums = row.map(numOf).filter(v => v !== null);
      if (!texts.length) continue;
      // 纯标题行（只有 1 个文本）：块标题，重置
      if (texts.length === 1 && !nums.length) {
        if (!TITLE_BAD.test(texts[0])) title = texts[0];
        continue;
      }
      const hh = header;
      const rowName = hh.nameIdx >= 0 ? txt(row[hh.nameIdx]) : '';
      const rowCode = hh.codeIdx >= 0 ? txt(row[hh.codeIdx]) : '';
      const name = rowName || title || rowCode || opts.sheetName || '';
      if (!name) continue;
      const zone = hh.zoneIdx >= 0 ? txt(row[hh.zoneIdx]) : '';
      const dests = zone || countryOf(title, opts.sheetName) || '';
      if (!dests && !name) continue;
      const origin = hh.originIdx >= 0 ? txt(row[hh.originIdx]) : '';

      // 价格：优先「运费/单价」列；只有 1 个档列时用该档列
      let price = hh.priceIdx >= 0 ? numOf(row[hh.priceIdx]) : null;
      let tier = null;
      if (hh.wIdx >= 0) {
        tier = tierOfLabel(row[hh.wIdx]);
        if (price === null && hh.tierCols.length === 1) price = numOf(row[hh.tierCols[0].c]);
      } else if (hh.tierCols.length === 1) {
        tier = hh.tierCols[0].t;
        price = numOf(row[hh.tierCols[0].c]);
      }
      if (price === null || price <= 0) continue;

      const key = normKey(name) + '\u0001' + normKey(dests) + '\u0001' + normKey(origin);
      let ch = seen[key];
      if (!ch) {
        ch = {
          type: typeOf([name, title, opts.sheetName], opts.defaultType),
          name: name.slice(0, 48),
          dests: dests
        };
        if (origin) ch.origin = origin;
        const fee = hh.feeIdx >= 0 ? numOf(row[hh.feeIdx]) : null;
        if (fee !== null && fee > 0) ch.regFee = fee;
        if (hh.transitIdx >= 0) {
          const t0 = txt(row[hh.transitIdx]).split(/\r?\n/)[0];
          if (t0) ch.transit = t0.slice(0, 40);
        }
        ch._tiers = [];
        seen[key] = ch;
        out.push(ch);
      }
      if (ch.regFee === undefined) {
        const fee2 = hh.feeIdx >= 0 ? numOf(row[hh.feeIdx]) : null;
        if (fee2 !== null && fee2 > 0) ch.regFee = fee2;
      }
      if (tier) {
        const dup = ch._tiers.some(t => t.wMin === tier.min);
        if (!dup) {
          ch._tiers.push({
            wMin: tier.min,
            wMax: tier.max == null ? null : tier.max,
            price: price
          });
        }
      } else {
        if (ch.priceKg === undefined) ch.priceKg = price;
      }
    }

    const list = out.filter(c => c._tiers.length || c.priceKg !== undefined);
    list.forEach(c => {
      if (c._tiers.length) {
        c._tiers.sort((a, b) => a.wMin - b.wMin);
        // 没写上限的档，用下一档的下限补齐，便于按重量命中
        c._tiers.forEach((t, i) => { if (t.wMax == null && i + 1 < c._tiers.length) t.wMax = c._tiers[i + 1].wMin; });
        c.tiers = c._tiers;
      }
      delete c._tiers;
    });
    return list.length ? { kind: 'longTable', channels: list } : null;
  }

  /* =========================================================================
   * 形态 4：多层表头网格
   *   行 = 目的地/仓库（或渠道名），列 = 渠道块 × 起运仓 × 重量档，单元格 = 单价
   * ======================================================================= */
  function tierColsOfRow(row, width) {
    const filled = fillRow(row, width);
    const out = [];
    for (let c = 0; c < width; c++) {
      const t = tierOfLabel(filled[c]);
      if (t) out.push({ c: c, t: t, label: filled[c] });
    }
    return out;
  }

  function tryGrid(rows, opts) {
    const width = widthOf(rows);
    let cursor = 0;
    const all = [];
    let usedKind = false;

    while (cursor < rows.length) {
      // 1) 找档行（横向补齐后至少 2 个重量档标签）
      let hr = -1, tierCols = [];
      for (let r = cursor; r < Math.min(rows.length, cursor + 40); r++) {
        const tc = tierColsOfRow(rows[r], width);
        if (tc.length >= 2) { hr = r; tierCols = tc; break; }
      }
      if (hr < 0) break;

      // 1.5) 表头续行合并：一张表的档标签常分散在 2~3 行表头里
      //      （如 624 的「单件0.05-20KG」在上一行、「20-50KG / 51-100KG / 101KG+」在下一行）
      {
        const seenCol = new Set(tierCols.map(t => t.c));
        const merged = tierCols.slice();
        for (let r2 = hr + 1; r2 < Math.min(rows.length, hr + 4); r2++) {
          const row2 = rows[r2] || [];
          const nums2 = row2.filter(v => numOf(v) !== null).length;
          const texts2 = row2.filter(v => txt(v)).length;
          const tc2 = tierColsOfRow(row2, width);
          // 续行必须自己也带重量档标签，否则会把「没有数字的说明行」吞进表头，
          // 表头区被拉长后列路径全乱（631 海运曾因此从 2596 条涨到 20566 条）
          const headerLike = nums2 === 0 && texts2 >= 2 && tc2.length >= 1;
          if (!headerLike) break;
          tc2.forEach(t => { if (!seenCol.has(t.c)) { seenCol.add(t.c); merged.push(t); } });
          hr = r2;
        }
        merged.sort((a, b) => a.c - b.c);
        tierCols = merged;
      }

      // 2) 表头起点：向上收集连续的表头行（遇到空行 / 明显的数据行即停）
      let top = hr;
      for (let r = hr - 1; r >= 0 && r >= hr - 5; r--) {
        const row = rows[r] || [];
        const nums = row.filter(v => numOf(v) !== null).length;
        if (!hasText(row)) { top = r + 1; break; }
        if (nums >= 2) break;
        top = r;
      }

      // 3) 每一列的标签路径（纵向逐行 + 横向继承）
      const filled = [];
      for (let r = top; r <= hr; r++) filled.push(fillRow(rows[r], width));
      const paths = [];
      for (let c = 0; c < width; c++) {
        const seg = [];
        let prev = '';
        for (let k = 0; k < filled.length; k++) {
          const s = txt(filled[k][c]);
          if (!s || s === prev) continue;
          seg.push(s);
          prev = s;
        }
        paths.push(seg);
      }

      const tierColSet = new Set(tierCols.map(t => t.c));
      const feeColSet = new Set();
      paths.forEach((seg, c) => {
        const last = seg[seg.length - 1] || '';
        if (tierOfLabel(last)) return;                  // 最后一段是重量档 → 价格列
        if (FEE_COL_RE.test(last)) feeColSet.add(c);    // 处理费/挂号费列
      });

      // 4) 行标签列：最小的价格列之前的所有列
      const minPriceCol = Math.min.apply(null, tierCols.map(t => t.c));
      const labelCols = [];
      for (let c = 0; c < minPriceCol; c++) labelCols.push(c);
      // 表头第一列若写明「渠道/下单渠道」，说明行标签是渠道名而不是目的地
      const nameHeader = labelCols.some(c => NAME_COL_RE.test(txt((rows[hr] || [])[c]) || (paths[c] || []).join(' ')));
      const sheetDests = countryOf(opts.sheetName);

      // 5) 数据行
      const dataRows = [];
      let pos = hr + 1;
      for (; pos < rows.length; pos++) {
        const row = rows[pos] || [];
        const nums = row.filter(v => numOf(v) !== null && numOf(v) > 0).length;
        const texts = row.filter(v => txt(v)).length;
        if (!nums) {
          if (texts >= 2 && dataRows.length === 0) continue;  // 表头续行/说明
          if (texts === 0) continue;
          if (dataRows.length) break;                          // 块结束
          continue;
        }
        dataRows.push(row);
      }
      if (!dataRows.length) { cursor = hr + 1; continue; }
      usedKind = true;

      // 6) 逐列生成渠道
      // 有的表标题行本身就在表头区里（813 的「美森CLX船FBA卡派特价」占一行、下一行才是
      // 「渠道代码/仓库代码」），此时往上找是空的，退一步把表头首行当标题试一次
      const blockTitle = bestTitle(rows, top, hr);
      if (root.__GRID_DBG) console.error('[grid] hr=' + hr + ' top=' + top + ' title=' + JSON.stringify(blockTitle) + ' tierCols=' + JSON.stringify(tierCols.map(t => t.c)) + ' dataRows=' + dataRows.length + ' nameHeader=' + nameHeader);
      tierCols.forEach(tc => {
        const c = tc.c;
        if (feeColSet.has(c)) return;
        const seg = paths[c] || [];
        const dims = seg.filter(s => {
          if (!s) return false;
          if (tierOfLabel(s)) return false;
          if (BAD_SEG_RE.test(s)) return false;
          if (PRICE_COL_RE.test(s) || FEE_COL_RE.test(s) || NOTE_COL_RE.test(s)) return false;
          if (/^[\d.\-+%]+$/.test(s)) return false;
          return s.length <= 40;
        });
        const origin = dims.find(s => isOriginSeg(s)) || '';
        const rest = dims.filter(s => s !== origin);
        let name = pickName(rest, blockTitle, opts.sheetName);

        dataRows.forEach(row => {
          const v = numOf(row[c]);
          if (v === null || v <= 0) return;
          let chName = name;
          let dests;
          if (nameHeader) {
            chName = labelOf(row, labelCols, blockTitle) || name;
            dests = sheetDests || '';
          } else {
            dests = labelOf(row, labelCols, blockTitle);
            if (!dests) dests = sheetDests || '';
          }
          if (!chName) return;
          const key = normKey(chName) + '\u0001' + normKey(dests) + '\u0001' + normKey(origin);
          let ch = all.find(x => x._k === key);
          if (!ch) {
            ch = {
              type: typeOf([chName, name, blockTitle, opts.sheetName], opts.defaultType),
              name: chName.slice(0, 48),
              dests: dests,
              _k: key,
              _t: []
            };
            if (origin) ch.origin = origin;
            // 费用列（处理费/挂号费）：同一行取第一个正数
            for (const fc of feeColSet) {
              const fv = numOf(row[fc]);
              if (fv !== null && fv > 0) { ch.regFee = fv; break; }
            }
            all.push(ch);
          }
          const t = tc.t;
          if (t.min >= 0 && !ch._t.some(x => x.wMin === t.min)) {
            let max = (t.max == null ? null : t.max);
            ch._t.push({ wMin: t.min, wMax: max, price: v });
          }
        });
      });

      cursor = pos;
    }

    if (root.__GRID_DBG) console.error('[grid] done used=' + usedKind + ' all=' + all.length);
    if (!usedKind || !all.length) return null;
    all.forEach(c => {
      c._t.sort((a, b) => a.wMin - b.wMin);
      c._t.forEach((t, i) => { if (t.wMax == null && i + 1 < c._t.length) t.wMax = c._t[i + 1].wMin; });
      c.tiers = c._t;
      delete c._t;
      delete c._k;
    });
    const list = all.filter(c => c.tiers && c.tiers.length && c.name && c.dests);
    return list.length ? { kind: 'grid', channels: list } : null;
  }

  // 行标签：跳过纯代码（PK1395 / US-EXP-PAK / 序号 1），取第一个像「目的地/仓库/渠道」的文本
  function labelOf(row, cols, blockTitle) {
    const cands = [];
    for (let i = 0; i < cols.length; i++) {
      const s = txt((row || [])[cols[i]]);
      if (!s) continue;
      if (numOf(s) !== null) continue;
      if (/^[A-Za-z]{1,4}[-_ ]?\d{2,}$/.test(s)) continue;   // 仓库/产品代码
      if (/^[A-Za-z]{2,6}(-[A-Za-z0-9]{2,})+$/.test(s)) continue; // US-EXP-PAK
      if (s.length < 2) continue;
      cands.push(s);
    }
    if (!cands.length) return '';
    // 有的表把「渠道标题 + 价格」放在目的地左边一列（813 的 FBA 卡派：
    // 左列「美森CLX船FBA卡派限时达12.98」、右列才是仓库代码），优先取不以标题开头的列
    const nt = noSpace(blockTitle);
    let pick = nt ? cands.find(s => noSpace(s).indexOf(nt) !== 0) : cands[0];
    if (!pick) pick = cands[0];
    const cut = cutByNoSpace(pick, blockTitle);
    if (cut) pick = cut;
    return pick.replace(/\s+/g, ' ').slice(0, 80);
  }

  // 说明/收费规则写进表头的段不能当渠道名（813 的「亚马逊地址-1/kg」）
  const SEG_NOTE_RE = /(\/\s*kg|每\s*kg|[+＋]\s*\d|加收|计费|低消|以上|说明|备注)/i;
  function pickName(segs, blockTitle, sheetName) {
    const title = cleanTitle(blockTitle) || cleanTitle(sheetName) || '';
    const valid = [];
    (segs || []).forEach(s0 => {
      if (!s0 || s0.length > 60) return;
      const s = cleanTitle(s0);                       // 「…特价 COSCO 的 CEN 航线…」只留主名
      if (!s || s.length > 40 || SEG_NOTE_RE.test(s)) return;
      if (valid.indexOf(s) < 0) valid.push(s);
    });
    if (!valid.length) return title.slice(0, 48);
    let main = valid[0];
    valid.forEach(s => { if (s.length > main.length) main = s; });
    if (/\s/.test(main) && /^[\u4e00-\u9fa5]/.test(main)) {
      const head = main.split(/\s+/)[0];
      if (head.length >= 4) main = head;
    }
    // 名称段本身就是标题时不要再拼末段（会变成「美森CLX船FBA卡派·51KG+」）
    if (title && (noSpace(main) === noSpace(title) || noSpace(title).indexOf(noSpace(main)) === 0)) {
      return title.slice(0, 48);
    }
    const last = valid[valid.length - 1];
    if (last && last !== main && last.length <= 12 && main.indexOf(last) < 0) {
      return (main + '·' + last).slice(0, 48);
    }
    return main.slice(0, 48);
  }

  /* ===== 入口：按形态优先级尝试，命中即返回 ===== */
  const SHEET_BAD = /(目录|说明|须知|注意事项|查询库|可达|邮编表|地址列表|反倾销|磁性|偏远|附加费|流程|条款|模板|封面|首页|常见问题|发货须)/;
  // 注意：不要用单字「州」——「广州 / 杭州 / 泉州」都会命中，会把正常价格表判成地址表
  const HEAD_KW = /(地址|城市|邮编|电话|联系人|仓位类型|仓库类型)/;
  const HEAD_KW_EN = /(address|city|state|zip code|zip|warehouse type|contact|phone)/i;
  const HEAD_STRONG = /(地址|address|邮编|zip)/i;

  // 地址表 / 目录页 / 须知页：长得像表格但本质不是价格表（813 的 FBA 代码地址表、
  // 531 的亚马逊地址列表都是上千行的地址库，误当价格表会灌进几百条垃圾渠道）
  function isNonPriceSheet(rows, sheetName) {
    if (SHEET_BAD.test(txt(sheetName))) return true;
    // 只看前 3 行：表头一定在前面；后面的说明行（「非亚马逊地址…邮编…」）与
    // 数据行（「悉尼私人地址 AU2（邮编2000-2999）」）都不能参与判定
    for (let r = 0; r < Math.min(rows.length, 3); r++) {
      const row = rows[r] || [];
      const cells = row.map(txt).filter(Boolean);
      if (cells.length < 3) continue;
      const nums = row.map(numOf).filter(v => v !== null).length;
      if (nums >= 1) continue;                       // 有数字 → 数据行/报价行
      const joined = cells.join(' | ');
      const zh = (joined.match(new RegExp(HEAD_KW.source, 'g')) || []).length;
      const en = (joined.match(new RegExp(HEAD_KW_EN.source, 'gi')) || []).length;
      // 必须同时出现「地址/邮编/zip」这类强特征，避免「广州仓」之类误伤
      if ((zh >= 2 || en >= 2) && HEAD_STRONG.test(joined)) return true;
    }
    return false;
  }

  function parseSheet(rawRows, opts) {
    opts = opts || {};
    const rows = (rawRows || []).filter(r => Array.isArray(r));
    if (rows.length < 3) return null;
    if (isNonPriceSheet(rows, opts.sheetName)) return null;
    const tries = [tryTranspose, tryFirstAdd, tryGrid, tryLongTable];
    for (let i = 0; i < tries.length; i++) {
      let r = null;
      try { r = tries[i](rows, opts); } catch (e) { r = null; }
      if (r && r.channels && r.channels.length) {
        r.channels = tidyChannels(r.channels);
        r.channels = fillTableCountry(r.channels, opts);
        return r;
      }
    }
    return null;
  }

  // 给「只有城市 / 仓库代码、没写国家」的渠道补上国家（写 c.country，不动 dests）。
  // FBA 卡派价目表的目的地往往只写仓号（ONT8）或城市（Bolingbrook），
  // 但整张表通常是同一个国家：表内只要能看出唯一一个国家，其余行就都归到它。
  // 多国混表（923 那种欧洲各国横排）一律不猜，保持空着——猜错比空着更糟。
  function fillTableCountry(list, opts) {
    const arr = list || [];
    if (!arr.length) return arr;
    const calc = root.App && root.App.calc;
    const cty = s => {
      if (calc && calc.countryOfText) return calc.countryOfText(s);
      return countryOf(s);
    };
    const known = Object.create(null);
    arr.forEach(c => {
      if (!c) return;
      const n = cty(c.dests) || cty(c.name);
      if (n) known[n] = (known[n] || 0) + 1;
    });
    // 表名 / 工作表名里的国家也算一条线索（「美国卡派价目表」）
    const fromSheet = cty(opts && opts.sheetName);
    if (fromSheet && !known[fromSheet]) known[fromSheet] = 1;
    const names = Object.keys(known);
    if (names.length !== 1) return arr;
    const only = names[0];
    arr.forEach(c => {
      if (!c || c.country) return;
      if (cty(c.dests) || cty(c.name)) return;
      c.country = only;
    });
    return arr;
  }

  // 收尾：价格统一两位小数（价格表里常有 =单价*克数 这类公式算出来的 116.82503492），
  // 同一档下限重复的档位只留一条（多个块拼在一张表里时会重复）
  function tidyChannels(list) {
    const r2 = v => (v == null || !isFinite(Number(v))) ? v : Math.round(Number(v) * 100) / 100;
    const scalar = ['priceKg', 'priceCbm', 'firstP', 'addP', 'minCharge', 'regFee'];
    const arrays = ['tiers', 'wTiers', 'cbmTiers'];
    (list || []).forEach(c => {
      if (!c) return;
      scalar.forEach(k => { if (c[k] != null) c[k] = r2(c[k]); });
      // 渠道名本身就是国家（「加拿大」「美国」）却没写目的地时，补上——否则这条渠道
      // 会因为「没有目的地」而命中任何国家的查询
      if (!c.dests) {
        const d = countryOf(c.name);
        if (d) c.dests = d;
      }
      arrays.forEach(k => {
        if (!Array.isArray(c[k])) return;
        c[k].forEach(t => { if (t) t.price = r2(t.price); });
        if (c[k].length > 1) {
          const seen = Object.create(null);
          c[k] = c[k].filter(t => {
            const key = (k === 'cbmTiers' ? t.cMin : t.wMin);
            if (seen[key]) return false;
            seen[key] = 1;
            return true;
          });
        }
      });
    });
    return list;
  }

  const api = {
    parseSheet, tryTranspose, tryFirstAdd, tryLongTable, tryGrid, isNonPriceSheet,
    fillTableCountry,
    tierOfLabel, countryOf, numOf, txt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App.grid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
