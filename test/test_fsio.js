'use strict';
const test = require('node:test');
const assert = require('node:assert');

// 模拟安全上下文（window 暴露了 File System Access API），但首次无已保存句柄
const fakeHandle = {
  getFile: async () => ({ text: async () => JSON.stringify({ version: 1, settings: {}, channels: [{ id: 'x', name: 'DHL' }], records: [] }) }),
  createWritable: async () => ({ write: async () => {}, close: async () => {} })
};
global.window = {
  showSaveFilePicker: async () => fakeHandle,
  showOpenFilePicker: async () => [fakeHandle]
};
global.App = { db: { getHandle: async () => null, persistHandle: async () => {} } };

const fsio = require('../js/fsio.js');

test('isFsSupported: 安全上下文识别为支持', () => {
  assert.strictEqual(fsio.isFsSupported(), true);
});

test('read() 在没有句柄时不自动弹窗，返回 null（boot 因此不会崩溃）', async () => {
  const p = await fsio.createFsPersistence();
  assert.strictEqual(p.kind, 'fs');
  assert.strictEqual(p.needsFile, true);
  let prompted = false;
  const orig = global.window.showSaveFilePicker;
  global.window.showSaveFilePicker = async () => { prompted = true; return fakeHandle; };
  const r = await p.read();
  assert.strictEqual(r, null);
  assert.strictEqual(prompted, false, 'read() 不应触发文件选择弹窗');
  global.window.showSaveFilePicker = orig;
});

test('chooseFile 由用户手势触发后落盘，并 flush 缓冲写入', async () => {
  const p = await fsio.createFsPersistence();
  assert.strictEqual(p.needsFile, true);
  // 选文件前先做一次写入，应被缓冲而非报错
  await p.write({ version: 1, settings: {}, channels: [], records: [] });
  // 用户点击触发
  await p.chooseFile(true);
  assert.strictEqual(p.needsFile, false);
  // 再次 read 应能读到已写入内容
  const r = await p.read();
  assert.ok(r && Array.isArray(r.channels), 'read 应返回包含 channels 的对象');
});

test('read() 在已有句柄时正常读文件', async () => {
  const p = await fsio.createFsPersistence();
  await p.chooseFile(true);
  const r = await p.read();
  assert.strictEqual(r.channels.length, 1);
  assert.strictEqual(r.channels[0].name, 'DHL');
});
