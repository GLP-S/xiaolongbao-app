/**
 * 小笼包 —— 本地 API 适配层（单机模式核心）
 * 复刻 server.py 的全部 /api/* 接口，内部调用 XLBStore，使平板彻底脱离电脑独立运行。
 * 初始化：XLBLocalApi.init() 从 IndexedDB 加载数据到 Store。
 */
(function (global) {
  "use strict";

  const APP_NAME = "小笼包";
  const APP_VERSION = "2.1";

  let store = null;
  let _initPromise = null;

  async function init() {
    if (store) return store;
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      const data = await global.XLBDB.load();
      store = new global.XLBStore(data || {});
      store.setSaver(d => global.XLBDB.save(d));
      return store;
    })();
    return _initPromise;
  }

  function getStore() {
    if (!store) throw new Error("Store 未初始化");
    return store;
  }

  // 统一响应格式
  function ok(data) { return data; }
  function err(msg, code = 400) { const e = new Error(msg); e.status = code; throw e; }

  // 解析路径：/api/xxx 或 /api/xxx/:id
  function parsePath(path) {
    const m = path.match(/^\/api\/([^/?#]+)(?:\/([^/?#]+))?/);
    return m ? { endpoint: m[1], id: m[2] || null } : null;
  }

  async function localApi(path, opt = {}) {
    await init();
    const p = parsePath(path);
    if (!p) err("未知接口: " + path, 404);
    const method = (opt.method || "GET").toUpperCase();
    const body = opt.body ? JSON.parse(opt.body) : {};
    const s = getStore();
    const cfg = s.config;

    switch (p.endpoint) {
      case "info":
        return { app_name: APP_NAME, version: APP_VERSION, mode: "local" };

      case "login": {
        if (method !== "POST") err("方法不允许", 405);
        const { user, pass } = body;
        if (user === cfg.login_user && pass === cfg.login_password) return { user };
        err("用户名或密码错误", 401);
      }

      case "items": {
        if (method === "POST") {
          // 保留：批量入库
          const bids = s.receiveBatch(body.form, body.qty || 1);
          return { bottle_ids: bids, product_code: s.productCodeFor(body.form.std_id, body.form.conc, body.form.unit, body.form.batch, body.form.name) };
        }
        // GET 查询
        const q = (opt._q || "").toLowerCase();
        const status = opt._status || "";
        let list = Object.values(s.items);
        if (q) list = list.filter(i => (i.bottle_id + i.name + i.std_id + i.conc + i.batch).toLowerCase().includes(q));
        if (status && status !== "全部") list = list.filter(i => i.status === status);
        return list.sort((a, b) => (b.bottle_id || "").localeCompare(a.bottle_id || ""));
      }

      case "item": {
        const it = s.items[p.id];
        if (!it) err("瓶号不存在: " + p.id, 404);
        return it;
      }

      case "receive": {
        const form = body.form || body;
        const n = parseInt(body.qty || form.qty || "1");
        const pcode = s.productCodeFor(form.std_id, form.conc, form.unit, form.batch, form.name);
        if (n > 1) {
          const bottle_ids = s.receiveBatch(form, n);
          return { bottle_ids, product_code: pcode };
        }
        const bid = s.receive(form);
        return { bottle_ids: [bid], bottle_id: bid, product_code: pcode };
      }

      case "scan": {
        const code = body.code;
        if (!code) err("扫码内容为空", 400);
        try {
          return s.scan(code);
        } catch (e) { err(e.message, 404); }
      }

      case "issue": {
        const { action, bottle_id, qty, person, purpose, operator, emptied, note } = body;
        if (action === "use") s.use(bottle_id, qty, person, purpose, operator, { emptied: !!emptied, note });
        else if (action === "checkout") s.checkout(bottle_id, person, purpose, operator, note);
        else err("未知操作类型", 400);
        return { ok: true };
      }

      case "return": {
        const { bottle_id, opened, open_date, operator, note } = body;
        s.returnBack(bottle_id, opened, open_date, operator, note);
        return { ok: true };
      }

      case "discard": {
        s.discard(body.bottle_id, body.reason, body.operator);
        return { ok: true };
      }

      case "modify": {
        s.modify(body.bottle_id, body.changes, body.operator);
        return { ok: true };
      }

      case "logs": {
        let logs = s.logs.slice().reverse();
        const q = (opt._q || "").toLowerCase();
        if (q) logs = logs.filter(l => (l.bottle_id + l.name + l.action + l.person + l.note).toLowerCase().includes(q));
        return logs;
      }

      case "config": {
        if (method === "POST") {
          for (const k in body) s.config[k] = body[k];
          await s.save();
          return { ok: true };
        }
        return { ...cfg };
      }

      case "dict": {
        return s.dictList(p.id);
      }

      case "stocktake": {
        if (p.id === "start") return { ok: true, time: new Date().toISOString() };
        if (p.id === "report") return s.stocktakeReport(body.found || []);
        err("未知盘点操作", 404);
      }

      case "locations": {
        // 字段与 server.py /api/locations 契约一致
        const pick = (k, d) => parseInt(s.config[k] || String(d));
        return {
          big_box: pick("big_box", 20), big_box_grid: pick("big_box_grid", 4),
          small_box: pick("small_box", 20), small_box_grid: pick("small_box_grid", 5),
          occupied: [...s.occupiedLocations()]
        };
      }

      case "label_data": {
        const it = s.items[p.id];
        if (!it) err("瓶号不存在", 404);
        const image = global.XLBLabel.renderLabel(it, cfg, parseInt(cfg.label_dpi || "203"));
        return { image, name: it.name, code: it.bottle_id };
      }

      case "print": {
        // 本地打印：走浏览器打印或蓝牙打印
        const bid = body.bottle_id;
        const it = s.items[bid];
        if (!it) err("瓶号不存在", 404);
        const image = global.XLBLabel.renderLabel(it, cfg, parseInt(cfg.label_dpi || "203"));
        // 调用蓝牙打印（若已连接），否则浏览器打印
        const printed = await tryBluetoothPrint(image, body.copies || 1);
        if (!printed) {
          printImageViaBrowser(image);
        }
        return { printer: printed ? "bluetooth" : "browser", ok: true };
      }

      case "printers": {
        // 本地模式：列出已配对蓝牙打印机（由 Capacitor 插件提供）
        return await listBluetoothPrinters();
      }

      default:
        err("未知接口: " + p.endpoint, 404);
    }
  }

  // ---------- 打印辅助 ----------
  function printImageViaBrowser(dataUrl) {
    const win = window.open("", "_blank");
    if (!win) { toast("请允许弹出窗口以打印"); return; }
    win.document.write(`<html><head><title>打印标签</title></head>
      <body style="margin:0"><img src="${dataUrl}" onload="window.print();setTimeout(()=>window.close(),500)"/></body></html>`);
    win.document.close();
  }

  async function tryBluetoothPrint(dataUrl, copies) {
    // 优先用蓝牙打印（XLBBluetoothPrint 封装了 Capacitor BluetoothLe）
    if (global.XLBBluetoothPrint && global.XLBBluetoothPrint.isConnected()) {
      try {
        await global.XLBBluetoothPrint.printLabel(dataUrl, copies);
        return true;
      } catch (e) { return false; }
    }
    return false;
  }

  async function listBluetoothPrinters() {
    if (global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.BluetoothPrint) {
      try { return await global.Capacitor.Plugins.BluetoothPrint.listDevices(); } catch (e) { return []; }
    }
    return [];
  }

  function toast(msg) {
    const t = document.createElement("div");
    t.style.cssText = "position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 16px;border-radius:6px;z-index:9999";
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  // ---------- 数据同步（联网时可选） ----------
  async function syncFromServer(base) {
    /** 从电脑端拉取全量数据合并到本地 */
    const r = await fetch(base + "/api/export/all");
    if (!r.ok) throw new Error("同步失败: " + r.status);
    const data = await r.json();
    await global.XLBDB.importJSON(JSON.stringify(data), "merge");
    store = new global.XLBStore(await global.XLBDB.load());
    store.setSaver(d => global.XLBDB.save(d));
    return true;
  }

  async function syncToServer(base) {
    /** 推送本地全量数据到电脑端 */
    const json = await global.XLBDB.exportJSON();
    const r = await fetch(base + "/api/import/all", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
    if (!r.ok) throw new Error("上传失败: " + r.status);
    return true;
  }

  global.XLBLocalApi = { init, localApi, getStore, syncFromServer, syncToServer };
})(window);
