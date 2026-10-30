/* 启动健壮性测试：复现用户的“页面打不开/白屏”场景。
 * 场景：安全上下文（预览面板 / localhost）下 window 暴露了 File System Access API，
 * 但首次打开没有已保存的文件句柄。旧代码会在 boot 阶段自动弹窗 → 无用户手势 → 抛错 → 整页白屏。
 * 修复后：boot 不自动弹窗，先用默认数据启动；未选 data.json 时数据自动落在浏览器本地存储，
 * 不再显示强制性的“选择数据文件”横幅（可在「数据与设置 → 更换数据文件」里随时绑定真实文件）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

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

function installSecureDom() {
  const ids = {};
  const all = [];
  ['content', 'conn-dot', 'conn-text', 'data-path', 'nav', 'toast'].forEach(id => {
    const n = new El('div'); n.id = id; ids[id] = n;
  });
  const body = new El('body');
  const doc = {
    readyState: 'complete',
    body,
    createElement: t => { const n = new El(t); all.push(n); return n; },
    createTextNode: t => { const n = new El('#text'); n.textContent = t; return n; },
    getElementById: id => ids[id] || all.filter(n => n.id === id).pop() || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {}
  };
  // 关键：安全上下文 —— window 暴露了 File System Access API（预览面板/localhost 的情形）
  const fakeHandle = {
    getFile: async () => ({ text: async () => '' }),
    createWritable: async () => ({ write: async () => {}, close: async () => {} })
  };
  global.window = { showSaveFilePicker: async () => fakeHandle, showOpenFilePicker: async () => [fakeHandle] };
  // indexedDB 保持未定义，模拟无法用 IndexedDB 兜底保存句柄
  global.document = doc;
  return { doc, ids };
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
  const limit = ms || 2000;
  while (Date.now() - t0 < limit) { if (fn()) return true; await new Promise(r => setTimeout(r, 5)); }
  return false;
}

const dom = installSecureDom();
loadScripts();

test('安全上下文(无已存文件)下 boot 不再崩溃：App 正常启动并进入首页', async () => {
  const ok = await waitFor(() => global.App.store && global.App.store.instance);
  assert.ok(ok, 'boot 应完成 store 初始化（旧代码此处会白屏）');
  const st = global.App.store.instance.getState();
  assert.ok(Array.isArray(st.channels), 'state.channels 应为数组');
  assert.strictEqual(st.channels.length, 0, '首次启动应为空价格库（默认数据）');
  assert.ok(dom.ids.content.textContent.length > 0, '首页应有内容（未白屏）');
});

test('安全上下文(无已存文件)下：不再显示强制横幅，数据用本地存储兜底', async () => {
  await waitFor(() => global.App.store && global.App.store.instance);
  const b = global.document.getElementById('file-banner');
  assert.ok(!b, '不应再显示“选择数据文件”强制横幅');
  const conn = global.document.getElementById('conn-text');
  // 文案由「本地存储（可绑定 data.json）」改成直接指名要绑的文件（v2.16）：
  // 横幅去掉了，状态就必须说清「还没绑定 data.json」，否则用户不知道数据只在浏览器里
  assert.ok(conn && /未绑定|本地存储/.test(conn.textContent), '连接状态应提示未绑定 data.json，实际：' + (conn && conn.textContent));
  const path = global.document.getElementById('data-path');
  assert.ok(path && /data\.json/.test(path.textContent), '顶栏应显示可点击的 data.json 绑定入口，实际：' + (path && path.textContent));
  assert.ok(global.App.store.instance, 'App 应可用');
  assert.ok(dom.ids.content.textContent.length > 0, '首页应有内容（非白屏）');
});
