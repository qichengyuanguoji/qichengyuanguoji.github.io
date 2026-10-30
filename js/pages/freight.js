(function (root) {
  'use strict';
  const App = root.App;
  const U = App.util;
  const calc = App.calc;

  let quick = null; // 首页快捷测算带入：{country, weight}
  // 快捷测算只按国家名搜，带入时统一规整成标准国家名（「us」「美西」→「美国」），
  // 避免首页和比价页对同一份数据给出两种写法。
  function setQuick(country, weight) {
    const cn = calc.countryName(country) || String(country || '').trim();
    quick = { country: cn, weight: weight || '' };
  }

  // 比价一次最多渲染多少张卡片。
  // 一份大价目表按「目的地 × 起运仓 × 重量档」导入后，单是「美国」就能匹到上千条渠道，
  // 每条都画一张卡片（10 来个节点）＝ 上万个 DOM 节点，页面会卡住好几秒。
  // 结果已按总价升序，最便宜的都在前面，先给前 N 张，其余的按需展开。
  const MAX_CARDS = 60;
  // 展开的硬上限：「显示全部」在几千条匹配时会把几万节点一次性塞进页面，
  // 所以最多只到 MAX_CARDS_MAX 张，再多就提示收窄条件（逐步 +60 张）。
  const MAX_CARDS_MAX = 300;
  const STEP = 60;
  let shownCount = MAX_CARDS;   // 当前渲染多少张（本页会话内累进）
  // 比价结果按渠道商筛选（多选）：存的是展示用的渠道商串（「631」「顺丰国际（631）」）。
  // 只影响展示，不影响已经算好的结果；换条件重算时，失效的渠道商会自动剔掉。
  let carrierPick = [];
  // 比价结果按渠道类型筛选（单选）：'' = 全部（不筛），'express'/'air'/'sea' = 只看这一类。
  // 同样只影响展示，不动已经算好的报价；换条件后该类不存在时自动回到「全部」。
  let typePick = '';

  // 计算所有匹配渠道报价（按总价升序，最便宜标记 cheapest）
  // 同一组输入会被「试算 / 保存到查询记录 / 用最低价做利润测算」连着调 2~3 次，
  // 每次都要遍历全库，所以记住上一次的结果（换条件或换数据就重算）。
  let cacheRef = null, cacheKey = '', cacheRes = null, cacheSkip = 0, cacheRange = 0, cacheRangeMax = null;
  function qKey(q) {
    return [q.dest, q.type, q.weight, q.pcs, q.len, q.wid, q.hgt, q.factor, q.remote, q.other, q.cargo, q.amazon, q.whCode, q.zip, q.includePoint ? 1 : 0].join('\u0001');
  }
  // 返回 { res, skipped, overRange, rangeMax }：
  //  skipped   = 「只送指定仓库/城市」被折叠掉的渠道数，
  //  overRange = 报价表不覆盖本次重量（只报小货/箱型价）被剔掉的渠道数，
  //  rangeMax  = 这些渠道里报价表覆盖到的最大重量，提示里用来说明「只到多重」。
  // 界面要显式告诉用户，否则用户会以为价格库里没这些渠道，或者以为系统漏算了。
  function computeAllEx(channels, q) {
    const key = qKey(q);
    if (cacheRef === channels && cacheKey === key && cacheRes) {
      return { res: cacheRes, skipped: cacheSkip, overRange: cacheRange, rangeMax: cacheRangeMax };
    }
    const m = calc.matchChannelsEx(channels, q);
    const list = [];
    let overRange = 0, rangeMax = null;
    m.list.forEach(c => {
      const r = calc.computeQuote(c, q);
      // 报价表没有这个重量的价（文件封报 100kg、小包表报 20kg）：不参与比价，
      // 否则会拿小货价凑出一个看起来最便宜的结果。
      if (r.noQuote) {
        overRange++;
        if (r.rangeMax != null && (rangeMax == null || r.rangeMax > rangeMax)) rangeMax = r.rangeMax;
        return;
      }
      if (r.total > 0) list.push(r);
    });
    list.sort((a, b) => a.total - b.total);
    const seen = {};
    const out = [];
    for (const r of list) {
      const key2 = r.ch.name + '|' + (r.ch.dests || '');
      if (seen[key2]) continue;
      seen[key2] = true;
      out.push(r);
    }
    if (out.length) out[0].cheapest = true;
    cacheRef = channels; cacheKey = key; cacheRes = out; cacheSkip = m.skippedPoint || 0;
    cacheRange = overRange; cacheRangeMax = rangeMax;
    return { res: out, skipped: cacheSkip, overRange: overRange, rangeMax: rangeMax };
  }
  function computeAll(channels, q) { return computeAllEx(channels, q).res; }

  function line(k, v, strong) {
    return U.el('div', { class: 'line' }, [
      U.el('span', { class: 'muted' }, k),
      U.el('span', strong ? { style: 'font-weight:600' } : null, v)
    ]);
  }

  function render(container) {
    const store = App.store.instance;
    const settings = store.getSettings();
    const channels = store.getState().channels;
    const cur = settings.currency;
    // 每次进页面都回到首屏上限：否则上一次点过「展开」会一直生效，
    // 之后每次试算都把上一次展开的几百张卡片重画一遍。
    // 同时丢掉上一次的比价结果，避免渠道价格在别的页面被改过之后还拿旧结果。
    shownCount = MAX_CARDS;
    carrierPick = [];
    typePick = '';
    cacheRef = null; cacheKey = ''; cacheRes = null;

    const q = { dest: '', type: 'all', weight: '', pcs: 1, len: '', wid: '', hgt: '', factor: settings.factor || 6000, remote: '', other: '', cargo: '', amazon: 'no', whCode: '', zip: '', includePoint: false };

    container.innerHTML = '';
    const dest = U.el('input', { type: 'text', placeholder: '如 US / 美国', value: '' });
    const typeSel = U.el('select', null, [
      U.el('option', { value: 'all' }, '全部类型'),
      U.el('option', { value: 'express' }, '国际快递/专线小包'),
      U.el('option', { value: 'air' }, '空运'),
      U.el('option', { value: 'sea' }, '海运')
    ]);
    const weight = U.el('input', { type: 'number', step: '0.1', placeholder: '实重 kg' });
    const pcs = U.el('input', { type: 'number', step: '1', value: '1', placeholder: '件数' });
    const len = U.el('input', { type: 'number', step: '0.1', placeholder: '长 cm' });
    const wid = U.el('input', { type: 'number', step: '0.1', placeholder: '宽 cm' });
    const hgt = U.el('input', { type: 'number', step: '0.1', placeholder: '高 cm' });
    const factor = U.el('select', null, [
      U.el('option', { value: '6000' }, '÷6000（空运/快递）'),
      U.el('option', { value: '5000' }, '÷5000（快递专线）'),
      U.el('option', { value: '8000' }, '÷8000')
    ]);
    factor.value = String(q.factor);
    const remote = U.el('input', { type: 'number', step: '0.1', placeholder: '偏远附加费' });
    const other = U.el('input', { type: 'number', step: '0.1', placeholder: '报关/杂费' });
    const cargo = U.el('input', { type: 'text', placeholder: '货物类型（如带电，用于排除不接渠道）' });
    const amazon = U.el('select', null, [U.el('option', { value: 'no' }, '否（普通地址）'), U.el('option', { value: 'yes' }, '是（FBA 仓库）')]);
    const whCode = U.el('input', { type: 'text', placeholder: '亚马逊仓库代码（如 ONT8）' });
    const zip = U.el('input', { type: 'text', placeholder: '邮编（选填）' });
    // 只送指定仓库/城市的渠道（卡派送仓、FBA 卡派）：按国家查价时默认折叠。
    // 一份卡派价目表几千条都是具体仓点，混在「美国」结果里会淹掉能发全美的渠道。
    const includePoint = U.el('input', { type: 'checkbox' });
    const whHint = U.el('div', { class: 'muted', style: 'margin-top:6px' });

    // 仓库代码 → 自动带出邮编与国家（仅当地址为空时回填国家，避免覆盖用户输入）
    function applyWh() {
      const code = whCode.value.trim().toUpperCase();
      if (!code || !App.fba) { whHint.textContent = ''; return; }
      const info = App.fba.lookup(code, store.getSettings().fbaWh);
      if (!info) {
        const has = (store.getSettings().fbaWh || []).length > 0;
        whHint.textContent = has
          ? '仓库表里没有 ' + code + '，可在「数据与设置 → FBA 仓库表」补充。'
          : '仓库表还是空的，可在「数据与设置 → FBA 仓库表」新增或从 CSV 导入。';
        return;
      }
      if (info.zip) zip.value = info.zip;
      if (!dest.value.trim()) dest.value = info.country;
      whHint.textContent = '已识别：' + App.fba.desc(info) + '（邮编已带入）';
    }
    whCode.addEventListener('input', applyWh);
    whCode.addEventListener('change', applyWh);

    function readQ() {
      q.dest = dest.value.trim();
      q.type = typeSel.value;
      q.weight = Number(weight.value) || 0;
      q.pcs = Math.max(1, Number(pcs.value) || 1);
      q.len = Number(len.value) || 0;
      q.wid = Number(wid.value) || 0;
      q.hgt = Number(hgt.value) || 0;
      q.factor = Number(factor.value) || 6000;
      q.remote = Number(remote.value) || 0;
      q.other = Number(other.value) || 0;
      q.cargo = cargo.value.trim();
      q.amazon = amazon.value;
      q.whCode = whCode.value.trim().toUpperCase();
      q.zip = zip.value.trim();
      q.includePoint = !!includePoint.checked;
      return q;
    }

    const resultBox = U.el('div', { id: 'fr-result', class: 'result' });
    const compareBox = U.el('div', { id: 'fr-compare' });

    function renderList() {
      const qq = readQ();
      // 先判条件再算：computeAll 会把「全部渠道」都走一遍 matchChannels + computeQuote，
      // 没填目的地时 matchChannels 的 `if (!dest) return true` 会让全库都命中，
      // 于是每次进页面都先白算一遍上万条报价。所以顺序必须是「先看有没有条件，再算」。
      resultBox.innerHTML = '';
      compareBox.innerHTML = '';
      if (!qq.dest) {
        resultBox.appendChild(U.el('div', { class: 'muted' }, '填写目的地后开始比价。'));
        compareBox.appendChild(U.el('div', { class: 'muted' }, '填写目的地后，显示所有匹配渠道的报价对比。'));
        return;
      }
      if (!qq.weight || qq.weight <= 0) {
        resultBox.appendChild(U.el('div', { class: 'muted' }, '请填写货物实重。'));
        return;
      }
      const ex = computeAllEx(channels, qq);
      const allRes = ex.res;
      // 只送指定仓库/城市的渠道被折叠时，必须说清楚，否则用户以为库里没有这些价
      const pointTip = (empty) => U.el('div', { class: 'point-tip' }, [
        U.el('span', { class: 'muted' }, empty
          ? ('只查到 ' + ex.skipped + ' 条只送指定仓库/城市的渠道（如卡派送仓），没有能发全国的渠道。')
          : ('另有 ' + ex.skipped + ' 条渠道只送指定仓库/城市（如卡派送仓），未参与比价。')),
        U.el('button', {
          class: 'btn btn-sm',
          onclick: () => { includePoint.checked = true; shownCount = MAX_CARDS; renderList(); }
        }, '包含这些渠道')
      ]);
      // 报价表不覆盖本次重量的渠道（只报小货/箱型价）被剔掉时也要说清，
      // 否则用户会以为库里没有大货渠道，或者以为系统漏算。
      const rangeTip = () => U.el('div', { class: 'range-tip' }, [
        U.el('span', { class: 'muted' },
          '另有 ' + ex.overRange + ' 条渠道的报价表只到 ' + ex.rangeMax + 'kg（只做小货/箱型价），不覆盖本次 ' +
          qq.weight + 'kg，未参与比价。')
      ]);
      if (!allRes.length) {
        if (ex.overRange) {
          resultBox.appendChild(rangeTip());
          compareBox.appendChild(U.el('div', { class: 'muted' },
            '这些渠道只报小货/箱型价，没有能装 ' + qq.weight + 'kg 的报价；可换更轻的重量，或到渠道价格库补充大货渠道。'));
          return;
        }
        if (ex.skipped) {
          resultBox.appendChild(pointTip(true));
          compareBox.appendChild(U.el('div', { class: 'muted' }, '这些渠道只到具体仓库/城市，可点「包含这些渠道」查看，或填写仓库代码。'));
        } else {
          resultBox.appendChild(U.el('div', { class: 'empty' }, '没有匹配的渠道，请检查目的地，或先在渠道价格库添加。'));
        }
        return;
      }

      // 渠道商筛选：一次按国家查价常命中十几个货代的几百条渠道，
      // 用户常常只比其中几家（「只看 631 和 269」），没有筛选只能在几百张卡里翻。
      // 只过滤展示，不动已经算好的报价；换筛选时回到首屏，避免上次展开的几百张一次性重画。
      // 渠道类型筛选（v2.27）：按国家查价时海运卡派、空运、快递小包混在几百条结果里，
      // 用户常常心里已经知道要走哪一类，或者想单看「如果走空运要多少钱」。
      // 第一个按键是「全部」= 不筛类型，选中某一类再点一次即取消。
      // 手工录入/老数据可能没有 type，归到 'unknown' 单独一类；不能直接当 ''，
      // 否则 key 与「全部」的 '' 撞车，点了没反应。
      const typeKey = (r) => r.ch.type || 'unknown';
      const typeLabel = (k) => (!k || k === 'unknown') ? '未标注类型' : calc.typeName(k);
      const typeStatsOf = (list) => {
        const map = {};
        list.forEach(r => {
          const k = typeKey(r);
          if (!map[k]) map[k] = { key: k, label: typeLabel(k), n: 0, min: r.total };
          map[k].n += 1;
          if (r.total < map[k].min) map[k].min = r.total;
        });
        return Object.keys(map).map(k => map[k]).sort((a, b) => a.min - b.min);
      };
      const typeBar = (stats, total) => {
        const chip = (label, active, onclick, tip) => U.el('button', {
          class: 'type-chip' + (active ? ' on' : ''),
          title: tip,
          onclick: onclick
        }, label);
        const nodes = [U.el('span', { class: 'cf-label' }, '渠道类型')];
        nodes.push(chip('全部（' + total + '）', !typePick, () => {
          typePick = '';
          shownCount = MAX_CARDS;
          renderList();
        }, '全部渠道类型，共 ' + total + ' 条报价'));
        stats.forEach(s => nodes.push(chip(s.label + '（' + s.n + '）', typePick === s.key, () => {
          typePick = (typePick === s.key) ? '' : s.key;
          shownCount = MAX_CARDS;
          renderList();
        }, s.label + '：' + s.n + ' 条报价，最低 ' + U.formatMoney(s.min, cur))));
        return U.el('div', { class: 'type-filter' }, nodes);
      };

      const carrierStatsOf = (list) => {
        const map = {};
        list.forEach(r => {
          const k = calc.carrierText(r.ch);
          if (!map[k]) map[k] = { key: k, n: 0, min: r.total };
          map[k].n += 1;
          if (r.total < map[k].min) map[k].min = r.total;
        });
        return Object.keys(map).map(k => map[k]).sort((a, b) => a.min - b.min);
      };
      const carrierBar = (stats, total) => {
        const chip = (label, active, onclick, tip) => U.el('button', {
          class: 'carrier-chip' + (active ? ' on' : ''),
          title: tip,
          onclick: onclick
        }, label);
        const toggle = (k) => {
          const i = carrierPick.indexOf(k);
          if (i >= 0) carrierPick.splice(i, 1); else carrierPick.push(k);
          shownCount = MAX_CARDS;
          renderList();
        };
        const nodes = [U.el('span', { class: 'cf-label' }, '渠道商')];
        nodes.push(chip('全部（' + total + '）', !carrierPick.length, () => {
          carrierPick = [];
          shownCount = MAX_CARDS;
          renderList();
        }, '显示所有渠道商的 ' + total + ' 条报价'));
        stats.forEach(s => nodes.push(chip(s.key + '（' + s.n + '）', carrierPick.indexOf(s.key) >= 0, () => toggle(s.key),
          s.key + '：' + s.n + ' 条报价，最低 ' + U.formatMoney(s.min, cur))));
        // 选了几家、剩几条，就在筛选条上回显，不用低头去找下面的汇总
        if (carrierPick.length) {
          nodes.push(U.el('span', { class: 'cf-hint' }, '已选 ' + carrierPick.length + ' 家 · ' + res.length + ' 条报价'));
        }
        return U.el('div', { class: 'carrier-filter' }, nodes);
      };

      const typeStats = typeStatsOf(allRes);
      // 换目的地/重量后，原来选的类型可能已经不在这次结果里（比如日本只有空运），
      // 直接回到「全部」，否则会得到一个永远为空的筛选。
      if (typePick && !typeStats.some(t => t.key === typePick)) typePick = '';
      const byType = typePick ? allRes.filter(r => typeKey(r) === typePick) : allRes;

      const carriers = carrierStatsOf(byType);
      // 换目的地/重量后，原来选的渠道商可能已不在结果里：剔掉，不要留下一个永远空结果的筛选
      carrierPick = carrierPick.filter(k => carriers.some(c => c.key === k));
      const res = carrierPick.length
        ? byType.filter(r => carrierPick.indexOf(calc.carrierText(r.ch)) >= 0)
        : byType;

      resultBox.appendChild(typeBar(typeStats, allRes.length));
      resultBox.appendChild(carrierBar(carriers, byType.length));
      if (!res.length) {
        resultBox.appendChild(U.el('div', { class: 'empty' }, [
          '当前筛选（' + carrierPick.join('、') + '）在这次结果里没有渠道。',
          U.el('button', {
            class: 'btn btn-sm',
            onclick: () => { carrierPick = []; typePick = ''; shownCount = MAX_CARDS; renderList(); }
          }, '清空筛选')
        ]));
        return;
      }
      const shown = res.slice(0, Math.min(shownCount, MAX_CARDS_MAX));
      shown.forEach((r, i) => {
        // ★最便宜跟着当前展示结果走：筛过之后，全局最低那条可能根本不在列表里
        const best = i === 0;
        const card = U.el('div', { class: 'quote-card' + (best ? ' cheapest' : '') }, [
          U.el('div', { class: 'qc-head' }, [
            U.el('span', { class: 'qc-name' }, r.ch.name + (best ? ' ★最便宜' : '')),
            U.el('span', { class: 'qc-type' }, calc.typeName(r.ch.type)),
            U.el('span', { class: 'qc-total' }, U.formatMoney(r.total, cur))
          ]),
          U.el('div', { class: 'qc-mode' }, r.mode),
          U.el('div', { class: 'qc-detail' }, [
            // 渠道商排在最前：同一批价格表里同名渠道（「包税卡派-芝加哥」）会在多个货代下重复出现，
            // 只靠渠道名分不清是谁家的价，必须把货代编号/名字摆出来。
            line('渠道商', calc.carrierText(r.ch)),
            line('计费重', r.cw + ' kg'),
            line('体积重', r.volW + ' kg（材积÷' + r.divisor + '）'),
            r.cbm ? line('CBM', r.cbm + ' m³') : null,
            line('基础运费', U.formatMoney(r.base, cur)),
            line('折扣后', U.formatMoney(r.disc, cur)),
            r.fuel ? line('燃油', U.formatMoney(r.fuel, cur)) : null,
            r.reg ? line('挂号/操作', U.formatMoney(r.reg, cur)) : null,
            r.remote ? line('偏远', U.formatMoney(r.remote, cur)) : null,
            r.other ? line('杂费', U.formatMoney(r.other, cur)) : null
          ].filter(Boolean))
        ]);
        resultBox.appendChild(card);
      });
      // 比价小结
      const maxv = res[res.length - 1].total, minv = res[0].total;
      compareBox.appendChild(U.el('div', { class: 'cmp-summary' },
        '共 ' + res.length + ' 个渠道可比' +
        (typePick ? '（' + typeLabel(typePick) + '）' : '') +
        (carrierPick.length ? '（已筛 ' + carrierPick.join('、') + '）' : '') +
        '，最低 ' + U.formatMoney(minv, cur) +
        (maxv > minv ? '，最贵与最低相差 ' + U.formatMoney(maxv - minv, cur) : '') +
        (res.length > shown.length ? ('（按总价升序，当前列出前 ' + shown.length + ' 个）') : '')));
      if (ex.skipped) compareBox.appendChild(pointTip(false));
      if (ex.overRange) compareBox.appendChild(rangeTip());
      if (res.length > MAX_CARDS) {
        const capped = res.length > MAX_CARDS_MAX;
        const more = res.length - shown.length;
        // 结果太多时不再一次性「显示全部」：每次只多给 STEP 张，最多到 MAX_CARDS_MAX。
        // 否则点了展开就等于把几千张卡片（几万节点）全画出来，页面直接卡死。
        const nextLen = Math.min(res.length, shown.length + STEP, MAX_CARDS_MAX);
        const canMore = more > 0 && nextLen > shown.length;
        const msg = !more
          ? ('已显示 ' + shown.length + ' / ' + res.length + ' 个')
          : (canMore
            ? ('还有 ' + more + ' 个渠道未显示' + (capped ? '（结果较多，建议缩小目的地或指定渠道类型）' : ''))
            : ('还有 ' + more + ' 个渠道未显示，已达展开上限 ' + MAX_CARDS_MAX + ' 张；建议缩小目的地、指定渠道类型或填写起运仓'));
        compareBox.appendChild(U.el('div', { class: 'cmp-more' }, [
          U.el('span', { class: 'muted' }, msg),
          canMore
            ? U.el('button', {
              class: 'btn btn-sm',
              onclick: () => {
                // 结果不多时一次展开；多的时候每次多给 STEP 张
                shownCount = (!capped && res.length <= MAX_CARDS_MAX) ? res.length : nextLen;
                renderList();
              }
            }, capped ? ('再显示 ' + (nextLen - shown.length) + ' 个') : ('显示全部 ' + res.length + ' 个'))
            : null,
          shown.length > MAX_CARDS
            ? U.el('button', {
              class: 'btn btn-sm',
              onclick: () => { shownCount = MAX_CARDS; renderList(); }
            }, '收起')
            : null
        ].filter(Boolean)));
      }
    }

    function save() {
      const qq = readQ();
      const res = computeAll(channels, qq);
      if (!res.length) { U.toast('没有可保存的报价，请先填写目的地与重量'); return; }
      const best = res[0];
      store.addRecord({
        type: 'freight', dest: qq.dest, country: qq.dest, weight: qq.weight, pcs: qq.pcs,
        cbm: best.cbm, type2: best.ch.type, channelId: best.ch.id, channelName: best.ch.name,
        freight: best.total, amazon: qq.amazon, whCode: qq.whCode, zip: qq.zip, note: best.mode
      }).then(() => U.toast('已保存到查询记录'));
    }
    function toProfit() {
      const res = computeAll(channels, readQ());
      if (!res.length) { U.toast('请先测算出报价'); return; }
      App.pages.profit.setPrefill(res[0].total);
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      const nav = document.querySelector('.nav-item[data-page="profit"]');
      if (nav) nav.classList.add('active');
      App.router.show('profit');
    }

    const form = U.el('div', { class: 'card' }, [
      U.el('h3', null, '运费试算比价'),
      U.el('div', { class: 'grid2' }, [
        field('目的国/区域 *', dest),
        field('渠道类型', typeSel),
        field('实重(kg) *', weight),
        field('件数', pcs),
        field('长(cm)', len),
        field('宽(cm)', wid),
        field('高(cm)', hgt),
        field('材积除数', factor),
        field('偏远附加费', remote),
        field('报关/杂费', other),
        field('货物类型', cargo),
        field('亚马逊FBA', amazon),
        field('仓库代码', whCode),
        field('邮编', zip)
      ]),
      whHint,
      U.el('label', { class: 'check-row' }, [
        includePoint,
        U.el('span', null, '包含只送指定仓库/城市的渠道（卡派送仓、FBA 卡派）'),
        U.el('span', { class: 'muted', style: 'font-size:12px' }, '— 按国家查价时默认折叠，避免淹没能发全国的渠道')
      ]),
      U.el('div', { class: 'row', style: 'margin-top:14px' }, [
        // 重新试算＝换了条件，展开的张数回到首屏
        U.el('button', { class: 'btn btn-primary', onclick: () => { shownCount = MAX_CARDS; renderList(); } }, '开始试算比价'),
        U.el('button', { class: 'btn', onclick: save }, '保存到查询记录'),
        U.el('button', { class: 'btn', onclick: toProfit }, '用最低价做利润测算')
      ]),
      resultBox,
      U.el('h4', { style: 'margin-top:16px' }, '比价'),
      compareBox
    ]);

    container.appendChild(form);
    if (quick) { dest.value = quick.country; weight.value = quick.weight; quick = null; }
    renderList();
  }

  function field(label, control) { return U.el('label', { class: 'field' }, [label, control]); }

  root.App.pages = root.App.pages || {};
  root.App.pages.freight = { render, computeAll, setQuick, MAX_CARDS, MAX_CARDS_MAX };
  if (typeof module !== 'undefined' && module.exports) module.exports = { computeAll, setQuick, MAX_CARDS, MAX_CARDS_MAX };
})(typeof globalThis !== 'undefined' ? globalThis : this);
