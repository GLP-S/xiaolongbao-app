/**
 * 小笼包 —— Canvas 标签渲染（替代 PIL）
 * 输出 dataURL，供浏览器打印或蓝牙打印机使用。
 * 瓶签：溶液名称 + Code128 条码 + 瓶号文字（30×14mm）
 */
(function (global) {
  "use strict";

  // ---------- Code128B 编码（支持可打印 ASCII） ----------
  const CODE128_B_START = 104;
  const CODE128_STOP = 106;
  // 0-9 对应值 16-25；A-Z 33-58；空格 0；其他可打印字符按 ASCII 偏移
  function code128BValue(ch) {
    const c = ch.charCodeAt(0);
    if (c === 32) return 0;                 // space
    if (c >= 48 && c <= 57) return c - 32;  // 0-9 -> 16-25
    if (c >= 65 && c <= 90) return c - 32;  // A-Z -> 33-58
    if (c >= 97 && c <= 122) return c - 32; // a-z -> 65-90
    return c - 32;                          // 其余可打印
  }
  // Code128 模式 B 的条空图案（107 个符号，每个 11 模块）
  // 来源：ISO/IEC 15417，按值索引
  const CODE128_PATTERNS = [
    "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
    "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
    "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
    "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
    "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
    "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
    "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
    "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
    "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
    "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
    "114131","311141","411131","211412","211214","211232","2331112"
  ];

  function code128Encode(text) {
    // 只支持可打印 ASCII
    const values = [];
    for (let i = 0; i < text.length; i++) {
      const v = code128BValue(text[i]);
      if (v < 0 || v > 95) return null;
      values.push(v);
    }
    // 校验位 = (start + sum(i*value_i)) mod 103
    let sum = CODE128_B_START;
    values.forEach((v, i) => { sum += (i + 1) * v; });
    const checksum = sum % 103;
    const symbols = [CODE128_B_START, ...values, checksum, CODE128_STOP];
    let pattern = "";
    for (const s of symbols) {
      pattern += CODE128_PATTERNS[s] || "";
    }
    return pattern; // 字符串，如 "212222..." 表示条空宽度
  }

  /** 在 canvas 上绘制 Code128 条码 */
  function drawBarcode(ctx, text, x, y, w, h) {
    const pattern = code128Encode(text);
    if (!pattern) return;
    const modules = pattern.length;
    const moduleW = w / modules;
    let cx = x;
    let isBar = true;
    for (let i = 0; i < modules; i++) {
      const width = parseInt(pattern[i]) * moduleW;
      if (isBar) { ctx.fillStyle = "#000"; ctx.fillRect(cx, y, width, h); }
      cx += width;
      isBar = !isBar;
    }
  }

  /** 自适应字体大小 */
  function fitText(ctx, text, maxW, startSize, bold, minSize) {
    let size = startSize;
    ctx.font = `${bold ? "bold " : ""}${size}px sans-serif`;
    while (size > minSize && ctx.measureText(text).width > maxW) {
      size -= 0.5;
      ctx.font = `${bold ? "bold " : ""}${size}px sans-serif`;
    }
    return size;
  }

  /** 渲染瓶签，返回 dataURL */
  function renderLabel(item, cfg, dpi) {
    dpi = dpi || parseInt(cfg.label_dpi || "203");
    const wMm = parseFloat(cfg.label_w_mm || "30");
    const hMm = parseFloat(cfg.label_h_mm || "14");
    const W = Math.max(1, Math.round(wMm / 25.4 * dpi));
    const H = Math.max(1, Math.round(hMm / 25.4 * dpi));
    const u = dpi / 25.4; // 每毫米像素

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#000";

    const mx = Math.max(2, Math.round(0.9 * u));
    const mt = Math.max(2, Math.round(0.7 * u));
    const mb = Math.max(1, Math.round(0.4 * u));
    const innerW = W - 2 * mx;

    // 1) 名称
    const name = String(item.name || "");
    const nameSize = fitText(ctx, name, innerW, Math.max(9, Math.round(3.4 * u)), true, Math.max(8, Math.round(1.7 * u)));
    ctx.font = `bold ${nameSize}px sans-serif`;
    ctx.textBaseline = "top";
    const nw = ctx.measureText(name).width;
    ctx.fillText(name, (W - nw) / 2, mt);
    const nameBottom = mt + nameSize;

    // 2) 代码文字
    const code = String(item.bottle_id || "");
    const codeSize = fitText(ctx, code, innerW, Math.max(8, Math.round(2.7 * u)), true, Math.max(7, Math.round(1.5 * u)));
    ctx.font = `bold ${codeSize}px monospace`;
    const cw = ctx.measureText(code).width;
    const codeY = H - mb - codeSize;
    ctx.fillText(code, (W - cw) / 2, codeY);

    // 3) 条码
    const gap = Math.max(1, Math.round(0.4 * u));
    const barH = Math.max(3, codeY - gap - (nameBottom + gap));
    drawBarcode(ctx, code, mx, nameBottom + gap, innerW, barH);

    return canvas.toDataURL("image/png");
  }

  /** 渲染品种标签（QR 简化版：用条码代替，避免外部 QR 库依赖） */
  function renderProductLabel(product, cfg, dpi) {
    return renderLabel({ name: product.name, bottle_id: product.code }, cfg, dpi);
  }

  global.XLBLabel = { renderLabel, renderProductLabel, code128Encode };
})(window);
