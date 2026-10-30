(function (root) {
  'use strict';
  const App = root.App;
  const U = App.util;

  function num(v, def) { return App.calc.num(v, def); }
  function fmt(n) { n = Number(n); if (!isFinite(n)) return '0'; return (Math.round(n * 100) / 100).toString(); }

  function uniqueSorted(arr) { return Array.from(new Set(arr.filter(Boolean))).sort(); }
  function typeOptions(channels) { return uniqueSorted(channels.map(c => c.type)); }
  function carrierOptions(channels) { return uniqueSorted(channels.map(c => c.carrier)); }
  function destOptions(channels) { return uniqueSorted(channels.map(c => c.dests)); }

  function expiryTag(validUntil) {
    const st = U.expiryStatus(validUntil);
    if (st === 'none') return U.el('span', { class: 'muted' }, '—');
    const map = { expired: '已过期', red: '7天内', orange: '15天内', normal: '正常' };
    return U.el('span', { class: 'tag ' + (st === 'normal' ? 'normal' : st) }, map[st]);
  }
  function rowClass(validUntil) {
    const st = U.expiryStatus(validUntil);
    if (st === 'red' || st === 'expired') return 'row-red';
    if (st === 'orange') return 'row-orange';
    return '';
  }
  // 有效期展示：起 ~ 止
  function validRangeText(c) {
    if (!c || (!c.validFrom && !c.validUntil)) return '—';
    if (c.validFrom && c.validUntil) return c.validFrom + ' ~ ' + c.validUntil;
    return c.validFrom || c.validUntil;
  }

  // 渠道计费摘要（移植云端 chPriceText）
  function chPriceText(ch) {
    // 重量档整票价（小包价目表：0.5kg 98.9 元/票）不分渠道类型：
    // 269 的「美国FedEx空快」是 air，价目表同样是每档一票多少钱，
    // 以前只认 express，这类渠道在库里显示成「未填价格」。
    if (ch.wTiers && ch.wTiers.length) {
      const s = ch.wTiers.map(t => fmt(t.wMin) + 'kg ¥' + fmt(t.price)).join(' · ');
      // 覆盖上限要写出来：报价表只到 5kg 的渠道，20kg 试算时不会出价
      const max = App.calc && App.calc.tierMaxOf ? App.calc.tierMaxOf(ch.wTiers, true) : null;
      return s + '（整票' + (max != null ? '，只到 ' + fmt(max) + 'kg' : '') + '）';
    }
    if (ch.type === 'express') {
      let s = '';
      if (num(ch.firstW) > 0 || num(ch.firstP) > 0) s += '首重 ' + fmt(num(ch.firstW)) + 'kg ¥' + fmt(num(ch.firstP));
      if (num(ch.addU) > 0 || num(ch.addP) > 0) s += (s ? ' + ' : '') + '续重 ' + fmt(num(ch.addU)) + 'kg ¥' + fmt(num(ch.addP));
      if (ch.tiers && ch.tiers.length) s += ' · ' + ch.tiers.map(t => fmt(t.wMin) + 'kg+ ¥' + fmt(t.price)).join(' · ');
      return s || '未填价格';
    }
    if ((ch.tiers && ch.tiers.length) || (ch.cbmTiers && ch.cbmTiers.length)) {
      const tt = [];
      if (ch.tiers && ch.tiers.length) tt.push(ch.tiers.map(t => fmt(t.wMin) + 'kg+ ¥' + fmt(t.price)).join(' · '));
      if (ch.cbmTiers && ch.cbmTiers.length) tt.push(ch.cbmTiers.map(t => fmt(t.cMin) + 'CBM+ ¥' + fmt(t.price)).join(' · '));
      if (!ch.cbmTiers && num(ch.priceCbm) > 0) tt.push('¥' + fmt(num(ch.priceCbm)) + '/CBM');
      if (num(ch.minCharge) > 0) tt.push('最低 ¥' + fmt(num(ch.minCharge)));
      return tt.join(' · ');
    }
    let t = '';
    if (num(ch.priceKg) > 0) t += '¥' + fmt(num(ch.priceKg)) + '/kg';
    if (num(ch.priceCbm) > 0) t += (t ? ' · ' : '') + '¥' + fmt(num(ch.priceCbm)) + '/CBM';
    if (num(ch.minCharge) > 0) t += (t ? ' · ' : '') + '最低 ¥' + fmt(num(ch.minCharge));
    return t || '未填价格';
  }

  function filterChannels(channels, f) {
    f = f || {};
    const q = (f.search || '').trim().toLowerCase();
    const carriers = (f.carriers && f.carriers.length) ? f.carriers : null;
    const expiry = (f.expiry && f.expiry.length) ? f.expiry : null;
    const origins = (f.origins && f.origins.length) ? f.origins : null;
    return channels.filter(c => {
      if (f.type && c.type !== f.type) return false;
      if (f.carrier && c.carrier !== f.carrier) return false;
      if (f.dest && c.dests !== f.dest) return false;
      if (carriers && carriers.indexOf(c.carrier || '') === -1) return false;
      if (origins && origins.indexOf(c.origin || '') === -1) return false;
      if (expiry && expiry.indexOf(expiryState(c.validUntil)) === -1) return false;
      if (q) {
        const hay = ((c.name || '') + ' ' + (c.carrier || '') + ' ' + (c.dests || '') + ' ' + (c.origin || '') + ' ' + (c.note || '')).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  /* ---- 有效期/状态：筛选分类与排序权重（两列共用同一套分类，别处也在用） ---- */
  const EXPIRY_KEYS = ['expired', 'red', 'orange', 'normal', 'none'];
  const EXPIRY_LABEL = { expired: '已过期', red: '7 天内到期', orange: '15 天内到期', normal: '正常', none: '未设置有效期' };
  const EXPIRY_RANK = { expired: 0, red: 1, orange: 2, normal: 3, none: 4 };
  function expiryState(validUntil) {
    const st = U.expiryStatus(validUntil);
    return EXPIRY_RANK[st] == null ? 'none' : st;
  }

  // 排序：dir = 'asc' | 'desc' | ''（不排序）。空值一律排在最后，不受升降序影响。
  function sortChannels(list, key, dir) {
    const out = (list || []).slice();
    if (!key || (dir !== 'asc' && dir !== 'desc')) return out;
    const sign = dir === 'desc' ? -1 : 1;
    const val = (c) => {
      if (key === 'carrier') return String(c.carrier || '');
      if (key === 'origin') return String(c.origin || '');
      if (key === 'validUntil') return String(c.validUntil || '');
      if (key === 'status') {
        const st = expiryState(c.validUntil);
        return st === 'none' ? null : EXPIRY_RANK[st]; // 未设置有效期视为空值，始终排最后
      }
      if (key === 'name') return String(c.name || '');
      return '';
    };
    out.sort((a, b) => {
      const va = val(a), vb = val(b);
      const emptyA = va === '' || va == null;
      const emptyB = vb === '' || vb == null;
      if (emptyA && emptyB) return 0;
      if (emptyA) return 1;
      if (emptyB) return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * sign;
      return String(va).localeCompare(String(vb), 'zh-Hans-CN') * sign;
    });
    return out;
  }

  function field(label, input, hint) {
    return U.el('label', { class: 'field' }, [
      U.el('span', { class: 'lbl' }, label),
      input,
      hint ? U.el('span', { class: 'hint' }, hint) : null
    ]);
  }
  function numInput(k, v, step) {
    return U.el('input', { type: 'number', step: step || 'any', value: (v == null ? '' : v), 'data-k': k });
  }
  function txtInput(k, v) {
    return U.el('input', { type: 'text', value: (v == null ? '' : v), 'data-k': k });
  }

  function tiersEditor(tiers, kind) {
    // kind: 'weight' (wMin/wMax/price) 或 'cbm' (cMin/cMax/price)
    tiers = tiers || [];
    const wrap = U.el('div', { class: 'tiers' });
    const render = () => {
      wrap.innerHTML = '';
      tiers.forEach((t, i) => {
        const loK = kind === 'cbm' ? 'cMin' : 'wMin';
        const hiK = kind === 'cbm' ? 'cMax' : 'wMax';
        const row = U.el('div', { class: 'tier-row' }, [
          U.el('span', null, kind === 'cbm' ? '≥' : '≥'),
          numInput('_' + i + '_lo', t[loK], 'any'),
          U.el('span', null, kind === 'cbm' ? 'CBM' : 'kg'),
          U.el('span', null, '至'),
          numInput('_' + i + '_hi', t[hiK] == null ? '' : t[hiK], 'any'),
          U.el('span', null, kind === 'cbm' ? 'CBM' : 'kg'),
          U.el('span', null, '价'),
          numInput('_' + i + '_p', t.price, 'any'),
          U.el('button', { class: 'btn sm', onclick: () => { tiers.splice(i, 1); render(); } }, '✕')
        ]);
        wrap.appendChild(row);
      });
      wrap.appendChild(U.el('button', { class: 'btn sm', onclick: () => { tiers.push(kind === 'cbm' ? { cMin: 0, cMax: null, price: 0 } : { wMin: 0, wMax: null, price: 0 }); render(); } }, '+ 添加重量段'));
    };
    render();
    return { wrap, tiers };
  }

  function openModal(store, existing) {
    const isEdit = !!(existing && existing.id);
    const c = existing || {};
    const typeVal = c.type || 'express';
    const inputs = {};

    const typeSel = U.el('select', { 'data-k': 'type' },
      [['express', '国际快递/专线小包'], ['air', '空运'], ['sea', '海运']].map(([v, t]) =>
        U.el('option', { value: v, selected: v === typeVal ? 'selected' : null }, t)));

    const expressBox = U.el('div', { class: 'bill-express' }, [
      field('首重(kg)', numInput('firstW', c.firstW)),
      field('首重价', numInput('firstP', c.firstP)),
      field('起重/最低计费重(kg)', numInput('minW', c.minW)),
      field('续重单位(kg)', numInput('addU', c.addU || 0.5)),
      field('续重价', numInput('addP', c.addP))
    ]);
    const airseaBox = U.el('div', { class: 'bill-airsea' }, [
      field('重量价(¥/kg)', numInput('priceKg', c.priceKg)),
      field('体积价(¥/CBM)', numInput('priceCbm', c.priceCbm)),
      field('最低收费', numInput('minCharge', c.minCharge))
    ]);
    const tierBox = U.el('div', { class: 'tier-box' });
    const cbmTierBox = U.el('div', { class: 'tier-box' });

    function syncType() {
      const t = typeSel.value;
      expressBox.style.display = (t === 'express') ? '' : 'none';
      airseaBox.style.display = (t === 'air' || t === 'sea') ? '' : 'none';
      tierBox.style.display = (t === 'express' || t === 'air') ? '' : 'none';
      cbmTierBox.style.display = (t === 'sea') ? '' : 'none';
    }
    typeSel.addEventListener('change', syncType);

    const wt = tiersEditor(c.tiers, 'weight');
    tierBox.appendChild(U.el('div', { class: 'lbl' }, '重量阶梯价（可选）'));
    tierBox.appendChild(wt.wrap);
    const ct = tiersEditor(c.cbmTiers, 'cbm');
    cbmTierBox.appendChild(U.el('div', { class: 'lbl' }, '体积阶梯价 CBM（可选）'));
    cbmTierBox.appendChild(ct.wrap);

    // 导入识别出的「重量档整票价」只读展示：这类表每档给的是整票价，改动请重新导入价格表
    const wTierBox = (c.wTiers && c.wTiers.length)
      ? U.el('div', { class: 'tier-box' }, [
        U.el('div', { class: 'lbl' }, '重量档整票价（导入自动识别）'),
        U.el('div', { class: 'hint' }, c.wTiers.map(t => fmt(t.wMin) + 'kg ¥' + fmt(t.price)).join(' · ')),
        U.el('div', { class: 'hint' }, '这是「一票多少钱」的报价，试算时按计费重落档直接取该档总价；'
          + '报价表覆盖到 ' + fmt(App.calc.tierMaxOf(c.wTiers, true)) + 'kg，再重的货这条渠道不出价（不是按末档价硬算）。'
          + '要改价格或补更重的档位，请重新导入价格表。')
      ])
      : null;

    const form = U.el('div', { class: 'ch-form' }, [
      field('渠道类型 *', typeSel),
      field('渠道名称 *', txtInput('name', c.name)),
      field('承运商/货代', txtInput('carrier', c.carrier)),
      field('起运仓 / 起运地（FBA 卡派按仓分列报价时填，可留空）', txtInput('origin', c.origin)),
      field('适用目的地 *（国家/地区/港口，多值用空格分隔）', txtInput('dests', c.dests)),
      expressBox,
      airseaBox,
      wTierBox,
      tierBox,
      cbmTierBox,
      field('燃油附加费(%)', numInput('fuel', c.fuel)),
      field('折扣(%)（85=85折）', numInput('discount', c.discount || 100)),
      field('挂号/操作费', numInput('regFee', c.regFee)),
      field('偏远/区域费', numInput('remoteFee', c.remoteFee)),
      field('材积除数（空运/快递÷6000，专线÷5000）', numInput('divisor', c.divisor)),
      field('时效', txtInput('transit', c.transit)),
      field('可接货物类型', txtInput('cargoType', c.cargoType)),
      field('报价有效期起', U.el('input', { type: 'date', value: c.validFrom || '', 'data-k': 'validFrom' })),
      field('报价有效期止', U.el('input', { type: 'date', value: c.validUntil || '', 'data-k': 'validUntil' })),
      field('备注', txtInput('note', c.note)),
      field('免责声明', txtInput('disclaimer', c.disclaimer))
    ]);

    const overlay = U.el('div', { class: 'modal-overlay' }, [
      U.el('div', { class: 'modal modal-lg' }, [
        U.el('h3', null, isEdit ? '编辑渠道' : '新增渠道'),
        form,
        U.el('div', { class: 'modal-actions' }, [
          U.el('button', { class: 'btn', onclick: () => overlay.remove() }, '取消'),
          U.el('button', { class: 'btn btn-primary', onclick: async () => {
            try {
              const data = {};
              form.querySelectorAll('[data-k]').forEach(inp => {
                const k = inp.getAttribute('data-k');
                if (k[0] === '_') return;
                let v = inp.value;
                if (inp.type === 'number') v = (v === '' ? '' : Number(v));
                else v = (v || '').trim();
                data[k] = v;
              });
              data.tiers = wt.tiers.filter(t => num(t.price) > 0).map(t => ({ wMin: num(t.wMin, 0), wMax: (t.wMax === '' || t.wMax == null ? null : num(t.wMax)), price: num(t.price) }));
              data.cbmTiers = ct.tiers.filter(t => num(t.price) > 0).map(t => ({ cMin: num(t.cMin, 0), cMax: (t.cMax === '' || t.cMax == null ? null : num(t.cMax)), price: num(t.price) }));
              if (!data.name) { U.toast('请填写渠道名称'); return; }
              if (!data.dests) { U.toast('请填写适用目的地'); return; }
              let tip = '';
              if (isEdit) {
                await store.updateChannel(existing.id, data);
                tip = '已更新';
              } else {
                // 同渠道商 + 同名渠道：直接覆盖旧价，不再新增重复条目
                const r = await store.upsertChannel(data);
                tip = r.updated ? '已覆盖同渠道商的同名渠道价格' : '已添加';
              }
              overlay.remove();
              U.toast(tip);
              App.router.show('channels');
            } catch (err) {
              console.error('保存渠道失败', err);
              U.toast('保存失败：' + (err && err.message ? err.message : '未知错误'));
            }
          } }, '保存')
        ])
      ])
    ]);
    document.body.appendChild(overlay);
    syncType();
  }

  // 批量编辑：勾选多条后，用同一个弹窗统一改「渠道商 / 有效期起 / 有效期止」（留空＝保持原值）
  function openBatchEdit(store, picked, onDone) {
    const inputs = {};
    function mk(k, label, type) {
      const inp = U.el('input', { type: type || 'text', value: '', 'data-bk': k });
      inputs[k] = inp;
      return field(label, inp);
    }
    const form = U.el('div', { class: 'ch-form' }, [
      U.el('p', { class: 'hint' }, '将把下列字段批量写入勾选的 ' + picked.length + ' 条渠道，留空的字段保持原值不变。'),
      U.el('ul', { class: 'batch-list' }, picked.slice(0, 6).map(c =>
        U.el('li', null, (c.name || '未命名') + (c.dests ? '（' + c.dests + '）' : '')))),
      picked.length > 6 ? U.el('p', { class: 'hint' }, '…等共 ' + picked.length + ' 条') : null,
      mk('carrier', '渠道商/货代'),
      mk('validFrom', '报价有效期起', 'date'),
      mk('validUntil', '报价有效期止', 'date')
    ]);
    const overlay = U.el('div', { class: 'modal-overlay' }, [
      U.el('div', { class: 'modal' }, [
        U.el('h3', null, '批量编辑 ' + picked.length + ' 条渠道'),
        form,
        U.el('div', { class: 'modal-actions' }, [
          U.el('button', { class: 'btn', onclick: () => overlay.remove() }, '取消'),
          U.el('button', { class: 'btn btn-primary', onclick: async () => {
            try {
              const patch = {};
              Object.keys(inputs).forEach(k => {
                const v = String(inputs[k].value == null ? '' : inputs[k].value).trim();
                if (v) patch[k] = v;
              });
              if (!Object.keys(patch).length) { U.toast('请至少填写一个要修改的字段'); return; }
              // 批量改一次落盘（逐条 updateChannel 会做 N 次「整份数据重写」）
              await store.updateChannels(picked.map(c => c.id), patch);
              overlay.remove();
              U.toast('已批量更新 ' + picked.length + ' 条渠道');
              if (onDone) onDone();
            } catch (err) {
              console.error('批量编辑失败', err);
              U.toast('批量编辑失败：' + (err && err.message ? err.message : '未知错误'));
            }
          } }, '保存')
        ])
      ])
    ]);
    document.body.appendChild(overlay);
  }

  function render(container) {
    const store = App.store.instance;
    const state = store.getState();
    const channels = state.channels;
    const f = { search: '', type: '', carrier: '', dest: '', carriers: [], origins: [], expiry: [], sort: { key: '', dir: '' } };
    let openFilter = ''; // 当前展开的筛选面板：'carrier' | 'origin' | 'expiry'
    let page = 1;        // 分页（几百上千条时不能一次渲染完，否则表格会卡）
    const PAGE_SIZE = 100;
    const sel = new Set(); // 勾选的渠道 id：表头的「一键编辑 / 一键删除」只作用于勾选项
    // 筛选面板/下拉用的候选项只跟「渠道数据」有关，跟筛选、翻页、键盘输入都无关。
    // 上万条时每次重算要 4 次全表 map + 去重 + 排序（约 20ms），放在渲染入口算一次就够。
    const carrierVals = uniqueSorted(channels.map(c => c.carrier || ''));
    const hasEmptyCarrier = channels.some(c => !c.carrier);
    const originVals = uniqueSorted(channels.map(c => c.origin || ''));
    const hasEmptyOrigin = channels.some(c => !c.origin);
    let searchTimer = null; // 搜索防抖的定时器（见下方 oninput）

    function draw() {
      container.innerHTML = '';
      const fileInput = U.el('input', {
        type: 'file',
        multiple: true,
        accept: '.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel',
        style: 'display:none'
      });
      fileInput.addEventListener('change', async () => {
        if (!fileInput.files || !fileInput.files.length) return;
        try {
          if (!App.excel || !App.excel.aggregateChannels) throw new Error('Excel 导入模块未加载');
          // 有效期止 = 导入日 + 「更新天数」（首页「设置更新天数」里可改，默认 7 天）
          const updDays = App.calc && App.calc.normUpdateDays ? App.calc.normUpdateDays(store.getSettings().updateDays) : 7;
          const { channels, skipped, errors, duplicates } = await App.excel.aggregateChannels(fileInput.files, { validDays: updDays });
          if (!channels.length) {
            U.toast('未能从所选文件识别到有效渠道' + (errors.length ? ('：' + errors.join('；')) : '（需包含 渠道名称 / 适用目的地 / 类型 列）'));
            fileInput.value = '';
            return;
          }
          let msg = '将导入 ' + channels.length + ' 条渠道价格' + (skipped > 0 ? ('，' + skipped + ' 行因缺少名称/目的地被跳过') : '');
          if (duplicates > 0) msg += '，' + duplicates + ' 条重复已合并';
          if (errors.length) msg += '；' + errors.length + ' 个文件有问题已跳过';
          // 渠道商：来自文件名开头的编号（如 436…xlsx）
          const carriers = Array.from(new Set(channels.map(c => c.carrier).filter(Boolean)));
          if (carriers.length === 1) msg += '；渠道商 ' + carriers[0];
          // 起运仓：FBA 卡派价目表按仓分列，条数会明显变多，这里先讲清楚
          const origins = Array.from(new Set(channels.map(c => c.origin).filter(Boolean)));
          if (origins.length) {
            msg += '；含 ' + origins.length + ' 个起运仓（' + origins.slice(0, 3).join('、') +
              (origins.length > 3 ? ' 等' : '') + '），导入后可在渠道库按「起运仓」列筛选';
          }
          // 整票价的渠道：小包价目表每档给一票总价，试算按重量落档
          const wTotalN = channels.filter(c => c.wTiers && c.wTiers.length).length;
          if (wTotalN) msg += '；其中 ' + wTotalN + ' 条是「重量档整票价」小包报价';
          // 有效期：以导入这一刻为起（今天），止 = 起 + 更新天数
          const froms = Array.from(new Set(channels.map(c => c.validFrom).filter(Boolean)));
          const untils = Array.from(new Set(channels.map(c => c.validUntil).filter(Boolean)));
          if (froms.length === 1 && untils.length === 1) msg += '；报价有效期 ' + froms[0] + ' ~ ' + untils[0];
          // 预演：同渠道商+同名渠道将覆盖旧价，不新增重复条目
          const preview = await store.upsertChannels(channels, { dryRun: true });
          if (preview.updated > 0) {
            msg += '。其中 ' + preview.updated + ' 条与已有「同渠道商同名渠道」重复，将直接覆盖旧价，' + preview.added + ' 条为新增';
          }
          if (!(await U.confirmDialog(msg + '。确认继续？'))) {
            fileInput.value = '';
            return;
          }
          const res = await store.upsertChannels(channels);
          // 写盘落点如实告诉用户：没写进 data.json 时必须当场说，不能等下次重开发现"数据没了"
          const saved = res.saved;
          const notSaved = saved && saved.target === 'idb';
          U.toast('已导入：新增 ' + res.added + ' 条' + (res.updated ? ('，覆盖更新 ' + res.updated + ' 条') : '') + (errors.length ? ('（' + errors.length + ' 个文件失败）') : ''));
          if (notSaved) {
            // 直连模式下没有"授权"这一步，失败就是服务没接住，重试即可
            const kind = App.app.persistence && App.app.persistence.kind;
            const how = kind === 'static'
              ? '当前为只读模式：需在服务器运行 serve.js 才能写回，或本机用「启动服务.bat」编辑后上传覆盖 data.json'
              : kind === 'http'
                ? '点「数据与设置 → 写回 data.json」重试'
                : '点顶栏「data.json」重新授权即可补写';
            setTimeout(() => U.toast('注意：这批数据没写进 data.json（' + (saved.error || '写入失败') + '）。' + how + '。'), 900);
          }
          App.router.show('channels');
        } catch (err) {
          console.error('导入 Excel 失败', err);
          U.toast('导入失败：' + (err && err.message ? err.message : '未知错误'));
        }
        fileInput.value = '';
      });

      const toolbar = U.el('div', { class: 'toolbar' }, [
        U.el('button', { class: 'btn btn-primary', onclick: () => openModal(store, null) }, '+ 新增渠道'),
        U.el('button', { class: 'btn', onclick: () => fileInput.click() }, '导入 Excel'),
        U.el('input', { type: 'search', placeholder: '搜索名称/承运商/目的地', oninput: (e) => {
          const v = e.target.value;
          f.search = v;
          page = 1;
          // 上万条时「按键 → 全表筛选+排序+重画表头」大约 20~40ms/次，连打会明显掉帧；
          // 清空要立刻生效，正常输入合并到 120ms 后只算一次。
          clearTimeout(searchTimer);
          if (!v) { drawTable(); return; }
          searchTimer = setTimeout(drawTable, 120);
        } }),
        U.el('select', { onchange: (e) => { f.type = e.target.value; drawTable(); } },
          [U.el('option', { value: '' }, '全部类型')].concat(typeOptions(channels).map(t => U.el('option', { value: t }, App.calc.typeName(t))))),
        U.el('select', { onchange: (e) => { f.carrier = e.target.value; drawTable(); } },
          [U.el('option', { value: '' }, '全部承运商')].concat(carrierOptions(channels).map(c => U.el('option', { value: c }, c))))
      ]);
      const tableWrap = U.el('div', { id: 'ch-table' });
      container.appendChild(toolbar);
      container.appendChild(fileInput);
      container.appendChild(tableWrap);

      function drawTable() {
        const list = sortChannels(filterChannels(channels, f), f.sort.key, f.sort.dir);
        // 分页：几千条时不切页会一次渲染几千个 <tr>，滚动和勾选都会卡
        const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
        if (page > totalPages) page = totalPages;
        if (page < 1) page = 1;
        const pageList = list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
        // 勾选状态：清掉已被删除的 id，其余保留（切换筛选/排序不会丢勾选）
        const alive = {};
        channels.forEach(c => { alive[c.id] = 1; });
        Array.from(sel).forEach(id => { if (!alive[id]) sel.delete(id); });
        const picked = channels.filter(c => sel.has(c.id));

        function needPick() {
          U.toast('请先在「操作」列勾选渠道（表头勾选框可全选当前列表）');
        }
        function headEdit() {
          if (!picked.length) { needPick(); return; }
          if (picked.length === 1) { openModal(store, picked[0]); return; }
          openBatchEdit(store, picked, () => { sel.clear(); App.router.show('channels'); });
        }
        async function headDelete() {
          if (!picked.length) { needPick(); return; }
          const names = picked.slice(0, 3).map(c => '「' + (c.name || '未命名') + '」' + (c.dests ? ('（' + c.dests + '）') : '')).join('、');
          const msg = '确定删除勾选的 ' + picked.length + ' 条渠道价格？\n' + names + (picked.length > 3 ? ' 等' : '');
          if (!(await U.confirmDialog(msg))) return;
          try {
            const ids = picked.map(c => c.id);
            // 一次批量删除 + 一次落盘：逐条删除会让上万条数据重写 N 遍（勾 100 条 = 重写 100 次）
            const n = store.deleteChannels ? await store.deleteChannels(ids) : 0;
            ids.forEach(id => sel.delete(id));
            U.toast('已删除 ' + n + ' 条渠道');
            drawTable();
          } catch (err) {
            console.error('批量删除失败', err);
            U.toast('删除失败：' + (err && err.message ? err.message : '未知错误'));
          }
        }
        // 「操作」列表头：全选 + 一键编辑 + 一键删除 + 清除筛选排序
        function opsHead() {
          const allOn = pageList.length > 0 && pageList.every(c => sel.has(c.id));
          return U.el('th', { class: 'th-ops' }, U.el('div', { class: 'ops-head' }, [
            U.el('span', { class: 'th-txt' }, '操作'),
            U.el('input', {
              type: 'checkbox',
              class: 'sel-all',
              title: '全选 / 取消全选当前列表',
              checked: allOn ? 'checked' : null,
              onchange: (e) => {
                if (e.target.checked) pageList.forEach(c => sel.add(c.id));
                else pageList.forEach(c => sel.delete(c.id));
                drawTable();
              }
            }),
            U.el('button', {
              class: 'btn btn-sm btn-primary',
              title: '编辑勾选的渠道（只勾 1 条＝编辑该条）',
              onclick: (e) => { e.stopPropagation(); headEdit(); }
            }, '一键编辑'),
            U.el('button', {
              class: 'btn btn-sm btn-danger',
              title: '删除勾选的渠道',
              onclick: (e) => { e.stopPropagation(); headDelete(); }
            }, '一键删除'),
            U.el('button', {
              class: 'th-ico th-reset' + ((f.carriers.length || f.origins.length || f.expiry.length || f.sort.key) ? ' on' : ''),
              title: '清除全部筛选与排序',
              onclick: (e) => {
                e.stopPropagation();
                f.carriers = []; f.origins = []; f.expiry = []; f.sort = { key: '', dir: '' }; openFilter = ''; page = 1;
                drawTable();
              }
            }, '↺')
          ]));
        }

        function toggleSort(key) {
          if (f.sort.key !== key) f.sort = { key, dir: 'asc' };
          else if (f.sort.dir === 'asc') f.sort = { key, dir: 'desc' };
          else f.sort = { key: '', dir: '' };
          openFilter = '';
          drawTable();
        }
        function toggleFilter(kind, v, on) {
          const key = kind === 'carrier' ? 'carriers' : (kind === 'origin' ? 'origins' : 'expiry');
          // 空数组表示「全选/不限」，此处先展开成完整列表再增删，否则取消一项会退化成"仍然全选"
          const all = kind === 'carrier'
            ? carrierVals.concat(hasEmptyCarrier ? [''] : [])
            : (kind === 'origin' ? originVals.concat(hasEmptyOrigin ? [''] : []) : EXPIRY_KEYS.slice());
          let cur = f[key].length ? f[key].slice() : all.slice();
          if (on) { if (cur.indexOf(v) < 0) cur.push(v); }
          else cur = cur.filter(x => x !== v);
          if (cur.length >= all.length) cur = []; // 全选 = 不限
          f[key] = cur;
          page = 1;                                // 换了筛选条件就回到第一页，否则可能停在空页上
          drawTable();
        }
        function filterPanel(kind, menuKey) {
          const items = kind === 'carrier'
            ? carrierVals.map(v => ({ v, label: v })).concat(hasEmptyCarrier ? [{ v: '', label: '（未填渠道商）' }] : [])
            : (kind === 'origin'
              ? originVals.map(v => ({ v, label: v })).concat(hasEmptyOrigin ? [{ v: '', label: '（未填起运仓）' }] : [])
              : EXPIRY_KEYS.map(k => ({ v: k, label: EXPIRY_LABEL[k] })));
          const cur = kind === 'carrier' ? f.carriers : (kind === 'origin' ? f.origins : f.expiry);
          const box = U.el('div', { class: 'th-menu' });
          box.appendChild(U.el('div', { class: 'flt-head' }, [
            U.el('span', null, kind === 'carrier' ? '按渠道商筛选' : (kind === 'origin' ? '按起运仓筛选' : '按有效期/状态筛选')),
            U.el('button', { class: 'flt-all', onclick: () => { f[kind === 'carrier' ? 'carriers' : (kind === 'origin' ? 'origins' : 'expiry')] = []; openFilter = menuKey || kind; drawTable(); } }, '全选')
          ]));
          items.forEach(it => {
            const checked = cur.length === 0 || cur.indexOf(it.v) >= 0;
            const cnt = kind === 'carrier'
              ? channels.filter(c => (c.carrier || '') === it.v).length
              : (kind === 'origin'
                ? channels.filter(c => (c.origin || '') === it.v).length
                : channels.filter(c => expiryState(c.validUntil) === it.v).length);
            box.appendChild(U.el('label', { class: 'flt-item' }, [
              U.el('input', { type: 'checkbox', checked: checked ? 'checked' : null, onchange: (e) => { e.stopPropagation(); toggleFilter(kind, it.v, e.target.checked); } }),
              U.el('span', { class: 'flt-txt' }, it.label),
              U.el('span', { class: 'flt-cnt' }, String(cnt))
            ]));
          });
          box.appendChild(U.el('button', { class: 'flt-done', onclick: () => { openFilter = ''; drawTable(); } }, '完成'));
          return box;
        }
        function headCell(col) {
          const wrap = U.el('div', { class: 'th-inner' }, [U.el('span', { class: 'th-txt' }, col.label)]);
          if (col.sortKey) {
            const active = f.sort.key === col.sortKey ? f.sort.dir : '';
            wrap.appendChild(U.el('button', {
              class: 'th-ico th-sort' + (active ? ' on' : ''),
              title: active === 'asc' ? '升序，点按切换为降序' : (active === 'desc' ? '降序，点按取消排序' : '点按按此列升序排序'),
              onclick: (e) => { e.stopPropagation(); toggleSort(col.sortKey); }
            }, active === 'asc' ? '↑' : (active === 'desc' ? '↓' : '⇅')));
          }
          if (col.filter) {
            const on = (col.filter === 'carrier' ? f.carriers : (col.filter === 'origin' ? f.origins : f.expiry)).length > 0;
            wrap.appendChild(U.el('button', {
              class: 'th-ico th-filter' + (on ? ' on' : ''),
              title: on ? '已筛选，点按修改' : '点按筛选',
              onclick: (e) => {
                e.stopPropagation();
                const key = col.menu || col.filter;
                openFilter = (openFilter === key ? '' : key);
                drawTable();
              }
            }, '▾'));
          }
          if (col.reset) {
            const active = f.carriers.length > 0 || f.origins.length > 0 || f.expiry.length > 0 || !!f.sort.key;
            wrap.appendChild(U.el('button', {
              class: 'th-ico th-reset' + (active ? ' on' : ''),
              title: '清除全部筛选与排序',
              onclick: (e) => {
                e.stopPropagation();
                f.carriers = []; f.origins = []; f.expiry = []; f.sort = { key: '', dir: '' }; openFilter = ''; page = 1;
                drawTable();
              }
            }, '↺'));
          }
          const th = U.el('th', null, wrap);
          if (col.filter && openFilter === (col.menu || col.filter)) th.appendChild(filterPanel(col.filter, col.menu || col.filter));
          return th;
        }

        if (list.length === 0) {
          tableWrap.innerHTML = '';
          tableWrap.appendChild(U.el('div', { class: 'empty' },
            channels.length === 0 ? '还没有渠道价格，点击“+ 新增渠道”添加第一条，或点“导入 Excel”批量导入。' : '没有匹配的结果。'));
          return;
        }
        const COLS = [
          { label: '类型' },
          { label: '渠道名称', sortKey: 'name' },
          { label: '渠道商', sortKey: 'carrier', filter: 'carrier' },
          { label: '适用目的地' },
          { label: '起运仓', sortKey: 'origin', filter: 'origin' },
          { label: '计费摘要' },
          { label: '时效' },
          { label: '报价有效期（起 ~ 止）', sortKey: 'validUntil', filter: 'expiry', menu: 'valid' },
          { label: '状态', sortKey: 'status', filter: 'expiry', menu: 'status' },
          { label: '操作', ops: true }
        ];
        const rows = pageList.map(c => U.el('tr', {
          class: rowClass(c.validUntil),
          ondblclick: () => openModal(store, c)
        }, [
          U.el('td', null, App.calc.typeName(c.type)),
          U.el('td', null, c.name),
          U.el('td', null, c.carrier || '—'),
          U.el('td', null, c.dests || '—'),
          U.el('td', null, c.origin || '—'),
          U.el('td', null, chPriceText(c)),
          U.el('td', null, c.transit || '—'),
          U.el('td', null, validRangeText(c)),
          U.el('td', null, expiryTag(c.validUntil)),
          U.el('td', { class: 'col-ops' }, U.el('input', {
            type: 'checkbox',
            class: 'sel-row',
            title: '勾选后，用表头的「一键编辑 / 一键删除」批量处理',
            checked: sel.has(c.id) ? 'checked' : null,
            onchange: (e) => {
              e.stopPropagation();
              if (e.target.checked) sel.add(c.id); else sel.delete(c.id);
              drawTable();
            }
          }))
        ]));
        const table = U.el('table', { class: 'table-filterable' }, [
          U.el('thead', null, U.el('tr', null, COLS.map(col => (col.ops ? opsHead() : headCell(col))))),
          U.el('tbody', null, rows)
        ]);
        const sortedLabel = { carrier: '渠道商', origin: '起运仓', validUntil: '有效期', status: '状态', name: '渠道名称' }[f.sort.key] || '';
        const cap = U.el('div', { class: 'table-cap' },
          '共 ' + channels.length + ' 条' + (list.length !== channels.length ? ('，筛选后 ' + list.length + ' 条') : '') +
          (list.length > PAGE_SIZE ? ('，本页 ' + ((page - 1) * PAGE_SIZE + 1) + '–' + Math.min(page * PAGE_SIZE, list.length) + ' 条') : '') +
          ((f.carriers.length || f.origins.length || f.expiry.length) ? '（已筛选）' : '') +
          (f.sort.key ? '（已按' + sortedLabel + (f.sort.dir === 'desc' ? '降序' : '升序') + '）' : '') +
          (picked.length ? ('，已勾选 ' + picked.length + ' 条') : '') +
          '　·　勾选行后用表头「一键编辑 / 一键删除」批量处理；双击某行可单独编辑'
        );
        // 分页条：上千条时只渲染当前页
        let pager = null;
        if (totalPages > 1) {
          const goto = (p) => { page = Math.min(totalPages, Math.max(1, p)); drawTable(); };
          pager = U.el('div', { class: 'pager' }, [
            U.el('button', { class: 'pg-btn', disabled: page <= 1 ? 'disabled' : null, onclick: () => goto(page - 1) }, '‹ 上一页'),
            U.el('span', { class: 'pg-info' }, '第 ' + page + ' / ' + totalPages + ' 页（每页 ' + PAGE_SIZE + ' 条）'),
            U.el('button', { class: 'pg-btn', disabled: page >= totalPages ? 'disabled' : null, onclick: () => goto(page + 1) }, '下一页 ›'),
            U.el('button', { class: 'pg-btn', onclick: () => goto(1) }, '首页'),
            U.el('button', { class: 'pg-btn', onclick: () => goto(totalPages) }, '末页')
          ]);
        }
        tableWrap.innerHTML = '';
        tableWrap.appendChild(table);
        tableWrap.appendChild(cap);
        if (pager) tableWrap.appendChild(pager);
      }
      drawTable();
    }
    draw();
  }

  root.App.pages = root.App.pages || {};
  root.App.pages.channels = { render, filterChannels, sortChannels, expiryState, EXPIRY_KEYS, EXPIRY_LABEL, typeOptions, carrierOptions, destOptions, rowClass, expiryTag, chPriceText };
  if (typeof module !== 'undefined' && module.exports) module.exports = { filterChannels, sortChannels, expiryState, EXPIRY_KEYS, EXPIRY_LABEL, typeOptions, carrierOptions, destOptions, rowClass, expiryTag, chPriceText };
})(typeof globalThis !== 'undefined' ? globalThis : this);
