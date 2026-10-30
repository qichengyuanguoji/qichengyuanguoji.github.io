(function (root) {
  'use strict';
  const App = root.App;
  const U = App.util;
  const calc = App.calc;

  let prefill = null; // 从运费测算带入的运费成本
  function setPrefill(amount) { prefill = (amount === 0 || amount) ? Number(amount) : null; }
  function getPrefill() { return prefill; }

  function calcProfitFor(input) { return calc.computeProfit(input); }

  function line(k, v, strong, cls) {
    return U.el('div', { class: 'line' }, [
      U.el('span', { class: 'muted' }, k),
      U.el('span', strong ? { style: 'font-weight:600' } : null, v)
    ]);
  }

  function render(container) {
    const store = App.store.instance;
    const settings = store.getSettings();
    const cur = settings.currency;

    const ship = U.el('input', { type: 'number', step: '0.1', placeholder: '物流运费' });
    const cost = U.el('input', { type: 'number', step: '0.1', placeholder: '商品货值成本' });
    const curSel = U.el('select', null, [
      U.el('option', { value: 'CNY' }, 'CNY 人民币'),
      U.el('option', { value: 'USD' }, 'USD 美元'),
      U.el('option', { value: 'EUR' }, 'EUR 欧元')
    ]);
    const price = U.el('input', { type: 'number', step: '0.1', placeholder: '售价' });
    const rate = U.el('input', { type: 'number', step: '0.01', placeholder: '汇率（1外币=¥）', value: '7' });
    const fee = U.el('input', { type: 'number', step: '0.1', placeholder: '平台佣金%', value: '0' });
    const oth = U.el('input', { type: 'number', step: '0.1', placeholder: '其他成本（包装/人工）' });
    const qty = U.el('input', { type: 'number', step: '1', value: '1', placeholder: '件数' });
    const note = U.el('input', { type: 'text', placeholder: '备注（可选）' });

    if (prefill != null) { ship.value = prefill; prefill = null; }

    function syncRate() {
      rate.disabled = (curSel.value === 'CNY');
      if (curSel.value === 'CNY') rate.value = '1';
    }
    curSel.addEventListener('change', syncRate);

    function recompute() {
      const p = {
        ship: Number(ship.value) || 0, cost: Number(cost.value) || 0, cur: curSel.value,
        price: Number(price.value) || 0, rate: Number(rate.value) || 1, fee: Number(fee.value) || 0,
        other: Number(oth.value) || 0, qty: Math.max(1, Number(qty.value) || 1)
      };
      const r = calcProfitFor(p);
      const curSym = p.cur === 'CNY' ? '¥' : (p.cur === 'USD' ? '$' : '€');
      const box = document.getElementById('pr-result');
      box.innerHTML = '';
      box.appendChild(U.el('div', { class: 'result' }, [
        line('总收入', U.formatMoney(r.revenue, cur)),
        line('总成本', U.formatMoney(r.total, cur)),
        line('毛利', U.formatMoney(r.profit, cur), true),
        line('毛利率', (Math.round(r.margin * 100) / 100) + ' %', true),
        line('物流占售价', (Math.round(r.shipRate * 100) / 100) + ' %'),
        line('保本售价', curSym + ' ' + (Math.round(r.breakEven * 100) / 100), false)
      ]));
      // 提示
      const tip = document.getElementById('pr-tip');
      tip.innerHTML = '';
      if (p.price <= 0) {
        tip.appendChild(U.el('div', { class: 'tip info' }, '填写售价后即可看到毛利。运费可在「运费试算」页直接带入。'));
      } else if (r.profit < 0) {
        tip.appendChild(U.el('div', { class: 'tip bad' }, '这单会亏 ' + U.formatMoney(-r.profit, cur) + '。保本售价需提到 ' + curSym + ' ' + (Math.round(r.breakEven * 100) / 100) + '，或换更便宜的渠道。'));
      } else if (r.shipRate > 30) {
        tip.appendChild(U.el('div', { class: 'tip bad' }, '物流吃掉售价的 ' + (Math.round(r.shipRate * 100) / 100) + '%（超 30% 警戒线），建议换渠道。'));
      } else if (r.margin < 15) {
        tip.appendChild(U.el('div', { class: 'tip info' }, '毛利率 ' + (Math.round(r.margin * 100) / 100) + '%，偏低，抗风险弱。'));
      } else {
        tip.appendChild(U.el('div', { class: 'tip ok' }, '毛利率 ' + (Math.round(r.margin * 100) / 100) + '%，物流占售价 ' + (Math.round(r.shipRate * 100) / 100) + '%，这单可以做。'));
      }
      return r;
    }

    [ship, cost, price, rate, fee, oth, qty].forEach(i => i.addEventListener('input', recompute));

    const form = U.el('div', { class: 'card' }, [
      U.el('h3', null, '利润测算'),
      U.el('div', { class: 'grid2' }, [
        field('物流运费', ship),
        field('商品货值成本', cost),
        field('售价币种', curSel),
        field('售价', price),
        field('汇率（1外币=¥）', rate),
        field('平台佣金(%)', fee),
        field('其他成本', oth),
        field('件数', qty)
      ]),
      U.el('div', { class: 'row', style: 'margin-top:10px' }, [field('备注', note)]),
      U.el('div', { id: 'pr-result', class: 'result', style: 'margin-top:14px' }),
      U.el('div', { id: 'pr-tip', style: 'margin-top:10px' }),
      U.el('button', { class: 'btn btn-primary', style: 'margin-top:14px', onclick: async () => {
        const r = recompute();
        await store.addRecord({
          type: 'profit', freightCost: Number(ship.value) || 0, otherCost: Number(oth.value) || 0,
          profitRate: Number(fee.value) || 0, quote: r.revenue, profit: r.profit,
          note: (curSel.value + ' 售价' + price.value + ' 毛利' + Math.round(r.margin * 100) / 100 + '% ' + (note.value || '')).trim()
        });
        U.toast('已保存到查询记录');
      } }, '保存到查询记录')
    ]);

    container.innerHTML = '';
    container.appendChild(form);
    syncRate();
    recompute();
  }

  function field(label, control) { return U.el('label', { class: 'field' }, [label, control]); }

  root.App.pages = root.App.pages || {};
  root.App.pages.profit = { render, calcProfitFor, setPrefill, getPrefill };
  if (typeof module !== 'undefined' && module.exports) module.exports = { calcProfitFor, setPrefill, getPrefill };
})(typeof globalThis !== 'undefined' ? globalThis : this);
