(function (root) {
  'use strict';
  const App = root.App;
  const U = App.util;

  // 今日待办一次渲染多少条。
  // 导入价格表后每条渠道的有效期止 = 导入日 + 7 天，而默认「显示 7 天内到期」的窗口正好
  // 卡在这个边界（d <= win），于是一次导入 N 条渠道，待办里立刻就有 N 条。
  // 一份 FBA 卡派价目表就能产出上千条，全渲染出去等于给首页建几万个 DOM 节点，
  // 打开首页要卡好几秒——所以只渲染前 N 条，其余用「显示全部」按钮展开。
  const TODO_LIMIT = 40;
  let todoExpanded = false;   // 用户点了「显示全部」后，本次会话内保持展开

  /* ---- 快捷测算的「目的地」候选：只给国家名 ----
     价格表里的目的地写法极不统一：「美国」「美西」「美西（邮编8 9开头）」，
     卡派价目表还会带上「芝加哥 1号仓 邮编90000-90036」这种每条唯一的长串。
     直接把 c.dests 整串塞进 datalist 会得到几千个没法选的候选，既卡又没用。
     统一收敛到**国家**这一层：候选只出国家名（美国 / 德国 / 日本…），
     输入也必须是国家名——按国家匹配才能把该国各仓各渠道一次比全。 */
  let hintCache = { ref: null, len: -1, list: null };
  function countryHints(channels) {
    const list = channels || [];
    if (hintCache.ref === list && hintCache.len === list.length && hintCache.list) return hintCache.list;
    const out = App.calc.countryHints(list);
    hintCache = { ref: list, len: list.length, list: out };
    return out;
  }
  const QUICK_HINT = '只支持按国家名搜索：如 美国 / 德国 / 日本（城市、仓号请在「运费试算比价」里填）。';

  function homeVM(state, settings) {
    const todoDays = App.calc.normTodoDays(settings && settings.todoDays);
    // 待办只算一次：统计数字（卡片 / 说明行）和待办列表用的是同一份结果。
    // 上万条渠道时 todayTodos 要遍历全库再排两次序，算两遍等于白白多花一倍时间。
    const todos = App.calc.todayTodos(state.channels, undefined, todoDays);
    const summaries = U.computeSummaries(state, settings, { todos });
    const recentRecords = state.records.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 3);
    const recentChannels = state.channels.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 3);
    return { summaries, todos, todoDays, recentRecords, recentChannels };
  }

  function navTo(page) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
    if (nav) nav.classList.add('active');
    App.router.show(page);
  }
  function daysLabel(days) {
    if (days === null) return '未设有效期';
    if (days < 0) return '已过期 ' + (-days) + ' 天';
    if (days === 0) return '今天到期';
    return days + ' 天后到期';
  }

  /* ---- 「设置更新天数」：设定几天后更新价格表；可选把待办渠道的有效期止一并改到那天 ---- */
  function openUpdatePlan(store) {
    const settings = store.getSettings();
    const state = store.getState();
    const all = (state.channels || []).slice();
    const due = App.calc.dueChannels(all);
    let days = App.calc.normUpdateDays(settings.updateDays);

    const dayInp = U.el('input', { type: 'number', min: '1', max: '365', step: '1', value: String(days), class: 'upd-days' });
    const dateBox = U.el('div', { class: 'upd-date' });
    const chipBox = U.el('div', { class: 'chips' });
    const applyBox = U.el('input', { type: 'checkbox', class: 'upd-apply' });
    applyBox.checked = true;
    const scopeSel = U.el('select', { class: 'upd-scope' },
      (due.length ? [U.el('option', { value: 'due' }, '仅待办中的渠道（' + due.length + ' 条）')] : [])
        .concat([U.el('option', { value: 'all' }, '全部渠道（' + all.length + ' 条）')]));

    const chipEls = [];
    function sync() {
      days = App.calc.normUpdateDays(dayInp.value, days);
      const target = App.calc.updateDueDate(days);
      dateBox.textContent = '今天 ' + App.calc.todayStr() + ' → 更新日 ' + target + '（' + days + ' 天后）';
      chipEls.forEach(c => c.el.classList.toggle('on', c.n === days));
      return target;
    }
    App.calc.UPDATE_CHOICES.forEach(n => {
      const chip = U.el('button', {
        class: 'chip', type: 'button',
        onclick: () => { dayInp.value = String(n); sync(); }
      }, n + ' 天');
      chipBox.appendChild(chip);
      chipEls.push({ n: n, el: chip });
    });
    dayInp.addEventListener('input', sync);
    dayInp.addEventListener('change', sync);

    const scopeRow = U.el('label', { class: 'upd-check' }, [
      applyBox,
      U.el('span', null, '同时把'),
      scopeSel,
      U.el('span', null, '的「报价有效期止」改为更新日')
    ]);

    const body = U.el('div', { class: 'ch-form' }, [
      U.el('p', { class: 'hint' }, '设定「几天后更新价格表」：以后导入价格表时，有效期止 = 导入日 + N 天；也可以立刻把待办渠道的有效期统一改到这一天。'),
      U.el('label', { class: 'field' }, ['几天后更新', dayInp]),
      chipBox,
      dateBox,
      due.length
        ? scopeRow
        : U.el('p', { class: 'hint' }, '当前没有已过期或临期的渠道，只会保存更新天数，不会改动任何渠道。')
    ]);

    const overlay = U.el('div', { class: 'modal-overlay' }, [
      U.el('div', { class: 'modal' }, [
        U.el('h3', null, '设置价格表更新天数'),
        body,
        U.el('div', { class: 'modal-actions' }, [
          U.el('button', { class: 'btn', onclick: () => overlay.remove() }, '取消'),
          U.el('button', { class: 'btn btn-primary', onclick: async () => {
            try {
              const d = App.calc.normUpdateDays(dayInp.value, days);
              const target = App.calc.updateDueDate(d);
              await store.updateSettings({ updateDays: d });
              let n = 0;
              if (due.length && applyBox.checked) {
                const scope = scopeSel.value || 'due';
                const list = (scope === 'all') ? all : due;
                n = await store.updateChannels(list.map(c => c.id), { validUntil: target });
              }
              overlay.remove();
              U.toast('已设为 ' + d + ' 天（下次更新 ' + target + '）' +
                (n ? ('，' + n + ' 条渠道的有效期已改到 ' + target) : ''));
              if (App.router && App.router.show) App.router.show('home');
            } catch (err) {
              console.error('设置更新天数失败', err);
              U.toast('设置失败：' + (err && err.message ? err.message : '未知错误'));
            }
          } }, '保存')
        ])
      ])
    ]);
    sync();
    document.body.appendChild(overlay);
  }

  /* ---- 「显示 N 天内到期」：只调整今日待办的挑选窗口（多久算临期），不改任何渠道数据 ---- */
  function openTodoWindow(store) {
    const settings = store.getSettings();
    const all = (store.getState().channels || []).slice();
    let days = App.calc.normTodoDays(settings.todoDays);

    const dayInp = U.el('input', { type: 'number', min: '1', max: '365', step: '1', value: String(days), class: 'upd-days todo-days' });
    const rangeBox = U.el('div', { class: 'upd-date' });
    const statBox = U.el('div', { class: 'todo-stat' });
    const chipBox = U.el('div', { class: 'chips' });
    const chipEls = [];

    function sync() {
      days = App.calc.normTodoDays(dayInp.value, days);
      const until = App.calc.updateDueDate(days); // 今天 + N 天
      const t = App.calc.todayTodos(all, undefined, days);
      rangeBox.textContent = '今天 ' + App.calc.todayStr() + ' → 列出 ' + until + '（含）之前到期的渠道';
      statBox.textContent = '已过期 ' + t.over.length + ' 条 · 将到期 ' + t.soon.length + ' 条 · 待补全目的地 ' + t.noDest.length + ' 条';
      chipEls.forEach(c => c.el.classList.toggle('on', c.n === days));
      return t;
    }
    App.calc.TODO_CHOICES.forEach(n => {
      const chip = U.el('button', {
        class: 'chip', type: 'button',
        onclick: () => { dayInp.value = String(n); sync(); }
      }, n + ' 天');
      chipBox.appendChild(chip);
      chipEls.push({ n: n, el: chip });
    });
    dayInp.addEventListener('input', sync);
    dayInp.addEventListener('change', sync);

    const body = U.el('div', { class: 'ch-form' }, [
      U.el('p', { class: 'hint' }, '设定今日待办「多少天内到期」的显示范围：窗口内到期的渠道会进入「将到期」，已过期和待补全目的地的不受窗口影响。'),
      U.el('label', { class: 'field' }, ['显示多少天内到期', dayInp]),
      chipBox,
      rangeBox,
      statBox
    ]);

    const overlay = U.el('div', { class: 'modal-overlay' }, [
      U.el('div', { class: 'modal' }, [
        U.el('h3', null, '设置到期提醒范围'),
        body,
        U.el('div', { class: 'modal-actions' }, [
          U.el('button', { class: 'btn', onclick: () => overlay.remove() }, '取消'),
          U.el('button', { class: 'btn btn-primary', onclick: async () => {
            try {
              const d = App.calc.normTodoDays(dayInp.value, days);
              const t = App.calc.todayTodos(all, undefined, d);
              await store.updateSettings({ todoDays: d });
              overlay.remove();
              U.toast('已改为显示 ' + d + ' 天内到期（待办 ' + (t.over.length + t.soon.length + t.noDest.length) + ' 条）');
              if (App.router && App.router.show) App.router.show('home');
            } catch (err) {
              console.error('设置到期提醒范围失败', err);
              U.toast('设置失败：' + (err && err.message ? err.message : '未知错误'));
            }
          } }, '保存')
        ])
      ])
    ]);
    sync();
    document.body.appendChild(overlay);
  }

  function render(container) {
    const store = App.store.instance;
    const state = store.getState();
    const settings = store.getSettings();
    const cur = settings.currency;
    const vm = homeVM(state, settings);

    container.innerHTML = '';

    const cards = U.el('div', { class: 'grid cards' }, [
      card('价格库渠道数', vm.summaries.channelCount, false),
      card('近7天查询次数', vm.summaries.recent7, false),
      card('本月利润估算', cur + vm.summaries.monthProfit.toFixed(2), false),
      card('快到期/待补全', vm.todos.over.length + vm.todos.soon.length + vm.todos.noDest.length, (vm.todos.over.length + vm.todos.soon.length + vm.todos.noDest.length) > 0)
    ]);

    const qCountry = U.el('input', { list: 'home-country', placeholder: '国家名，如 美国' });
    const qWeight = U.el('input', { type: 'number', step: '0.1', placeholder: '重量kg' });
    const qTip = U.el('div', { class: 'quick-tip muted' }, QUICK_HINT);
    const hints = countryHints(state.channels);
    const quickCard = U.el('div', { class: 'card', style: 'margin-top:16px' }, [
      U.el('h3', null, '快捷运费测算'),
      U.el('datalist', { id: 'home-country' }, hints.map(c => U.el('option', { value: c }))),
      U.el('div', { class: 'row' }, [field('目的国', qCountry), field('重量(kg)', qWeight)]),
      qTip,
      U.el('button', { class: 'btn btn-primary', style: 'margin-top:12px', onclick: () => {
        const raw = qCountry.value.trim();
        const cn = App.calc.countryName(raw);
        if (!cn) {
          // 城市 / 仓号 / 空值一律不放行：带过去只会得到一堆匹配不上的空结果
          qTip.textContent = raw
            ? ('「' + raw + '」不是国家名，请输入国家，如 美国 / 德国 / 日本')
            : '请先填写国家名，如 美国 / 德国 / 日本';
          qTip.classList.add('err');
          qCountry.focus();
          return;
        }
        qTip.textContent = QUICK_HINT;
        qTip.classList.remove('err');
        App.pages.freight.setQuick(cn, qWeight.value.trim());
        navTo('freight');
      } }, '前往测算')
    ]);

    const t = vm.todos;
    const todoDays = vm.todoDays;
    const updDays = App.calc.normUpdateDays(settings.updateDays);
    const dueDate = App.calc.updateDueDate(updDays);
    const winEnd = App.calc.updateDueDate(todoDays);
    const allTodo = [];
    t.over.forEach(c => allTodo.push({ c: c, cls: 'over', tag: '已过期', hint: '出货前必须复核新价' }));
    t.soon.forEach(c => allTodo.push({ c: c, cls: 'soon', tag: '将到期', hint: '提前向货代要新报价' }));
    t.noDest.forEach(c => allTodo.push({ c: c, cls: 'none', tag: '待补全', hint: '未填适用目的地，试算时无法被匹配' }));
    const shownTodo = todoExpanded ? allTodo : allTodo.slice(0, TODO_LIMIT);
    const todoItems = shownTodo.map(it => todoRow(it.c, it.cls, it.tag, it.hint));
    // 超过上限时给一行「还有 N 条」+ 展开/收起，避免一次建出几万个节点
    const moreBox = allTodo.length > TODO_LIMIT
      ? U.el('div', { class: 'todo-more' }, [
        U.el('span', { class: 'muted' }, todoExpanded
          ? ('已显示全部 ' + allTodo.length + ' 条')
          : ('共 ' + allTodo.length + ' 条，当前只列前 ' + TODO_LIMIT + ' 条')),
        U.el('button', {
          class: 'btn btn-sm',
          onclick: () => { todoExpanded = !todoExpanded; App.router.show('home'); }
        }, todoExpanded ? '收起' : ('显示全部 ' + allTodo.length + ' 条'))
      ])
      : null;
    const expiringCard = U.el('div', { class: 'card', style: 'margin-top:16px' }, [
      U.el('div', { class: 'card-head' }, [
        U.el('h3', null, '今日待办（价格有效性）'),
        U.el('div', { class: 'head-ops' }, [
          U.el('span', { class: 'upd-hint' }, '每 ' + updDays + ' 天更新 · 下次 ' + dueDate),
          U.el('button', {
            class: 'upd-btn win-btn',
            title: '设置今日待办「多少天内到期」的显示范围',
            onclick: () => openTodoWindow(store)
          }, '显示 ' + todoDays + ' 天内到期'),
          U.el('button', {
            class: 'upd-btn',
            title: '设置几天后更新价格表（报价有效期止 = 今天 + N 天）',
            onclick: () => openUpdatePlan(store)
          }, '设置更新天数')
        ])
      ]),
      U.el('div', { class: 'todo-cap' },
        '显示 ' + todoDays + ' 天内到期（截至 ' + winEnd + '）· 已过期 ' + t.over.length +
        ' / 将到期 ' + t.soon.length + ' / 待补全 ' + t.noDest.length),
      allTodo.length === 0
        ? U.el('div', { class: 'muted', style: 'margin-top:8px' }, '所有渠道报价都在有效期内，且目的地已填全。')
        : U.el('div', { class: 'todo-list' }, todoItems),
      moreBox
    ]);

    const recentCard = U.el('div', { class: 'card', style: 'margin-top:16px' }, [
      U.el('h3', null, '最近动态'),
      U.el('div', null, [
        U.el('div', { class: 'muted', style: 'margin:6px 0' }, '最近查询记录'),
        vm.recentRecords.length
          ? U.el('ul', null, vm.recentRecords.map(r => U.el('li', null,
              U.formatDate(r.createdAt) + ' · ' + (r.country || r.dest || '—') + ' · ' +
              (r.type === 'profit' ? ('利润 ' + cur + r.profit.toFixed(2)) : ('运费 ' + cur + r.freight.toFixed(2))))))
          : U.el('div', { class: 'muted' }, '暂无'),
        U.el('div', { class: 'muted', style: 'margin:10px 0 6px' }, '最近添加的价格'),
        vm.recentChannels.length
          ? U.el('ul', null, vm.recentChannels.map(c => U.el('li', null, c.name + ' · ' + (c.dests || '—'))))
          : U.el('div', { class: 'muted' }, '暂无')
      ])
    ]);

    container.appendChild(cards);
    container.appendChild(quickCard);
    container.appendChild(expiringCard);
    container.appendChild(recentCard);

    function todoRow(c, cls, tag, hint) {
      const vs = App.calc.validState(c);
      const sub = (c.validUntil ? (daysLabel(vs.days) + ' · ') : '') + hint;
      return U.el('div', { class: 'todo-item ' + cls }, [
        U.el('span', { class: 'todo-tag' }, tag),
        U.el('span', { class: 'todo-txt' }, [
          U.el('b', null, c.name),
          U.el('small', null, sub),
          (cls === 'over' || cls === 'soon')
            ? U.el('small', { class: 'todo-due' },
              (c.dests ? (c.dests + ' · ') : '') + '建议更新日 ' + dueDate)
            : null
        ]),
        U.el('button', { class: 'todo-act', onclick: () => navTo('channels') }, '去更新')
      ]);
    }
    function card(title, value, alert) {
      return U.el('div', { class: 'card' + (alert ? ' alert' : '') }, [
        U.el('h3', null, title),
        U.el('div', { class: 'big' }, String(value))
      ]);
    }
    function field(label, control) { return U.el('label', { class: 'field' }, [label, control]); }
  }

  root.App.pages = root.App.pages || {};
  root.App.pages.home = { render, homeVM, openUpdatePlan, openTodoWindow, TODO_LIMIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = { homeVM, openUpdatePlan, openTodoWindow, TODO_LIMIT };
})(typeof globalThis !== 'undefined' ? globalThis : this);
