// 小笼包 PWA Service Worker
// ① 静态壳：CacheFirst（离线也能打开 App）
// ② API 读取(GET)：NetworkFirst（在线取最新→压缩→加密写缓存，离线/超时回退并解密→解压）
// ③ 本地缓存：JSON/文本类先 gzip 压缩再 AES-GCM 256 加密；图片等已压缩格式只加密
// ④ 原生 App 内按用户配置的服务器地址，把 /api 请求重写到真实服务端
const SHELL_CACHE = "xlb-shell-v8";
const DATA_CACHE = "xlb-data-v4";
const ALL_CACHES = [SHELL_CACHE, DATA_CACHE];
const ASSETS = [
  "./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png",
  "./store.js", "./db.js", "./label.js", "./api_local.js", "./bluetooth_print.js"
];

// 页面通过 IndexedDB(kv, key=server_base) 共享地址；null 表示尚未读取
let swBase = null;
async function getSwBase(force) {
  if (!force && swBase !== null) return swBase;
  try {
    const db = await secOpenDB();
    const v = await secIDB(db, "readonly", os => os.get("server_base"));
    swBase = typeof v === "string" ? v.replace(/\/+$/, "") : "";
  } catch (e) { swBase = ""; }
  return swBase;
}

const cmpSupported = typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
async function gzipBytes(bytes) {
  if (!cmpSupported) return bytes;
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzipBytes(bytes) {
  if (!cmpSupported || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/* ---------- 加密层（与 index.html 相同契约，共用密钥库） ---------- */
const SEC_PREFIX = "E1$", SEC_DB = "xlb-sec-v1", SEC_STORE = "kv", SEC_KEYID = "aesgcm256-v1";
function secOpenDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(SEC_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(SEC_STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function secIDB(db, mode, fn) {
  return new Promise((res, rej) => {
    const tx = db.transaction(SEC_STORE, mode), os = tx.objectStore(SEC_STORE);
    const rq = fn(os);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function secGetKey() {
  const db = await secOpenDB();
  const existed = await secIDB(db, "readonly", os => os.get(SEC_KEYID));
  if (existed) return existed;
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await secIDB(db, "readwrite", os => os.put(key, SEC_KEYID));
  return key;
}
function b64Encode(u8) {
  let bin = "", CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(bin);
}
function b64Decode(s) {
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function encBytes(bytes) {
  const key = await secGetKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes);
  return SEC_PREFIX + b64Encode(iv) + "." + b64Encode(new Uint8Array(ct));
}
async function decToBytes(str) {
  const body = str.slice(SEC_PREFIX.length), dot = body.indexOf(".");
  const iv = b64Decode(body.slice(0, dot));
  const ct = b64Decode(body.slice(dot + 1));
  const key = await secGetKey();
  return await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
}

/* ---------- 压缩+加密写入 / 解密+解压读取缓存 ---------- */
async function encryptedPut(cache, req, resp) {
  const origCT = resp.headers.get("content-type") || "application/octet-stream";
  const raw = new Uint8Array(await resp.clone().arrayBuffer());
  // 仅对文本类压缩；图片/二进制已压缩，gzip 反而增大
  const compressible = /json|text|javascript|xml|svg/i.test(origCT);
  let payload = raw, cmp = "raw";
  if (compressible && cmpSupported) {
    const z = await gzipBytes(raw);
    if (z.length < raw.length) { payload = z; cmp = "gzip"; }
  }
  const d = await encBytes(payload);
  const wrap = JSON.stringify({ xlbenc: 1, ct: origCT, cmp, rawsize: raw.length, d });
  await cache.put(req, new Response(wrap, { headers: { "Content-Type": "application/x-xlbcache" } }));
}
async function decryptedMatch(cache, req) {
  const cached = await cache.match(req);
  if (!cached) return null;
  const text = await cached.text();
  try {
    const w = JSON.parse(text);
    if (w && w.xlbenc) {
      let pt = await decToBytes(w.d);
      if (w.cmp === "gzip") pt = await gunzipBytes(new Uint8Array(pt));
      return new Response(pt, { headers: { "Content-Type": w.ct || "application/json" } });
    }
  } catch (e) { /* 非加密包原样返回 */ }
  return cached;
}

self.addEventListener("install", e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(ks =>
      Promise.all(ks.filter(k => !ALL_CACHES.includes(k)).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// 页面可 postMessage：CLEAR_DATA 清数据缓存；SET_BASE 更新服务器地址
self.addEventListener("message", e => {
  if (e.data && e.data.type === "CLEAR_DATA") {
    e.waitUntil(caches.delete(DATA_CACHE));
  }
  if (e.data && e.data.type === "SET_BASE") {
    swBase = (e.data.base || "").replace(/\/+$/, "");
  }
});

// ---- API GET：网络优先，3 秒超时，失败回退加密缓存 ----
async function networkFirst(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(req, { signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.ok) await encryptedPut(cache, req, resp);
    return resp;
  } catch (err) {
    const decrypted = await decryptedMatch(cache, req);
    if (decrypted) return decrypted;
    return offlineFallback(req);
  }
}

// 无缓存时的离线兜底响应，保证前端不崩
function offlineFallback(req) {
  const u = new URL(req.url);
  const listEndpoints = ["/api/items", "/api/logs", "/api/products", "/api/printers"];
  if (listEndpoints.some(p => u.pathname.startsWith(p))) {
    return new Response("[]", { headers: { "Content-Type": "application/json" } });
  }
  const body = JSON.stringify({ offline: true, msg: "当前离线且本地无此数据缓存" });
  return new Response(body, { status: 503, headers: { "Content-Type": "application/json" } });
}

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    e.respondWith((async () => {
      // 原生 App：读取配置的服务器地址并把请求重写为绝对地址
      const base = await getSwBase();
      let target = e.request;
      if (base) target = new Request(base + url.pathname + url.search, e.request);
      if (e.request.method === "GET") return networkFirst(target);
      return fetch(target);
    })());
    return;
  }

  e.respondWith(
    caches.match(e.request).then(r =>
      r || fetch(e.request).then(resp => {
        if (resp.ok && e.request.method === "GET") {
          const copy = resp.clone();
          caches.open(SHELL_CACHE).then(c => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
