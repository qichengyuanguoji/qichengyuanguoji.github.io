(function (root) {
  'use strict';

  function defaultData() {
    return {
      version: 1,
      settings: { profitRate: 30, volRatio: 5000, currency: '¥', weightStep: 0.5, firstWeight: 1 },
      channels: [],
      records: []
    };
  }

  function isFsSupported() {
    return typeof window !== 'undefined' && 'showSaveFilePicker' in window && 'showOpenFilePicker' in window;
  }

  function parseData(text) {
    if (!text) return defaultData();
    try { return JSON.parse(text); } catch (e) { throw new Error('DATA_PARSE_ERROR'); }
  }

  // 工作副本的序列化：必须紧凑（不加缩进）。
  // 价格库上万条时，data.json 紧凑约 2MB、pretty-print 约 3.6MB；而每次增删改都要
  // 整份重写，缩进会让每次落盘的字节数几乎翻倍（1 万条实测 19ms → 25ms，且磁盘/IDB 写入同步变慢）。
  // 需要人看的备份文件走 exportData，那里仍用缩进。
  function serialize(dataObj) { return JSON.stringify(dataObj); }

  const JSON_TYPE = [{ description: 'JSON', accept: { 'application/json': ['.json'] } }];

  // 数据文件：固定叫 data.json，放在项目目录（工作空间\1.02）里跟代码做伴。
  // PICKER_ID 是「记住目录」的关键——浏览器的保存/打开对话框会按 id 记住上次选的目录，
  // 同一 id 下次直接回到那里，不用每次重新找。网页无权指定绝对路径，选一次即可。
  const DATA_NAME = 'data.json';
  const PICKER_ID = 'logi-data-json';
  const SAVE_OPTS = { id: PICKER_ID, suggestedName: DATA_NAME, startIn: 'desktop', types: JSON_TYPE };
  const OPEN_OPTS = { id: PICKER_ID, startIn: 'desktop', types: JSON_TYPE };

  function countOf(d) { return (d && Array.isArray(d.channels)) ? d.channels.length : 0; }

  // 浏览器：基于 File System Access API 的持久化
  // 注意：showSaveFilePicker / showOpenFilePicker 必须由用户手势触发，
  // 因此 read/write 在“尚无句柄”时绝不自动弹窗，仅返回 null / 缓冲写入，
  // 待用户点击“选择数据文件”时再通过 chooseFile 触发（避免 boot 阶段崩溃）。
  async function createFsPersistence() {
    const App = root.App;
    const WORK_KEY = 'fsWorkingCopy'; // 未选文件时的工作副本（IndexedDB）
    // 时间戳容差：文件系统的 lastModified 与 Date.now() 有几百毫秒误差，
    // 不设容差会把「刚落盘的文件」误判成「比工作副本旧」，从而读回旧副本。
    const NEWER_MS = 1500;
    let handle = null;
    let pending = null; // 尚未选文件期间的内存缓冲
    let permCache = 'none'; // 'none' 无句柄 / 'granted' 可读写 / 'prompt' 需重新授权 / 'denied'
    let lastWrite = null;   // { target:'file'|'idb', at, error }
    let stale = null;       // { fileCount, memCount }：浏览器里的工作副本比 data.json 新

    async function ensureHandle() {
      if (handle) return handle;
      try { handle = await App.db.getHandle(); } catch (e) { handle = null; }
      return handle;
    }

    async function queryPermOf(h) {
      try {
        if (h && typeof h.queryPermission === 'function') return await h.queryPermission({ mode: 'readwrite' });
      } catch (e) { /* 老浏览器不支持 queryPermission */ }
      return null;
    }

    // 把句柄升到读写权限。
    // showOpenFilePicker() 只授予**读**权限（写要另一次授权），所以「绑定已有的 data.json」
    // 之后如果直接 createWritable，会抛 NotAllowedError。
    // 以前这里只 query 不 request：写盘一直失败 → 数据只落在浏览器里 → 下次打开又读回文件里的旧数据，
    // 表现就是「导入了几千条，重开又变回几百条」。
    async function upgradePerm(h) {
      if (!h) return 'none';
      if (typeof h.requestPermission !== 'function') return 'granted';
      try {
        const q = await queryPermOf(h);
        if (q === 'granted') return 'granted';
        if (q === 'denied') return 'denied';
        const r = await h.requestPermission({ mode: 'readwrite' });
        return r || q || 'prompt';
      } catch (e) {
        return 'prompt';
      }
    }

    // 工作副本带 savedAt（老版本直接存裸数据，按 0 处理）
    async function readWork() {
      try {
        const raw = await App.db.getIdbJson(WORK_KEY);
        if (!raw) return { data: null, at: 0 };
        if (raw.data && raw.savedAt && Array.isArray(raw.data.channels)) {
          return { data: raw.data, at: Date.parse(raw.savedAt) || 0 };
        }
        return { data: raw, at: 0 };
      } catch (e) {
        return { data: null, at: 0 };
      }
    }

    async function writeWork(data, at) {
      const t = at || Date.now();
      try { await App.db.putIdbJson(WORK_KEY, { savedAt: new Date(t).toISOString(), data: data }); } catch (e) {}
      return t;
    }

    // 空文件（刚新建的 data.json）不能当成「清空的数据」：
    // 否则新建后刷新，会把浏览器里的工作副本一起盖掉。
    function parseFileData(text) {
      if (!text || !text.trim()) return null;
      const d = parseData(text);
      return (d && typeof d === 'object') ? d : null;
    }

    // 浏览器重启后句柄还在、授权却可能被撤回（perm 变 prompt）：
    // 此时写盘会失败，必须让上层知道「数据只在浏览器里」，不能谎报已存文件。
    async function refreshPerm() {
      const h = await ensureHandle();
      if (!h) { permCache = 'none'; return permCache; }
      const p = await queryPermOf(h);
      permCache = p || 'unknown';
      return permCache;
    }

    async function read() {
      const h = await ensureHandle();
      let fileData = null, fileAt = 0;
      if (h) {
        try {
          const f = await h.getFile();
          fileAt = f.lastModified || 0;
          fileData = parseFileData(await f.text());
          // 注意：读成功 ≠ 能写。绑定用的 open picker 只给读权限，
          // 这里若无条件记成 granted，顶栏就会一直显示「已连接」而写盘其实早就失败了。
          permCache = (await queryPermOf(h)) || 'granted';
        } catch (e) {
          // 句柄失效：回退到工作副本（多半是授权被撤，记下来让 UI 提示重新授权）
          const p = await queryPermOf(h);
          if (p) permCache = p;
        }
      }
      const work = await readWork();
      // 文件读得到，但浏览器里的工作副本更新（上次写盘失败/授权被收回）：
      // 这时候必须用工作副本，否则用户「重开 App」就会退回旧数据。
      // work.at === 0 是旧版本留下的裸数据（当时没记 savedAt），无法比时间：
      // 这种只能按条数判断——条数更多的几乎一定是"后来的那批"，取它才不会丢数据。
      const workNewer = work.data && (work.at > fileAt + NEWER_MS ||
        (work.at === 0 && countOf(work.data) > countOf(fileData)));
      if (workNewer) {
        stale = { fileCount: countOf(fileData), memCount: countOf(work.data) };
        if (work.at === 0) { try { await writeWork(work.data, Date.now()); } catch (e) {} } // 顺手补上时间戳
        return work.data;
      }
      stale = null;
      if (fileData) return fileData;
      // 无文件 / 文件为空 / 文件读不到 → 工作副本。
      // 顺序很重要：空文件绝不能盖掉工作副本，否则「新建 data.json 后刷新」会把数据清空。
      if (work.data) return work.data;
      // 已绑定但文件还没内容（刚新建的 data.json）→ 给一份空数据；
      // 完全没绑定 → null，由调用方（store.load）兜底，避免"看起来有文件其实没有"。
      return h ? defaultData() : null;
    }

    // 写盘成功后也把一份镜像放到浏览器里（延迟 300ms、不阻塞保存）。
    // 只靠「失败时才写」不行：万一以后文件读不到了，浏览器里留着的是很久以前那份旧副本，
    // 一开就会看到"渠道数变回几百条"。
    let mirrorTimer = null;
    function scheduleMirror(data, at) {
      if (mirrorTimer) clearTimeout(mirrorTimer);
      // 时间戳用"文件写入那一刻"，不是镜像真正执行的那一刻：
      // 否则镜像总比文件"新"，下次启动会把好好的文件判成"旧文件"。
      mirrorTimer = setTimeout(() => { mirrorTimer = null; writeWork(data, at); }, 300);
    }

    // 返回 { target: 'file' | 'idb' }：数据到底进了磁盘文件，还是只落在浏览器里。
    // 上层据此提示用户——否则授权过期时会「看起来保存成功、其实文件没更新」。
    async function write(dataObj) {
      const h = await ensureHandle();
      if (h) {
        try {
          const writable = await h.createWritable();
          await writable.write(serialize(dataObj));
          await writable.close();
          permCache = 'granted';
          pending = null;
          stale = null;
          lastWrite = { target: 'file', at: Date.now() };
          scheduleMirror(dataObj, lastWrite.at);
          return { ok: true, target: 'file' };
        } catch (e) {
          const p = await queryPermOf(h);
          if (p) permCache = p;
          lastWrite = { target: 'idb', at: Date.now(), error: (e && e.name) || 'WRITE_ERROR' };
        }
      } else {
        lastWrite = { target: 'idb', at: Date.now(), error: 'NO_HANDLE' };
      }
      // 未选择文件 / 写不进去：先写内存缓冲，并同步到浏览器本地存储，保证刷新不丢
      pending = dataObj;
      await writeWork(dataObj);
      return { ok: true, target: 'idb', permission: permCache, error: lastWrite.error };
    }

    // 用户手势触发：绑定已有 data.json（create=false）或新建（create=true）。
    // 只负责「拿到句柄 + 升权限 + 报出文件现状」，不擅自写盘：
    // 写什么由调用方决定（文件里条数更多时应该采用文件，而不是拿旧数据盖掉它）。
    async function chooseFile(create) {
      if (typeof window === 'undefined') throw new Error('no window');
      let h;
      if (create) {
        h = await window.showSaveFilePicker(SAVE_OPTS);
      } else {
        h = (await window.showOpenFilePicker(OPEN_OPTS))[0];
      }
      handle = h;
      // open picker 只给读权限：必须在这里（同一个用户手势里）升到读写
      permCache = await upgradePerm(h);
      if (App.db.persistHandle) { try { await App.db.persistHandle(h); } catch (e) {} }

      let fileData = null, fileAt = 0;
      try {
        const f = await h.getFile();
        fileAt = f.lastModified || 0;
        fileData = parseFileData(await f.text());
      } catch (e) { /* 文件读不到（空/刚新建）按无数据处理 */ }

      return {
        handle: h,
        perm: permCache,
        writable: permCache === 'granted',
        fileData: fileData,
        fileAt: fileAt,
        fileCount: countOf(fileData)
      };
    }

    // 重新授权（浏览器要求由用户手势触发）：拿回读写权限后把当前内容补写一次
    async function requestPerm() {
      const h = await ensureHandle();
      if (!h) return 'none';
      permCache = await upgradePerm(h);
      const data = pending;
      if (permCache === 'granted' && data) { try { await write(data); } catch (e) {} }
      return permCache;
    }

    async function changeFile(create) {
      return chooseFile(create !== false);
    }

    return {
      read, write, chooseFile, changeFile, refreshPerm, requestPerm,
      isFsSupported: true,
      kind: 'fs',
      get handlePath() { return handle ? (handle.name || DATA_NAME) : null; },
      get needsFile() { return !handle; },
      get perm() { return permCache; },
      get lastWrite() { return lastWrite; },
      get stale() { return stale; }
    };
  }

  /* =========================================================================
   * 本地服务直连（kind = 'http'）——最省事的一档
   * serve.js 在同一个端口上开了 /api/data：
   *   GET  → 返回 data.json 原文
   *   POST → 整份覆写 data.json（服务端先写 .tmp 再改名，原子替换）
   * 落到这里，网页只管把 JSON 丢过去，落盘由 Node 干：
   * 不用选文件、不用每次开机重新授权、刷新后读回来的就是文件里那份。
   * ========================================================================= */
  const HTTP_READ_TIMEOUT = 8000;
  const HTTP_WRITE_TIMEOUT = 20000;
  const HTTP_PROBE_TIMEOUT = 1500;

  function trimBase(base) { return String(base || '').replace(/\/+$/, ''); }

  function abortSignal(ms) {
    if (typeof AbortController === 'undefined') return undefined;
    const c = new AbortController();
    const t = setTimeout(() => { try { c.abort(); } catch (e) {} }, ms);
    // Node 下（跑测试/脚本）别让这个超时定时器把进程钉住；浏览器里返回的是数字，没有 unref
    if (t && typeof t.unref === 'function') t.unref();
    return c.signal;
  }

  // 页面是否由本地服务提供（file:// 打开时谈不上 /api/*）
  function httpAvailable() {
    if (typeof location === 'undefined' || !location) return false;
    return /^https?:$/.test(location.protocol || '') && typeof fetch === 'function';
  }

  // 探活：能拿到 { ok:true } 就说明这台服务带数据接口。
  // 探不到（旧版 serve.js / 别的静态服务器 / 端口被占）返回 null，由调用方降级。
  // 部署时若服务端设了 DATA_TOKEN，浏览器必须把 token 带在 Authorization 头里。
  // 优先从地址栏 ?token= 取（分享链接一次带过去），并存进 localStorage 以后免带。
  const TOKEN_KEY = 'logiDataToken';
  function getApiToken() {
    try {
      const params = new URLSearchParams((typeof location !== 'undefined' && location && location.search) || '');
      const fromUrl = params.get('token');
      if (fromUrl) { try { localStorage.setItem(TOKEN_KEY, fromUrl); } catch (e) {} return fromUrl; }
      const stored = localStorage.getItem(TOKEN_KEY);
      return stored || '';
    } catch (e) { return ''; }
  }
  function authHeader(token) {
    const t = (token != null) ? token : getApiToken();
    return t ? { 'Authorization': 'Bearer ' + t } : {};
  }

  async function probeHttp(base, ms, token) {
    const b = trimBase(base);
    if (typeof fetch !== 'function') return null;
    if (!b && !httpAvailable()) return null;   // 相对路径只在 http(s) 页面里才有意义
    try {
      const r = await fetch(b + '/api/health', {
        cache: 'no-store',
        signal: abortSignal(ms || HTTP_PROBE_TIMEOUT),
        headers: authHeader(token)
      });
      if (r && r.status === 401) return { needsToken: true }; // 接口在，但需要令牌
      if (!r || !r.ok) return null;
      const j = await r.json();
      if (!j || j.ok !== true) return null;
      return j;
    } catch (e) {
      return null;
    }
  }

  async function createHttpPersistence(opts) {
    const base = trimBase(opts && opts.base);
    const url = base + '/api/data';
    const token = (opts && opts.token) || getApiToken();
    let lastWrite = null;
    let filePath = (opts && opts.file) || null;
    let mtime = (opts && opts.mtime) || 0;

    function takeMeta(res) {
      const f = res.headers && res.headers.get ? res.headers.get('X-Data-File') : null;
      if (f) { try { filePath = decodeURIComponent(f); } catch (e) { filePath = f; } }
      const m = res.headers && res.headers.get ? res.headers.get('X-Data-Mtime') : null;
      if (m) mtime = Number(m) || 0;
    }

    async function read() {
      const r = await fetch(url, { cache: 'no-store', signal: abortSignal(HTTP_READ_TIMEOUT), headers: authHeader(token) });
      if (!r || !r.ok) throw new Error('HTTP_READ_' + (r ? r.status : 'FAILED'));
      takeMeta(r);
      const text = await r.text();
      const d = parseData(text);
      return (d && typeof d === 'object') ? d : defaultData();
    }

    // 写失败不抛错（store.save 的调用方默认写盘不会炸），只把结果标成 'idb'：
    // 数据还在内存里，顶栏会亮黄灯，点「写回 data.json」重试即可。
    async function write(dataObj) {
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader(token)),
          body: serialize(dataObj),
          signal: abortSignal(HTTP_WRITE_TIMEOUT)
        });
        if (!r || !r.ok) throw new Error('HTTP_WRITE_' + (r ? r.status : 'FAILED'));
        let j = null;
        try { j = await r.json(); } catch (e) { j = null; }
        if (j && j.mtime) mtime = j.mtime;
        lastWrite = { target: 'http', at: Date.now() };
        return { ok: true, target: 'http' };
      } catch (e) {
        const err = (e && e.name === 'AbortError') ? 'TIMEOUT' : ((e && e.message) || 'WRITE_ERROR');
        lastWrite = { target: 'idb', at: Date.now(), error: err };
        return { ok: false, target: 'idb', error: err };
      }
    }

    return {
      kind: 'http',
      isHttp: true,
      read, write,
      isFsSupported: false,
      // 统一接口：http 模式下没有"绑定文件"和"授权"这两件事
      needsFile: false,
      perm: 'granted',
      requestPerm: async () => 'granted',
      refreshPerm: async () => 'granted',
      get handlePath() { return DATA_NAME; },
      get filePath() { return filePath; },
      get mtime() { return mtime; },
      get lastWrite() { return lastWrite; },
      get stale() { return null; }
    };
  }

  /* =========================================================================
   * 纯静态托管只读档（kind = 'static'）——放到没有 Node 后端的静态主机时
   * 浏览器永远无法直接写服务器文件（安全限制），但能 GET 到 /data.json 把它读出来。
   * 这一档让页面「至少能看、能测算」，并在顶栏明确提示「只读」，避免误以为改动能保存。
   * 要真正写回，请在该服务器上跑本项目的 serve.js（提供 /api/data 写入接口）。
   * ========================================================================= */
  async function probeStatic(base) {
    const b = trimBase(base);
    if (!b && !httpAvailable()) return null;
    if (typeof fetch !== 'function') return null;
    try {
      const r = await fetch(b + '/data.json', { cache: 'no-store', signal: abortSignal(HTTP_READ_TIMEOUT) });
      if (!r || !r.ok) return null;
      const text = await r.text();
      const d = parseData(text);
      if (!d || typeof d !== 'object') return null;
      return { file: b + '/data.json', mtime: 0, channels: countOf(d) };
    } catch (e) {
      return null;
    }
  }

  function createStaticPersistence(opts) {
    const base = trimBase(opts && opts.base);
    // probeStatic 返回的 file 已是完整 URL（如 http://host/data.json）；
    // 直接拿它去 fetch，避免 boot 只传 file、base 为空时拼出 /data.json 这种非法地址
    const filePath = (opts && opts.file) || (base + '/data.json');
    const url = filePath;
    let lastWrite = null;

    async function read() {
      const r = await fetch(url, { cache: 'no-store', signal: abortSignal(HTTP_READ_TIMEOUT) });
      if (!r || !r.ok) throw new Error('STATIC_READ_' + (r ? r.status : 'FAILED'));
      const text = await r.text();
      const d = parseData(text);
      return (d && typeof d === 'object') ? d : defaultData();
    }

    // 浏览器写不进服务器文件：明确返回只读失败，让 UI 亮黄灯并提示，绝不谎报已保存
    async function write() {
      lastWrite = { target: 'idb', at: Date.now(), error: 'READONLY' };
      return { ok: false, target: 'idb', error: 'READONLY', readonly: true };
    }

    return {
      kind: 'static',
      isStatic: true,
      readonly: true,
      read, write,
      isFsSupported: false,
      needsFile: false,
      perm: 'granted',
      requestPerm: async () => 'granted',
      refreshPerm: async () => 'granted',
      get handlePath() { return DATA_NAME; },
      get filePath() { return filePath; },
      get mtime() { return 0; },
      get lastWrite() { return lastWrite; },
      get stale() { return null; }
    };
  }

  // 数据文件状态描述（纯函数，供侧栏/顶栏/设置页共用同一套文案与判断）
  function dataFileVm(p) {
    p = p || {};
    const degrade = p.kind === 'degrade';
    const isHttp = p.kind === 'http';
    const isStatic = p.kind === 'static';
    const needsBind = !degrade && !isHttp && !isStatic && p.kind === 'fs' && !!p.needsFile;
    const perm = isHttp ? 'granted' : (p.perm || 'none');
    const needsPerm = !degrade && !isHttp && !needsBind && perm !== 'granted';
    const last = p.lastWrite || null;
    const stale = (!degrade && !isHttp && !needsBind) ? (p.stale || null) : null;
    // 有句柄、也"授权了"，但写盘仍然失败（read-only 句柄、文件被别的程序占用…）：
    // 这种情况最坑——不说出来用户会以为数据已经存进 data.json 了。
    const writeFailed = !degrade && !needsBind && !!last && last.target === 'idb';
    const name = p.handlePath || DATA_NAME;
    // 双击 index.html 打开时是 file:// 页面，浏览器不允许调用文件选择器，
    // 必须先起本地服务（服务脚本已随项目提供），否则永远绑不上 data.json
    const proto = (typeof location !== 'undefined' && location && location.protocol) || '';
    const fileProto = proto === 'file:';
    let status, hint;
    if (degrade) {
      status = '浏览器本地存储（此浏览器不支持绑定文件）';
      hint = '当前浏览器不支持直接读写磁盘文件，数据存在浏览器里。建议用 Chrome / Edge 打开，或在设置里「导出备份」手动存到 工作空间\\1.02。';
    } else if (isHttp && writeFailed) {
      status = '未写入 data.json（服务没接住这次保存）';
      hint = '刚才那次保存没能传给本地服务' + (last && last.error ? '（' + last.error + '）' : '') +
        '。数据还在页面里，点「写回 data.json」重试一次；如果一直失败，看下运行「启动服务.bat」的窗口是否还开着。';
    } else if (isHttp) {
      status = '已直连 data.json（自动保存）';
      hint = '页面通过本地服务直接读写项目目录里的 data.json：每次增删改立刻整份写回，不用选文件、不用授权，刷新读到的就是文件里那份。要备份用「导出备份」。';
    } else if (isStatic) {
      status = '只读模式（服务器未提供写入接口）';
      hint = '页面直接读取了服务器上的 data.json，可以浏览和测算，但浏览器无法写回服务器文件（这是浏览器的安全限制，任何纯静态托管都一样）。如需保存修改，请在服务器上运行本项目的 serve.js（它提供 /api/data 写入接口）；或在本机用「启动服务.bat」打开后编辑，再把 data.json 上传覆盖。';
    } else if (needsBind && fileProto) {
      status = '未绑定数据文件（当前是 file:// 方式打开）';
      hint = '双击 index.html 打开时浏览器不允许绑定磁盘文件。请先双击项目里的「启动服务.bat」（或在目录下执行 node serve.js），用 http://localhost:5173 打开，再点下面的按钮把 data.json 选到 工作空间\\1.02 即可。';
    } else if (needsBind) {
      status = '未绑定数据文件（数据只在浏览器里）';
      hint = '把数据文件固定为项目目录「工作空间\\1.02」下的 data.json：点下面的按钮选中它一次即可（文件已随项目预置），浏览器会按选择器 id 记住这个目录，以后打开就直接读写它。';
    } else if (needsPerm) {
      status = '需要重新授权 data.json';
      hint = '浏览器重启后文件授权会被收回，写入会被拦下（数据只会先存在浏览器里）。点「重新授权」并允许读写即可继续写回 工作空间\\1.02\\data.json。';
    } else if (writeFailed) {
      status = '未写入 data.json（数据只在浏览器里）';
      hint = '刚才那次保存没能写进 data.json' + (last && last.error ? '（' + last.error + '）' : '') +
        '。数据已暂存在浏览器里，不会丢，但换浏览器 / 清缓存就没了。点「重新授权」允许读写后会自动补写。';
    } else if (stale) {
      status = '浏览器里的数据比 data.json 新';
      hint = '浏览器里有 ' + stale.memCount + ' 条渠道，data.json 里只有 ' + stale.fileCount +
        ' 条，已按较新的那份显示。安全起见请点「写回 data.json」把浏览器里的数据落回文件。';
    } else {
      status = '已连接 data.json';
      hint = '每次增删改都会整份写回 工作空间\\1.02\\data.json。要换机器或备份，用「导出备份」另存一份。';
    }
    return {
      status, hint, name, perm, needsBind, needsPerm, writeFailed,
      stale: !!stale, staleCounts: stale, isDegrade: degrade, isHttp: isHttp, isStatic: isStatic,
      filePath: p.filePath || null, fileProtocol: fileProto
    };
  }

  const api = {
    defaultData, isFsSupported, parseData, serialize,
    createFsPersistence, createHttpPersistence, probeHttp, probeStatic,
    createStaticPersistence, getApiToken, httpAvailable,
    dataFileVm, JSON_TYPE, DATA_NAME, PICKER_ID
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.fsio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
