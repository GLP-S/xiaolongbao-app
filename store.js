/**
 * 小笼包 —— 本地 Store（JS 移植版）
 * 接口与 standard_solution_manager.py 的 Store 对齐，使平板可脱离电脑独立运行。
 * 持久化由 db.js（IndexedDB）负责；本文件只做内存业务逻辑。
 */
(function (global) {
  "use strict";

  // ---------- 常量（与 Python 版一致） ----------
  const STOCK_KEYS = ["bottle_id","name","std_id","product_code","conc","batch","maker",
    "prod_date","exp_date","open_date","open_limit","open_exp_date","init_amount","amount",
    "unit","location","status","in_date","operator","project_no","solvent","note"];
  const LOG_KEYS = ["log_id","time","bottle_id","name","action","qty","unit","person","purpose","operator","note"];
  const PROD_KEYS = ["code","name","std_id","conc","batch","unit","first_date"];

  const ST_IN="在库", ST_OUT="已出库", ST_EMPTY="已用尽", ST_DISCARD="已作废", ST_USED="已取用";
  const ACT_RECEIVE="入库", ACT_USE="取用", ACT_CHECKOUT="出库", ACT_RETURN="归还",
        ACT_DISCARD="作废", ACT_REPRINT="补打标签", ACT_EDIT="编辑";

  const DEFAULT_CONFIG = {
    warn_days:"30", label_w_mm:"30", label_h_mm:"14", label_dpi:"203", cfg_version:"2",
    printer:"", id_prefix:"SS", product_prefix:"P", product_seq:"0", default_open_days:"30",
    default_operator:"", locations:"", persons:"", purposes:"", units:"mL\ng\nL\nmg",
    box_count:"20", slot_per_box:"60", bigbox_count:"20", slot_per_bigbox:"24",
    login_user:"admin", login_password:"admin123"
  };

  // ---------- 日期工具 ----------
  function todayStr(){ const d=new Date(); return d.toISOString().slice(0,10); }
  function nowStr(){ const d=new Date(); const p=n=>String(n).padStart(2,"0");
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
  function toDate(v){
    if(!v) return null;
    if(v instanceof Date) return v;
    if(typeof v==="string"){ const m=v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m) return new Date(+m[1],+m[2]-1,+m[3]); }
    return null;
  }
  function dateStr(d){ if(!d) return ""; const d2=toDate(d); if(!d2) return ""; const p=n=>String(n).padStart(2,"0");
    return `${d2.getFullYear()}-${p(d2.getMonth()+1)}-${p(d2.getDate())}`; }
  function addDays(d, n){ const d2=toDate(d); if(!d2) return null; d2.setDate(d2.getDate()+n); return d2; }
  function addPeriod(d, value, unit){
    const n=parseFloat(value); if(!n) return d;
    const d2=toDate(d); if(!d2) return null;
    const map={"天":1,"日":1,"周":7,"月":30,"年":365};
    return addDays(d2, Math.round(n*(map[unit]||1)));
  }

  // ---------- Store 类 ----------
  class Store {
    constructor(data){
      this.items = {};       // bottle_id -> item
      this.logs = [];
      this.config = {...DEFAULT_CONFIG};
      this.products = {};    // code -> product
      if(data) this.hydrate(data);
    }

    hydrate(data){
      if(data.items){ for(const k in data.items) this.items[k]=data.items[k]; }
      if(data.logs) this.logs = data.logs.slice();
      if(data.config) this.config = {...DEFAULT_CONFIG, ...data.config};
      if(data.products){ for(const k in data.products) this.products[k]=data.products[k]; }
    }

    toJSON(){ return {items:this.items, logs:this.logs, config:this.config, products:this.products}; }

    // ---- 配置字典 ----
    dictList(key){ return (this.config[key]||"").split("\n").map(s=>s.trim()).filter(Boolean); }

    // ---- 品种 ----
    productCodeFor(std_id, conc, unit, batch, name){
      const parts=[];
      if(std_id) parts.push(std_id);
      const c=(conc||"").replace(/\s+/g,"");
      if(c){ parts.push(c+(unit||"")); }
      if(batch) parts.push(batch);
      if(!parts.length && name) parts.push(name);
      return (this.config.product_prefix||"P") + parts.join("-");
    }

    findProduct(code){
      const p=this.products[code];
      return p ? [p, Object.values(this.items).filter(i=>i.product_code===code && i.status===ST_IN)] : [null, null];
    }

    itemsOfProduct(code){ return Object.values(this.items).filter(i=>i.product_code===code); }
    remainingCount(code){ return this.itemsOfProduct(code).filter(i=>i.status===ST_IN).length; }
    remainingLocations(code){ return this.itemsOfProduct(code).filter(i=>i.status===ST_IN).map(i=>i.location); }

    // ---- 库位 ----
    boxCount(){ return parseInt(this.config.box_count||"20"); }
    slotPerBox(){ return parseInt(this.config.slot_per_box||"60"); }
    bigboxCount(){ return parseInt(this.config.bigbox_count||"20"); }
    slotPerBigbox(){ return parseInt(this.config.slot_per_bigbox||"24"); }

    /** 平面棋盘全部格位（标签与 index.html drawBoard 一致：序号-列字母） */
    boardLocations(kind="small"){
      const n=parseInt(this.config[kind+"_box"]||"20");
      const grid=parseInt(this.config[kind+"_box_grid"]||(kind==="small"?"5":"4"));
      const out=[];
      for(let i=1;i<=n;i++){ const col=(i%grid)||grid; out.push(i+"-"+String.fromCharCode(64+col)); }
      return out;
    }

    occupiedLocations(){
      const s=new Set();
      for(const k in this.items){ const it=this.items[k]; if(it.location && it.status===ST_IN) s.add(it.location); }
      return s;
    }
    isLocationOccupied(loc){ return this.occupiedLocations().has(loc); }

    freeSlots(boxNo, boxType="small"){
      const n = boxType==="big" ? this.slotPerBigbox() : this.slotPerBox();
      const prefix = boxType==="big" ? `B${boxNo}-` : `${boxNo}-`;
      const occ=this.occupiedLocations();
      const res=[];
      for(let s=1;s<=n;s++){ const l=`${prefix}${s}`; if(!occ.has(l)) res.push(l); }
      return res;
    }
    allocConsecutiveSlots(boxNo, n, boxType="small"){
      const free=this.freeSlots(boxNo, boxType);
      if(free.length<n) return [];
      return free.slice(0,n);
    }

    // ---- 瓶号 ----
    newBottleId(){
      const prefix=(this.config.id_prefix||"SS").trim()||"SS";
      const d=new Date(); const t=`${d.getFullYear()%100}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}`;
      const head=prefix+t;
      let seq=1;
      for(const bid in this.items){
        if(bid.startsWith(head)){ const tail=bid.slice(head.length); if(/^\d+$/.test(tail)) seq=Math.max(seq, parseInt(tail)+1); }
      }
      return `${head}${String(seq).padStart(3,"0")}`;
    }

    // ---- 流水 ----
    _log(bottleId, action, {qty="", unit="", person="", purpose="", operator="", note=""}={}){
      const it=this.items[bottleId]||{};
      this.logs.push({
        log_id:`LOG${new Date().toISOString().replace(/[-:T]/g,"").slice(2,14)}-${String(this.logs.length+1).padStart(5,"0")}`,
        time:nowStr(), bottle_id:bottleId, name:it.name||"", action, qty, unit, person, purpose, operator, note
      });
    }

    // ---- 有效期推算 ----
    parseConc(conc){
      if(!conc) return [null,null];
      const m=String(conc).match(/([\d.]+)\s*([a-zA-Z%]+)/);
      if(m) return [parseFloat(m[1]), m[2]];
      const m2=String(conc).match(/([\d.]+)/);
      return m2?[parseFloat(m2[1]),""]:[null,null];
    }
    expiryByConc(prodDate, conc){
      const [val, unit]=this.parseConc(conc);
      if(val==null) return null;
      const p=toDate(prodDate)||new Date();
      // 与 Python 版规则一致：高浓度短，低浓度长
      let days;
      if(/mol\/L|mol\/L/i.test(unit||"")){
        days = val>=1 ? 180 : 365;
      } else if(/mg\/L|ug\/mL|ng\/mL/i.test(unit||"")){
        days = val>=100 ? 180 : 90;
      } else if(/%/.test(unit||"")){
        days = 365;
      } else {
        days = 365;
      }
      return addDays(p, days);
    }

    // ---- 入库 ----
    receive(form, {commit=true, note="入库", productCode=null, location=null}={}){
      const bid=form.bottle_id||this.newBottleId();
      if(this.items[bid]) throw new Error(`瓶号 ${bid} 已存在，不能重复入库`);
      const name=(form.name||"").trim();
      if(!name) throw new Error("溶液名称不能为空");
      const stdId=(form.std_id||"").trim();
      const batch=(form.batch||"").trim();
      if(batch && !/^\d{4}$/.test(batch)) throw new Error("批号必须为 4 位数字格式（如 0001）");
      const loc=(location!==null?location:form.location||"").trim();
      if(loc && this.isLocationOccupied(loc)) throw new Error(`库位 ${loc} 已被占用，请选择空闲格位`);
      let exp=toDate(form.exp_date);
      if(!exp){
        const prod=toDate(form.prod_date)||new Date();
        exp=this.expiryByConc(prod, form.conc);
      }
      if(!exp) throw new Error("请填写有效期至（浓度无法解析时需手动填写）");
      const init=form.init_amount;
      const unit=form.unit||"";
      const conc=(form.conc||"").trim();
      if(productCode===null) productCode=this.productCodeFor(stdId, conc, unit, batch, name);

      // 品种登记
      if(!this.products[productCode]){
        this.products[productCode]={code:productCode, name, std_id:stdId, conc, batch, unit, first_date:todayStr()};
      }

      const item={
        bottle_id:bid, name, std_id:stdId, product_code:productCode, conc, batch,
        maker:(form.maker||"").trim(), prod_date:dateStr(form.prod_date), exp_date:dateStr(exp),
        open_date:null,
        open_limit: form.open_limit_value ? `${form.open_limit_value}${form.open_limit_unit||"天"}` : "",
        open_exp_date:null,
        init_amount: init!=null && init!=="" ? parseFloat(init) : null,
        amount:null, unit, location:loc, status:ST_IN, in_date:todayStr(),
        operator:(form.operator||"").trim(), project_no:(form.project_no||"").trim(),
        solvent:(form.solvent||"").trim(), note:(form.note||"").trim()
      };
      this.items[bid]=item;
      // 经办人/配置人自动加入人员列表
      for(const who of [item.operator, item.maker]){
        if(who && !this.dictList("persons").includes(who)){
          const cur=this.config.persons||"";
          this.config.persons = cur ? (cur+"\n"+who).trim() : who;
        }
      }
      this._log(bid, ACT_RECEIVE, {qty:1, unit:"瓶", operator:item.operator, note:note||"入库"});
      if(commit) this.save();
      return bid;
    }

    receiveBatch(form, n){
      n=parseInt(n);
      if(n<1) throw new Error("入库数量至少为 1 瓶");
      if(n>999) throw new Error("单次入库数量不能超过 999 瓶");
      const name=(form.name||"").trim();
      if(!name) throw new Error("溶液名称不能为空");
      // 批量时提前算有效期
      let exp=toDate(form.exp_date);
      if(!exp) exp=this.expiryByConc(toDate(form.prod_date)||new Date(), form.conc);
      if(!exp) throw new Error("请填写有效期至");
      const bids=[];
      // 库位分配
      let locs=[];
      if(form.box_no){
        const boxType=form.box_type||"small";
        locs=this.allocConsecutiveSlots(parseInt(form.box_no), n, boxType);
        if(locs.length<n) throw new Error(`所选盒子剩余连续空位不足 ${n} 个`);
      }else if(form.location){
        // 棋盘多选：逗号分隔的库位逐瓶分配（每瓶不同位置）
        const sel=[...new Set(String(form.location).split(",").map(s=>s.trim()).filter(Boolean))];
        const occ=this.occupiedLocations();
        for(const l of sel) if(occ.has(l)) throw new Error(`库位 ${l} 已被占用，请重新点选空闲格位`);
        if(sel.length>n) throw new Error(`所选库位 ${sel.length} 个，超过入库数量 ${n} 瓶`);
        locs=sel.slice();
        if(locs.length<n){
          // 未选满：用同棋盘空闲格补齐
          const free=this.boardLocations("small").filter(l=>!occ.has(l)&&!locs.includes(l));
          while(locs.length<n&&free.length) locs.push(free.shift());
        }
      }
      for(let i=0;i<n;i++){
        const f={...form, exp_date:dateStr(exp)};
        const loc = locs.length ? locs[i] : "";
        const bid=this.receive(f, {commit:false, note:`批量入库第${i+1}瓶`, location:loc});
        bids.push(bid);
      }
      this.save();
      return bids;
    }

    // ---- 取用 / 出库 ----
    use(bid, qty, person, purpose, operator, {emptied=false, note=""}={}){
      const it=this._getInStock(bid);
      this._log(bid, ACT_USE, {qty:qty||"", unit:it.unit||"", person, purpose, operator, note:note||"取用"});
      if(emptied){ it.status=ST_EMPTY; it.open_date=todayStr(); }
      this.save();
    }
    checkout(bid, person, purpose, operator, note=""){
      const it=this._getInStock(bid);
      it.status=ST_OUT;
      this._log(bid, ACT_CHECKOUT, {person, purpose, operator, note:note||"出库"});
      this.save();
    }
    returnBack(bid, opened, openDate, operator, note=""){
      const it=this.items[bid];
      if(!it) throw new Error(`瓶号 ${bid} 不存在`);
      if(it.status===ST_DISCARD) throw new Error("该瓶已作废，不能归还");
      it.status=ST_IN;
      if(opened){
        it.open_date=dateStr(openDate)||todayStr();
        const limit=this.config.default_open_days||"30";
        it.open_limit=`${limit}天`;
        it.open_exp_date=dateStr(addDays(toDate(it.open_date), parseInt(limit)));
      }
      this._log(bid, ACT_RETURN, {operator, note:note||"归还"});
      this.save();
    }
    discard(bid, reason, operator){
      const it=this.items[bid];
      if(!it) throw new Error(`瓶号 ${bid} 不存在`);
      it.status=ST_DISCARD;
      this._log(bid, ACT_DISCARD, {operator, note:reason||"作废"});
      this.save();
    }
    reprintLog(bid, operator){ this._log(bid, ACT_REPRINT, {operator}); this.save(); }
    modify(bid, changes, operator){
      const it=this.items[bid];
      if(!it) throw new Error(`瓶号 ${bid} 不存在`);
      for(const k in changes){ if(k in it && changes[k]!==undefined) it[k]=changes[k]; }
      this._log(bid, ACT_EDIT, {operator, note:"编辑"});
      this.save();
    }

    _getInStock(bid){
      const it=this.items[bid];
      if(!it) throw new Error(`瓶号 ${bid} 不存在`);
      if(it.status!==ST_IN) throw new Error(`该瓶当前状态为「${it.status}」，不能执行此操作`);
      return it;
    }

    // ---- 扫码 ----
    scan(code){
      code=(code||"").trim();
      if(!code) throw new Error("扫码内容为空");
      // 瓶码
      if(this.items[code]) return {type:"bottle", item:this.items[code]};
      // 品种码
      const [prod, list]=this.findProduct(code);
      if(prod) return {type:"product", product:prod, items:list};
      throw new Error(`未识别的码：${code}`);
    }

    // ---- 盘点 ----
    stocktakeReport(foundIds){
      const found=new Set(foundIds||[]);
      const inStock=Object.values(this.items).filter(i=>i.status===ST_IN);
      const missing=inStock.filter(i=>!found.has(i.bottle_id)).map(i=>i.bottle_id);
      const extra=[...found].filter(id=>!this.items[id] || this.items[id].status!==ST_IN);
      return {total:inStock.length, found:found.size, missing, extra, diff:missing.length+extra.length};
    }

    // ---- 持久化（由 db.js 注入） ----
    setSaver(fn){ this._saver=fn; }
    async save(){ if(this._saver) await this._saver(this.toJSON()); }
  }

  global.XLBStore = Store;
  global.XLBConst = {STOCK_KEYS,LOG_KEYS,PROD_KEYS,ST_IN,ST_OUT,ST_EMPTY,ST_DISCARD,ST_USED,
    ACT_RECEIVE,ACT_USE,ACT_CHECKOUT,ACT_RETURN,ACT_DISCARD,ACT_REPRINT,ACT_EDIT,DEFAULT_CONFIG};
})(window);
