/* 数据文件（data.json）落位：把库文件固定到项目目录（工作空间\1.02）
 *
 * 浏览器安全限制：网页不能直接往任意路径写文件，只能由用户点一次保存/打开对话框；
 * 但选择器支持 `id` 参数（同一 id 会记住上次选的目录），所以「选一次工作空间目录，
 * 以后就一直读写那里的 data.json」是可行的。本测试锁定这几件事：
 *   1) 选择器始终带固定 id + suggestedName=data.json（记住目录、文件名不会变）
 *   2) 绑定已有文件走 open picker（预置的 data.json 可直接选中），新建走 save picker
 *   3) write() 必须如实报告数据到底写进了文件还是只落在浏览器里（否则用户以为存了）
 *   4) 文件句柄的读写权限状态可查询，供 UI 提示「需要重新授权」
 *   5) 「数据与设置」页的状态文案按这几种情况正确切换
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// --- 选择器 / 句柄桩 ---
let saveArgs = null;
let openArgs = null;
let handleToReturn = null;
let permResult = 'granted';
let written = '';
let writeFails = false;

const fakeHandle = {
  name: 'data.json',
  queryPermission: async () => permResult,
  requestPermission: async () => permResult,
  getFile: async () => ({ text: async () => JSON.stringify({ version: 1, settings: {}, channels: [], records: [] }) }),
  createWritable: async () => {
    if (writeFails) throw new Error('not allowed');
    return { write: async (t) => { written = t; }, close: async () => {} };
  }
};

global.window = {
  showSaveFilePicker: async (opts) => { saveArgs = opts; return fakeHandle; },
  showOpenFilePicker: async (opts) => { openArgs = opts; return [fakeHandle]; }
};
global.App = {
  db: {
    getHandle: async () => handleToReturn,
    persistHandle: async () => {},
    getIdbJson: async () => null,
    putIdbJson: async () => {}
  }
};

const fsio = require(ROOT + '/js/fsio.js');
require(ROOT + '/js/util.js');
const settings = require(ROOT + '/js/pages/settings.js');

// createFsPersistence 是 async 的（要等它取一次句柄）
function fresh() {
  return fsio.createFsPersistence();
}

test('数据文件名与选择器 id 固定（id 是「记住工作空间目录」的关键）', () => {
  assert.strictEqual(fsio.DATA_NAME, 'data.json');
  assert.ok(fsio.PICKER_ID && typeof fsio.PICKER_ID === 'string', 'PICKER_ID 必须存在');
});

test('新建 data.json：save picker 带固定 id 与 suggestedName', async () => {
  handleToReturn = null;
  const p = await fresh();
  await p.chooseFile(true);
  assert.ok(saveArgs, '应调用 showSaveFilePicker');
  assert.strictEqual(saveArgs.id, fsio.PICKER_ID, '必须传 id，否则每次都回到默认目录');
  assert.strictEqual(saveArgs.suggestedName, 'data.json');
  assert.ok(Array.isArray(saveArgs.types) && saveArgs.types.length, '应限定为 JSON 类型');
});

test('绑定工作空间里已有的 data.json：走 open picker，同样带 id', async () => {
  handleToReturn = null;
  openArgs = null;
  const p = await fresh();
  await p.chooseFile(false);
  assert.ok(openArgs, '应调用 showOpenFilePicker');
  assert.strictEqual(openArgs.id, fsio.PICKER_ID);
  assert.strictEqual(p.needsFile, false, '绑定后不再需要选文件');
});

test('write 绑定文件时返回 target=file（数据真的进了文件）', async () => {
  handleToReturn = fakeHandle;
  permResult = 'granted';
  const p = await fresh();
  await p.read();                       // 触发 ensureHandle
  const r = await p.write({ version: 1, settings: {}, channels: [{ id: 'a' }], records: [] });
  assert.strictEqual(r.target, 'file');
  assert.ok(written.indexOf('"channels"') >= 0, '应真的写入文件内容');
});

test('write 未绑定/写失败时返回 target=idb（不能谎报已存文件）', async () => {
  handleToReturn = null;
  const p = await fresh();
  const r = await p.write({ version: 1, settings: {}, channels: [], records: [] });
  assert.strictEqual(r.target, 'idb');

  // 句柄在但写不进去（授权过期）：同样要如实报告
  handleToReturn = fakeHandle;
  permResult = 'prompt';
  writeFails = true;
  const p2 = await fresh();
  await p2.read();
  const r2 = await p2.write({ version: 1, settings: {}, channels: [], records: [] });
  assert.strictEqual(r2.target, 'idb');
  assert.strictEqual(r2.permission, 'prompt', '应带出权限状态，供 UI 提示重新授权');
  writeFails = false;
  permResult = 'granted';
});

test('权限状态可查：无句柄 none / 需授权 prompt / 已授权 granted', async () => {
  handleToReturn = null;
  const p = await fresh();
  assert.strictEqual(p.perm, 'none');
  assert.strictEqual(await p.refreshPerm(), 'none');

  handleToReturn = fakeHandle;
  permResult = 'prompt';
  const p2 = await fresh();
  await p2.read();
  assert.strictEqual(await p2.refreshPerm(), 'prompt');
  assert.strictEqual(p2.perm, 'prompt');

  permResult = 'granted';
  assert.strictEqual(await p2.refreshPerm(), 'granted');
  assert.strictEqual(p2.perm, 'granted');
});

test('数据文件卡片文案：未绑定 / 需授权 / 已连接 三种状态各不相同', () => {
  const unbound = settings.dataFileVm({ kind: 'fs', needsFile: true, perm: 'none', handlePath: null });
  assert.match(unbound.status, /未绑定|浏览器/);
  assert.strictEqual(unbound.needsBind, true);
  assert.match(unbound.hint, /工作空间/, '要告诉用户把 data.json 放在工作空间目录');
  assert.match(unbound.hint, /data\.json/);

  const needPerm = settings.dataFileVm({ kind: 'fs', needsFile: false, perm: 'prompt', handlePath: 'data.json' });
  assert.match(needPerm.status, /授权/);
  assert.strictEqual(needPerm.needsPerm, true);

  const ok = settings.dataFileVm({ kind: 'fs', needsFile: false, perm: 'granted', handlePath: 'data.json' });
  assert.strictEqual(ok.status.indexOf('授权'), -1);
  assert.strictEqual(ok.needsBind, false);
  assert.strictEqual(ok.needsPerm, false);

  const degrade = settings.dataFileVm({ kind: 'degrade' });
  assert.match(degrade.status, /浏览器/);
  assert.strictEqual(degrade.isDegrade, true);
});

test('双击 index.html（file://）打开时，提示改用本地服务才能绑定 data.json', () => {
  // file:// 页面浏览器不放行文件选择器，只提示「点按钮选文件」会让用户点了没反应
  global.location = { protocol: 'file:' };
  const vm = settings.dataFileVm({ kind: 'fs', needsFile: true, perm: 'none', handlePath: null });
  assert.strictEqual(vm.fileProtocol, true);
  assert.match(vm.status, /file:\/\//);
  assert.match(vm.hint, /启动服务|localhost/, '必须告诉用户怎么绕开 file:// 限制');
  assert.strictEqual(vm.needsBind, true);

  // http 下不应出现这条提示
  global.location = { protocol: 'http:' };
  const vm2 = settings.dataFileVm({ kind: 'fs', needsFile: true, perm: 'none', handlePath: null });
  assert.strictEqual(vm2.fileProtocol, false);
  assert.strictEqual(/启动服务|localhost/.test(vm2.hint), false);
  delete global.location;
});

/* =======================================================================
 * 回归：为什么「重开 App，渠道数又变回 255 条」
 *
 * 绑定已有文件走的是 showOpenFilePicker —— 它只授予**读**权限，
 * 写要另外 requestPermission({mode:'readwrite'})。以前绑定后直接 createWritable，
 * 于是每一次保存都抛 NotAllowedError，被 write() 静默吞掉退到 IndexedDB；
 * 而 read() 又优先读文件 → 每次重开都读回文件里那份旧数据（255 条）。
 * 下面把这套时序钉死。
 * ======================================================================= */

function idbWorld() {
  const map = new Map();
  return {
    map,
    getHandle: async () => (map.get('handle') || null),
    persistHandle: async (h) => { map.set('handle', h); },
    getIdbJson: async (k) => (map.has(k) ? map.get(k) : null),
    putIdbJson: async (k, v) => { map.set(k, v); }
  };
}

// writable=false 模拟 open picker 拿到的只读句柄
function readonlyHandle(text, lastModified) {
  let t = text;
  return {
    name: 'data.json',
    queryPermission: async () => 'prompt',
    requestPermission: async () => 'denied',
    getFile: async () => ({ lastModified, text: async () => t }),
    createWritable: async () => { const e = new Error('not allowed'); e.name = 'NotAllowedError'; throw e; }
  };
}
function writableHandle(text, lastModified) {
  let t = text;
  const h = {
    name: 'data.json',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFile: async () => ({ lastModified, text: async () => t }),
    createWritable: async () => ({ write: async (x) => { t = x; h.lastModified = Date.now(); }, close: async () => {} }),
    lastModified
  };
  return h;
}
function dataOf(n, prefix) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ id: 'c' + i, name: (prefix || 'ch') + i });
  return { version: 1, settings: {}, channels: out, records: [] };
}

test('只读句柄绑定后：写盘失败要如实报 idb，而且数据只落在浏览器里时不能丢', async () => {
  const db = idbWorld();
  global.App.db = db;
  global.location = { protocol: 'http:' };

  const fileText = JSON.stringify(dataOf(255, 'old'));
  const handle = readonlyHandle(fileText, Date.now() - 3600 * 1000);
  global.window = { showOpenFilePicker: async () => [handle], showSaveFilePicker: async () => handle };

  const p = await fresh();
  const info = await p.chooseFile(false);
  assert.strictEqual(info.writable, false, 'open picker 的句柄应被判为只读（需要另外授权读写）');
  assert.strictEqual(info.fileCount, 255, '要把文件里现有条数报给调用方，避免拿旧数据盖掉它');

  const r = await p.write(dataOf(1200, 'new'));
  assert.strictEqual(r.target, 'idb', '只读句柄写文件必然失败，不能谎报写入成功');
  assert.ok(r.error, '应带上失败原因，供顶栏/提示显示');
});

test('回归：写盘失败后重开 App，读到的是浏览器里的新数据，而不是文件里的旧数据', async () => {
  const db = idbWorld();
  global.App.db = db;
  global.location = { protocol: 'http:' };

  const fileText = JSON.stringify(dataOf(255, 'old'));
  const handle = readonlyHandle(fileText, Date.now() - 3600 * 1000);
  global.window = { showOpenFilePicker: async () => [handle], showSaveFilePicker: async () => handle };

  // 第一次会话：绑定 → 导入 1200 条（写盘失败，落在浏览器里）
  const p1 = await fresh();
  await p1.chooseFile(false);
  await p1.write(dataOf(1200, 'new'));

  // 第二次会话（重开浏览器）：同一个 IndexedDB、同一个句柄
  const p2 = await fresh();
  const got = await p2.read();
  assert.strictEqual(got.channels.length, 1200,
    '重开后应读到 1200 条（浏览器里的较新数据），实际 ' + got.channels.length + ' 条');
  assert.ok(p2.stale, '应标记「浏览器数据比文件新」，供 UI 提示写回');
  assert.strictEqual(p2.stale.fileCount, 255);
  assert.strictEqual(p2.stale.memCount, 1200);
});

test('写盘正常时，重开读文件（文件更新就不该被旧工作副本顶掉）', async () => {
  const db = idbWorld();
  global.App.db = db;
  global.location = { protocol: 'http:' };

  const handle = writableHandle(JSON.stringify(dataOf(0)), Date.now() - 7200 * 1000);
  global.window = { showSaveFilePicker: async () => handle, showOpenFilePicker: async () => [handle] };

  const p1 = await fresh();
  await p1.chooseFile(true);
  const r = await p1.write(dataOf(3000, 'f'));
  assert.strictEqual(r.target, 'file');

  const p2 = await fresh();
  const got = await p2.read();
  assert.strictEqual(got.channels.length, 3000);
  assert.strictEqual(p2.stale, null, '文件已是最新，不该提示"浏览器较新"');
});

test('刚新建的空 data.json 不能把浏览器里的工作副本清空', async () => {
  const db = idbWorld();
  global.App.db = db;
  global.location = { protocol: 'http:' };

  const handle = writableHandle('', Date.now());   // 空文件、修改时间是现在
  global.window = { showSaveFilePicker: async () => handle, showOpenFilePicker: async () => [handle] };

  // 浏览器里已有一份较新的数据（上一轮写盘失败留下的）
  await db.putIdbJson('fsWorkingCopy', { savedAt: new Date(Date.now() - 60 * 1000).toISOString(), data: dataOf(800, 'w') });

  const p = await fresh();
  const got = await p.read();
  assert.strictEqual(got.channels.length, 800, '空文件不应被当成"数据被清空"，实际 ' + got.channels.length + ' 条');
});

test('数据文件卡片：写盘失败 / 浏览器较新 两种状态都要说人话', () => {
  const failed = settings.dataFileVm({
    kind: 'fs', needsFile: false, perm: 'granted', handlePath: 'data.json',
    lastWrite: { target: 'idb', at: Date.now(), error: 'NotAllowedError' }
  });
  assert.strictEqual(failed.writeFailed, true);
  assert.match(failed.status, /未写入|没写进/);
  assert.match(failed.hint, /浏览器/, '要说明数据暂时在浏览器里');
  assert.match(failed.hint, /授权/, '要告诉用户怎么补救');

  const stale = settings.dataFileVm({
    kind: 'fs', needsFile: false, perm: 'granted', handlePath: 'data.json',
    lastWrite: { target: 'file', at: Date.now() },
    stale: { fileCount: 255, memCount: 1200 }
  });
  assert.strictEqual(stale.stale, true);
  assert.match(stale.status, /新/);
  assert.match(stale.hint, /1200/);
  assert.match(stale.hint, /255/);

  const ok = settings.dataFileVm({
    kind: 'fs', needsFile: false, perm: 'granted', handlePath: 'data.json',
    lastWrite: { target: 'file', at: Date.now() }, stale: null
  });
  assert.strictEqual(ok.writeFailed, false);
  assert.strictEqual(ok.stale, false);
  assert.strictEqual(ok.status, '已连接 data.json');
});

test('老版本留下的工作副本（没有 savedAt）：条数更多时也要救回来，并补上时间戳', async () => {
  const db = idbWorld();
  global.App.db = db;
  global.location = { protocol: 'http:' };

  const handle = readonlyHandle(JSON.stringify(dataOf(255, 'old')), Date.now() - 3600 * 1000);
  global.window = { showOpenFilePicker: async () => [handle], showSaveFilePicker: async () => handle };

  // 旧版本 write() 失败时直接 putIdbJson(WORK_KEY, data)，没有 { savedAt, data } 外壳
  await db.putIdbJson('fsWorkingCopy', dataOf(1200, 'legacy'));

  const p = await fresh();
  const got = await p.read();
  assert.strictEqual(got.channels.length, 1200, '旧的裸工作副本不能因为没时间戳就被文件盖掉');
  assert.ok(p.stale, '应提示浏览器数据比文件新');

  const raw = db.map.get('fsWorkingCopy');
  assert.ok(raw && raw.savedAt && raw.data, '读到旧格式后应顺手升级成带 savedAt 的结构');
  assert.strictEqual(raw.data.channels.length, 1200);
});
