/**
 * 小笼包 —— Canvas 标签渲染（替代 PIL）
 * 输出 dataURL，供浏览器打印或蓝牙打印机使用。
 * 瓶签：溶液名称 + Code128 条码 + 瓶号文字（默认 30×14mm）
 * 品种签：溶液名称（仅一次）+ 二维码（6 字段动态内容，默认 40×30mm）
 */
(function (global) {
  "use strict";

  // ==========================================================================
  // Code128B 编码（瓶签条码，支持可打印 ASCII）
  // ==========================================================================
  const CODE128_B_START = 104;
  const CODE128_STOP = 106;
  function code128BValue(ch) {
    const c = ch.charCodeAt(0);
    if (c === 32) return 0;                 // space
    if (c >= 48 && c <= 57) return c - 32;  // 0-9 -> 16-25
    if (c >= 65 && c <= 90) return c - 32;  // A-Z -> 33-58
    if (c >= 97 && c <= 122) return c - 32; // a-z -> 65-90
    return c - 32;                          // 其余可打印
  }
  // Code128 模式 B 的条空图案（107 个符号，每个 11 模块）ISO/IEC 15417
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
    const values = [];
    for (let i = 0; i < text.length; i++) {
      const v = code128BValue(text[i]);
      if (v < 0 || v > 95) return null;
      values.push(v);
    }
    let sum = CODE128_B_START;
    values.forEach((v, i) => { sum += (i + 1) * v; });
    const checksum = sum % 103;
    const symbols = [CODE128_B_START, ...values, checksum, CODE128_STOP];
    let pattern = "";
    for (const s of symbols) {
      pattern += CODE128_PATTERNS[s] || "";
    }
    return pattern;
  }

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

  function fitText(ctx, text, maxW, startSize, bold, minSize) {
    let size = startSize;
    ctx.font = `${bold ? "bold " : ""}${size}px sans-serif`;
    while (size > minSize && ctx.measureText(text).width > maxW) {
      size -= 0.5;
      ctx.font = `${bold ? "bold " : ""}${size}px sans-serif`;
    }
    return size;
  }

  // ==========================================================================
  // 纯 JS QR Code 编码器（字节模式 / UTF-8 / 自动版本 1-40 / 自动掩码）
  // 算法与表来自 ISO/IEC 18004，经主流 qrcode 管线逐位核对。
  // ==========================================================================

  // 各版本总码字数（数据+纠错），索引=版本
  const QR_CODEWORDS_COUNT = [
    0,
    26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
    404, 466, 532, 581, 655, 733, 815, 901, 991, 1085,
    1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921, 2051, 2185,
    2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706
  ];
  // 纠错块数量（L M Q H，按版本平铺）
  const QR_EC_BLOCKS = [
    1,1,1,1, 1,1,1,1, 1,1,2,2, 1,2,2,4, 1,2,4,4,
    2,4,4,4, 2,4,6,5, 2,4,6,6, 2,5,8,8, 4,5,8,8,
    4,5,8,11, 4,8,10,11, 4,9,12,16, 4,9,16,16, 6,10,12,18,
    6,10,17,16, 6,11,16,19, 6,13,18,21, 7,14,21,25, 8,16,20,25,
    8,17,23,25, 9,17,23,34, 9,18,25,30, 10,20,27,32, 12,21,29,35,
    12,23,34,37, 12,25,34,40, 13,26,35,42, 14,28,38,45, 15,29,40,48,
    16,31,43,51, 17,33,45,54, 18,35,48,57, 19,37,51,60, 19,38,53,63,
    20,40,56,66, 21,43,59,70, 22,45,62,74, 24,47,65,77, 25,49,68,81
  ];
  // 纠错码字数总计（L M Q H，按版本平铺）
  const QR_EC_TOTAL = [
    7,10,13,17, 10,16,22,28, 15,26,36,44, 20,36,52,64, 26,48,72,88,
    36,64,96,112, 40,72,108,130, 48,88,132,156, 60,110,160,192, 72,130,192,224,
    80,150,224,264, 96,176,260,308, 104,198,288,352, 120,216,320,384, 132,240,360,432,
    144,280,408,480, 168,308,448,532, 180,338,504,588, 196,364,546,650, 224,416,600,700,
    224,442,644,750, 252,476,690,816, 270,504,750,900, 300,560,810,960, 312,588,870,1050,
    336,644,952,1110, 360,700,1020,1200, 390,728,1050,1260, 420,784,1140,1350, 450,812,1200,1440,
    480,868,1290,1530, 510,924,1350,1620, 540,980,1440,1710, 570,1036,1530,1800, 570,1064,1590,1890,
    600,1120,1680,1980, 630,1204,1770,2100, 660,1260,1860,2220, 720,1316,1950,2310, 750,1372,2040,2430
  ];

  const EC_IDX={L:0,M:1,Q:2,H:3};
  const EC_BIT={L:1,M:0,Q:3,H:2};   // 格式信息中的 EC 指示位
  function qrSize(v){ return v*4+17; }

  function utf8Bytes(s){
    if(typeof TextEncoder!=="undefined") return new TextEncoder().encode(s);
    const out=[];
    for(let i=0;i<s.length;i++){
      let c=s.charCodeAt(i);
      if(c>=0xD800&&c<=0xDBFF&&i+1<s.length){
        const c2=s.charCodeAt(i+1);
        if(c2>=0xDC00&&c2<=0xDFFF){c=0x10000+((c-0xD800)<<10)+(c2-0xDC00);i++;}
      }
      if(c<0x80) out.push(c);
      else if(c<0x800) out.push(0xC0|(c>>6),0x80|(c&63));
      else if(c<0x10000) out.push(0xE0|(c>>12),0x80|((c>>6)&63),0x80|(c&63));
      else out.push(0xF0|(c>>18),0x80|((c>>12)&63),0x80|((c>>6)&63),0x80|(c&63));
    }
    return new Uint8Array(out);
  }

  // ---- GF(256)，本原多项式 0x11D ----
  const GF_EXP=new Uint8Array(512), GF_LOG=new Uint8Array(256);
  (function(){
    let x=1;
    for(let i=0;i<255;i++){
      GF_EXP[i]=x; GF_LOG[x]=i;
      x<<=1;
      if(x&0x100) x^=0x11D;
    }
    for(let i=255;i<512;i++) GF_EXP[i]=GF_EXP[i-255];
  })();
  function gfMul(x,y){
    if(x===0||y===0)return 0;
    return GF_EXP[GF_LOG[x]+GF_LOG[y]];
  }

  // ---- 多项式运算 ----
  function polyMod(divident, divisor){
    let result=new Uint8Array(divident);
    while(result.length-divisor.length>=0){
      const coeff=result[0];
      for(let i=0;i<divisor.length;i++) result[i]^=gfMul(divisor[i],coeff);
      let off=0;
      while(off<result.length&&result[off]===0)off++;
      result=result.slice(off);
    }
    return result;
  }
  function ecPolynomial(degree){
    let poly=new Uint8Array([1]);
    for(let i=0;i<degree;i++){
      const next=new Uint8Array(poly.length+1);
      for(let j=0;j<poly.length;j++){
        next[j]^=gfMul(poly[j],1);
        next[j+1]^=gfMul(poly[j],GF_EXP[i]);
      }
      poly=next;
    }
    return poly;
  }

  // ---- 位缓冲 ----
  function BitBuffer(){ this.buffer=[]; this.length=0; }
  BitBuffer.prototype.put=function(num,len){
    for(let i=0;i<len;i++) this.putBit(((num>>>(len-i-1))&1)===1);
  };
  BitBuffer.prototype.putBit=function(bit){
    const i=Math.floor(this.length/8);
    if(this.buffer.length<=i)this.buffer.push(0);
    if(bit)this.buffer[i]|=(0x80>>>(this.length%8));
    this.length++;
  };
  BitBuffer.prototype.bits=function(){return this.length;};

  // ---- 位矩阵 ----
  function BitMatrix(size){
    this.size=size;
    this.data=new Uint8Array(size*size);
    this.reservedBit=new Uint8Array(size*size);
  }
  BitMatrix.prototype.set=function(row,col,value,reserved){
    const i=row*this.size+col;
    this.data[i]=value?1:0;
    if(reserved)this.reservedBit[i]=1;
  };
  BitMatrix.prototype.get=function(row,col){return this.data[row*this.size+col];};
  BitMatrix.prototype.xor=function(row,col,value){
    if(value)this.data[row*this.size+col]^=1;
  };
  BitMatrix.prototype.isReserved=function(row,col){return this.reservedBit[row*this.size+col];};

  // ---- 功能图案 ----
  function setupFinderPattern(matrix){
    const size=matrix.size;
    const pos=[[0,0],[size-7,0],[0,size-7]];
    for(const [row,col] of pos){
      for(let r=-1;r<=7;r++){
        if(row+r<0||size<=row+r)continue;
        for(let c=-1;c<=7;c++){
          if(col+c<0||size<=col+c)continue;
          const dark=(r>=0&&r<=6&&(c===0||c===6))||
                     (c>=0&&c<=6&&(r===0||r===6))||
                     (r>=2&&r<=4&&c>=2&&c<=4);
          matrix.set(row+r,col+c,dark,true);
        }
      }
    }
  }
  function setupTimingPattern(matrix){
    const size=matrix.size;
    for(let r=8;r<size-8;r++){
      const v=r%2===0;
      matrix.set(r,6,v,true);
      matrix.set(6,r,v,true);
    }
  }
  // 对齐图案中心坐标（特殊情况 size=145 即 v32）
  function alignmentCoords(version){
    if(version===1)return [];
    const count=Math.floor(version/7)+2;
    const size=qrSize(version);
    const intervals=size===145?26:Math.ceil((size-13)/(2*count-2))*2;
    const positions=[size-7];
    for(let i=1;i<count-1;i++)positions[i]=positions[i-1]-intervals;
    positions.push(6);
    return positions.reverse();
  }
  function setupAlignmentPattern(matrix,version){
    const coords=alignmentCoords(version);
    const n=coords.length;
    for(let i=0;i<n;i++){
      for(let j=0;j<n;j++){
        // 与三个探测图案重叠的位置跳过
        if((i===0&&j===0)||(i===0&&j===n-1)||(i===n-1&&j===0))continue;
        const row=coords[i],col=coords[j];
        for(let r=-2;r<=2;r++){
          for(let c=-2;c<=2;c++){
            const dark=r===-2||r===2||c===-2||c===2||(r===0&&c===0);
            matrix.set(row+r,col+c,dark,true);
          }
        }
      }
    }
  }
  function bchDigit(data){let d=0;while(data!==0){d++;data>>>=1;}return d;}
  // 版本信息（v≥7）：BCH(18,6)
  const G18=(1<<12)|(1<<11)|(1<<10)|(1<<9)|(1<<8)|(1<<5)|(1<<2)|(1<<0);
  const G18_DIGIT=bchDigit(G18);
  function versionBits(version){
    let d=version<<12;
    while(bchDigit(d)-G18_DIGIT>=0)d^=(G18<<(bchDigit(d)-G18_DIGIT));
    return (version<<12)|d;
  }
  function setupVersionInfo(matrix,version){
    const size=matrix.size,bits=versionBits(version);
    for(let i=0;i<18;i++){
      const row=Math.floor(i/3),col=i%3+size-8-3;
      const mod=((bits>>i)&1)===1;
      matrix.set(row,col,mod,true);
      matrix.set(col,row,mod,true);
    }
  }
  // 格式信息：BCH(15,5) 后异或掩码
  const G15=(1<<10)|(1<<8)|(1<<5)|(1<<4)|(1<<2)|(1<<1)|(1<<0);
  const G15_MASK=(1<<14)|(1<<12)|(1<<10)|(1<<4)|(1<<1);
  const G15_DIGIT=bchDigit(G15);
  function formatBits(ecLevel,mask){
    const data=(EC_BIT[ecLevel]<<3)|mask;
    let d=data<<10;
    while(bchDigit(d)-G15_DIGIT>=0)d^=(G15<<(bchDigit(d)-G15_DIGIT));
    return ((data<<10)|d)^G15_MASK;
  }
  function setupFormatInfo(matrix,ecLevel,mask){
    const size=matrix.size,bits=formatBits(ecLevel,mask);
    for(let i=0;i<15;i++){
      const mod=((bits>>i)&1)===1;
      if(i<6)matrix.set(i,8,mod,true);
      else if(i<8)matrix.set(i+1,8,mod,true);
      else matrix.set(size-15+i,8,mod,true);
      if(i<8)matrix.set(8,size-i-1,mod,true);
      else if(i<9)matrix.set(8,15-i-1+1,mod,true);
      else matrix.set(8,15-i-1,mod,true);
    }
    matrix.set(size-8,8,1,true);
  }

  // ---- 数据放置（之字形）----
  function setupData(matrix,data){
    const size=matrix.size;
    let inc=-1,row=size-1,bitIndex=7,byteIndex=0;
    for(let col=size-1;col>0;col-=2){
      if(col===6)col--;
      while(true){
        for(let c=0;c<2;c++){
          if(!matrix.isReserved(row,col-c)){
            let dark=false;
            if(byteIndex<data.length)dark=(((data[byteIndex]>>>bitIndex)&1)===1);
            matrix.set(row,col-c,dark,false);
            bitIndex--;
            if(bitIndex===-1){byteIndex++;bitIndex=7;}
          }
        }
        row+=inc;
        if(row<0||size<=row){
          row-=inc;inc=-inc;break;
        }
      }
    }
  }

  // ---- 数据编码 + Reed-Solomon ----
  function createData(version,ecLevel,bytes){
    const buffer=new BitBuffer();
    buffer.put(1<<2,4);                       // 字节模式指示 0100
    buffer.put(bytes.length,version<10?8:16); // 字符数
    for(let i=0;i<bytes.length;i++)buffer.put(bytes[i],8);

    const totalCodewords=QR_CODEWORDS_COUNT[version];
    const ecTotal=QR_EC_TOTAL[(version-1)*4+EC_IDX[ecLevel]];
    const dataBits=(totalCodewords-ecTotal)*8;
    if(buffer.bits()+4<=dataBits)buffer.put(0,4);   // 终止符
    while(buffer.bits()%8!==0)buffer.putBit(false);
    const remaining=(dataBits-buffer.bits())/8;
    for(let i=0;i<remaining;i++)buffer.put(i%2?0x11:0xEC,8);

    return createCodewords(new Uint8Array(buffer.buffer),version,ecLevel,totalCodewords,ecTotal);
  }
  function createCodewords(buffer,version,ecLevel,totalCodewords,ecTotal){
    const dataTotal=totalCodewords-ecTotal;
    const blocks=QR_EC_BLOCKS[(version-1)*4+EC_IDX[ecLevel]];
    const group2=totalCodewords%blocks;
    const group1=blocks-group2;
    const totalG1=Math.floor(totalCodewords/blocks);
    const dataG1=Math.floor(dataTotal/blocks);
    const dataG2=dataG1+1;
    const ecCount=totalG1-dataG1;
    const gen=ecPolynomial(ecCount);

    let off=0,maxData=0;
    const dcData=new Array(blocks),ecData=new Array(blocks);
    for(let b=0;b<blocks;b++){
      const size=b<group1?dataG1:dataG2;
      dcData[b]=buffer.slice(off,off+size);
      const padded=new Uint8Array(size+ecCount);
      padded.set(dcData[b]);
      let rem=polyMod(padded,gen);
      const ec=new Uint8Array(ecCount);
      ec.set(rem,ecCount-rem.length);
      ecData[b]=ec;
      off+=size;
      maxData=Math.max(maxData,size);
    }
    const out=new Uint8Array(totalCodewords);
    let idx=0;
    for(let i=0;i<maxData;i++)
      for(let b=0;b<blocks;b++)
        if(i<dcData[b].length)out[idx++]=dcData[b][i];
    for(let i=0;i<ecCount;i++)
      for(let b=0;b<blocks;b++)
        out[idx++]=ecData[b][i];
    return out;
  }

  // ---- 掩码 ----
  const MASK_COND=[
    (i,j)=>(i+j)%2===0,
    (i,j)=>i%2===0,
    (i,j)=>j%3===0,
    (i,j)=>(i+j)%3===0,
    (i,j)=>(Math.floor(i/2)+Math.floor(j/3))%2===0,
    (i,j)=>((i*j)%2+(i*j)%3)===0,
    (i,j)=>(((i*j)%2+(i*j)%3)%2)===0,
    (i,j)=>(((i*j)%3+(i+j)%2)%2)===0
  ];
  function applyMask(pattern,matrix){
    const size=matrix.size,cond=MASK_COND[pattern];
    for(let col=0;col<size;col++)
      for(let row=0;row<size;row++){
        if(matrix.isReserved(row,col))continue;
        matrix.xor(row,col,cond(row,col));
      }
  }
  function penaltyN1(m){
    const size=m.size;let points=0;
    for(let row=0;row<size;row++){
      let cc=0,cr=0,lc=null,lr=null;
      for(let col=0;col<size;col++){
        let v=m.get(row,col);
        if(v===lc)cc++;else{if(cc>=5)points+=3+(cc-5);lc=v;cc=1;}
        v=m.get(col,row);
        if(v===lr)cr++;else{if(cr>=5)points+=3+(cr-5);lr=v;cr=1;}
      }
      if(cc>=5)points+=3+(cc-5);
      if(cr>=5)points+=3+(cr-5);
    }
    return points;
  }
  function penaltyN2(m){
    const size=m.size;let points=0;
    for(let row=0;row<size-1;row++)
      for(let col=0;col<size-1;col++){
        const s=m.get(row,col)+m.get(row,col+1)+m.get(row+1,col)+m.get(row+1,col+1);
        if(s===0||s===4)points++;
      }
    return points*3;
  }
  function penaltyN3(m){
    const size=m.size;let points=0;
    for(let row=0;row<size;row++){
      let bc=0,br=0;
      for(let col=0;col<size;col++){
        bc=((bc<<1)&0x7FF)|m.get(row,col);
        if(col>=10&&(bc===0x5D0||bc===0x05D))points++;
        br=((br<<1)&0x7FF)|m.get(col,row);
        if(col>=10&&(br===0x5D0||br===0x05D))points++;
      }
    }
    return points*40;
  }
  function penaltyN4(m){
    let dark=0;
    for(let i=0;i<m.data.length;i++)dark+=m.data[i];
    const k=Math.abs(Math.ceil((dark*100/m.data.length)/5)-10);
    return k*10;
  }
  function getBestMask(matrix,ecLevel){
    let best=0,lower=Infinity;
    for(let p=0;p<8;p++){
      setupFormatInfo(matrix,ecLevel,p);
      applyMask(p,matrix);
      const penalty=penaltyN1(matrix)+penaltyN2(matrix)+penaltyN3(matrix)+penaltyN4(matrix);
      applyMask(p,matrix);
      if(penalty<lower){lower=penalty;best=p;}
    }
    return best;
  }

  /**
   * 生成 QR 矩阵。
   * @param {string} text 任意文本（本系统传 6 字段 JSON 字符串，支持中文）
   * @param {string} ecLevel "L"/"M"/"Q"/"H"，默认 M
   * @return {{size:number, data:Uint8Array, version:number, mask:number}}
   */
  function qrCreate(text,ecLevel,forcedMask){
    ecLevel=ecLevel||"M";
    if(!EC_IDX.hasOwnProperty(ecLevel))ecLevel="M";
    const bytes=utf8Bytes(String(text));
    let version=0;
    for(let v=1;v<=40;v++){
      const total=QR_CODEWORDS_COUNT[v];
      const ec=QR_EC_TOTAL[(v-1)*4+EC_IDX[ecLevel]];
      const cc=v<10?8:16;
      const cap=Math.floor(((total-ec)*8-4-cc)/8);
      if(bytes.length<=cap){version=v;break;}
    }
    if(!version)throw new Error("二维码内容超出容量（v40-"+ecLevel+"）");
    const codewords=createData(version,ecLevel,bytes);
    const matrix=new BitMatrix(qrSize(version));
    setupFinderPattern(matrix);
    setupTimingPattern(matrix);
    setupAlignmentPattern(matrix,version);
    setupFormatInfo(matrix,ecLevel,0);
    if(version>=7)setupVersionInfo(matrix,version);
    setupData(matrix,codewords);
    const mask=(forcedMask>=0&&forcedMask<8)?forcedMask:getBestMask(matrix,ecLevel);
    applyMask(mask,matrix);
    setupFormatInfo(matrix,ecLevel,mask);
    return {size:matrix.size,data:matrix.data,version,mask};
  }

  // ==========================================================================
  // Canvas 标签渲染
  // ==========================================================================

  /** 渲染瓶签，返回 dataURL */
  function renderLabel(item, cfg, dpi) {
    dpi = dpi || parseInt(cfg.label_dpi || "203");
    const wMm = parseFloat(cfg.label_w_mm || "30");
    const hMm = parseFloat(cfg.label_h_mm || "14");
    const W = Math.max(1, Math.round(wMm / 25.4 * dpi));
    const H = Math.max(1, Math.round(hMm / 25.4 * dpi));
    const u = dpi / 25.4;

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

  /**
   * 渲染品种二维码标签（v2.2）
   * @param {object} payload store.productQR(code) 返回的 6 字段对象
   * 默认 40×30mm；名称只显示一次。
   */
  function renderProductQR(payload, cfg, dpi) {
    cfg = cfg || {};
    dpi = dpi || parseInt(cfg.label_dpi || "203");
    const wMm = parseFloat(cfg.product_w_mm || "40");
    const hMm = parseFloat(cfg.product_h_mm || "30");
    const W = Math.max(1, Math.round(wMm / 25.4 * dpi));
    const H = Math.max(1, Math.round(hMm / 25.4 * dpi));
    const u = dpi / 25.4;

    const qr = qrCreate(JSON.stringify(payload));
    const n = qr.size;

    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#000";

    const mx = Math.round(1.2 * u);
    const titleTop = Math.round(0.8 * u);
    const titleH = Math.round(3.6 * u);
    // 名称（同品种仅出现这一次）
    const title = String(payload["溶液名称"] || "");
    const titleSize = fitText(ctx, title, W - 2 * mx, titleH, true, Math.max(7, Math.round(1.6 * u)));
    ctx.font = `bold ${titleSize}px sans-serif`;
    ctx.textBaseline = "top";
    const tw = ctx.measureText(title).width;
    ctx.fillText(title, (W - tw) / 2, titleTop);

    // 二维码（含 4 模块静区）
    const availW = W - 2 * mx;
    const availH = H - titleTop - titleH - mx;
    const qrPx = Math.min(availW, availH);
    let mod = Math.floor(qrPx / (n + 8));
    if(mod < 1) mod = 1;
    const qrW = mod * n;
    const qrX = Math.round((W - qrW) / 2);
    const qrY = titleTop + titleH + Math.round((availH - qrW) / 2);
    for(let r=0;r<n;r++){
      for(let c=0;c<n;c++){
        if(qr.data[r*n+c]) ctx.fillRect(qrX+c*mod, qrY+r*mod, mod, mod);
      }
    }
    return canvas.toDataURL("image/png");
  }

  /**
   * 渲染品种标签（兼容旧调用）。
   * product = {name, code} 旧条形码模式；或 {qr: payload} 二维码模式。
   */
  function renderProductLabel(product, cfg, dpi) {
    if(product && product.qr) return renderProductQR(product.qr, cfg, dpi);
    return renderLabel({ name: product.name, bottle_id: product.code }, cfg, dpi);
  }

  global.XLBLabel = { renderLabel, renderProductLabel, renderProductQR, code128Encode, qrCreate };
})(window);
