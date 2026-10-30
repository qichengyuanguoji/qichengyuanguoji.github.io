/* 复现：点击「渠道价格库」页的「+ 新增渠道」按钮，验证 modal 能正常打开且不抛错。 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '..');

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = []; this.attrs = {}; this._text = '';
    this.className = ''; this.style = {}; this.dataset = {};
    this.listeners = {}; this.value = ''; this.id = '';
    this.placeholder = '';
    this.classList = { add(){}, remove(){}, contains(){return false;}, toggle(){} };
  }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') this.id = v; if (k === 'value') this.value = v; if (k === 'placeholder') this.placeholder = v; if (k === 'class') this.className = v; if (k && k.indexOf('data-') === 0) this.dataset[k.slice(5)] = v; }
  getAttribute(k) { return this.attrs[k]; }
  appendChild(c) { if (c) this.children.push(c); return c; }
  append() { for (const c of arguments) this.appendChild(c); }
  prepend(c) { if (c) this.children.unshift(c); }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  remove() { if (this._parent) this._parent.removeChild(this); }
  set _p(p){ this._parent = p; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener() {}
  dispatch(t, ev) { (this.listeners[t] || []).forEach(f => f(ev || { target: this, preventDefault(){} })); }
  click() { this.dispatch('click', { target: this, preventDefault(){} }); }
  focus() {}
  querySelector(sel) { return findAll(this, n => matchSel(n, sel))[0] || null; }
  querySelectorAll(sel) { return findAll(this, n => matchSel(n, sel)); }
  closest(sel) { let n = this; while (n) { if (matchSel(n, sel)) return n; n = n._parent; } return null; }
  set innerHTML(v) { if (v === '') { this.children = []; this._text = ''; } else this._text = String(v); }
  get innerHTML() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent || '').join(''); }
}
function matchSel(n, sel) {
  if (!sel) return false;
  if (sel[0] === '.') return (' ' + n.className + ' ').indexOf(' ' + sel.slice(1) + ' ') >= 0;
  if (sel[0] === '#') return n.id === sel.slice(1);
  return n.tagName === sel.toUpperCase();
}
function findAll(node, pred, out) {
  out = out || [];
  if (!node) return out;
  if (pred(node)) out.push(node);
  for (const c of node.children || []) findAll(c, pred, out);
  return out;
}
function findByText(node, tag, text) {
  return findAll(node, n => n.tagName === tag.toUpperCase() && n.textContent.indexOf(text) >= 0)[0] || null;
}

function installDom() {
  const ids = {};
  ['content','conn-dot','conn-text','data-path','nav','toast'].forEach(id => { const n = new El('div'); n.id = id; ids[id] = n; });
  const body = new El('body');
  const doc = {
    readyState: 'complete', body,
    createElement: t => { const n = new El(t); n._p = null; return n; },
    createTextNode: t => { const n = new El('#text'); n.textContent = t; return n; },
    getElementById: id => ids[id] || null,
    querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}
  };
  global.window = {}; global.document = doc;
  return { doc, ids, body };
}
function loadScripts() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /<script src="([^"]+)"><\/script>/g; const srcs = []; let m;
  while ((m = re.exec(html))) srcs.push(m[1]);
  srcs.forEach(src => vm.runInThisContext(fs.readFileSync(path.join(ROOT, src), 'utf8'), { filename: src }));
}
function wireParent(node, parent) { node._p = parent; (node.children || []).forEach(c => wireParent(c, node)); }

const dom = installDom();
loadScripts();

test('点击「+ 新增渠道」能打开 modal 且不抛错', async () => {
  // 触发 boot（degrade 模式，无 FS）
  await global.App.app.boot().catch(e => { throw e; });
  await new Promise(r => setTimeout(r, 50));
  global.App.router.show('channels');
  const content = dom.ids.content;
  wireParent(content, null);
  const btn = findByText(content, 'button', '+ 新增渠道');
  assert.ok(btn, '应找到「+ 新增渠道」按钮');
  let threw = null;
  try { btn.click(); } catch (e) { threw = e; }
  assert.ifError(threw, '点击「+ 新增渠道」不应抛错: ' + (threw && threw.stack));
  const overlay = findByText(dom.body, 'div', ''); // placeholder
  const overlays = findAll(dom.body, n => matchSel(n, '.modal-overlay'));
  assert.ok(overlays.length >= 1, '应把一个 modal-overlay 挂到 body 上');
  const modal = overlays[0];
  // 确认 modal 内包含「保存」按钮
  const saveBtn = findByText(modal, 'button', '保存');
  assert.ok(saveBtn, 'modal 内应含「保存」按钮');
});
