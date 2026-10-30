(function (root) {
  'use strict';

  // updateDays：价格表更新周期（天）。导入时有效期止 = 导入日 + updateDays，首页「设置更新天数」也用它
  // todoDays：今日待办「多少天内到期」的显示窗口（天），首页「显示 N 天内到期」用它
  const DEFAULT_SETTINGS = { profitRate: 30, volRatio: 5000, factor: 6000, currency: '¥', weightStep: 0.5, firstWeight: 1, fbaWh: [], updateDays: 7, todoDays: 7 };

  function createStore(persistence) {
    let state = null;

    async function load() {
      state = await persistence.read();
      if (!state || typeof state !== 'object') state = (root.App.fsio ? root.App.fsio.defaultData() : { version: 1, settings: {}, channels: [], records: [] });
      state.settings = Object.assign({}, DEFAULT_SETTINGS, state.settings || {});
      if (!Array.isArray(state.channels)) state.channels = [];
      if (!Array.isArray(state.records)) state.records = [];
      return state;
    }

    // 落盘：整份数据一次写盘。上万条渠道时单次约 20~150ms（取决于紧凑序列化 + 磁盘/IDB），
    // 所以这里做「写盘合并」：上一次写盘还没结束时，后面的保存不再排新的写盘，只在尾部补一次，
    // 避免「连续快速操作 → 几十次全量重写」把界面卡住。
    let writing = null;
    let pending = false;
    async function save() {
      if (!state) return;
      if (writing) { pending = true; return writing; }
      writing = persistence.write(state);
      let res;
      try {
        res = await writing;
      } finally {
        writing = null;
      }
      // 写盘结果要立刻反映到顶栏（"已连接" / "没写进文件"），否则用户以为存进去了
      try { if (root.App && root.App.app && root.App.app.updateConnUi) root.App.app.updateConnUi(); } catch (e) {}
      if (pending) {          // 写盘期间又改过数据：只补写最后一次
        pending = false;
        return save();
      }
      return res;
    }

    function getState() { return state; }
    function getSettings() { return state ? state.settings : Object.assign({}, DEFAULT_SETTINGS); }

    async function updateSettings(patch) {
      if (!state) await load();
      state.settings = Object.assign({}, state.settings, patch);
      await save();
      return state.settings;
    }

    function uid() { return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

    async function addChannel(data) {
      if (!state) await load();
      const ch = Object.assign({ id: uid(), createdAt: new Date().toISOString() }, data);
      state.channels.push(ch);
      await save();
      return ch;
    }
    async function updateChannel(id, patch) {
      if (!state) await load();
      const ch = state.channels.find(c => c.id === id);
      if (!ch) throw new Error('CHANNEL_NOT_FOUND');
      Object.assign(ch, patch);
      await save();
      return ch;
    }
    async function deleteChannel(id) {
      if (!state) await load();
      state.channels = state.channels.filter(c => c.id !== id);
      await save();
    }
    // 批量删除：只落盘一次。逐条 deleteChannel 在千条级数据上会变成
    // 「删 1 条 → 全量重写一次」× N，勾 100 条要重写 100 次（几十秒）。
    async function deleteChannels(ids) {
      if (!state) await load();
      const set = new Set((ids || []).map(String));
      const before = state.channels.length;
      state.channels = state.channels.filter(c => !set.has(String(c.id)));
      const n = before - state.channels.length;
      if (n) await save();
      return n;
    }
    // 批量给一组渠道打同一个补丁（如统一改「报价有效期止」）：只落盘一次。返回实际改动条数
    async function updateChannels(ids, patch) {
      if (!state) await load();
      const set = new Set((ids || []).map(String));
      let n = 0;
      state.channels.forEach(c => {
        if (set.has(String(c.id))) { Object.assign(c, patch); n++; }
      });
      if (n) await save();
      return n;
    }

    /* ---- 渠道唯一键：同一渠道商 + 同一渠道名称 + 同一目的地 + 同一发货仓视为同一条（后提交覆盖先前的） ----
       目的地必须进键：一份价格表里同一渠道常有「美西 / 美中 / 美东」三行分区价，
       若只按名称+渠道商去重，三行会互相覆盖，最后只剩一条（美中/美东看起来就"丢了"）。
       起运仓也必须进键：FBA 卡派同一渠道按「华南 / 华东 / 义乌仓」分列报价，
       价格不同，只按名称+目的地会互相覆盖。 */
    function normKey(s) { return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase(); }
    function channelKey(ch) {
      if (!ch) return '';
      const name = normKey(ch.name);
      if (!name) return '';
      return name + '\u0001' + normKey(ch.carrier) + '\u0001' + normKey(ch.dests) + '\u0001' + normKey(ch.origin);
    }
    function findChannelIndex(data) {
      const k = channelKey(data);
      if (!k) return -1;
      return state.channels.findIndex(c => channelKey(c) === k);
    }

    // 不落盘的单条 upsert（供批量与 dryRun 复用）
    function applyUpsert(data, indexMap) {
      const key = channelKey(data);
      const idx = key && indexMap.has(key) ? indexMap.get(key) : -1;
      if (idx >= 0 && idx < state.channels.length) {
        const old = state.channels[idx];
        // 覆盖语义：整体替换为新数据，仅保留原 id / 创建时间
        const merged = Object.assign({}, data, { id: old.id, createdAt: old.createdAt || new Date().toISOString() });
        // country 是导入/启动时补出来的推导字段（老渠道只有城市/仓号），
        // 编辑弹窗里没有这一项；不保留的话改一次价格就把国家弄丢，按国家又搜不到了。
        if (!merged.country && old.country) merged.country = old.country;
        state.channels[idx] = merged;
        return { ch: merged, updated: true };
      }
      const ch = Object.assign({ id: uid(), createdAt: new Date().toISOString() }, data);
      if (indexMap && key) indexMap.set(key, state.channels.length);
      state.channels.push(ch);
      return { ch, updated: false };
    }
    function buildIndexMap() {
      const m = new Map();
      state.channels.forEach((c, i) => { const k = channelKey(c); if (k && !m.has(k)) m.set(k, i); });
      return m;
    }

    // 单条：存在则覆盖，不存在则新增。返回 { ch, updated }
    async function upsertChannel(data, opts) {
      if (!state) await load();
      const res = applyUpsert(data, buildIndexMap());
      if (!(opts && opts.dryRun)) await save();
      return res;
    }

    // 批量：一次落盘。返回 { added, updated, channels, dryRun, saved }
    // saved 是写盘结果（{target:'file'|'idb'}）：导入后要据此告诉用户「到底写进 data.json 没有」
    async function upsertChannels(list, opts) {
      if (!state) await load();
      const dryRun = !!(opts && opts.dryRun);
      const indexMap = buildIndexMap();
      const snapshot = state.channels.slice();
      let added = 0, updated = 0;
      const out = [];
      for (const data of (list || [])) {
        const r = applyUpsert(data, indexMap);
        if (r.updated) updated++; else added++;
        out.push(r.ch);
      }
      let saved = null;
      if (dryRun) state.channels = snapshot; // 预览不动真实数据
      else saved = await save();
      return { added, updated, channels: out, dryRun, saved };
    }

    // 把「同一渠道重复」的历史数据合并成一条（保留最后一条），返回合并条数
    async function dedupeChannels() {
      if (!state) await load();
      const keep = new Map();
      state.channels.forEach(c => {
        const k = channelKey(c) || ('\u0001\u0001' + c.id);
        if (keep.has(k)) {
          const old = keep.get(k);
          keep.set(k, Object.assign({}, c, { id: old.id, createdAt: old.createdAt || c.createdAt }));
        } else {
          keep.set(k, c);
        }
      });
      const before = state.channels.length;
      state.channels = Array.from(keep.values());
      const removed = before - state.channels.length;
      if (removed > 0) await save();
      return removed;
    }

    async function addRecord(data) {
      if (!state) await load();
      const rec = Object.assign({ id: uid(), createdAt: new Date().toISOString() }, data);
      state.records.push(rec);
      await save();
      return rec;
    }
    async function deleteRecord(id) {
      if (!state) await load();
      state.records = state.records.filter(r => r.id !== id);
      await save();
    }

    return {
      load, save, getState, getSettings, updateSettings,
      addChannel, updateChannel, deleteChannel, deleteChannels,
      upsertChannel, upsertChannels, dedupeChannels, channelKey, updateChannels,
      addRecord, deleteRecord
    };
  }

  const api = { createStore, DEFAULT_SETTINGS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.store = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
