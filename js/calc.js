(function (root) {
  'use strict';

  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  function num(v, def) {
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    return isFinite(n) ? n : def;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr(d) {
    d = d ? new Date(d) : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function shiftDay(n, from) {
    const d = from ? new Date(from) : new Date();
    d.setDate(d.getDate() + n);
    return todayStr(d);
  }
  // 仅比较日期，返回 a - b 的天数（a、b 为 YYYY-MM-DD）。
  // 约定与云端一致：daysBetween(validUntil, today) 为负表示已过期。
  function daysBetween(aStr, bStr) {
    const a = new Date(aStr + 'T00:00:00');
    const b = new Date(bStr + 'T00:00:00');
    return Math.round((a - b) / 86400000);
  }

  function typeName(t) {
    return t === 'express' ? '快递小包' : (t === 'air' ? '空运' : '海运');
  }

  // 渠道商显示文本。
  // 价格表导入时 carrier 多数是货代编号（价目表文件名开头的 631 / 813 这种），
  // CSV 或手工录入时又可能是名字（顺丰 / 美森），所以这里两种都认：
  // 有名字优先显示名字，名字和编号不是同一个东西时把编号带上「顺丰国际（631）」，
  // 便于回价目表对照；两者都没有就明确写「未标注」——卡片上留一行空白会被当成渲染漏了。
  function carrierText(c) {
    if (!c) return '未标注';
    const code = String(c.carrier || '').trim();
    const name = String(c.carrierName || '').trim();
    if (name && name !== code) return code ? (name + '（' + code + '）') : name;
    return name || code || '未标注';
  }

  /* ============ 阶梯价 ============ */
  function tierSorted(tiers) { return tiers.slice().sort((a, b) => a.wMin - b.wMin); }
  // 报价表覆盖到多重 = 这张表「到底有没有这个重量的价」。两个坑：
  //  1) 单价表（tiers，¥/kg）末档写死了上限（如小包表只到 5kg），
  //     超出就是没报价；以前会回退成首档价，于是 20kg 也被算出「首档 126¥/kg」。
  //  2) 整票价表（wTiers，¥/票）每档是「这一档一票多少钱」，末档 wMax 为空只是
  //     数据源没写上界，并不代表 100kg 也收这一档的钱。269「文件封 0.5-1kg / 1kg 以上 154.75」
  //     按末档价外推，100kg 只报 154.75，比所有大货渠道都便宜 —— 「只做小货」的渠道反而排第一。
  //     所以整票价表末档开放时只保一个步长（文件封 1.5kg、PAK 5.5kg、小箱 11.5kg）。
  function tierMaxOf(tiers, isTotal) {
    if (!tiers || !tiers.length) return null;
    const list = tierSorted(tiers);
    const last = list[list.length - 1];
    if (last.wMax != null) return last.wMax;
    if (!isTotal) return null;                        // 单价表：该档以上每 kg 同价，无限覆盖
    const prev = list[list.length - 2];
    let step = prev ? last.wMin - prev.wMin : 0;
    if (!(step > 0)) step = 0.5;                      // 只有一档：按 0.5kg 步长
    return round2(last.wMin + step);
  }
  // 重量档「整票价」：小包价目表常见「0.5kg 98.9 元/票、1kg 134.38 元/票」，
  // 价格就是这一档的总运费（不是单价/kg），按计费重落档取该档总价。
  function tierTotalForWeight(tiers, w) {
    if (!tiers || !tiers.length) return null;
    const list = tierSorted(tiers);
    const max = tierMaxOf(list, true);
    if (max != null && w >= max) return null;         // 超出报价表覆盖范围：没价
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (w >= t.wMin && (t.wMax == null || w < t.wMax)) return t.price;
    }
    if (w < list[0].wMin) return list[0].price;      // 不足首档按首档（小包惯例）
    return list[list.length - 1].price;
  }
  function tierPriceForWeight(tiers, w) {
    if (!tiers || !tiers.length) return null;
    const list = tierSorted(tiers);
    const max = tierMaxOf(list, false);
    if (max != null && w >= max) return null;         // 末档封顶，超出没价
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (w >= t.wMin && (t.wMax == null || w < t.wMax)) return t.price;
    }
    if (w < list[0].wMin) return list[0].price;      // 低于首档按首档
    return list[list.length - 1].price;
  }
  function tierPriceForVolume(tiers, v) {
    if (!tiers || !tiers.length) return null;
    for (let i = 0; i < tiers.length; i++) {
      const t = tiers[i];
      if (v >= t.cMin && (t.cMax == null || v < t.cMax)) return t.price;
    }
    return tiers[0].price;
  }

  /* ============ FBA 仓库代码识别（简化版，完整地址解析列入 v2-later） ============ */
  const WH_BLACK = /^(US|USA|CBM|KG|KGS|ZIP|FEDEX|UPS|DHL|DPD|TNT|RMB|USD|FBA|PR|HI|AK|CDG|LHR|NRT)$/;
  // 常见纯字母仓（其余由 ONT8 / WMT-LAX1 等正则覆盖）
  const WH_MAP = { IUSP: 1, IUSQ: 1, SMF1: 1, SMF3: 1, FTW1: 1, FTW2: 1, MDW2: 1, ONT8: 1, LAX9: 1, LGB8: 1 };
  function whTokens(s0) {
    const s = String(s0 || '').toUpperCase();
    if (!s) return [];
    const tokens = s.split(/[^A-Z0-9\-]+/);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = String(tokens[i] || '').trim();
      if (!t || t.length < 3 || t.length > 9) continue;
      if (WH_BLACK.test(t)) continue;
      if (/^\d/.test(t)) continue;
      const ok = /^[A-Z]{3}\d{1,2}$/.test(t)
        || /^[A-Z]{2,4}-[A-Z]{3}\d{1}$/.test(t)
        || (Object.prototype.hasOwnProperty.call(WH_MAP, t))
        // 有 FBA 仓库表时以表为准（覆盖 SMF1 / IUSP 等纯字母仓）
        || !!(root.App && root.App.fba && root.App.fba.isWhCode && root.App.fba.isWhCode(t));
      if (!ok) continue;
      if (out.indexOf(t) < 0) out.push(t);
    }
    return out;
  }
  const WH_CACHE = new Map();
  const ZIP_CACHE = new Map();
  function whCodesOf(ch) {
    if (!ch) return [];
    if (ch.whCodes && ch.whCodes.length) return ch.whCodes;
    // 按 dests 字符串缓存：比价时对全库跑一遍 matchChannels，每条都要 whTokens(dests)
    // （一串正则 split/test），上万条渠道单次就是十几万次正则。dests 相同的行占大多数，
    // 缓存后同一份价目表只需要算一次。
    const key = String(ch.dests || '');
    const hit = WH_CACHE.get(key);
    if (hit) return hit;
    const r = whTokens(key);
    if (WH_CACHE.size > 8000) WH_CACHE.clear();
    WH_CACHE.set(key, r);
    return r;
  }
  function isWhChannel(ch) { return whCodesOf(ch).length > 0; }

  /* ============ 邮编范围规则 ============ */
  function zipRuleOf(dests) {
    const src = String(dests || '');
    if (ZIP_CACHE.has(src)) return ZIP_CACHE.get(src);
    const r = zipRuleParse(src);
    if (ZIP_CACHE.size > 8000) ZIP_CACHE.clear();
    ZIP_CACHE.set(src, r);
    return r;
  }
  function zipRuleParse(dests) {
    const s = String(dests || '');
    const m = /邮编\s*([0-9A-Za-z\s\-\—~至、,，和及.]{1,40})/.exec(s)
      || /ZIP\s*[:：]?\s*([0-9A-Za-z\s\-\—~至、,，和及.]{1,40})/i.exec(s);
    if (!m) return null;
    const body = String(m[1]).replace(/[（(].*$/, '').replace(/开头.*$/, '');
    if (!/\d/.test(body)) return null;
    const toks = body.match(/\d+/g);
    if (!toks || !toks.length) return null;
    let digits = 1;
    for (let i = 0; i < toks.length; i++) { if (toks[i].length >= 2) { digits = 2; break; } }
    const allow = {};
    const re2 = /(\d+)\s*(?:[-—~至]\s*(\d+))?/g;
    let mm;
    while ((mm = re2.exec(body))) {
      let a = parseInt(mm[1], 10);
      let b = mm[2] ? parseInt(mm[2], 10) : a;
      if (!isFinite(a)) continue;
      if (!isFinite(b)) b = a;
      if (b < a) { const t0 = a; a = b; b = t0; }
      // 完整 5 位邮编区间（如 90000-92999）：按前两位区域展开，避免被下方的区间上限截断
      if (digits === 2 && a >= 1000 && b >= 1000) {
        let pa = Math.floor(a / 1000);
        let pb = Math.floor(b / 1000);
        if (pb - pa > 99) pb = pa + 99;
        for (let p = pa; p <= pb; p++) allow[String(p).slice(-2)] = 1;
        continue;
      }
      if (b - a > 40) b = a + 40;
      for (let v = a; v <= b; v++) {
        let key = digits === 2 ? String(v).slice(-2) : String(v).slice(-1);
        if (digits === 2 && String(v).length < 2) key = ('0' + v).slice(-2);
        allow[key] = 1;
      }
    }
    const keys = []; for (const k in allow) keys.push(k);
    if (!keys.length) return null;
    return { digits, allow };
  }
  function zipMatchRule(zip, rule) {
    if (!zip || !rule) return true;
    const z = String(zip).replace(/[^0-9A-Za-z]/g, '');
    if (!z) return true;
    return !!rule.allow[z.slice(0, rule.digits)];
  }

  /* ============ 目的地同义词（价格表常写“美西/美东”，用户常输“美国/US”） ============
     每组第一个是**标准国家名**，其余是别名（区域写法、英文、缩写）。
     快捷测算只按国家名搜索，靠这张表把「美西」「US」「澳洲」「印尼」都归到一个国家上。 */
  const DEST_GROUPS = [
    ['美国', '美西', '美东', '美中', '美南', '美北', '波多黎各', 'us', 'usa', 'pr', 'america', 'united states'],
    ['加拿大', 'ca', 'canada'],
    ['墨西哥', 'mx', 'mexico'],
    ['英国', 'uk', 'gb', 'england', 'britain'],
    ['爱尔兰', 'ie', 'ireland'],
    ['德国', 'de', 'germany'],
    ['法国', 'fr', 'france'],
    ['意大利', 'it', 'italy'],
    ['西班牙', 'es', 'spain'],
    ['葡萄牙', 'pt', 'portugal'],
    ['荷兰', 'nl', 'netherlands', 'holland'],
    ['比利时', 'be', 'belgium'],
    ['卢森堡', 'lu', 'luxembourg'],
    ['奥地利', 'at', 'austria'],
    ['瑞士', 'ch', 'switzerland'],
    ['波兰', 'pl', 'poland'],
    ['捷克', 'cz', 'czech'],
    ['斯洛伐克', 'sk', 'slovakia'],
    ['匈牙利', 'hu', 'hungary'],
    ['罗马尼亚', 'ro', 'romania'],
    ['保加利亚', 'bg', 'bulgaria'],
    ['希腊', 'gr', 'greece'],
    ['克罗地亚', 'hr', 'croatia'],
    ['斯洛文尼亚', 'si', 'slovenia'],
    ['瑞典', 'se', 'sweden'],
    ['丹麦', 'dk', 'denmark'],
    ['挪威', 'no', 'norway'],
    ['芬兰', 'fi', 'finland'],
    ['拉脱维亚', 'lv', 'latvia'],
    ['立陶宛', 'lt', 'lithuania'],
    ['爱沙尼亚', 'ee', 'estonia'],
    ['俄罗斯', 'ru', 'russia'],
    ['乌克兰', 'ua', 'ukraine'],
    ['土耳其', 'tr', 'turkey'],
    ['以色列', 'il', 'israel'],
    ['沙特阿拉伯', '沙特', 'sa', 'saudi'],
    ['阿联酋', '迪拜', 'ae', 'uae', 'dubai'],
    ['日本', 'jp', 'japan'],
    ['韩国', 'kr', 'korea'],
    ['澳大利亚', '澳洲', 'au', 'australia'],
    ['新西兰', 'nz', 'new zealand'],
    ['越南', 'vn', 'vietnam'],
    ['泰国', 'th', 'thailand'],
    ['马来西亚', 'my', 'malaysia'],
    ['新加坡', 'sg', 'singapore'],
    ['菲律宾', 'ph', 'philippines'],
    ['印度尼西亚', '印尼', 'id', 'indonesia'],
    ['印度', 'in', 'india'],
    ['巴基斯坦', 'pk', 'pakistan'],
    ['孟加拉', 'bd', 'bangladesh'],
    ['斯里兰卡', 'lk', 'sri lanka'],
    ['柬埔寨', 'kh', 'cambodia'],
    ['缅甸', 'mm', 'myanmar'],
    ['巴西', 'br', 'brazil'],
    ['智利', 'cl', 'chile'],
    ['秘鲁', 'pe', 'peru'],
    ['哥伦比亚', 'co', 'colombia'],
    ['阿根廷', 'ar', 'argentina'],
    ['南非', 'za', 'south africa'],
    ['埃及', 'eg', 'egypt'],
    ['尼日利亚', 'ng', 'nigeria'],
    ['肯尼亚', 'ke', 'kenya'],
    ['摩洛哥', 'ma', 'morocco'],
    ['哈萨克斯坦', 'kz', 'kazakhstan'],
    ['欧洲', '欧盟', 'eu', 'europe'],
    ['东南亚', 'sea', 'southeast asia'],
    ['中东', 'me', 'middle east']
  ];

  function isCjkWord(k) { return /[\u4e00-\u9fa5]/.test(k); }

  /* 找分组：英文/缩写只做整词全等（否则 “sea” 会命中 “seattle”）；
     中文取**最长**命中的别名——“印度尼西亚”必须命中印尼，不能被“印度”截走。 */
  function destGroupOf(tok) {
    const t = String(tok == null ? '' : tok).trim().toLowerCase();
    if (!t) return -1;
    for (let i = 0; i < DEST_GROUPS.length; i++) {
      const g = DEST_GROUPS[i];
      for (let k = 0; k < g.length; k++) {
        if (!isCjkWord(g[k]) && t === g[k]) return i;
      }
    }
    let best = -1, bestLen = 0;
    for (let i = 0; i < DEST_GROUPS.length; i++) {
      const g = DEST_GROUPS[i];
      for (let k = 0; k < g.length; k++) {
        if (!isCjkWord(g[k])) continue;
        if (t.indexOf(g[k]) >= 0 && g[k].length > bestLen) { bestLen = g[k].length; best = i; }
      }
    }
    return best;
  }
  function destAlike(a, b) {
    if (!a || !b) return false;
    if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
    const ga = destGroupOf(a), gb = destGroupOf(b);
    return ga >= 0 && ga === gb;
  }
  /* ============ 国家名归一（快捷测算只按国家搜） ============ */

  // 严格校验：整串必须就是一个国家名/别名（「US」「美西」算，「美国芝加哥」不算）。
  // 快捷测算的输入框用它把关——用户输城市时直接挡住，不要拿它去碰运气匹配。
  function countryName(v) {
    const t = String(v == null ? '' : v).trim().toLowerCase();
    if (!t) return '';
    for (let i = 0; i < DEST_GROUPS.length; i++) {
      const g = DEST_GROUPS[i];
      for (let k = 0; k < g.length; k++) {
        if (t === g[k]) return g[0];
      }
    }
    return '';
  }
  function isCountryName(v) { return !!countryName(v); }

  // 从一段目的地文字里认国家（「美西（邮编8 9开头）」→ 美国，「邮编1开头」→ 空）
  const CTY_CACHE = new Map();
  function countryOfText(s) {
    const key = String(s == null ? '' : s);
    if (!key) return '';
    const hit = CTY_CACHE.get(key);
    if (hit !== undefined) return hit;
    const g = destGroupOf(key);
    const out = g >= 0 ? DEST_GROUPS[g][0] : '';
    if (CTY_CACHE.size > 8000) CTY_CACHE.clear();
    CTY_CACHE.set(key, out);
    return out;
  }

  // 渠道归哪个国家：显式字段优先（导入时按表补的），再看目的地，目的地里没写（只写了城市/仓号）
  // 就看渠道名。价格表里「Bolingbrook」「ONT8」这类只有城市或仓库代码的渠道很多，得靠 c.country 兜住。
  function countryOfChannel(c) {
    if (!c) return '';
    if (c.country) return c.country;
    return countryOfText(c.dests) || countryOfText(c.name);
  }

  // 补齐历史数据里缺国家的渠道。
  // 早期导入的渠道只有城市 / 仓库代码（「Bolingbrook」「ONT8」），按国家搜会漏掉；
  // 而同一货代（carrier）的价目表基本只覆盖一个国家，所以按 carrier + 渠道类型分组：
  // 组内只要能认出**唯一**一个国家，就把同组其余渠道补上；多国混表一律不猜。
  function fillMissingCountries(channels) {
    const list = channels || [];
    const groups = new Map();
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (!c || c.country) continue;
      const carrier = String(c.carrier || '').trim();
      if (!carrier) continue;                       // 没有货代号就没有分组依据，不猜
      const key = carrier + '|' + String(c.type || '');
      let g = groups.get(key);
      if (!g) { g = { known: new Set(), items: [] }; groups.set(key, g); }
      const n = countryOfText(c.dests) || countryOfText(c.name);
      if (n) g.known.add(n);
      else g.items.push(c);                         // 只有真的认不出来的才等着被补
    }
    let filled = 0;
    groups.forEach(g => {
      if (g.known.size !== 1) return;               // 认不出 / 多国混表：保持原样
      const only = g.known.values().next().value;
      for (let i = 0; i < g.items.length; i++) {
        const c = g.items[i];
        if (!c.country) { c.country = only; filled++; }
      }
    });
    return filled;
  }

  // 快捷测算的候选：库里实际出现过的国家，按渠道数从多到少。
  // 城市、仓号、邮编片段一律不进候选——国家名才是能稳定选中的一层。
  function countryHints(channels) {
    const cnt = new Map();
    const list = channels || [];
    for (let i = 0; i < list.length; i++) {
      const n = countryOfChannel(list[i]);
      if (n) cnt.set(n, (cnt.get(n) || 0) + 1);
    }
    const arr = Array.from(cnt.entries());
    arr.sort((x, y) => (y[1] - x[1]) || (x[0] < y[0] ? -1 : (x[0] > y[0] ? 1 : 0)));
    return arr.map(x => x[0]);
  }

  /* ============ 「只送指定仓库/城市」的渠道 ============ */
  // 卡派价目表里大量渠道只到某个仓点：目的地写的是仓号（ONT8）、城市（Bolingbrook）、
  // 仓库名（乐歌仓）或整条街道地址。它们被补上 country 之后，按「美国」查价就会成片命中，
  // 结果真正能发全美的渠道（快递、空派、海派普货、邮编分区）被淹掉。
  // 这里把这类渠道标出来：按**国家/大区**查价时默认不参与，填仓号/城市或显式勾选时照旧可用。
  const POINT_NUM_RE = /^\d{1,5}(\s*[-~至]\s*\d{1,5})?$/;
  // 目的地文本里有没有写「国家/大区」。
  // 整串先看一遍；再逐段看，但单段只信中文国名和 4 字母以上的写法——
  // 城市/州缩写（IL、CA、NY）和国家代码（IL=以色列、CA=加拿大）会撞车，
  // 否则「… Chicago IL 60632」这种街道地址会被认成以色列。
  function countryInText(str) {
    if (countryOfText(str)) return true;
    const segs = String(str || '').split(/[,，、;；\/|]+|\s+/).filter(Boolean);
    // 整串都是 2~3 字母代码（"DE EU"、"US CA"、"USA"）时按国家代码看，
    // 这种写法在价目表里就是「德国 欧洲」的意思
    if (segs.length && segs.every(x => /^[A-Za-z]{2,3}$/.test(x)) && segs.some(x => !!countryName(x))) return true;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!(/[\u4e00-\u9fa5]/.test(seg) || seg.length >= 4)) continue;
      if (countryName(seg) || countryOfText(seg)) return true;
    }
    return false;
  }
  function pointOnlyText(s) {
    const str = String(s || '').trim();
    if (!str) return false;
    // 目的地里自己写了国家/大区（美国 / 美西 / 加拿大 / US）→ 覆盖范围已经说明，不算点对点
    if (countryInText(str)) return false;
    // 邮编分区（邮编90-91 / 邮编1开头 / 07-08 / 90000-90036）覆盖的是一片区域
    if (/邮编|zip/i.test(str)) return false;
    const segs = str.split(/[,，、;；\/|]+|\s+/).filter(Boolean);
    if (segs.length && segs.every(x => POINT_NUM_RE.test(x))) return false;
    return true;
  }
  const POINT_CACHE = new Map();
  function isPointOnly(c) {
    if (!c) return false;
    if (whCodesOf(c).length) return true;          // ONT8 / LGB8 这类仓号
    const s = String(c.dests || '');
    if (!s.trim()) return false;                   // 没写目的地不算
    const hit = POINT_CACHE.get(s);
    if (hit !== undefined) return hit;
    const out = pointOnlyText(s);
    if (POINT_CACHE.size > 8000) POINT_CACHE.clear();
    POINT_CACHE.set(s, out);
    return out;
  }

  // 匹配并同时报出「被折叠的仓点渠道数」，供界面提示「另有 N 条」。
  // 折叠只在「按国家/大区查价」时生效：这时用户要的是能发全国的渠道；
  // 一旦填了仓号、城市或邮编，说明在找具体点，就不再折叠。
  function matchChannelsEx(channels, q) {
    const dest = String(q.dest || '').trim().toLowerCase();
    const wh = String(q.whCode || '').trim().toUpperCase();
    const includePoint = q.includePoint === true || q.includePoint === 'yes';
    // 只要目的地填的是国家/大区，就按「全国口径」看价：仓点渠道默认折叠。
    // 填了仓号也一样折叠——用户写「美国 + ONT8」是想看这个仓的报价，不该被几千条仓点渠道淹掉。
    const countryLevel = !!dest && (isCountryName(dest) || !!countryOfText(dest));
    let skippedPoint = 0;
    const list = [];
    (channels || []).forEach(function (c) {
      if (!matchOne(c, q, dest, wh)) return;
      // 仓号渠道（ONT8）能走到这里说明用户就是填了这个仓号，是明确的意图，不再折叠
      if (countryLevel && !includePoint && !isWhChannel(c) && isPointOnly(c)) { skippedPoint++; return; }
      list.push(c);
    });
    return { list, skippedPoint };
  }

  function matchOne(c, q, dest, wh) {
    if (q.type && q.type !== 'all' && c.type !== q.type) return false;
    if (isWhChannel(c)) {
      if (!wh) return false;
      if (whCodesOf(c).indexOf(wh) < 0) return false;
      return true;
    }
    if (q.zip) {
      const zr = zipRuleOf(c.dests);
      if (zr && !zipMatchRule(q.zip, zr)) return false;
    }
    if (!dest) return true;
    const list = String(c.dests || '').split(/[,，、;；\s]+/).filter(Boolean);
    if (!list.length) return true;
    if (list.some(function (d) { return destAlike(d.toLowerCase(), dest); })) return true;
    // 目的地只写了邮编/仓号、国家写在渠道名里（「美国空运普货 邮编90000-90036」）：
    // 按国家名搜也必须搜得到，否则「只能按国家搜」会漏掉一批渠道。
    const nc = countryOfChannel(c);
    return !!nc && destAlike(nc.toLowerCase(), dest);
  }

  // 兼容旧调用：只要匹配结果数组
  function matchChannels(channels, q) { return matchChannelsEx(channels, q).list; }

  /* ============ 核心报价 computeQuote（精确移植云端） ============ */
  // 报价表覆盖不了这个重量时，明确标成「不报价」，而不是硬凑一个价。
  // 比价页会把这些渠道剔掉，并提示「另有 N 条只报小货/箱型价」。
  function noQuote(res, tiers, isTotal, cw) {
    const max = tierMaxOf(tiers, isTotal);
    res.noQuote = true;
    res.rangeMax = max;
    res.base = 0; res.disc = 0; res.fuel = 0; res.reg = 0; res.remote = 0; res.other = 0; res.total = 0;
    res.mode = '不报价';
    res.quoteNote = '报价表只到 ' + max + 'kg，不覆盖 ' + cw + 'kg';
    return res;
  }

  function computeQuote(ch, q) {
    const pcs = Math.max(1, num(q.pcs, 1));
    const actW = num(q.weight, 0);
    // 三边尺寸缺省按 0：否则 num() 返回 undefined，乘出来是 NaN，
    // 会把计费重和总价一起污染成 NaN（不填尺寸只填实重时最常见）。
    const cbm = (num(q.len, 0) * num(q.wid, 0) * num(q.hgt, 0)) / 1e6 * pcs;
    const dv = num(ch.divisor) > 0 ? num(ch.divisor) : (num(q.factor, 6000) || 6000);
    const volW = (num(q.len, 0) * num(q.wid, 0) * num(q.hgt, 0)) / dv * pcs;
    const res = { ch: ch, cw: 0, volW: volW, cbm: cbm, base: 0, disc: 0, fuel: 0, reg: 0, remote: 0, other: 0, total: 0, mode: '', divisor: dv };
    const hasWT = !!(ch.wTiers && ch.wTiers.length);   // 整票价表（一档一票多少钱）
    if (ch.type === 'express') {
      const cw = Math.max(actW, volW, num(ch.minW, 0));
      const fw = num(ch.firstW), fp = num(ch.firstP);
      const au = num(ch.addU) || 0.5, ap = num(ch.addP);
      // 重量档整票价（wTiers）优先：这类报价单每一档给的是「一票多少钱」，
      // 直接用计费重落档，不乘重量，否则 0.5kg 98.9 会被算成 49.45。
      const wTotal = hasWT ? tierTotalForWeight(ch.wTiers, cw) : null;
      res.cw = cw;
      res.minW = num(ch.minW, 0);
      if (hasWT && wTotal == null) return noQuote(res, ch.wTiers, true, cw);
      if (wTotal != null) {
        res.base = wTotal;
        res.mode = '重量档整票价（' + cw + 'kg 落档）';
        res.wTotal = wTotal;
      } else if (fw > 0 && fp > 0) {
        res.base = (cw <= fw) ? fp : fp + Math.ceil((cw - fw) / au) * ap;
        res.mode = '首重 ' + fw + 'kg / 续重 ' + au + 'kg';
      } else {
        res.base = cw * ap;
        res.mode = '首重 ' + fw + 'kg / 续重 ' + au + 'kg';
      }
      if (ch.tiers && ch.tiers.length) {
        const tpH = tierPriceForWeight(ch.tiers, cw);
        // 阶梯表封顶（小包表只到 5kg 之类），超重就是没价，不能退回首重/续重再凑一个
        if (tpH == null && cw >= ch.tiers[0].wMin) return noQuote(res, ch.tiers, false, cw);
        if (tpH != null && cw >= ch.tiers[0].wMin) {
          let tierBase = cw * tpH;
          if (num(ch.minCharge, 0) > 0) tierBase = Math.max(tierBase, num(ch.minCharge, 0));
          if (tierBase < res.base) {
            res.base = tierBase;
            res.mode = '阶梯价 ' + tpH + '¥/kg（低于快递算法）';
          }
        }
      }
    } else {
      const mbw = (ch.tiers && ch.tiers.length) ? ch.tiers[0].wMin : num(ch.minW, 0);
      let cw2 = Math.max(actW, volW);
      if (mbw > 0 && cw2 < mbw) cw2 = mbw;
      res.cw = cw2;
      res.minW = mbw;
      if (hasWT) {
        // 269 / 531 的「空派小货」表也是每档一票总价，只是挂在 air/sea 上；
        // 只读 priceKg/tiers 会让这类渠道算成 0 元，比价格造假更糟。
        const wTotal = tierTotalForWeight(ch.wTiers, cw2);
        if (wTotal == null) return noQuote(res, ch.wTiers, true, cw2);
        res.base = wTotal;
        res.wTotal = wTotal;
        res.mode = '重量档整票价（' + cw2 + 'kg 落档）';
      } else {
        let unitKg = num(ch.priceKg, 0);
        if (ch.tiers && ch.tiers.length) {
          const tp = tierPriceForWeight(ch.tiers, cw2);
          if (tp == null) return noQuote(res, ch.tiers, false, cw2);
          unitKg = tp;
        }
        const byW = cw2 * unitKg;
        let priceCbm = num(ch.priceCbm, 0);
        if (ch.cbmTiers && ch.cbmTiers.length) {
          const cp = tierPriceForVolume(ch.cbmTiers, cbm);
          if (cp != null) priceCbm = cp;
        }
        let byV = cbm * priceCbm;
        // 体积不足首档（如「1CBM+」而货量只有 0.1CBM）：
        // 若该渠道同时有重量价（卡派/海派常见「包税12KG+ / 包税1CBM+」），按重量计费即可，
        // 不能把体积硬抬到 1CBM，否则 20kg 的小货会被算成 2400+；只有纯体积报价才按首档兜底。
        const hasWeightBasis = (ch.tiers && ch.tiers.length) || num(ch.priceKg, 0) > 0;
        if (ch.cbmTiers && ch.cbmTiers.length && cbm > 0 && cbm < ch.cbmTiers[0].cMin) {
          byV = hasWeightBasis ? 0 : ch.cbmTiers[0].cMin * priceCbm;
        }
        let b2 = Math.max(byW, byV);
        if (num(ch.minCharge, 0) > 0) b2 = Math.max(b2, num(ch.minCharge, 0));
        res.base = b2;
        res.mode = (byW >= byV)
          ? '按重 ' + unitKg + '¥/kg' + ((ch.tiers && ch.tiers.length) ? '（阶梯价）' : '')
          : '按体积 ' + priceCbm + '¥/CBM' + ((ch.cbmTiers && ch.cbmTiers.length) ? '（阶梯价）' : '');
      }
    }
    res.disc = res.base * ((num(ch.discount, 100) || 100) / 100);
    res.fuel = res.disc * (num(ch.fuel, 0) / 100);
    res.reg = num(ch.regFee, 0);
    res.remote = num(ch.remoteFee, 0) + num(q.remote, 0);
    res.other = num(q.other, 0);
    res.total = res.disc + res.fuel + res.reg + res.remote + res.other;
    return res;
  }

  /* ============ 有效期状态 ============ */
  // 「多少天内到期」窗口：1~365 天，默认 7 天（今日待办按这个窗口挑出「将到期」的渠道）
  const TODO_DAYS = 7;
  const TODO_CHOICES = [3, 7, 15, 30, 60];
  function normTodoDays(v, def) {
    const fallback = (def == null ? TODO_DAYS : def);
    const n = Math.round(num(v, fallback));
    if (!isFinite(n) || n < 1) return fallback;
    return Math.min(365, n);
  }

  function validState(ch, nowStr, soonDays) {
    const win = normTodoDays(soonDays);
    if (!ch.validUntil) return { st: 'none', days: null, txt: '未设有效期', win: win };
    const d = daysBetween(ch.validUntil, nowStr || todayStr());
    if (d < 0) return { st: 'over', days: d, txt: '已过期 ' + (-d) + ' 天', win: win };
    if (d <= win) return { st: 'soon', days: d, txt: (d === 0 ? '今天到期' : d + ' 天后到期'), win: win };
    return { st: 'ok', days: d, txt: '有效', win: win };
  }

  /* ============ 今日待办分类 ============ */
  // soonDays：多少天内到期算「将到期」（默认 7 天，可在首页「显示 N 天内到期」里改）
  function todayTodos(channels, nowStr, soonDays) {
    const win = normTodoDays(soonDays);
    const over = [], soon = [], noDest = [];
    (channels || []).forEach(function (ch) {
      const vs = validState(ch, nowStr, win);
      if (vs.st === 'over') over.push(ch);
      else if (vs.st === 'soon') soon.push(ch);
      if (!ch.dests || !String(ch.dests).trim()) noDest.push(ch);
    });
    over.sort((a, b) => daysBetween(a.validUntil, nowStr || todayStr()) - daysBetween(b.validUntil, nowStr || todayStr()));
    soon.sort((a, b) => daysBetween(a.validUntil, nowStr || todayStr()) - daysBetween(b.validUntil, nowStr || todayStr()));
    return { over, soon, noDest };
  }

  /* ============ 价格更新计划（「几天后更新价格表」） ============ */
  const UPDATE_DAYS = 7;
  const UPDATE_CHOICES = [3, 7, 10, 15, 30];

  // 规范化「几天后更新」：正整数，1~365，非法值回落到上次的设置（默认 7）
  function normUpdateDays(v, def) {
    const fallback = (def == null ? UPDATE_DAYS : def);
    const n = Math.round(num(v, fallback));
    if (!isFinite(n) || n < 1) return fallback;
    return Math.min(365, n);
  }
  // 下次更新日 = 今天（或指定日期 fromStr）+ N 天
  function updateDueDate(days, fromStr) {
    const n = normUpdateDays(days);
    const base = new Date((fromStr || todayStr()) + 'T00:00:00');
    if (isNaN(base.getTime())) return shiftDay(n);
    return shiftDay(n, base);
  }
  // 需要更新报价的渠道 = 已过期 + 即将到期（同一渠道只算一次）
  function dueChannels(channels, nowStr, soonDays) {
    const t = todayTodos(channels, nowStr, soonDays);
    const seen = Object.create(null);
    return t.over.concat(t.soon).filter(function (c) {
      const k = (c && c.id != null) ? String(c.id) : '';
      if (!k) return true;
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
  }

  /* ============ 利润测算 v2（按售价/币种/汇率/佣金） ============ */
  function computeProfit(p) {
    const qty = Math.max(1, num(p.qty, 1));
    const rate = (p.cur === 'CNY') ? 1 : (num(p.rate, 1) || 1);
    const revenue = num(p.price) * rate * qty;
    const cGoods = num(p.cost) * qty;
    const cOther = num(p.other) * qty;
    const fee = revenue * (num(p.fee) / 100);
    const total = cGoods + num(p.ship) + fee + cOther;
    const profit = revenue - total;
    const margin = revenue > 0 ? (profit / revenue * 100) : 0;
    const shipRate = revenue > 0 ? (num(p.ship) / revenue * 100) : 0;
    const breakEven = (total / qty) / (rate || 1);
    return { qty, rate, revenue, cGoods, cOther, fee, ship: num(p.ship), total, profit, margin, shipRate, breakEven };
  }

  /* ============ 兼容 v1 旧接口（向后兼容，测试保留） ============ */
  function calcFreight(input) {
    const actualWeight = num(input.actualWeight, 0);
    const volRatio = num(input.volRatio, 5000);
    const firstWeight = num(input.firstWeight, 1);
    const firstPrice = num(input.firstPrice, 0);
    const addPrice = num(input.addPrice, 0);
    const weightStep = num(input.weightStep, 0.5);
    const l = num(input.length, 0), w = num(input.width, 0), h = num(input.height, 0);
    const volWeight = (l > 0 && w > 0 && h > 0) ? round2((l * w * h) / volRatio) : 0;
    const chargeWeight = round2(Math.max(actualWeight, volWeight));
    const addUnits = Math.max(0, Math.ceil((chargeWeight - firstWeight) / weightStep));
    const freight = round2(firstPrice + addPrice * addUnits);
    return { volWeight, chargeWeight, addUnits, freight };
  }
  function calcProfit(input) {
    const freightCost = num(input.freightCost, 0);
    const otherCost = num(input.otherCost, 0);
    const profitRate = num(input.profitRate, 0);
    const totalCost = round2(freightCost + otherCost);
    const quote = round2(totalCost * (1 + profitRate / 100));
    const profit = round2(quote - totalCost);
    const margin = quote > 0 ? round2((profit / quote) * 100) : 0;
    return { totalCost, quote, profit, margin };
  }

  const api = {
    num, round2, todayStr, shiftDay, daysBetween,
    typeName, carrierText, tierPriceForWeight, tierPriceForVolume, tierTotalForWeight, tierMaxOf,
    whTokens, whCodesOf, isWhChannel, zipRuleOf, zipMatchRule,
    countryName, isCountryName, countryOfText, countryOfChannel, countryHints, fillMissingCountries, destGroupOf, destAlike,
    matchChannels, matchChannelsEx, isPointOnly, computeQuote, validState, todayTodos, computeProfit,
    normTodoDays, TODO_DAYS, TODO_CHOICES,
    normUpdateDays, updateDueDate, dueChannels, UPDATE_DAYS, UPDATE_CHOICES,
    calcFreight, calcProfit
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.calc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
