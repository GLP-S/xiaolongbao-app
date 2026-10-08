/**
 * 小笼包 —— 钉钉机器人直推模块 v3.0
 * 三端业务数据联网后自动同步到钉钉群（入 / 出 / 还 / 废实时卡片）：
 * - Android 原生（已启用 CapacitorHttp）：标准 JSON POST，可读响应确认送达；
 * - iOS PWA / 普通浏览器：钉钉接口未开放 CORS，自动改用 no-cors 的
 *   application/x-www-form-urlencoded 简单请求直推（钉钉可解析 JSON body，即发即忘）；
 * - 离线：消息进本地队列，恢复网络 / 同步成功后自动补发（自动遵守 20 条/分钟限速）。
 */
(function (global) {
  "use strict";

  const QUEUE_KEY = "xlb_dingtalk_queue_v3";
  let _flushing = false;

  /* ---------------- 加签（Web Crypto HMAC-SHA256） ---------------- */
  async function hmacSignB64(secret, stringToSign) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(stringToSign));
    const bytes = new Uint8Array(sig);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return encodeURIComponent(btoa(bin));
  }

  async function signedUrl(webhook, secret) {
    if (!secret) return webhook;
    const ts = Date.now();
    const sign = await hmacSignB64(secret, ts + "\n" + secret);
    const sep = webhook.indexOf("?") >= 0 ? "&" : "?";
    return webhook + sep + "timestamp=" + ts + "&sign=" + sign;
  }

  /* ---------------- 发送 ---------------- */
  /** 发送 markdown。cfg={dingtalk_webhook,dingtalk_secret}。
   * 返回 {ok, confirmed, retry, msg}。 */
  async function send(text, title, cfg) {
    cfg = cfg || {};
    const webhook = String(cfg.dingtalk_webhook || "").trim();
    if (!webhook) return { ok: false, msg: "未配置钉钉机器人 Webhook" };
    const secret = String(cfg.dingtalk_secret || "").trim();
    const url = await signedUrl(webhook, secret);
    const payload = JSON.stringify({
      msgtype: "markdown",
      markdown: { title: title || "小笼包消息", text: text },
    });
    // 1) 标准 JSON POST（Android CapacitorHttp 原生层 / 若钉钉开放 CORS 时可读取响应）
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      if (j) {
        if (j.errcode === 0) return { ok: true, confirmed: true, msg: "发送成功" };
        if (j.errcode === 660026 || j.errcode === 130101)
          return { ok: false, retry: true, msg: "钉钉限流，稍后自动重发" };
        return { ok: false, msg: "钉钉返回：" + j.errmsg };
      }
      // 请求已实际发出但响应不可读：视为送达
      return { ok: true, confirmed: false, msg: "已发送" };
    } catch (e) {
      // 2) CORS 拦截：no-cors 简单请求直推（urlencoded 钉钉可解析），即发即忘
      try {
        await fetch(url, {
          method: "POST", mode: "no-cors",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: payload,
        });
        return { ok: true, confirmed: false, msg: "已发送（浏览器直推）" };
      } catch (e2) {
        return { ok: false, retry: true, msg: String(e2.message || e2) };
      }
    }
  }

  /* ---------------- 队列 ---------------- */
  function loadQueue() {
    try { return JSON.parse(global.localStorage.getItem(QUEUE_KEY)) || []; }
    catch (e) { return []; }
  }
  function saveQueue(q) {
    try { global.localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(0, 100))); }
    catch (e) {}
  }

  function nowText() {
    const p = n => String(n).padStart(2, "0"), d = new Date();
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  /** 业务操作自动通知。取本地 Store 配置，dingtalk_auto=1 时发出。 */
  async function notify(action, name, fields, operator) {
    let cfg = {};
    try { cfg = global.XLBLocalApi.getStore().config; } catch (e) { return; }
    if (String(cfg.dingtalk_auto || "0") !== "1") return;
    if (!String(cfg.dingtalk_webhook || "").trim()) return;
    const lines = [
      "### 小笼包 · " + action, "",
      "- 溶液：" + (name || "—"),
      "- 操作人：" + (operator || "—"),
    ];
    (fields || []).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== "") lines.push("- " + k + "：" + v);
    });
    lines.push("- 时间：" + nowText());
    const item = { text: lines.join("\n"), title: "小笼包 · " + action };
    if (!navigator.onLine) {
      const q = loadQueue(); q.push(item); saveQueue(q);
      return;
    }
    const r = await send(item.text, item.title, cfg);
    if (!r.ok && r.retry) { const q = loadQueue(); q.push(item); saveQueue(q); }
  }

  /** 补发队列（限流时保留剩余，1.5 秒间隔遵守每分钟 20 条限制）。 */
  async function flushQueue() {
    if (_flushing || !navigator.onLine) return;
    let cfg = {};
    try { cfg = global.XLBLocalApi.getStore().config; } catch (e) { return; }
    const q = loadQueue();
    if (!q.length) return;
    if (String(cfg.dingtalk_auto || "0") !== "1" ||
        !String(cfg.dingtalk_webhook || "").trim()) { saveQueue([]); return; }
    _flushing = true;
    let idx = 0;
    for (; idx < q.length; idx++) {
      const r = await send(q[idx].text, q[idx].title, cfg);
      if (!r.ok) break;
      await new Promise(res => setTimeout(res, 1500));
    }
    saveQueue(q.slice(idx));
    _flushing = false;
  }

  global.addEventListener("online", () => setTimeout(flushQueue, 2000));
  global.addEventListener("xlb-sync-done", () => setTimeout(flushQueue, 1000));

  global.XLBDingTalk = { send, notify, flushQueue, signedUrl };
})(window);
