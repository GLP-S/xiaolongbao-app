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

  // ---------- 溶液名称自动派生（v2.2：名称只读，由 编号-浓度/规格单位-批号 整合） ----------
  // 紧凑式，例：GBW06103-0.1000mol/L-0001（浓度去空格）
  function deriveName(std_id, conc, unit, batch){
    const parts=[];
    if(std_id) parts.push(String(std_id).trim());
    const c=String(conc||"").replace(/\s+/g,"");
    if(c) parts.push(c+String(unit||""));
    if(batch) parts.push(String(batch).trim());
    return parts.join("-");
  }

  // ---------- 品种二维码载荷解析（QR 内容为 6 字段 JSON） ----------
  function parseQRPayload(s){
    if(typeof s!=="string" || s[0]!=="{" || s.indexOf("溶液名称")<0) return null;
    try{
      const o=JSON.parse(s);
      return (o && typeof o==="object" && "溶液名称" in o) ? o : null;
    }catch(e){ return null; }
  }
  const ACT_RECEIVE="入库", ACT_USE="取用", ACT_CHECKOUT="出库", ACT_RETURN="归还",
        ACT_DISCARD="作废", ACT_REPRINT="补打标签", ACT_EDIT="编辑";

  const DEFAULT_CONFIG = {
    warn_days:"30", label_w_mm:"30", label_h_mm:"14", label_dpi:"203",
    product_w_mm:"40", product_h_mm:"30", cfg_version:"4",
    printer:"", id_prefix:"SS", product_prefix:"P", product_seq:"0", default_open_days:"30",
    default_operator:"", locations:"", persons:"", purposes:"", units:"mL\ng\nL\nmg",
    box_count:"20", slot_per_box:"60", bigbox_count:"20", slot_per_bigbox:"24",
    login_user:"admin", login_password:"admin123",
    users:"", boxes:"", server_url:"", sync_last_ts:"0",
    dingtalk_webhook:"", dingtalk_secret:"", dingtalk_auto:"0", company_server_url:""
  };

  // v3.0 权限全集（与 Python 端 ALL_PERMS 一致）
  const ALL_PERMS = ["inout", "query", "check", "cfg", "admin"];

  // ---------- 口令哈希：优先 SHA-256（与桌面端一致），非安全上下文退化为 djb2 ----------
  async function hashPass(p){
    p = String(p==null?"":p);
    try{
      if(global.crypto && crypto.subtle && crypto.subtle.digest){
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(p));
        return [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,"0")).join("");
      }
    }catch(e){}
    let h = 5381; for(let i=0;i<p.length;i++) h = ((h<<5)+h+p.charCodeAt(i))>>>0;
    return "djb2:"+h.toString(16);
  }
  // 同步校验用：无法 await 的场景（不应出现；checkLogin 一律走异步）
  function defaultAdmin(){ return {pass_hash:"", role:"admin", perms:ALL_PERMS.slice()}; }

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

    /** v2.2：品种二维码载荷（6 字段动态数据；QR 内容直接 JSON.stringify 此对象） */
    productQR(code){
      const p=this.products[code];
      if(!p) return null;
      const inItems=Object.values(this.items).filter(i=>i.product_code===code && i.status===ST_IN);
      const uniq=a=>[...new Set(a.filter(v=>v!==undefined && v!==null && v!==""))];
      const latest=key=>{ for(let i=inItems.length-1;i>=0;i--){ const v=inItems[i][key]; if(v) return v; } return ""; };
      return {
        "溶液名称": p.name,
        "储存位置": uniq(inItems.map(i=>i.location)),
        "剩余数量": inItems.length,
        "项目号": uniq(inItems.map(i=>i.project_no)),
        "配置人": p.maker || latest("maker"),
        "生产日期": p.prod_date || latest("prod_date")
      };
    }

    /** v2.2：按 QR 载荷（溶液名称）反查本地品种，返回与 findProduct 相同的元组 */
    findProductByQR(obj){
      const name=String((obj&&obj["溶液名称"])||"").trim();
      if(!name) return [null,null];
      for(const code in this.products){
        if(this.products[code].name===name) return this.findProduct(code);
      }
      return [null,null];
    }

    // ---- v3.0：多账号（口令哈希存储；哈希算法见 hashPass） ----
    users(){
      try{
        const d = JSON.parse(this.config.users || "{}");
        if(d && typeof d==="object" && Object.keys(d).length) return d;
      }catch(e){}
      return {admin: defaultAdmin()};
    }
    async saveUsers(users){ this.config.users = JSON.stringify(users); await this.save(); }
    async checkLogin(username, password){
      const u = this.users()[String(username||"").trim()];
      if(!u) return null;
      const hp = await hashPass(password);
      // 兼容：旧数据可能存明文密码
      const ok = u.pass_hash ? (u.pass_hash===hp || u.pass_hash===String(password||""))
                             : (String(password||"")==="admin123" && String(username||"").trim()==="admin");
      if(!ok) return null;
      return {role: u.role||"user", perms: (u.perms||ALL_PERMS).slice()};
    }
    async addUser(username, password, perms){
      username = String(username||"").trim();
      if(!username) throw new Error("账号不能为空");
      const users = this.users();
      if(users[username]) throw new Error("账号已存在");
      users[username] = {pass_hash: await hashPass(password||"123456"), role:"user",
                         perms:(perms&&perms.length?perms:["inout","query"]).slice()};
      await this.saveUsers(users);
    }
    async delUser(username){
      const users = this.users();
      const u = users[username];
      if(!u) return;
      if(u.role==="admin" && Object.values(users).filter(x=>x.role==="admin").length<=1)
        throw new Error("至少保留一个管理员账号");
      delete users[username];
      await this.saveUsers(users);
    }
    async setUserPerms(username, perms){
      const users = this.users();
      if(!users[username]) throw new Error("账号不存在");
      users[username].perms = users[username].role==="admin" ? ALL_PERMS.slice() : (perms||[]).slice();
      await this.saveUsers(users);
    }
    async setUserPass(username, password){
      const users = this.users();
      if(!users[username]) throw new Error("账号不存在");
      users[username].pass_hash = await hashPass(password||"");
      await this.saveUsers(users);
    }

    // ---- v3.0：盒定义（[{id,type,rows,cols}]，库位串 = prefix+格号） ----
    boxes(){
      try{
        const lst = JSON.parse(this.config.boxes || "[]");
        if(Array.isArray(lst) && lst.length){
          return lst.map(b=>({id:parseInt(b.id), type:b.type==="big"?"big":"small",
                              rows:Math.max(1,parseInt(b.rows||6)), cols:Math.max(1,parseInt(b.cols||10))}));
        }
      }catch(e){}
      return this.defaultBoxes();
    }
    defaultBoxes(){
      const out = [];
      for(let i=1;i<=this.boxCount();i++) out.push({id:i, type:"small", rows:6, cols:10});
      for(let i=1;i<=this.bigboxCount();i++) out.push({id:i, type:"big", rows:4, cols:6});
      return out;
    }
    async saveBoxes(boxes){ this.config.boxes = JSON.stringify(boxes); await this.save(); }
    boxLabel(box){ return box.type==="big" ? `大盒${String(box.id).padStart(2,"0")}` : `小盒${box.id}`; }
    boxLocPrefix(box){ return box.type==="big" ? `大盒${String(box.id).padStart(2,"0")}-` : `${box.id}-`; }
    boxSlots(box){ return box.rows*box.cols; }
    findBox(boxNo, boxType="small"){
      return this.boxes().find(b=>b.id===parseInt(boxNo) && b.type===boxType) || null;
    }

    // ---- 库位 ----
    boxCount(){ return parseInt(this.config.box_count||"20"); }
    slotPerBox(){ return parseInt(this.config.slot_per_box||"60"); }
    bigboxCount(){ return parseInt(this.config.bigbox_count||"20"); }
    slotPerBigbox(){ return parseInt(this.config.slot_per_bigbox||"24"); }

    /** 平面棋盘全部格位（按盒定义展开全部盒的库位串） */
    boardLocations(){
      const out = [];
      for(const b of this.boxes()){
        const prefix = this.boxLocPrefix(b);
        for(let s=1;s<=this.boxSlots(b);s++) out.push(prefix+s);
      }
      return out;
    }

    occupiedLocations(){
      const s=new Set();
      for(const k in this.items){ const it=this.items[k]; if(it.location && it.status===ST_IN) s.add(it.location); }
      return s;
    }
    isLocationOccupied(loc){ return this.occupiedLocations().has(loc); }

    freeSlots(boxNo, boxType="small"){
      const box = this.findBox(boxNo, boxType);
      const n = box ? this.boxSlots(box) : (boxType==="big" ? this.slotPerBigbox() : this.slotPerBox());
      const prefix = box ? this.boxLocPrefix(box)
                         : (boxType==="big" ? `大盒${String(boxNo).padStart(2,"0")}-` : `${boxNo}-`);
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
      const stdId=(form.std_id||"").trim();
      const batch=(form.batch||"").trim();
      const unit=form.unit||"";
      const conc=(form.conc||"").trim();
      // v2.2：名称不允许手填，由 编号+浓度/规格单位+批号 自动整合
      let name=(form.name||"").trim();
      if(!name) name=deriveName(form.std_id, form.conc, unit, batch);
      if(!name) throw new Error("溶液名称将自动生成，请先填写标准物质编号、浓度/规格和批号");
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
      if(productCode===null) productCode=this.productCodeFor(stdId, conc, unit, batch, name);

      // 品种登记（v2.2：补充 maker/prod_date/project_no，供品种二维码使用）
      if(!this.products[productCode]){
        this.products[productCode]={code:productCode, name, std_id:stdId, conc, batch, unit,
          first_date:todayStr(), maker:(form.maker||"").trim(),
          prod_date:dateStr(form.prod_date), project_no:(form.project_no||"").trim()};
      }else{
        // 后续入库补全品种档案缺失字段（不覆盖已有值）
        const p=this.products[productCode];
        if(!p.maker && form.maker) p.maker=(form.maker||"").trim();
        if(!p.prod_date && form.prod_date) p.prod_date=dateStr(form.prod_date);
        if(!p.project_no && form.project_no) p.project_no=(form.project_no||"").trim();
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
      let name=(form.name||"").trim();
      if(!name) name=deriveName(form.std_id, form.conc, form.unit, form.batch);
      form.name=name;
      if(!name) throw new Error("溶液名称将自动生成，请先填写标准物质编号、浓度/规格和批号");
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
          // 未选满：用全部空闲格补齐
          const free=this.boardLocations().filter(l=>!occ.has(l)&&!locs.includes(l));
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
      // v2.2：品种二维码（6 字段 JSON）
      const qr=parseQRPayload(code);
      if(qr){
        const [prod, list]=this.findProductByQR(qr);
        if(prod) return {type:"product", product:prod, items:list};
        return {type:"product", product:null, qr};
      }
      // 品种码（旧式条形码）
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

  Store.deriveName=deriveName;
  Store.parseQRPayload=parseQRPayload;

  global.XLBStore = Store;
  global.XLBDeriveName = deriveName;
  global.XLBParseQRPayload = parseQRPayload;
  global.XLBHashPass = hashPass;
  global.XLBConst = {STOCK_KEYS,LOG_KEYS,PROD_KEYS,ST_IN,ST_OUT,ST_EMPTY,ST_DISCARD,ST_USED,
    ACT_RECEIVE,ACT_USE,ACT_CHECKOUT,ACT_RETURN,ACT_DISCARD,ACT_REPRINT,ACT_EDIT,DEFAULT_CONFIG,ALL_PERMS};
})(window);
