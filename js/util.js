(function (root) {
  'use strict';

  function round2(n) { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

  function formatMoney(amount, currency) {
    currency = currency || '¥';
    const n = Number(amount);
    if (!isFinite(n)) return currency + '0.00';
    return currency + n.toFixed(2);
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function formatDate(d) {
    if (!d) return '';
    if (typeof d === 'string') d = new Date(d);
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function todayISO() { return formatDate(new Date()); }

  // 返回今天到目标日期（含）的天数；已过期为负数；无日期为 Infinity
  function daysUntil(dateStr) {
    if (!dateStr) return Infinity;
    const target = new Date(dateStr + 'T00:00:00');
    if (isNaN(target.getTime())) return Infinity;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return Math.round((target - today) / 86400000);
  }

  // 有效期状态：expired / red(<7天) / orange(<15天) / normal / none(无日期)
  function expiryStatus(validUntil) {
    if (!validUntil) return 'none';
    const d = daysUntil(validUntil);
    if (d < 0) return 'expired';
    if (d < 7) return 'red';
    if (d < 15) return 'orange';
    return 'normal';
  }

  // 纯函数：根据记录列表计算首页/摘要所需数据
  // opts.todos：调用方已经算好的 todayTodos 结果，传进来就不再重复遍历一遍渠道
  function computeSummaries(state, settings, opts) {
    const channels = (state && state.channels) || [];
    const records = (state && state.records) || [];
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 7 * 86400000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const recent7 = records.filter(r => new Date(r.createdAt) >= dayAgo).length;
    const monthProfit = records
      .filter(r => r.type === 'profit' && new Date(r.createdAt) >= monthStart)
      .reduce((s, r) => s + (Number(r.profit) || 0), 0);
    const calc = (state && state.__calc) || (root.App && root.App.calc);
    let expiring = 0;
    if (opts && opts.todos) {
      expiring = opts.todos.over.length + opts.todos.soon.length;
    } else if (calc && calc.todayTodos) {
      // 「将到期」窗口跟随设置的「显示 N 天内到期」（默认 7 天）
      const t = calc.todayTodos(channels, undefined, settings && settings.todoDays);
      expiring = t.over.length + t.soon.length;
    } else {
      expiring = channels.filter(c => {
        const st = expiryStatus(c.validUntil);
        return st === 'red' || st === 'orange' || st === 'expired';
      }).length;
    }
    return {
      channelCount: channels.length,
      recent7,
      monthProfit: round2(monthProfit),
      expiring
    };
  }

  // DOM 助手（仅浏览器）
  function el(tag, attrs, children) {
    if (typeof document === 'undefined') return null;
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class') node.className = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v);
      }
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }

  function toast(msg) {
    if (typeof document === 'undefined') { console.log('[toast]', msg); return; }
    let t = document.getElementById('toast');
    if (!t) { t = el('div', { id: 'toast', class: 'toast' }); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2000);
  }

  function confirmDialog(message) {
    return new Promise(resolve => {
      if (typeof document === 'undefined') { resolve(confirm(message)); return; }
      const overlay = el('div', { class: 'modal-overlay' }, [
        el('div', { class: 'modal' }, [
          el('p', null, message),
          el('div', { class: 'modal-actions' }, [
            el('button', { class: 'btn', onclick: () => { overlay.remove(); resolve(false); } }, '取消'),
            el('button', { class: 'btn btn-primary', onclick: () => { overlay.remove(); resolve(true); } }, '确定')
          ])
        ])
      ]);
      document.body.appendChild(overlay);
    });
  }

  const api = { round2, formatMoney, formatDate, todayISO, daysUntil, expiryStatus, computeSummaries, el, toast, confirmDialog };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.util = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
