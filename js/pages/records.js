(function (root) {
  'use strict';
  const App = root.App;
  const U = App.util;

  function filterRecords(records, f) {
    f = f || {};
    const from = f.from ? new Date(f.from + 'T00:00:00') : null;
    const to = f.to ? new Date(f.to + 'T23:59:59.999') : null;
    return records.filter(r => {
      const t = new Date(r.createdAt);
      if (from && t < from) return false;
      if (to && t > to) return false;
      const country = r.country || r.dest || '';
      if (f.country && country !== f.country) return false;
      if (f.channel && r.channelName !== f.channel) return false;
      return true;
    });
  }

  function uniqueSorted(arr) { return Array.from(new Set(arr.filter(Boolean))).sort(); }
  function countryOptions(records) { return uniqueSorted(records.map(r => r.country || r.dest)); }
  function channelOptions(records) { return uniqueSorted(records.map(r => r.channelName)); }

  function openDetail(rec, cur) {
    const rows = [
      ['类型', rec.type === 'profit' ? '利润测算' : '运费测算'],
      ['时间', U.formatDate(rec.createdAt) + ' ' + new Date(rec.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })],
      ['目的地', rec.country || rec.dest || '—'],
      ['重量(kg)', rec.weight != null ? rec.weight : '—'],
      ['件数', rec.pcs != null ? rec.pcs : '—'],
      ['CBM', rec.cbm != null ? rec.cbm : '—'],
      ['渠道', rec.channelName || '—']
    ];
    if (rec.type === 'freight') {
      rows.push(['运费', cur + (rec.freight != null ? rec.freight.toFixed(2) : '—')]);
    } else {
      rows.push(['运费成本', cur + (rec.freightCost != null ? rec.freightCost.toFixed(2) : '—')]);
      rows.push(['其他成本', cur + (rec.otherCost != null ? rec.otherCost.toFixed(2) : '—')]);
      rows.push(['平台佣金(%)', (rec.profitRate != null ? rec.profitRate : '—')]);
      rows.push(['总收入/报价', cur + (rec.quote != null ? rec.quote.toFixed(2) : '—')]);
      rows.push(['利润', cur + (rec.profit != null ? rec.profit.toFixed(2) : '—')]);
    }
    if (rec.note) rows.push(['备注', rec.note]);
    const overlay = U.el('div', { class: 'modal-overlay' }, [
      U.el('div', { class: 'modal', style: 'width:360px' }, [
        U.el('h3', null, '记录详情'),
        ...rows.map(([k, v]) => U.el('div', { class: 'line' }, [U.el('span', { class: 'muted' }, k), U.el('span', null, String(v))])),
        U.el('div', { class: 'modal-actions' }, [U.el('button', { class: 'btn btn-primary', onclick: () => overlay.remove() }, '关闭')])
      ])
    ]);
    document.body.appendChild(overlay);
  }

  function render(container) {
    const store = App.store.instance;
    const state = store.getState();
    const cur = store.getSettings().currency;
    const records = state.records.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const f = { from: '', to: '', country: '', channel: '' };

    function draw() {
      container.innerHTML = '';
      const toolbar = U.el('div', { class: 'toolbar' }, [
        U.el('label', { class: 'field' }, ['起始', U.el('input', { type: 'date', onchange: (e) => { f.from = e.target.value; drawTable(); } })]),
        U.el('label', { class: 'field' }, ['结束', U.el('input', { type: 'date', onchange: (e) => { f.to = e.target.value; drawTable(); } })]),
        U.el('select', { onchange: (e) => { f.country = e.target.value; drawTable(); } },
          [U.el('option', { value: '' }, '全部目的地')].concat(countryOptions(records).map(c => U.el('option', { value: c }, c)))),
        U.el('select', { onchange: (e) => { f.channel = e.target.value; drawTable(); } },
          [U.el('option', { value: '' }, '全部渠道')].concat(channelOptions(records).map(c => U.el('option', { value: c }, c)))),
        U.el('button', { class: 'btn', onclick: () => { f.from = ''; f.to = ''; f.country = ''; f.channel = ''; draw(); } }, '重置')
      ]);
      const wrap = U.el('div', { id: 'rec-table' });
      container.appendChild(toolbar);
      container.appendChild(wrap);

      function drawTable() {
        const list = filterRecords(records, f);
        if (list.length === 0) {
          wrap.innerHTML = '';
          wrap.appendChild(U.el('div', { class: 'empty' }, records.length === 0 ? '还没有任何测算记录。' : '没有匹配的记录。'));
          return;
        }
        const rows = list.map(r => U.el('tr', null, [
          U.el('td', null, U.formatDate(r.createdAt)),
          U.el('td', null, r.country || r.dest || '—'),
          U.el('td', null, r.weight != null ? r.weight : '—'),
          U.el('td', null, r.channelName || '—'),
          U.el('td', null, r.type === 'freight' ? U.formatMoney(r.freight, cur) : '—'),
          U.el('td', null, r.type === 'profit' ? U.formatMoney(r.profit, cur) : '—'),
          U.el('td', null, U.el('div', { class: 'row' }, [
            U.el('button', { class: 'btn', onclick: () => openDetail(r, cur) }, '查看'),
            U.el('button', { class: 'btn btn-danger', onclick: async () => {
              if (await U.confirmDialog('确定删除该记录？')) { await store.deleteRecord(r.id); U.toast('已删除'); drawTable(); }
            } }, '删除')
          ]))
        ]));
        const table = U.el('table', null, [
          U.el('thead', null, U.el('tr', null, ['时间', '目的地', '重量', '渠道', '运费', '利润', '操作'].map(h => U.el('th', null, h)))),
          U.el('tbody', null, rows)
        ]);
        wrap.innerHTML = '';
        wrap.appendChild(table);
      }
      drawTable();
    }
    draw();
  }

  root.App.pages = root.App.pages || {};
  root.App.pages.records = { render, filterRecords, countryOptions, channelOptions };
  if (typeof module !== 'undefined' && module.exports) module.exports = { filterRecords, countryOptions, channelOptions };
})(typeof globalThis !== 'undefined' ? globalThis : this);
