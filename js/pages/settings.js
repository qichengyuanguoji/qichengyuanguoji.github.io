(function (root) {
  'use strict';
  const App = root.App;
  const U = App.util;

  // 仓库表导入可接受的文件类型：xlsx/xlsm 走 Excel 解析，csv/txt/tsv 走文本解析
  const WH_ACCEPT = '.csv,.txt,.tsv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // 纯函数：合并默认参数（v2 含 factor 体积系数）
  function withDefaults(patch) {
    const def = (App.store && App.store.DEFAULT_SETTINGS) || { profitRate: 30, volRatio: 5000, factor: 6000, currency: '¥', weightStep: 0.5, firstWeight: 1, fbaWh: [], updateDays: 7, todoDays: 7 };
    return Object.assign({}, def, patch || {});
  }
  // 纯函数：解析导入的 JSON 文本（缺省/非法由 fsio 统一处理）
  function parseImported(text) {
    return App.fsio.parseData(text);
  }
  // 写入默认参数到 store（保留其它默认值）
  async function applySettings(patch) {
    if (!App.store.instance) return null;
    return await App.store.instance.updateSettings(patch);
  }

  function render(container) {
    const store = App.store.instance;
    const settings = store.getSettings();

    // 数据文件卡：状态由 fsio.dataFileVm 统一给出（直连 / 未绑定 / 需授权 / 已连接 / 降级）
    const dv = App.fsio.dataFileVm(App.app.persistence);
    const fileBtns = [];
    if (!dv.isHttp) {
      // 只有通过文件选择器（fs）或降级模式才需要"绑定 / 更换 / 授权"这么多按钮；
      // 本地服务直连时文件已由 serve.js 托管，这些动作都不存在。
      fileBtns.push(U.el('button', {
        class: dv.needsBind ? 'btn btn-primary' : 'btn',
        onclick: () => App.app.changeDataFile(false)
      }, dv.needsBind ? '绑定工作空间里的 data.json' : '更换数据文件'));
      if (dv.needsPerm) {
        fileBtns.push(U.el('button', { class: 'btn btn-primary', onclick: () => App.app.requestDataPerm() }, '重新授权'));
      }
      if (dv.needsBind) {
        fileBtns.push(U.el('button', { class: 'btn', onclick: () => App.app.changeDataFile(true) }, '新建 data.json'));
      }
    }
    // 写盘失败（两种模式都可能）：给一个不用重新授权也能重试的按钮
    if (dv.writeFailed || dv.stale) {
      fileBtns.push(U.el('button', { class: 'btn btn-primary', onclick: () => App.app.writeBackFile() }, '写回 data.json'));
    }
    fileBtns.push(U.el('button', { class: 'btn', onclick: () => App.app.exportData() }, '导出备份'));
    fileBtns.push(importButton());

    const fileCard = U.el('div', { class: 'card' }, [
      U.el('h3', null, '数据文件'),
      U.el('div', { class: 'muted', style: 'margin-bottom:6px' }, '当前：' + dv.status),
      U.el('div', { class: 'muted', style: 'margin-bottom:10px' }, dv.hint),
      dv.isHttp && dv.filePath ? U.el('div', { class: 'muted', style: 'margin-bottom:10px;word-break:break-all' }, '文件位置：' + dv.filePath) : null,
      U.el('div', { class: 'row' }, fileBtns)
    ]);

    // CSV 价格表 导入/导出
    const csvCard = U.el('div', { class: 'card', style: 'margin-top:16px' }, [
      U.el('h3', null, '价格表 CSV'),
      U.el('div', { class: 'muted', style: 'margin-bottom:10px' }, '支持从 .csv/.xlsx 导出的价格表批量导入；列名含中英文别名会被自动识别（渠道名称、适用目的地、渠道类型为必填）。同一渠道商的同名渠道重复导入会直接覆盖旧价。'),
      U.el('div', { class: 'row' }, [
        U.el('button', { class: 'btn', onclick: () => { exportChannels(); } }, '导出价格表 CSV'),
        importCsvButton(),
        dedupeButton()
      ])
    ]);

    // FBA 仓库表：只有用户自己维护的条目（v2.25 起不再内置亚马逊仓地址）
    const kwInput = U.el('input', { type: 'text', placeholder: '搜索代码/城市/州/邮编（如 ONT8、CA、92551）' });
    const fbaBox = U.el('div', { style: 'max-height:260px;overflow:auto;margin-top:10px' });
    const fbaCount = U.el('div', { class: 'muted', style: 'margin-top:6px' });
    let bulkBtn = null;
    const newCode = U.el('input', { type: 'text', placeholder: '仓库代码 *（如 ONT8）' });
    const newZip = U.el('input', { type: 'text', placeholder: '邮编' });
    const newCountry = U.el('input', { type: 'text', placeholder: '国家代码（US/CA/UK…）', value: 'US' });
    const newCity = U.el('input', { type: 'text', placeholder: '城市' });
    const newState = U.el('input', { type: 'text', placeholder: '州/省（如 CA）' });

    function extraWh() { return store.getSettings().fbaWh || []; }
    // 命中数（用于按钮文案与"删的到底是几条"，显示只列前 80 条，删除按命中全量）
    function hitWh(kw) { return App.fba.search(kw, extraWh(), 0); }

    async function removeWh(list) {
      if (!list || !list.length) { U.toast('当前没有可删除的仓库'); return 0; }
      const plan = App.fba.removeEntries(list, extraWh());
      await store.updateSettings({ fbaWh: plan.fbaWh });
      return plan.removedCount;
    }

    function renderFbaList(kw) {
      if (!App.fba) return;
      const extra = extraWh();
      const hit = App.fba.search(kw, extra, 0);
      const list = hit.slice(0, 80);
      fbaBox.innerHTML = '';
      fbaCount.textContent = '仓库 ' + extra.length + ' 个 · 当前显示 ' + list.length + ' / 命中 ' + hit.length + ' 个';
      if (bulkBtn) {
        bulkBtn.textContent = '一键删除' + (hit.length ? '（' + hit.length + '）' : '');
        bulkBtn.disabled = !hit.length;
      }
      if (!list.length) {
        fbaBox.appendChild(U.el('div', { class: 'muted' },
          extra.length ? '没有匹配的仓库。' : '仓库表是空的，用下面的「新增 / 修正仓库」或「从 Excel/CSV 导入仓库」添加。'));
        return;
      }
      list.forEach(e => {
        const row = U.el('div', { class: 'line' }, [
          U.el('span', null, App.fba.desc(e))
        ]);
        row.appendChild(U.el('button', {
          class: 'btn btn-danger', style: 'padding:2px 8px',
          onclick: async () => {
            if (!(await U.confirmDialog('确定删除仓库 ' + e.code + '？删除后不可恢复，运费试算也不再自动带出它的邮编/国家。'))) return;
            await removeWh([e]);
            U.toast('已删除 ' + e.code);
            renderFbaList(kwInput.value);
          }
        }, '删除'));
        fbaBox.appendChild(row);
      });
    }

    // 一键删除：删当前筛选结果（搜索框为空 = 整张表）
    async function bulkDelete() {
      const kw = kwInput.value.trim();
      const hit = hitWh(kw);
      if (!hit.length) { U.toast('当前没有可删除的仓库'); return; }
      const scope = kw ? '当前筛选出的 ' + hit.length + ' 个仓库（搜索：' + kw + '）' : '全部 ' + hit.length + ' 个仓库';
      if (!(await U.confirmDialog('确定删除' + scope + '？\n\n删除后不可恢复，运费试算输入这些仓号也不再自动带出邮编/国家。'))) return;
      const n = await removeWh(hit);
      U.toast('已删除 ' + n + ' 个仓库');
      renderFbaList(kwInput.value);
    }

    const fbaCard = U.el('div', { class: 'card', style: 'margin-top:16px' }, [
      U.el('h3', null, 'FBA 仓库表'),
      U.el('div', { class: 'muted', style: 'margin-bottom:10px' },
        '输入仓库代码可在运费试算中自动带出邮编与国家。仓库表默认是空的（不再内置亚马逊仓地址），按需新增或直接导入 .xlsx / .csv（多工作表会一起读入，表头可不在第一行）；同码重复导入会覆盖旧地址。'),
      U.el('div', { class: 'row' }, [kwInput]),
      U.el('div', { class: 'row', style: 'margin-top:8px' }, [
        bulkBtn = U.el('button', { class: 'btn btn-danger', onclick: bulkDelete }, '一键删除')
      ]),
      fbaBox,
      fbaCount,
      U.el('div', { class: 'muted', style: 'margin-top:4px' },
        '「一键删除」删的是当前筛选出的全部仓库（搜索框为空时即整张表），删前请自行留好原始表格。'),
      U.el('h4', { style: 'margin-top:14px' }, '新增 / 修正仓库'),
      U.el('div', { class: 'row' }, [
        field('仓库代码 *', newCode),
        field('邮编', newZip),
        field('国家', newCountry),
        field('城市', newCity),
        field('州/省', newState)
      ]),
      U.el('div', { class: 'row', style: 'margin-top:12px' }, [
        U.el('button', { class: 'btn btn-primary', onclick: async () => {
          const code = App.fba ? App.fba.normCode(newCode.value) : '';
          if (!code) { U.toast('请填写仓库代码'); return; }
          const entry = {
            code: code,
            zip: newZip.value.trim(),
            country: App.fba.normCode(newCountry.value) || 'US',
            city: newCity.value.trim(),
            state: newState.value.trim().toUpperCase()
          };
          const arr = extraWh().filter(x => App.fba.normCode(x.code) !== code);
          arr.push(entry);
          await store.updateSettings({ fbaWh: arr });
          U.toast('已保存 ' + code);
          newCode.value = ''; newZip.value = ''; newCity.value = ''; newState.value = '';
          renderFbaList(kwInput.value);
        } }, '保存仓库'),
        importWhButton()
      ])
    ]);

    const inputs = {
      profitRate: U.el('input', { type: 'number', step: '1', value: settings.profitRate }),
      factor: U.el('input', { type: 'number', step: '1', value: settings.factor || 6000 }),
      volRatio: U.el('input', { type: 'number', step: '1', value: settings.volRatio }),
      currency: U.el('input', { type: 'text', value: settings.currency }),
      weightStep: U.el('input', { type: 'number', step: '0.1', value: settings.weightStep }),
      firstWeight: U.el('input', { type: 'number', step: '0.1', value: settings.firstWeight })
    };
    const settingsCard = U.el('div', { class: 'card', style: 'margin-top:16px' }, [
      U.el('h3', null, '默认参数'),
      U.el('div', { class: 'row' }, [
        field('默认利润率(%)', inputs.profitRate),
        field('默认体积系数', inputs.factor),
        field('体积重系数(v1兼容)', inputs.volRatio),
        field('货币符号', inputs.currency),
        field('续重单位(kg)', inputs.weightStep),
        field('首重重量(kg)', inputs.firstWeight)
      ]),
      U.el('button', { class: 'btn btn-primary', style: 'margin-top:14px', onclick: async () => {
        const patch = {
          profitRate: Number(inputs.profitRate.value) || 0,
          factor: Number(inputs.factor.value) || 6000,
          volRatio: Number(inputs.volRatio.value) || 5000,
          currency: inputs.currency.value.trim() || '¥',
          weightStep: Number(inputs.weightStep.value) || 0.5,
          firstWeight: Number(inputs.firstWeight.value) || 1
        };
        await App.store.instance.updateSettings(patch);
        U.toast('参数已保存');
      } }, '保存参数')
    ]);

    const dangerCard = U.el('div', { class: 'card', style: 'margin-top:16px;border-color:#f0c4c2' }, [
      U.el('h3', null, '危险区'),
      U.el('div', { class: 'muted', style: 'margin-bottom:10px' }, '清空后将删除全部渠道价格与查询记录，且不可恢复。'),
      U.el('button', { class: 'btn btn-danger', onclick: async () => {
        if (!(await U.confirmDialog('确定清空所有数据？此操作不可恢复。'))) return;
        if (!(await U.confirmDialog('请再次确认：所有数据将被彻底删除。'))) return;
        const st = store.getState();
        const def = App.fsio.defaultData();
        st.channels = []; st.records = []; st.settings = def.settings;
        await store.save();
        U.toast('已清空');
        App.router.show('settings');
      } }, '清空所有数据')
    ]);

    container.innerHTML = '';
    container.appendChild(fileCard);
    container.appendChild(csvCard);
    container.appendChild(fbaCard);
    container.appendChild(settingsCard);
    container.appendChild(dangerCard);

    kwInput.addEventListener('input', () => renderFbaList(kwInput.value));
    renderFbaList('');

    function exportChannels() {
      const chs = store.getState().channels;
      if (!chs.length) { U.toast('还没有渠道可导出'); return; }
      download('渠道价格表_' + U.formatDate(new Date()) + '.csv', App.csv.exportChannelsCsv(chs), 'text/csv;charset=utf-8');
      U.toast('已导出 ' + chs.length + ' 个渠道');
    }
    function importCsvButton() {
      const inp = U.el('input', { type: 'file', multiple: true, accept: '.csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', style: 'display:none' });
      inp.addEventListener('change', async () => {
        if (!inp.files || !inp.files.length) return;
        try {
          if (!App.excel || !App.excel.aggregateChannels) throw new Error('Excel 导入模块未加载');
          const updDays = App.calc && App.calc.normUpdateDays ? App.calc.normUpdateDays(store.getSettings().updateDays) : 7;
          const { channels, errors, duplicates } = await App.excel.aggregateChannels(inp.files, { validDays: updDays });
          if (!channels.length) { U.toast('未能从文件识别到有效渠道' + (errors.length ? ('：' + errors.join('；')) : '（需含 渠道名称/适用目的地/类型 列）')); inp.value = ''; return; }
          const pv = await store.upsertChannels(channels, { dryRun: true });
          let cmsg = '将从 ' + inp.files.length + ' 个文件中导入 ' + channels.length + ' 条渠道价格' + (duplicates > 0 ? ('（已合并 ' + duplicates + ' 条重复）') : '');
          const carriers = Array.from(new Set(channels.map(c => c.carrier).filter(Boolean)));
          if (carriers.length === 1) cmsg += '，渠道商 ' + carriers[0];
          if (pv.updated > 0) cmsg += '，其中 ' + pv.updated + ' 条为同渠道商同名渠道，将覆盖旧价';
          if (!(await U.confirmDialog(cmsg + '，确认继续？'))) { inp.value = ''; return; }
          const res = await store.upsertChannels(channels);
          U.toast('已导入：新增 ' + res.added + ' 条' + (res.updated ? ('，覆盖更新 ' + res.updated + ' 条') : '') + (errors.length ? ('（' + errors.length + ' 个文件失败）') : ''));
        } catch (err) {
          console.error(err);
          U.toast('导入失败：' + (err && err.message ? err.message : '未知错误'));
        }
        inp.value = '';
      });
      return U.el('span', null, [U.el('button', { class: 'btn', onclick: () => inp.click() }, '从 Excel/CSV 导入'), inp]);
    }
    function importButton() {
      const inp = U.el('input', { type: 'file', accept: 'application/json,.json', style: 'display:none' });
      inp.addEventListener('change', async () => { if (inp.files[0]) await App.app.importData(inp.files[0]); });
      return U.el('span', null, [U.el('button', { class: 'btn', onclick: () => inp.click() }, '从备份恢复'), inp]);
    }
    // 清理历史遗留的「同渠道商同名渠道」重复条目（保留最后一次提交的价格）
    function dedupeButton() {
      return U.el('button', {
        class: 'btn', onclick: async () => {
          try {
            if (!(await U.confirmDialog('将合并“同一渠道商 + 同名渠道”的重复条目，只保留最后提交的那条价格。确认继续？'))) return;
            const removed = await store.dedupeChannels();
            U.toast(removed > 0 ? ('已合并 ' + removed + ' 条重复渠道') : '没有发现重复渠道');
            if (removed > 0) App.router.show('settings');
          } catch (err) {
            console.error(err);
            U.toast('合并失败：' + (err && err.message ? err.message : '未知错误'));
          }
        }
      }, '合并重复渠道');
    }
    // 仓库表导入：.xlsx/.xlsm 直接读（多个工作表都能读），.csv/.txt/.tsv 走文本
    async function readWhFile(file) {
      const name = String(file.name || '').toLowerCase();
      if (/\.(xlsx|xlsm)$/.test(name)) {
        if (!App.excel || !App.excel.parseWorkbook) throw new Error('Excel 解析模块未加载');
        const sheets = await App.excel.parseWorkbook(await file.arrayBuffer());
        return App.fba.parseWhSheets(sheets);
      }
      if (/\.xls$/.test(name)) throw new Error('不支持旧版 .xls，请另存为 .xlsx 或 CSV 再导入');
      return App.fba.parseWhCsv(await file.text());
    }
    function importWhButton() {
      const inp = U.el('input', { type: 'file', multiple: true, accept: WH_ACCEPT, style: 'display:none' });
      inp.addEventListener('change', async () => {
        if (!inp.files || !inp.files.length) return;
        try {
          const all = [];
          const fails = [];
          let bad = 0, sheetCount = 0;
          for (const f of Array.from(inp.files)) {
            try {
              const one = await readWhFile(f);
              Array.prototype.push.apply(all, one.list);
              bad += one.bad || 0;
              sheetCount += one.sheets || 0;
            } catch (err) {
              fails.push(f.name + '：' + (err && err.message ? err.message : '解析失败'));
            }
          }
          if (!all.length) {
            U.toast('未从文件中识别到仓库（需含「仓库代码」列）' + (fails.length ? ('：' + fails.join('；')) : ''));
            inp.value = '';
            return;
          }
          // 同码覆盖：统计新增 / 覆盖各多少，导入前先把数说清楚
          const before = {};
          extraWh().forEach(x => { before[App.fba.normCode(x.code)] = 1; });
          const incoming = {};
          all.forEach(x => { incoming[x.code] = 1; });
          const updated = Object.keys(incoming).filter(c => before[c]).length;
          const added = Object.keys(incoming).length - updated;
          const merged = App.fba.mergeWh(extraWh(), all);
          await store.updateSettings({ fbaWh: merged });
          U.toast('已导入 ' + Object.keys(incoming).length + ' 个仓库（新增 ' + added
            + (updated ? '，覆盖 ' + updated : '') + '）'
            + (sheetCount > 1 ? '（' + sheetCount + ' 个工作表）' : '')
            + (bad ? '，另有 ' + bad + ' 行缺仓库代码已跳过' : '')
            + (fails.length ? '；' + fails.length + ' 个文件失败' : ''));
          inp.value = '';
          renderFbaList(kwInput.value);
        } catch (err) {
          console.error(err);
          U.toast('导入失败：' + (err && err.message ? err.message : '未知错误'));
          inp.value = '';
        }
      });
      return U.el('span', null, [U.el('button', { class: 'btn', onclick: () => inp.click() }, '从 Excel/CSV 导入仓库'), inp]);
    }
    function field(label, control) { return U.el('label', { class: 'field' }, [label, control]); }
  }

  // 数据文件状态（转出 fsio 的纯函数，便于单测与页面共用）
  const dataFileVm = (App.fsio && App.fsio.dataFileVm) ? App.fsio.dataFileVm : function () {
    return { status: '未知', hint: '', name: 'data.json', needsBind: false, needsPerm: false, isDegrade: false };
  };

  root.App.pages = root.App.pages || {};
  root.App.pages.settings = { render, withDefaults, parseImported, applySettings, dataFileVm };
  if (typeof module !== 'undefined' && module.exports) module.exports = { withDefaults, parseImported, applySettings, dataFileVm };
})(typeof globalThis !== 'undefined' ? globalThis : this);
