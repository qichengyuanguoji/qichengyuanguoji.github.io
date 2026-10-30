/* 端到端：页面跑在本地服务上时，数据真的直接进 data.json
 *
 * test_http_data.js 测的是接口本身（GET/POST 行为）。
 * 这里把整个 App 在桩 DOM 里 boot 起来，让 fetch 指向一台真的 serve.js，
 * 验证用户实际感受到的三件事：
 *   1) boot 选中的是 http 直连（而不是"未绑定 data.json"，不需要用户选文件）
 *   2) 打开页面读到的就是 data.json 里的渠道
 *   3) 改一下设置，data.json 立刻被重写（不用点保存、不用授权）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const serve = require('../serve.js');

const ROOT = path.resolve(__dirname, '..');

/* ---------- 极简 DOM 桩（与 test_boot.js 同一套，够 boot + 首页渲染用） ---------- */
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.attrs = {};
    this._text = '';
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.value = '';
    this.id = '';
    this.classList = { add() {}, remove() {}, contains() { return false; }, toggle() {} };
  }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; if (k === 'value') this.value = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { if (c) this.children.push(c); return c; }
  append() { for (const c of arguments) this.appendChild(c); }
  insertBefore(node, ref) { if (!node) return node; const i = ref ? this.children.indexOf(ref) : -1; if (i >= 0) this.children.splice(i, 0, node); else this.children.push(node); return node; }
  get firstChild() { return this.children[0] || null; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() {}
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  dispatch(t) { (this.listeners[t] || []).forEach(f => f({ target: this, preventDefault() {} })); }
  click() { this.dispatch('click'); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  set innerHTML(v) { if (v === '') { this.children = []; this._text = ''; } else this._text = String(v); }
  get innerHTML() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent || '').join(''); }
}

function installDom() {
  const ids = {};
  const all = [];
  ['content', 'conn-dot', 'conn-text', 'data-path', 'nav', 'toast'].forEach(id => {
    const n = new El('div'); n.id = id; ids[id] = n;
  });
  global.document = {
    readyState: 'complete',
    body: new El('body'),
    createElement: t => { const n = new El(t); all.push(n); return n; },
    createTextNode: t => { const n = new El('#text'); n.textContent = t; return n; },
    getElementById: id => ids[id] || all.filter(n => n.id === id).pop() || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  // 安全上下文：File System Access API 也在（用来证明 http 直连优先于"选文件"）
  const fakeHandle = {
    getFile: async () => ({ text: async () => '' }),
    createWritable: async () => ({ write: async () => {}, close: async () => {} })
  };
  global.window = { showSaveFilePicker: async () => fakeHandle, showOpenFilePicker: async () => [fakeHandle] };
  global.location = { protocol: 'http:' };
  return ids;
}

function loadScripts() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /<script src="([^"]+)"><\/script>/g;
  const srcs = [];
  let m;
  while ((m = re.exec(html))) srcs.push(m[1]);
  srcs.forEach(src => {
    const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
    vm.runInThisContext(code, { filename: src });
  });
}

async function waitFor(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 3000)) { if (fn()) return true; await new Promise(r => setTimeout(r, 5)); }
  return false;
}

const SEED = {
  version: 1,
  settings: { profitRate: 30, volRatio: 5000 },
  channels: [
    { id: 'c1', name: '海运直航', carrier: '088', type: '海运', dests: '美国' },
    { id: 'c2', name: '空运快线', carrier: '631', type: '空运', dests: '美国' }
  ],
  records: []
};

test('页面在本地服务上启动：走 http 直连，读的是 data.json，改了就落盘', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logi-boot-'));
  const dataFile = path.join(dir, 'data.json');
  fs.writeFileSync(dataFile, JSON.stringify(SEED), 'utf8');

  const server = serve.createServer(dir);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const realFetch = global.fetch;
  // 页面的请求都是相对路径（/api/...）：接到这台真服务上
  global.fetch = (url, opts) => realFetch(String(url).startsWith('http') ? url : base + url, opts || {});

  try {
    installDom();
    loadScripts();
    const ok = await waitFor(() => global.App && global.App.store && global.App.store.instance);
    assert.ok(ok, 'boot 应完成 store 初始化');

    const p = global.App.app.persistence;
    assert.strictEqual(p.kind, 'http', '有 /api/data 时应优先直连，而不是让用户选文件');
    assert.strictEqual(p.needsFile, false, '直连模式不需要选文件');

    const st = global.App.store.instance.getState();
    assert.strictEqual(st.channels.length, 2, '打开页面读到的应是 data.json 里的渠道');
    assert.strictEqual(st.channels[0].name, '海运直航');

    // 顶栏文案：已连接，且不再是"未绑定 · 点此绑定"
    const conn = global.document.getElementById('conn-text');
    assert.match(conn.textContent, /已直连|已连接/, '顶栏应显示已连接，实际：' + conn.textContent);
    const dp = global.document.getElementById('data-path');
    assert.match(dp.textContent, /自动保存/, '顶栏应说明自动保存，实际：' + dp.textContent);
    assert.strictEqual(dp.onclick, null, '直连模式顶栏不应再挂"绑定文件"的点击');

    // 改一下设置 → 不点任何按钮，文件自己更新
    await global.App.store.instance.updateSettings({ profitRate: 41 });
    await waitFor(() => JSON.parse(fs.readFileSync(dataFile, 'utf8')).settings.profitRate === 41, 2000);
    const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.strictEqual(onDisk.settings.profitRate, 41, '设置应自动写进 data.json');
    assert.strictEqual(onDisk.channels.length, 2, '写回不能丢渠道');

    // 设置页：直连模式下不该再出现"绑定/重新授权"的按钮
    await global.App.router.show('settings');
    const txt = global.document.getElementById('content').textContent;
    assert.match(txt, /已直连/);
    assert.ok(!/绑定工作空间里的 data\.json/.test(txt), '直连模式不应再引导用户绑定文件');
    assert.ok(!/重新授权/.test(txt), '直连模式不应再出现重新授权');
    assert.match(txt, /导出备份/);
  } finally {
    global.fetch = realFetch;
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  }
});
