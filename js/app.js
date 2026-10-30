(function (root) {
  'use strict';
  const App = root.App;

  // 降级持久化：用 IndexedDB 作工作副本，支持导出/导入文件
  function createDegradePersistence() {
    const KEY = 'degradeData';
    let cache = null;
    return {
      kind: 'degrade',
      isDegrade: true,
      read: async () => {
        if (cache) return cache;
        try { cache = await App.db.getIdbJson(KEY); } catch (e) { cache = null; }
        return cache || App.fsio.defaultData();
      },
      write: async (obj) => { cache = obj; try { await App.db.putIdbJson(KEY, obj); } catch (e) {} },
      exportFile: async () => {
        const data = cache || App.fsio.defaultData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'data-backup-' + App.util.formatDate(new Date()) + '.json';
        a.click();
        URL.revokeObjectURL(a.href);
      },
      importFile: async (file) => {
        const text = await file.text();
        cache = App.fsio.parseData(text);
        await App.db.putIdbJson(KEY, cache);
        return cache;
      }
    };
  }

  // 持久化候选，按"省事程度"排序，逐个试到能读为止：
  //   1) http  —— 页面由 serve.js 提供时，GET/POST /api/data 直接读写服务器上的 data.json
  //               （不用选文件、不用授权，这就是"网页数据直接进 data.json"；部署时可用 DATA_TOKEN 保护）
  //   2) static —— 放到没有 Node 后端的纯静态主机时，直接 GET /data.json 只读加载（浏览器写不进服务器文件）
  //   3) fs    —— Chrome/Edge 的 File System Access API，需要用户选一次本地文件（本机 http/file:// 场景）
  //   4) degrade —— 都不行时存浏览器里，靠导出备份兜底
  function persistenceFactories() {
    return [
      async () => {
        // 探活服务接口；若接口要求令牌（401），用地址栏 ?token= 或已记住的令牌再探一次
        let health = await App.fsio.probeHttp('');
        if (health && health.needsToken) {
          const tok = App.fsio.getApiToken();
          if (tok) health = await App.fsio.probeHttp('', undefined, tok);
        }
        if (!health || health.needsToken) return null;
        return await App.fsio.createHttpPersistence({
          file: health.file ? decodeURIComponent(health.file) : null,
          mtime: health.mtime,
          token: App.fsio.getApiToken()
        });
      },
      async () => {
        const st = await App.fsio.probeStatic('');
        if (!st) return null;
        return App.fsio.createStaticPersistence({ file: st.file, mtime: st.mtime });
      },
      async () => (App.fsio.isFsSupported() ? App.fsio.createFsPersistence() : null),
      async () => createDegradePersistence()
    ];
  }

  async function boot() {
    if (typeof document === 'undefined') return;
    const content = document.getElementById('content');

    let persistence = null;
    let store = null;
    for (const make of persistenceFactories()) {
      let p = null;
      try { p = await make(); } catch (e) { p = null; }
      if (!p) continue;
      const s = App.store.createStore(p);
      try {
        await s.load();
        persistence = p;
        store = s;
        break;
      } catch (e) {
        // 这一档读不出来（服务刚停、文件坏了、句柄失效…）：换下一档，绝不让 App 白屏
      }
    }
    if (!store) {
      persistence = createDegradePersistence();
      store = App.store.createStore(persistence);
      await store.load();
    }
    App.store.instance = store;
    App.app.persistence = persistence;

    // 句柄是持久化的，但浏览器重启后授权可能被收回：先把权限状态查准，再决定提示
    if (persistence.refreshPerm) { try { await persistence.refreshPerm(); } catch (e) {} }
    // 上次写盘失败留下的"浏览器新、文件旧"：权限还在就顺手补写一次，
    // 免得用户每次开机都看到「浏览器数据较新」的提示。
    if (persistence.stale && persistence.perm === 'granted') {
      try { await store.save(); } catch (e) {}
    }
    // 老数据补国家：早期导入的渠道常常只写了城市/仓号（「Bolingbrook」「ONT8」），
    // 而快捷测算只按国家名搜，这些渠道会搜不到。按货代分组补一次（幂等），补了就落盘。
    let countryFilled = 0;
    try { countryFilled = App.calc.fillMissingCountries(store.getState().channels || []); } catch (e) { countryFilled = 0; }
    if (countryFilled) { try { await store.save(); } catch (e) {} }
    updateConnUi();
    // 不再强制弹出“选择数据文件”横幅：未选文件时数据自动落在浏览器本地存储，
    // 点顶栏的「data.json 未绑定」或到「数据与设置」即可绑定项目目录里的 data.json。

    document.getElementById('nav').addEventListener('click', (e) => {
      const a = e.target.closest('.nav-item');
      if (!a) return;
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      a.classList.add('active');
      App.router.show(a.dataset.page);
    });

    App.router.init(content);
    App.router.show('home');
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
  async function exportData() {
    const state = App.store.instance.getState();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'data-backup-' + App.util.formatDate(new Date()) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    App.util.toast('已导出备份');
  }

  // 就地替换当前状态（保留 state 对象引用，页面里已经拿到的引用不会失效）
  function applyInPlace(data) {
    const st = App.store.instance.getState();
    Object.assign(st, data || {});
    st.settings = Object.assign({}, App.store.DEFAULT_SETTINGS, st.settings || {});
    if (!Array.isArray(st.channels)) st.channels = [];
    if (!Array.isArray(st.records)) st.records = [];
    return st;
  }

  async function importData(file) {
    const text = await file.text();
    const data = App.fsio.parseData(text);
    applyInPlace(data);
    await App.store.instance.save();
    App.util.toast('已从备份恢复');
    App.router.show(App.router.current || 'home');
  }

  // 侧栏/顶栏的连接状态：与设置页共用 fsio.dataFileVm，避免三处文案各说各的
  function updateConnUi() {
    if (typeof document === 'undefined') return;
    const connDot = document.getElementById('conn-dot');
    const connText = document.getElementById('conn-text');
    const dataPath = document.getElementById('data-path');
    const dv = App.fsio.dataFileVm(App.app.persistence);
    if (connDot) {
      connDot.classList.remove('ok');
      connDot.classList.remove('warn');
      connDot.classList.add((dv.needsBind || dv.needsPerm || dv.isDegrade || dv.writeFailed || dv.stale || dv.isStatic) ? 'warn' : 'ok');
    }
    if (connText) {
      connText.textContent = dv.isDegrade ? '本地存储（浏览器）'
        : dv.isStatic ? '只读模式（data.json）'
          : dv.isHttp ? (dv.writeFailed ? '未写入 data.json' : '已直连 data.json')
            : dv.needsBind ? '未绑定 data.json'
              : dv.needsPerm ? '需授权 data.json'
                : dv.writeFailed ? '未写入 data.json'
                  : dv.stale ? '浏览器数据较新'
                    : '已连接 data.json';
    }
    if (dataPath) {
      // http 直连 / 静态只读 都没有"绑定"这回事，顶栏只报状态；file:// 或未绑定时才是可点的绑定入口
      const clickable = !dv.isDegrade && !dv.isHttp && !dv.isStatic;
      dataPath.textContent = dv.isDegrade ? ''
        : dv.isStatic ? 'data.json · 只读（无写入接口）'
          : dv.isHttp ? ('data.json · 自动保存' + (dv.writeFailed ? '（未写入）' : ''))
            : dv.needsBind ? 'data.json 未绑定 · 点此绑定'
              : ('data.json' + (dv.needsPerm ? '（需授权）' : dv.writeFailed ? '（未写入）' : dv.stale ? '（文件较旧）' : ''));
      dataPath.title = dv.hint + (dv.isHttp && dv.filePath ? '\n' + dv.filePath : '');
      dataPath.style.cursor = clickable ? 'pointer' : '';
      dataPath.onclick = clickable ? () => App.app.changeDataFile(!dv.needsBind) : null;
    }
  }

  // 绑定项目目录里的 data.json（create=false）或另存一个新的（create=true）。
  // 关键：绑定时不能拿浏览器里的旧副本盖掉文件里已有的数据——
  // 用户往往是「文件里有几千条、浏览器里只有几百条」时来重新绑定，
  // 一盖就等于把文件里的渠道清空（看起来就是"重开变几百条"）。
  async function changeDataFile(create) {
    const p = App.app.persistence;
    // http 直连模式下文件已由服务托管，选文件没有意义（选了反而会切到 fs 模式）
    if (p && p.kind === 'http') {
      App.util.toast('当前已直连 data.json（本地服务托管），无需绑定文件');
      return;
    }
    // 静态只读模式：浏览器写不进服务器文件，绑定本地文件只会把数据存到本机，与服务器脱节
    if (p && p.kind === 'static') {
      App.util.toast('当前为只读模式：服务器未提供写入接口。要在服务器上保存，请运行 serve.js；或本机用「启动服务.bat」编辑后上传覆盖 data.json。');
      return;
    }
    const wantCreate = create === true;
    let info = null;
    try {
      if (p && p.chooseFile) info = await p.chooseFile(wantCreate);
      else if (p && p.changeFile) info = await p.changeFile(wantCreate);
      else { App.util.toast('当前模式不支持绑定文件'); return; }
    } catch (e) {
      App.util.toast('未选择文件');
      return;
    }
    const memCount = ((App.store.instance.getState() || {}).channels || []).length;
    const fileCount = (info && typeof info.fileCount === 'number') ? info.fileCount : 0;
    if (info && info.fileData && fileCount > memCount) {
      // 文件里的数据更多：采用文件，绝不拿浏览器里的旧副本盖掉它
      applyInPlace(info.fileData);
      App.util.toast('已绑定 data.json，采用文件里的 ' + fileCount + ' 条渠道（未覆盖）');
    } else {
      await App.store.instance.save();
      App.util.toast(wantCreate
        ? ('已新建 data.json，写入 ' + memCount + ' 条渠道')
        : ('已绑定 data.json，写入 ' + memCount + ' 条渠道'));
    }
    if (info && info.writable === false) {
      App.util.toast('文件是只读授权的，数据暂时只存在浏览器里');
    }
    updateConnUi();
    App.router.show('settings');
  }

  // 把浏览器里的较新数据补写回 data.json（设置页「写回 data.json」）
  async function writeBackFile() {
    const p = App.app.persistence;
    if (p && p.kind === 'static') {
      App.util.toast('当前为只读模式，服务器未提供写入接口，无法写回。请在服务器上运行 serve.js。');
      return;
    }
    if (!App.store.instance) return;
    let r = null;
    try { r = await App.store.instance.save(); } catch (e) {}
    updateConnUi();
    const okTarget = r && (r.target === 'file' || r.target === 'http');
    App.util.toast(okTarget ? '已写回 data.json' : '还是没写进去：检查「启动服务.bat」窗口是否还开着，或点「重新授权」允许读写后再试');
    App.router.show('settings');
  }

  // 浏览器重启后重新拿回读写权限（必须由用户点击触发）
  async function requestDataPerm() {
    const p = App.app.persistence;
    if (!p || !p.requestPerm) { App.util.toast('当前模式不支持授权'); return; }
    const st = await p.requestPerm();
    if (App.store.instance) { try { await App.store.instance.save(); } catch (e) {} }
    updateConnUi();
    App.util.toast(st === 'granted' ? '已授权，数据会写回 data.json' : '未获得授权，数据暂存浏览器');
    App.router.show('settings');
  }

  const api = { boot, createDegradePersistence, exportData, importData, changeDataFile, requestDataPerm, writeBackFile, applyInPlace, updateConnUi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.app = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
