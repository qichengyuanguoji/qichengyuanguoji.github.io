(function (root) {
  'use strict';
  const App = root.App;
  let container = null;
  let current = null;
  function init(c) { container = c; }
  function show(name) {
    if (!container) return;
    current = name;
    const page = App.pages && App.pages[name];
    container.innerHTML = '';
    if (!page || typeof page.render !== 'function') {
      container.appendChild(App.util.el('div', { class: 'placeholder' }, '模块建设中…'));
      return;
    }
    page.render(container);
  }
  const api = { init, show, get current() { return current; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.router = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
