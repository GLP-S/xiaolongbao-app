/* 小笼包 v3.12 摄像头扫码模块（平板自带相机代替扫码枪）
 * - 优先使用系统 BarcodeDetector（Android WebView / Chrome）；
 *   iOS Safari 等不支持时自动回退到内置 zxing-js（已随壳预缓存，离线可用）。
 * - 仅负责"取景→解码→回填文本"，业务管线零改动：
 *   onScan 回调把文本写入原输入框并触发原有 Enter 同款处理函数。
 * 用法：XLBCamScan.open({title, continuous, onScan(text)})
 *   continuous=true 连续扫码（盘点用），同一码 2.5 秒内不重复触发。 */
"use strict";
(function () {
  var BUSY = false;                 // 单例：取景层同时只开一个
  var FMTS = ["code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e",
              "itf", "qr_code", "data_matrix", "pdf_417", "aztec"];
  var ZX_FMT = { code_128: "CODE_128", code_39: "CODE_39", ean_13: "EAN_13",
    ean_8: "EAN_8", upc_a: "UPC_A", upc_e: "UPC_E", itf: "ITF",
    qr_code: "QR_CODE", data_matrix: "DATA_MATRIX", pdf_417: "PDF_417",
    aztec: "AZTEC" };

  /* ---- 识别成功蜂鸣（WebAudio，需在用户手势后创建） ---- */
  var actx = null;
  function beep() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.18, actx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.16);
      o.connect(g); g.connect(actx.destination);
      o.start(); o.stop(actx.currentTime + 0.17);
    } catch (e) {}
  }

  /* ---- 系统原生检测器（可用则性能最好） ---- */
  function nativeDetector() {
    if (!("BarcodeDetector" in window)) return Promise.resolve(null);
    try {
      if (window.BarcodeDetector.getSupportedFormats) {
        return window.BarcodeDetector.getSupportedFormats().then(function (sup) {
          var use = FMTS.filter(function (f) { return sup.indexOf(f) >= 0; });
          return use.length ? new window.BarcodeDetector({ formats: use }) : null;
        }).catch(function () { return null; });
      }
      return Promise.resolve(new window.BarcodeDetector({ formats: FMTS }));
    } catch (e) { return Promise.resolve(null); }
  }

  /* ---- zxing 回退解码器（iOS Safari 等） ---- */
  function zxingDecoder() {
    if (!window.ZXing) return null;
    try {
      var Z = window.ZXing;
      var reader = new Z.MultiFormatReader();
      var hints = new Map(), formats = [];
      for (var k in ZX_FMT) {
        if (Z.BarcodeFormat && Z.BarcodeFormat[ZX_FMT[k]] != null)
          formats.push(Z.BarcodeFormat[ZX_FMT[k]]);
      }
      if (Z.DecodeHintType) {
        hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, formats);
        hints.set(Z.DecodeHintType.TRY_HARDER, true);
      }
      reader.setHints(hints);
      return {
        decode: function (canvas) {
          try {
            var lum = new Z.HTMLCanvasElementLuminanceSource(canvas);
            var r = reader.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(lum)));
            if (reader.reset) reader.reset();
            return r ? r.getText() : null;
          } catch (e) { return null; }
        }
      };
    } catch (e) { return null; }
  }

  function open(opts) {
    opts = opts || {};
    if (BUSY) { close(); return; }
    BUSY = true;

    var layer = document.createElement("div");
    layer.className = "cam-layer";
    layer.innerHTML =
      '<div class="cam-top"><div class="t"></div>' +
      '<button type="button" class="btn secondary btn-sm" id="xc_close">关闭</button></div>' +
      '<div class="cam-view"><video id="xc_video" playsinline muted autoplay></video>' +
      '<div class="cam-frame"></div><div class="cam-flash" id="xc_flash"></div></div>' +
      '<div class="cam-foot"><div class="st" id="xc_st">正在启动摄像头…</div></div>';
    layer.querySelector(".t").textContent = opts.title || "摄像头扫码";
    document.body.appendChild(layer);

    var video = layer.querySelector("#xc_video");
    var st = layer.querySelector("#xc_st");
    var flash = layer.querySelector("#xc_flash");
    var stream = null, timer = null, dead = false;
    var det = null, zx = null;
    var canvas = document.createElement("canvas");
    var ctx2d = canvas.getContext("2d", { willReadFrequently: true });
    var lastHit = 0, lastText = "", lastTextAt = 0;

    function setStatus(s) { if (!dead) st.textContent = s; }

    function close() {
      if (dead) return;
      dead = true;
      if (timer) { clearInterval(timer); timer = null; }
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      if (actx) { try { actx.close(); } catch (e) {} actx = null; }
      var l = document.querySelector(".cam-layer");
      if (l) l.remove();
      document.removeEventListener("keydown", onKey);
      BUSY = false;
    }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    layer.querySelector("#xc_close").addEventListener("click", close);

    function hit(text) {
      if (!text) return;
      var now = Date.now();
      if (opts.continuous) {
        if (text === lastText && now - lastTextAt < 2500) return;  // 连扫去重
        lastText = text; lastTextAt = now;
        if (now - lastHit < 800) return;                            // 冷却
      } else if (now - lastHit < 400) return;
      lastHit = now;
      beep();
      if (flash) { flash.style.opacity = ".55"; setTimeout(function () { flash.style.opacity = "0"; }, 120); }
      setStatus("已识别：" + text + (opts.continuous ? "（继续扫码…）" : ""));
      if (!opts.continuous) setTimeout(close, 260);
      if (typeof opts.onScan === "function") opts.onScan(text);
    }

    function tick() {
      if (dead || video.readyState < 2 || !video.videoWidth) return;
      var now = Date.now();
      if (now - lastHit < (opts.continuous ? 500 : 400)) return;
      var w = video.videoWidth, h = video.videoHeight;
      var cap = 720;                                    // 解码降采样，兼顾速度
      var dw = w > cap ? cap : w, dh = Math.round(h * dw / w);
      if (canvas.width !== dw || canvas.height !== dh) {
        canvas.width = dw; canvas.height = dh;
      }
      ctx2d.drawImage(video, 0, 0, dw, dh);
      if (det) {
        det.detect(video).then(function (codes) {
          if (dead || !codes || !codes.length) return;
          hit(codes[0].rawValue || "");
        }).catch(function () {});
      } else if (zx) {
        var t = zx.decode(canvas);
        if (t) hit(t);
      }
    }

    function start() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setStatus("当前环境不支持摄像头（需 HTTPS / 系统相机权限）"); return;
      }
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" },
                 width: { ideal: 1280 }, height: { ideal: 720 } }
      }).then(function (s) {
        if (dead) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s;
        video.srcObject = s;
        return video.play().catch(function () {}).then(function () {
          return nativeDetector();
        }).then(function (d) {
          if (dead) return;
          if (d) { det = d; setStatus((opts.continuous ? "连续扫码中" : "扫码中") + "…对准条码自动识别"); }
          else {
            zx = zxingDecoder();
            if (zx) setStatus((opts.continuous ? "连续扫码中" : "扫码中") + "…对准条码自动识别");
            else { setStatus("浏览器缺少解码器，无法摄像头扫码"); return; }
          }
          timer = setInterval(tick, 220);
        });
      }).catch(function (e) {
        var m = e && e.name === "NotAllowedError" ? "相机权限被拒绝"
              : e && e.name === "NotFoundError" ? "未找到可用摄像头"
              : "摄像头启动失败" + (e && e.name ? "（" + e.name + "）" : "");
        setStatus(m + "：请检查系统相机权限，或继续使用扫码枪 / 手动输入瓶号。");
      });
    }
    start();
  }

  window.XLBCamScan = { open: open };
})();
