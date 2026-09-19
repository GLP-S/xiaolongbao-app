/**
 * 小笼包 —— 蓝牙标签打印模块
 * 基于 @capacitor-community/bluetooth-le，发送 ESC/POS 位图指令打印标签。
 * 兼容常见 58mm / 标签打印机（汉印、佳博、得力、芯烨等）。
 */
(function (global) {
  "use strict";

  const BT = global.Capacitor && global.Capacitor.Plugins && global.Capacitor.Plugins.BluetoothLe;

  let connectedDevice = null;
  let writeChar = null;

  /** 检查是否支持蓝牙 */
  function isSupported() { return !!BT; }

  /** 初始化并请求权限 */
  async function init() {
    if (!BT) throw new Error("当前环境不支持蓝牙打印");
    try { await BT.initialize(); } catch (e) { /* 已初始化 */ }
    try {
      await BT.requestPermissions({ permissions: ["scan", "connect"] });
    } catch (e) {
      // Android 12+ 需要运行时权限；若被拒则抛出
      throw new Error("蓝牙权限被拒绝，请在系统设置中授予");
    }
  }

  /** 搜索附近蓝牙设备（10秒） */
  async function scanDevices(onDevice) {
    await init();
    const devices = [];
    await BT.requestLEScan({ allowDuplicates: false, scanMode: 2 });
    BT.addListener("onScanResult", result => {
      const d = result.device;
      if (d.name && !devices.find(x => x.deviceId === d.deviceId)) {
        devices.push(d);
        if (onDevice) onDevice(d);
      }
    });
    // 10 秒后停止扫描
    await new Promise(r => setTimeout(r, 10000));
    try { await BT.stopLEScan(); } catch (e) {}
    return devices;
  }

  /** 连接到指定设备，找到可写特征值 */
  async function connect(deviceId) {
    await BT.connect({ deviceId });
    connectedDevice = deviceId;
    // 发现服务，寻找可写特征值
    const services = await BT.getServices({ deviceId });
    for (const svc of services.services) {
      for (const ch of svc.characteristics) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) {
          writeChar = { service: svc.uuid, characteristic: ch.uuid };
          return { deviceId, service: svc.uuid, char: ch.uuid };
        }
      }
    }
    throw new Error("未找到可写特征值，该设备可能不支持打印");
  }

  /** 断开连接 */
  async function disconnect() {
    if (connectedDevice) {
      try { await BT.disconnect({ deviceId: connectedDevice }); } catch (e) {}
      connectedDevice = null;
      writeChar = null;
    }
  }

  /** 获取连接状态 */
  function isConnected() { return !!connectedDevice; }

  // ---------- ESC/POS 位图编码 ----------
  /** dataURL → 黑白二值化 → ESC/POS 光栅位图指令 */
  async function imageToEscPos(dataUrl, maxWidthPx) {
    const img = await loadImage(dataUrl);
    // 缩放到打印机宽度（58mm 打印机约 384 点）
    const w = Math.min(maxWidthPx || 384, img.width);
    const scale = w / img.width;
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const imgData = ctx.getImageData(0, 0, w, h);

    // 二值化（灰度 > 128 为白）
    const bytesPerRow = Math.ceil(w / 8);
    const raster = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x += 8) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) {
          const px = x + bit;
          if (px < w) {
            const idx = (y * w + px) * 4;
            const gray = (imgData.data[idx] + imgData.data[idx + 1] + imgData.data[idx + 2]) / 3;
            if (gray < 128) b |= (0x80 >> bit);
          }
        }
        raster.push(b);
      }
    }

    // ESC/POS GS v 0 光栅位图指令：GS(L 或 GS v 0
    // 简化版：用 ESC * 位图模式（适用于大多数打印机）
    const cmd = [];
    // 初始化
    cmd.push(0x1B, 0x40); // ESC @
    // 对齐居中
    cmd.push(0x1B, 0x61, 0x01); // ESC a 1
    // GS v 0 m xL xH yL yH d1...dk
    cmd.push(0x1D, 0x76, 0x30, 0x00); // GS v 0 m=0(8点单密度)
    const xL = bytesPerRow & 0xFF;
    const xH = (bytesPerRow >> 8) & 0xFF;
    const yL = h & 0xFF;
    const yH = (h >> 8) & 0xFF;
    cmd.push(xL, xH, yL, yH);
    cmd.push(...raster);
    // 走纸切纸
    cmd.push(0x1D, 0x56, 0x42, 0x00); // GS V B 0 (切纸)
    return new Uint8Array(cmd);
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /** 发送数据到打印机（分包，每包 512 字节） */
  async function writeData(uint8) {
    if (!connectedDevice || !writeChar) throw new Error("打印机未连接");
    const chunkSize = 512;
    for (let i = 0; i < uint8.length; i += chunkSize) {
      const chunk = uint8.slice(i, i + chunkSize);
      await BT.write({
        deviceId: connectedDevice,
        service: writeChar.service,
        characteristic: writeChar.characteristic,
        value: Array.from(chunk)
      });
      await new Promise(r => setTimeout(r, 50)); // 防止缓冲区溢出
    }
  }

  /** 打印标签图片 */
  async function printLabel(dataUrl, copies = 1) {
    if (!connectedDevice) throw new Error("请先连接蓝牙打印机");
    const esc = await imageToEscPos(dataUrl);
    for (let i = 0; i < copies; i++) {
      await writeData(esc);
      if (i < copies - 1) await new Promise(r => setTimeout(r, 300));
    }
    return true;
  }

  /** 测试打印（打印一行文字） */
  async function printTest() {
    if (!connectedDevice) throw new Error("请先连接蓝牙打印机");
    const text = "小笼包标签打印测试\n\n";
    const enc = new TextEncoder().encode(text);
    const cmd = new Uint8Array([0x1B, 0x40, 0x1B, 0x61, 0x01, ...enc, 0x1D, 0x56, 0x42, 0x00]);
    await writeData(cmd);
    return true;
  }

  global.XLBBluetoothPrint = {
    isSupported, init, scanDevices, connect, disconnect,
    isConnected, printLabel, printTest
  };
})(window);
