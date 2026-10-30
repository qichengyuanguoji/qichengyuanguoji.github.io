(function (root) {
  'use strict';

  const DB_NAME = 'logi-app';
  const STORE = 'handles';
  const KEY = 'dataFile';

  function openDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB not available')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function persistHandle(handle) {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  }

  async function getHandle() {
    const db = await openDB();
    const val = await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(KEY);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return val || null;
  }

  async function clearHandle() {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  }

  // 通用 JSON 存取（降级模式用）
  async function getIdbJson(key) {
    const db = await openDB();
    const val = await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return val || null;
  }

  async function putIdbJson(key, val) {
    const db = await openDB();
    await new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(val, key);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    db.close();
  }

  const api = { persistHandle, getHandle, clearHandle, getIdbJson, putIdbJson };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.App = root.App || {};
  root.App.db = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
