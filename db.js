/**
 * 小笼包 —— IndexedDB 持久化层
 * 存储结构：xlb-data v1
 *   store "main" (keyPath: "k")：单条记录 k="root" 存 {items,logs,config,products}
 * 设计理由：单对象存储，结构简单，全量读写；数据量通常 < 1MB，性能足够。
 */
(function (global) {
  "use strict";
  const DB_NAME = "xlb-data";
  const DB_VER = 1;
  const STORE = "main";
  const ROOT_KEY = "root";

  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "k" });
      };
      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  async function load() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(ROOT_KEY);
      req.onsuccess = () => resolve(req.result ? req.result.data : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function save(data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put({ k: ROOT_KEY, data, ts: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function clear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** 导出为 JSON 字符串（备份/同步用） */
  async function exportJSON() {
    const data = await load();
    return JSON.stringify(data || { items: {}, logs: [], config: {}, products: {} });
  }

  /** 导入 JSON 字符串（覆盖/合并） */
  async function importJSON(jsonStr, mode = "merge") {
    const incoming = JSON.parse(jsonStr);
    if (mode === "replace") { await save(incoming); return; }
    const cur = (await load()) || { items: {}, logs: [], config: {}, products: {} };
    // items：以瓶号为键覆盖；logs：追加去重（按 log_id）；config：覆盖；products：覆盖
    cur.items = { ...cur.items, ...(incoming.items || {}) };
    const seen = new Set(cur.logs.map(l => l.log_id));
    for (const l of (incoming.logs || [])) if (!seen.has(l.log_id)) { cur.logs.push(l); seen.add(l.log_id); }
    cur.config = { ...cur.config, ...(incoming.config || {}) };
    cur.products = { ...cur.products, ...(incoming.products || {}) };
    await save(cur);
  }

  global.XLBDB = { load, save, clear, exportJSON, importJSON };
})(window);
