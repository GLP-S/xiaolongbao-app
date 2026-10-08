/**
 * 小笼包 —— 本地 API 适配层（单机模式核心）v3.0
 * 复刻 server.py 的全部 /api/* 接口，内部调用 XLBStore，使平板彻底脱离电脑独立运行。
 * 初始化：XLBLocalApi.init() 从 IndexedDB 加载数据到 Store。
 * v3.0：多账号会话与权限校验、盒定义库位、增量同步（sync/push+pull）。
 */
(function (global) {
  "use strict";

  const APP_NAME = "小笼包";
  const APP_VERSION = "3.0";

  let store = null;
  let _initPromise = null;
  // 当前登录会话（由前端登录成功后 setSession 注入）
  let _session = null;   // {user, role, perms[]}

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

  function setSession(s) { _session = s && s.user ? { user: s.user, role: s.role || "user", perms: (s.perms || []).slice() } : null; }
  function getSession() { return _session; }

  // 统一响应格式
  function ok(data) { return data; }
  function err(msg, code = 400) { const e = new Error(msg); e.status = code; throw e; }

  // 权限校验：admin 放行；否则需具备任一指定权限（本地模式未登录视为游客，仅只读）
  function requirePerm(...perms) {
    if (!_session) err("未登录或登录已过期", 401);
    if (_session.role === "admin") return;
    if (!perms.some(p => (_session.perms || []).includes(p))) err("无权限", 403);
  }
  function requireAdmin() {
    if (!_session) err("未登录或登录已过期", 401);
    if (_session.role !== "admin") err("仅管理员可执行此操作", 403);
  }

  // 解析路径：/api/xxx 或 /api/xxx/:id
  function parsePath(path) {
    const m = path.match(/^\/api\/([^/?#]+)(?:\/([^/?#]+))?/);
    return m ? { endpoint: m[1], id: m[2] || null } : null;
  }

  function locationsPayload(s) {
    return {
      boxes: s.boxes().map(b => ({ ...b, label: s.boxLabel(b), prefix: s.boxLocPrefix(b), slots: s.boxSlots(b) })),
      occupied: [...s.occupiedLocations()],
    };
  }

  // v3.0：业务写操作成功后直推钉钉（静默，失败由 XLBDingTalk 自己排队）
  function dtNotify() {
    try {
      if (global.XLBDingTalk)
        return global.XLBDingTalk.notify.apply(global.XLBDingTalk, arguments);
    } catch (e) { }
  }
  function opUser(fallback) { return fallback || (_session && _session.user) || ""; }

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
        const info = await s.checkLogin(user, pass);
        if (!info) err("账号或密码错误", 401);
        setSession({ user, role: info.role, perms: info.perms });
        return { ok: true, user, role: info.role, perms: info.perms, token: "local" };
      }

      case "users": {
        requireAdmin();
        if (method === "GET") {
          return Object.entries(s.users()).map(([n, u]) => ({ user: n, role: u.role || "user", perms: u.perms || [] }));
        }
        if (method === "POST") {
          if (body.action === "set_perms") await s.setUserPerms(body.user, body.perms || []);
          else if (body.action === "set_pass") await s.setUserPass(body.user, body.pass || "");
          else await s.addUser(body.user, body.pass || "123456", body.perms || ["inout", "query"]);
          return { ok: true };
        }
        if (method === "DELETE") {
          await s.delUser(body.user);
          return { ok: true };
        }
        err("方法不允许", 405);
      }

      case "items": {
        // GET 查询
        const q = (opt._q || "").toLowerCase();
        const status = opt._status || "";
        let list = Object.values(s.items);
        if (q) list = list.filter(i => (String(i.bottle_id) + i.name + i.std_id + i.conc + i.unit + i.batch + i.product_code + i.location).toLowerCase().includes(q));
        if (status && status !== "全部") list = list.filter(i => i.status === status);
        return list.sort((a, b) => (b.bottle_id || "").localeCompare(a.bottle_id || ""));
      }

      case "item": {
        const it = s.items[p.id];
        if (!it) err("瓶号不存在: " + p.id, 404);
        return it;
      }

      case "receive": {
        requirePerm("inout");
        const form = body.form || body;
        const n = parseInt(body.qty || form.qty || form.quantity || "1");
        const pcode = s.productCodeFor(form.std_id, form.conc, form.unit, form.batch, form.name);
        if (n > 1) {
          const bottle_ids = s.receiveBatch(form, n);
          const first = s.items[bottle_ids[0]];
          const locs = bottle_ids.map(b => s.items[b].location).filter(Boolean);
          dtNotify("批量入库（" + n + " 瓶）", first.name,
            [["瓶号范围", bottle_ids[0] + " ~ " + bottle_ids[bottle_ids.length - 1]],
             ["批号", first.batch],
             ["浓度规格", (first.conc || "") + (first.unit || "")],
             ["库位", locs.slice(0, 5).join("、") + (locs.length > 5 ? "……" : "")]],
            opUser(first.operator));
          return { ok: true, bottle_ids, product_code: pcode, is_new_product: !s.products[pcode] };
        }
        const bid = s.receive(form);
        const it = s.items[bid];
        dtNotify("入库登记", it.name,
          [["瓶号", bid], ["批号", it.batch],
           ["浓度规格", (it.conc || "") + (it.unit || "")],
           ["有效期至", it.exp_date], ["库位", it.location]],
          opUser(it.operator));
        return { ok: true, bottle_ids: [bid], bottle_id: bid, product_code: pcode, is_new_product: !s.products[pcode] };
      }

      case "scan": {
        const code = body.code;
        if (!code) err("扫码内容为空", 400);
        try {
          const r = s.scan(code);
          return { ok: true, ...r };
        } catch (e) { err(e.message, 404); }
      }

      case "product_qr": {
        // 品种二维码 6 字段载荷（code 在 query，因码内可能含 "/"）
        const code = opt._code || p.id || "";
        const payload = s.productQR(code);
        if (!payload) err("品种码不存在: " + code, 404);
        return payload;
      }

      case "products": {
        return Object.entries(s.products).map(([code, v]) => ({ code, ...v }));
      }

      case "product": {
        const code = decodeURIComponent(p.id || "");
        const [prod, list] = s.findProduct(code);
        if (!prod) err("品种码不存在: " + code, 404);
        return { code, ...prod };
      }

      case "issue": {
        requirePerm("inout");
        const { action, bottle_id, qty, person, purpose, operator, emptied, note } = body;
        const it = s.items[bottle_id];
        if (action === "use") {
          s.use(bottle_id, qty, person, purpose, operator, { emptied: !!emptied, note });
          dtNotify("整瓶取用", it && it.name,
            [["瓶号", bottle_id], ["领用人", person], ["用途/项目", purpose],
             ["备注", note]], opUser(operator));
        } else if (action === "checkout" || action === "out") {
          s.checkout(bottle_id, person, purpose, operator, note);
          dtNotify("整瓶出库", it && it.name,
            [["瓶号", bottle_id], ["领用人", person], ["用途/项目", purpose],
             ["备注", note]], opUser(operator));
        } else err("未知操作类型", 400);
        return { ok: true };
      }

      case "return": {
        requirePerm("inout");
        const { bottle_id, opened, open_date, operator, note } = body;
        s.returnBack(bottle_id, opened, open_date, operator, note);
        dtNotify("归还入库", s.items[bottle_id] && s.items[bottle_id].name,
          [["瓶号", bottle_id], ["已开封", opened ? "是" : "否"],
           ["备注", note]], opUser(operator));
        return { ok: true };
      }

      case "discard": {
        requirePerm("inout");
        s.discard(body.bottle_id, body.reason, body.operator);
        dtNotify("作废", s.items[body.bottle_id] && s.items[body.bottle_id].name,
          [["瓶号", body.bottle_id], ["作废原因", body.reason]],
          opUser(body.operator));
        return { ok: true };
      }

      case "modify": {
        requirePerm("inout");
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
          requireAdmin();
          for (const k in body) {
            if (k === "users") continue;   // 账号表只能经 /api/users 变更
            s.config[k] = body[k];
          }
          await s.save();
          return { ok: true };
        }
        const out = { ...cfg };
        delete out.users;                 // 口令哈希不下发
        return out;
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
        return locationsPayload(s);
      }

      case "boxes": {
        if (method === "GET") return locationsPayload(s).boxes;
        requireAdmin();
        const newBoxes = (body.boxes || []).map(b => ({
          id: parseInt(b.id), type: b.type === "big" ? "big" : "small",
          rows: Math.max(1, parseInt(b.rows || 6)), cols: Math.max(1, parseInt(b.cols || 10)),
        }));
        // 保护：仍有在库瓶的盒不允许删除
        const occ = s.occupiedLocations();
        const keep = new Set(newBoxes.map(b => s.boxLocPrefix(b)));
        for (const loc of occ) {
          for (const b of s.boxes()) {
            const prefix = s.boxLocPrefix(b);
            if (loc.startsWith(prefix) && !keep.has(prefix)) {
              err(`盒位「${s.boxLabel(b)}」仍有在库瓶，不能删除`, 400);
            }
          }
        }
        await s.saveBoxes(newBoxes);
        return { ok: true };
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
        const printed = await tryBluetoothPrint(image, body.copies || 1);
        if (!printed) {
          printImageViaBrowser(image);
        }
        return { printer: printed ? "bluetooth" : "browser", ok: true };
      }

      case "printers": {
        return await listBluetoothPrinters();
      }

      case "export": {
        // 与远程 /api/export/all 对齐
        if (p.id === "all") return { items: s.items, logs: s.logs, config: (() => { const c = { ...s.config }; delete c.users; return c; })(), products: s.products };
        err("本地模式不支持该导出", 404);
      }

      case "import": {
        // 与远程 /api/import/all 对齐
        if (p.id === "all" && method === "POST") {
          if (body.items) for (const bid in body.items) s.items[bid] = body.items[bid];
          if (body.logs) {
            const seen = new Set(s.logs.map(l => l.log_id));
            for (const l of body.logs) if (!seen.has(l.log_id)) { s.logs.push(l); seen.add(l.log_id); }
          }
          if (body.products) for (const code in body.products) s.products[code] = body.products[code];
          if (body.config) for (const k in body.config) { if (k !== "users") s.config[k] = body.config[k]; }
          await s.save();
          return { ok: true, items: Object.keys(s.items).length, logs: s.logs.length };
        }
        err("未知导入操作", 404);
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

  // ---------- v3.0 数据同步（本地优先，联网自动上传） ----------
  function serverBase() {
    const u = (store && store.config.server_url || "").trim();
    if (!u) return "";
    return /^https?:\/\//i.test(u) ? u.replace(/\/+$/, "") : "http://" + u.replace(/\/+$/, "");
  }

  async function serverLogin(base) {
    if (!_session) throw new Error("未登录，无法同步");
    // 用当前账号口令无法直接重放（本地只存哈希），故同步登录凭据由前端在登录时缓存明文于内存
    const cred = global.__xlb_sync_cred;   // {user, pass} 由 index.html 登录成功时写入（仅内存）
    if (!cred || !cred.user) throw new Error("缺少同步凭据");
    const r = await fetch(base + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: cred.user, pass: cred.pass }),
    });
    if (!r.ok) throw new Error("服务器登录失败: " + r.status);
    const j = await r.json();
    return j.token;
  }

  async function pingServer() {
    const base = serverBase();
    if (!base) return false;
    try {
      const r = await fetch(base + "/api/info", { method: "GET", cache: "no-store" });
      return r.ok;
    } catch (e) { return false; }
  }

  /** 推送本地脏数据到服务器，再拉取服务器增量合并回本地。返回 {ok,msg}。 */
  async function syncNow() {
    const base = serverBase();
    if (!base) return { ok: false, msg: "未配置服务器地址" };
    await init();
    const token = await serverLogin(base);
    const H = { "Content-Type": "application/json", "Authorization": "Bearer " + token };
    // 1) push：全量 items/products + 全量 logs（服务端按 log_id 去重）
    if (api.isDirty()) {
      const pushBody = { items: store.items, logs: store.logs, products: store.products };
      if (_session && _session.role === "admin") pushBody.boxes = store.boxes();
      const pr = await fetch(base + "/api/sync/push", { method: "POST", headers: H, body: JSON.stringify(pushBody) });
      if (!pr.ok) throw new Error("推送失败: " + pr.status);
    }
    // 2) pull：增量流水 + 全量瓶/品种/盒定义
    const since = parseFloat(store.config.sync_last_ts || "0") || 0;
    const rr = await fetch(base + "/api/sync/pull?since=" + since, { headers: H });
    if (!rr.ok) throw new Error("拉取失败: " + rr.status);
    const data = await rr.json();
    for (const bid in (data.items || {})) store.items[bid] = data.items[bid];
    for (const code in (data.products || {})) store.products[code] = data.products[code];
    const seen = new Set(store.logs.map(l => l.log_id));
    for (const l of (data.logs || [])) if (!seen.has(l.log_id)) { store.logs.push(l); seen.add(l.log_id); }
    if (Array.isArray(data.boxes) && data.boxes.length && _session && _session.role === "admin") {
      store.config.boxes = JSON.stringify(data.boxes);
    }
    store.config.sync_last_ts = String(data.ts || Date.now() / 1000);
    await store.save();
    api.markClean();
    return { ok: true, msg: "同步完成", ts: data.ts };
  }

  /** 上传公司服务器（钉钉云端对接地址 company_server_url），静默失败。 */
  async function uploadCompany() {
    const url = (store && store.config.company_server_url || "").trim();
    if (!url) return false;
    const full = /^https?:\/\//i.test(url) ? url : "http://" + url;
    try {
      await fetch(full, {
        method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          source: "小笼包标准溶液管理系统", version: APP_VERSION,
          time: new Date().toISOString().replace("T", " ").slice(0, 19),
          items: store.items, logs: store.logs, products: store.products,
        }),
      });
      return true;
    } catch (e) { return false; }
  }

  // 兼容旧接口名
  async function syncFromServer(base) {
    const r = await fetch(base + "/api/export/all");
    if (!r.ok) throw new Error("同步失败: " + r.status);
    const data = await r.json();
    await global.XLBDB.importJSON(JSON.stringify(data), "merge");
    store = new global.XLBStore(await global.XLBDB.load());
    store.setSaver(d => global.XLBDB.save(d));
    return true;
  }

  async function syncToServer(base) {
    const json = await global.XLBDB.exportJSON();
    const r = await fetch(base + "/api/import/all", { method: "POST", headers: { "Content-Type": "application/json" }, body: json });
    if (!r.ok) throw new Error("上传失败: " + r.status);
    return true;
  }

  // ---------- 写操作脏标记（联网自动同步依据） ----------
  const WRITE_ENDPOINTS = new Set(["receive", "items", "issue", "return", "discard", "modify", "config", "users", "boxes"]);
  const _rawLocalApi = localApi;
  const api = {
    _dirty: false,
    isDirty() { return api._dirty; },
    markClean() { api._dirty = false; },
  };
  api.localApi = async function (path, opt = {}) {
    const r = await _rawLocalApi(path, opt);
    const m = (opt.method || "GET").toUpperCase();
    const p = parsePath(path);
    if ((m === "POST" || m === "DELETE") && p && WRITE_ENDPOINTS.has(p.endpoint)) api._dirty = true;
    return r;
  };

  global.XLBLocalApi = Object.assign(api, {
    init, getStore, setSession, getSession,
    syncNow, pingServer, uploadCompany, serverBase,
    syncFromServer, syncToServer,
  });
})(window);
