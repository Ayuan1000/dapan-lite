
'use strict';
/* ================= 常量与工具 ================= */
const UT='7eea3edcaed734bea9cbfc24409ed989';
const EM_ZT='https://push2ex.eastmoney.com/getTopicZTPool?ut='+UT+'&dpt=wz.ztzt&Pageindex=0&pagesize=400&sort=fbt:asc&date=';
const EM_ZB='https://push2ex.eastmoney.com/getTopicZBPool?ut='+UT+'&dpt=wz.ztzt&Pageindex=0&pagesize=400&sort=fbt:asc&date=';
const EM_DT='https://push2ex.eastmoney.com/getTopicDTPool?ut='+UT+'&dpt=wz.ztzt&Pageindex=0&pagesize=200&sort=fund:asc&date=';
const EM_KL='https://push2his.eastmoney.com/api/qt/stock/kline/get?klt=101&fqt=1&end=20500101&lmt=30&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&ut=fa5fd1943c7b386f172d6893dbfba10b&secid=';
const THS_URL='https://d.10jqka.com.cn/v4/line/bk_883900/01/'; // 同花顺883900 昨日涨停表现指数
const EM_ULIST='https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f2,f3,f4,f6,f12,f14,f104,f105,f106&secids=1.000001,0.399001';
const TX_QT='https://qt.gtimg.cn/q=';
const GBK=new TextDecoder('gbk');
const $=id=>document.getElementById(id);
const pad2=n=>String(n).padStart(2,'0');
const dstr=d=>''+d.getFullYear()+pad2(d.getMonth()+1)+pad2(d.getDate());
const today=dstr(new Date());
const yest=(()=>{const d=new Date();d.setDate(d.getDate()-1);return dstr(d);})();
const dayOf=d=>new Date(+d.slice(0,4),+d.slice(4,6)-1,+d.slice(6,8)).getDay();
const isWd=d=>dayOf(d)>=1&&dayOf(d)<=5;
function fmtTime(x){x=String(x||0).padStart(6,'0');return x.slice(0,2)+':'+x.slice(2,4);}
function clamp(n,a,b){return Math.min(b,Math.max(a,n));}
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function fmtPrice(p){ // 东财 p 单位 分 → 元；腾讯元直用
  if(p==null)return'-';const n=Number(p);return n>=10000?(n/100).toFixed(0):(n/100).toFixed(2);
}
const clsPct=p=>p>0.05?'up':p<-0.05?'dn':'fl';
function emToTx(c,m){ // 东财code → 腾讯代码
  if(m===1)return'sh'+c;
  const h=c[0];
  if(h==='6')return'sh'+c;
  if(h==='0'||h==='3')return'sz'+c;
  return'bj'+c; // 4/8/9
}
/* ================= 演示模式 ================= */
const DEMO_MODE=/[?&]demo=1/.test(location.search);
let DEMO_T=null;
if(DEMO_MODE){
  // 模拟数据(演示渲染用；真实访问不带 demo=1)
  DEMO_T=1;
}
function DEMO_ZT(){return[
 {c:'600721',m:1,n:'百花医药',p:1715,zdp:10.0,lbc:6,fbt:93005,lbt:93005,fund:5.4e8,zbc:0,hybk:'化学制药',hs:2.1,ltsz:6.8e9,amount:3.2e8},
 {c:'002702',m:0,n:'海欣食品',p:679,zdp:10.0,lbc:3,fbt:92500,lbt:92500,fund:6.88e7,zbc:0,hybk:'食品饮料',hs:19.4,ltsz:3.1e9,amount:6.0e8},
 {c:'000912',m:0,n:'泸天化',p:731,zdp:10.1,lbc:3,fbt:93000,lbt:93000,fund:2.1e8,zbc:0,hybk:'化学制品',hs:8.9,ltsz:5.2e9,amount:4.6e8},
 {c:'000523',m:0,n:'红棉股份',p:4360,zdp:10.1,lbc:2,fbt:92500,lbt:92500,fund:4.8e8,zbc:0,hybk:'综合Ⅱ',hs:1.3,ltsz:7.8e9,amount:1.0e8},
 {c:'605179',m:1,n:'一鸣食品',p:1430,zdp:10.0,lbc:2,fbt:93200,lbt:93500,fund:1.2e8,zbc:1,hybk:'食品饮料',hs:6.5,ltsz:2.2e9,amount:2.8e8},
 {c:'002470',m:0,n:'金正大',p:286,zdp:10.0,lbc:2,fbt:93200,lbt:93200,fund:9.8e7,zbc:0,hybk:'化学制品',hs:7.2,ltsz:4.6e9,amount:3.3e8},
 {c:'600596',m:1,n:'新安股份',p:942,zdp:10.0,lbc:2,fbt:94000,lbt:94100,fund:1.5e8,zbc:1,hybk:'化学制品',hs:5.8,ltsz:9.4e9,amount:5.5e8},
 {c:'002155',m:0,n:'湖南黄金',p:1896,zdp:9.98,lbc:1,fbt:100500,lbt:100500,fund:2.6e8,zbc:0,hybk:'贵金属',hs:4.2,ltsz:1.9e10,amount:6.2e8},
 {c:'600812',m:1,n:'华北制药',p:655,zdp:10.1,lbc:1,fbt:94500,lbt:94500,fund:6.6e7,zbc:0,hybk:'化学制药',hs:3.6,ltsz:1.1e10,amount:2.1e8},
 {c:'600141',m:1,n:'兴发集团',p:2160,zdp:10.0,lbc:1,fbt:95500,lbt:95500,fund:1.9e8,zbc:0,hybk:'化学制品',hs:5.0,ltsz:1.5e10,amount:4.4e8}];}
function DEMO_ZB(){return[
 {c:'002162',m:0,n:'悦心健康',p:4420,ztp:4510,zdp:7.8,zbc:3,fbt:92500,hybk:'家居用品',hs:8.1,ltsz:4.1e9,amount:3.3e8},
 {c:'300684',m:0,n:'中石科技',p:2150,ztp:2640,zdp:4.5,zbc:2,fbt:93010,hybk:'消费电子',hs:12.1,ltsz:8.8e9,amount:7.0e8},
 {c:'603711',m:1,n:'香飘飘',p:1490,ztp:1670,zdp:3.2,zbc:2,fbt:93400,hybk:'食品饮料',hs:7.4,ltsz:5.1e9,amount:4.3e8},
 {c:'001366',m:0,n:'播恩集团',p:1638,ztp:1738,zdp:3.7,zbc:1,fbt:94000,hybk:'农牧饲渔',hs:21.9,ltsz:2.6e9,amount:5.7e8},
 {c:'002717',m:0,n:'岭南股份',p:205,ztp:214,zdp:5.1,zbc:1,fbt:95000,hybk:'环保行业',hs:6.3,ltsz:3.4e9,amount:2.6e8},
 {c:'603861',m:1,n:'白云电器',p:970,ztp:1080,zdp:-1.9,zbc:1,fbt:100000,hybk:'电网设备',hs:5.1,ltsz:4.8e9,amount:2.9e8}];}
function DEMO_YZ(){return[
 {c:'605179',m:1,n:'一鸣食品',p:1300,zdp:10.0,lbc:3,fbt:92500,lbt:92500,fund:1.0e8,zbc:1,hybk:'食品饮料',hs:8.8,ltsz:2.2e9,amount:3.4e8},
 {c:'600721',m:1,n:'百花医药',p:1559,zdp:10.0,lbc:5,fbt:93005,lbt:93005,fund:5.0e8,zbc:0,hybk:'化学制药',hs:3.0,ltsz:6.5e9,amount:4.5e8},
 {c:'002702',m:0,n:'海欣食品',p:617,zdp:10.0,lbc:2,fbt:92500,lbt:92500,fund:5.5e7,zbc:0,hybk:'食品饮料',hs:16.0,ltsz:3.0e9,amount:5.2e8},
 {c:'000523',m:0,n:'红棉股份',p:3964,zdp:10.0,lbc:1,fbt:92500,lbt:92500,fund:4.6e8,zbc:0,hybk:'综合Ⅱ',hs:1.1,ltsz:7.7e9,amount:8.8e7},
 {c:'600178',m:1,n:'东安动力',p:1280,zdp:10.0,lbc:2,fbt:93500,lbt:101200,fund:4.2e7,zbc:2,hybk:'汽车零部件',hs:11.2,ltsz:5.9e9,amount:6.6e8},
 {c:'603860',m:1,n:'中公高科',p:1700,zdp:10.0,lbc:2,fbt:94000,lbt:105000,fund:3.8e7,zbc:1,hybk:'专业工程',hs:9.5,ltsz:2.8e9,amount:4.1e8}];}
function DEMO_YB(){return[
 {c:'001366',m:0,n:'播恩集团',p:1581,zdp:6.1,zbc:1,fbt:94000,hybk:'农牧饲渔',hs:18.0,ltsz:2.6e9,amount:4.0e8},
 {c:'300684',m:0,n:'中石科技',p:2200,zdp:8.0,zbc:1,fbt:93010,hybk:'消费电子',hs:14.0,ltsz:8.8e9,amount:6.0e8},
 {c:'000635',m:0,n:'英力特',p:730,zdp:4.1,zbc:2,fbt:93500,hybk:'化学原料',hs:9.0,ltsz:2.1e9,amount:1.9e8},
 {c:'000990',m:0,n:'诚志股份',p:800,zdp:2.6,zbc:2,fbt:94500,hybk:'化学原料',hs:6.0,ltsz:6.8e9,amount:2.2e8}];}
/* ================= 状态 ================= */
function demoQuotes(codes){
  const seed={sh000001:{n:'上证指数',p:3954.37,pc:3940.5,l:4150},sz399001:{n:'深证成指',p:13714.64,pc:13703.7,l:14350},sz399006:{n:'创业板指',p:3353.61,pc:3359.6,l:3520},
    sz002702:{n:'海欣食品',p:6.79,pc:6.17,l:6.79,up:1},sz000523:{n:'红棉股份',p:43.60,pc:39.64,l:43.60,up:1},
    sh600721:{n:'百花医药',p:17.15,pc:15.59,l:17.15,up:1},sz000912:{n:'泸天化',p:7.31,pc:6.65,l:7.32,up:1},
    sz002470:{n:'金正大',p:2.86,pc:2.60,l:2.86,up:1},sh600596:{n:'新安股份',p:9.42,pc:8.56,l:9.42,up:1},
    sh605179:{n:'一鸣食品',p:14.30,pc:13.0,l:14.30,up:1},sz002155:{n:'湖南黄金',p:18.96,pc:17.24,l:18.96,up:1},
    sh600812:{n:'华北制药',p:6.55,pc:5.95,l:6.55,up:1},sh600141:{n:'兴发集团',p:21.60,pc:19.64,l:21.60,up:1},
    sz002162:{n:'悦心健康',p:44.20,pc:40.9,l:45.10,up:0},sz001366:{n:'播恩集团',p:16.38,pc:15.81,l:17.38,up:0},
    sz300684:{n:'中石科技',p:21.5,pc:22.0,l:26.4,up:0},sh603711:{n:'香飘飘',p:14.9,pc:15.2,l:16.7,up:0},
    sz002717:{n:'岭南股份',p:2.05,pc:1.95,l:2.14,up:0},sh603861:{n:'白云电器',p:9.7,pc:9.9,l:10.8,up:0},
    sh600178:{n:'东安动力',p:12.40,pc:12.80,l:14.08,up:0},sh603860:{n:'中公高科',p:18.20,pc:17.00,l:18.70,up:0},
    sz000635:{n:'英力特',p:6.90,pc:7.30,l:8.03,up:0},sz000990:{n:'诚志股份',p:8.05,pc:8.00,l:8.80,up:0}};
  const t=Date.now()/1000;const out={};
  codes.forEach(c=>{
    const s=seed[c]||{n:c,p:12.5,pc:12.2,l:13.4,up:0};
    const drift=s.up?0:Math.sin(t/7+(c.length||1))*0.002;
    const price=+(s.p+drift).toFixed(2);
    const sealed=!!s.up&&price>=s.l-0.005;
    out[c]={name:s.n,code:c.slice(2),price,prev:s.pc,open:+(s.pc*(1+(s.up?0.035:0.008))).toFixed(2),high:s.l,low:+((s.pc*0.99).toFixed(2)),
      pct:+((price/s.pc-1)*100).toFixed(2),amt:0,tr:5,limit:s.l,sealed,gap:null};
  });
  return out;
}

/* ================= 状态 ================= */
const S={emOk:false,txOk:false,trading:false,poolDate:'',today:{zt:[],zb:[],dt:[],dtOk:false},yest:{zt:[],zb:[],date:''},
  quotes:{},idx:{},idx2:{ok:false,ma20:null,preAmt:0,shPrevClose:null},ths:{ok:false,pct:null},breadth:null,mainline:{},lastEm:0,lastTx:0,failEm:0,watch:new Set(),cols:{},
  themes:[],themeOk:false,themeHist:[],newThemes:new Set(),themeTime:'',themeZt:0};

/* ================= 题材聚合（开盘啦式主线） ================= */
async function loadTheme(){
  if(DEMO_MODE){
    S.themeOk=true;S.themeTime='演示';S.themeZt=10;
    S.themes=[
      {name:'低空经济',score:186,pct:4.2,inflow:9.8e8,ztCount:4,maxLbc:3,zt:[{name:'海欣食品',lbc:3},{name:'红棉股份',lbc:2},{name:'金正大',lbc:2}]},
      {name:'化学制品',score:142,pct:3.1,inflow:5.2e8,ztCount:4,maxLbc:3,zt:[{name:'泸天化',lbc:3},{name:'新安股份',lbc:2},{name:'兴发集团',lbc:1}]},
      {name:'创新药',score:118,pct:2.6,inflow:3.1e8,ztCount:3,maxLbc:6,zt:[{name:'百花医药',lbc:6},{name:'华北制药',lbc:1}]},
      {name:'食品饮料',score:97,pct:2.2,inflow:1.4e8,ztCount:3,maxLbc:3,zt:[{name:'一鸣食品',lbc:2},{name:'香飘飘',lbc:1}]}
    ];
    renderThemes();return;
  }
  const date=S.poolDate||S.yest.date||yest;
  try{
    const d=await jget('./.netlify/functions/theme?date='+date,2,20000);
    if(d&&d.rc===0&&d.concepts){
      S.themeOk=true;S.themes=d.concepts;S.themeZt=d.ztTotal||0;S.themeTime=new Date().toTimeString().slice(0,5);
      if(d.concepts.length){
        S.themeHist.push({t:Date.now(),top1:(d.concepts[0]||{}).name||'',ranks:d.concepts.slice(0,5).map(c=>c.name),
          scores:Object.fromEntries(d.concepts.slice(0,8).map(c=>[c.name,c.score]))});
        if(S.themeHist.length>40)S.themeHist.shift();
        S.newThemes=new Set();
        const now=Date.now();const old=[...S.themeHist].reverse().find(h=>now-h.t>=5*60*1000);
        if(old)d.concepts.slice(0,3).forEach(c=>{if(c.name!==old.top1&&!(old.ranks||[]).includes(c.name))S.newThemes.add(c.name);});
      }
      renderThemes();
    }else{S.themeOk=false;renderThemes();}
  }catch(e){S.themeOk=false;renderThemes();}
}

/* ================= fetch helpers ================= */
async function jget(url,tries=2,to=8000){
  for(let i=0;i<tries;i++){
    try{
      const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),to);
      const r=await fetch(url,{signal:ctl.signal});clearTimeout(t);
      if(!r.ok)throw new Error('HTTP '+r.status);
      return await r.json();
    }catch(e){ if(i===tries-1)throw e; await sleep(1200); }
  }
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function txQuote(codes){ // 批量腾讯现价，40/批
  return new Promise(async(resolve)=>{
    const out={};const all=[...codes];
    for(let i=0;i<all.length;i+=40){
      const chunk=all.slice(i,i+40);const url=TX_QT+chunk.join(',');
      try{
        const r=await fetch(url);const buf=await r.arrayBuffer();const txt=GBK.decode(buf);
        const re=/v_(sh|sz|bj)(\d+)="([^"]*)"/g;let m;
        while((m=re.exec(txt))){out[(m[1]==='sh'?'sh':m[1]==='sz'?'sz':'bj')+m[2]]=parseTx(m[3]);}
      }catch(e){/* single batch fail -> keep old */}
    }
    resolve(out);
  });
}
function parseTx(body){
  const f=body.split('~');
  const pr=parseFloat(f[3]),pc=parseFloat(f[4]),op=parseFloat(f[5]);
  return{name:f[1],code:f[2],price:pr||0,prev:pc||0,open:op||0,high:parseFloat(f[33])||0,low:parseFloat(f[34])||0,
    pct:parseFloat(f[32]),amt:parseFloat(f[37])||0,tr:parseFloat(f[38]),limit:parseFloat(f[47])||0,
    sealed:false, gap:(pc&&op>0)?(op/pc-1)*100:null};
}
/* ================= 东财池 ================= */
async function emPool(kind,date){
  // 直连东财失败时自动走 Netlify Function 代理（绕开东财对本机/网络 IP 的限流）
  const direct=(kind==='ZT'?EM_ZT:kind==='DT'?EM_DT:EM_ZB)+date;
  let d=null;
  try{d=await jget(direct);}catch(e){}
  if(!d||d.rc!==0||!d.data){
    try{d=await jget('./.netlify/functions/pool?date='+date+'&kind='+kind);}catch(e){}
  }
  if(!d||d.rc!==0||!d.data)throw new Error('pool fail '+(d&&d.rc));
  return d.data; // {tc, qdate, pool}
}
function normStock(x){
  const pct=+x.zdp; const amt=+x.amount||0;
  return{code:x.c,m:x.m,name:x.n,price:+x.p,pct,
    boards:+x.lbc||0,hybk:x.hybk||'未知',fbt:+x.fbt||0,lbt:+x.lbt||0,zbc:+x.zbc||0,
    fund:+x.fund||0,ltsz:+x.ltsz||0,hs:+x.hs||0,amt,
    ztp:+x.ztp||0,kind:''};
}
/* ================= 渲染 ================= */
function setSrc(key,ok){$(key).className=ok?'ok':'bad';}
function setMarket(st,msg){$('mktBadge').className='dot '+st;$('mktTxt').textContent=msg;}
function banner(msg,cls){const b=$('bannerBox');if(!msg){b.innerHTML='';return;}b.innerHTML='<div class="banner show '+cls+'">'+msg+'</div>';}

function renderIndex(){
  const o={sh:{n:'上证',q:S.idx.sh},sz:{n:'深证',q:S.idx.sz},cyb:{n:'创业板',q:S.idx.cyb}};
  $('indexBox').innerHTML='<div class="indexbar">'+Object.values(o).map(x=>{
    const q=x.q;if(!q)return'<div class="ix"><div class="nm">'+x.n+'</div><div class="pr fl">--</div></div>';
    const c=clsPct(q.pct);
    return'<div class="ix"><div class="nm">'+x.n+'</div><div class="pr '+c+' mono">'+q.price.toFixed(2)+'</div><div class="pc '+c+' mono">'+(q.pct>=0?'+':'')+q.pct.toFixed(2)+'%</div></div>';
  }).join('')+'</div>';
  const b=S.breadth;const zt=S.today.zt.length,zb=S.today.zb.length;
  const rise=b?(b.up||0):'-',fall=b?(b.down||0):'-';
  let maxB=0;S.today.zt.forEach(x=>{if(x.boards>maxB)maxB=x.boards;});
  const zbRate=zt+zb>0?(zb/(zt+zb)*100):0;
  const estAmt=estTodayAmt(w2e(S.idx.sh,S.idx.zzr)||0);
  const estTxt=estAmt==null?'待开盘':(estAmt/1e12).toFixed(2)+'万亿';
  $('chipBox').innerHTML='<div class="chips">'
   +chip('沪深上涨',rise,'up')+chip('沪深下跌',fall,'dn')
   +chip('涨停',zt+'<small>跌'+S.today.dt.length+'</small>','up')
   +chip('昨涨停表现',S.ths.ok?((S.ths.pct>=0?'+':'')+S.ths.pct+'%<small>883900</small>'):'--',S.ths.ok?(S.ths.pct>0?'up':'dn'):'fl')
   +chip('炸板',zb+'<small>率'+zbRate.toFixed(0)+'%</small>','dn')
   +chip('最高板',maxB+'<small>板</small>',maxB>=4?'up':'fl')
   +chip('今日预估成交额',estTxt,estAmt!=null&&estAmt>=2e12?'up':(estAmt!=null?'dn':'fl'))
   +chip('封单王',S.topFund?S.topFund.name:'-','')
   +'</div>';
}
function chip(k,v,c){return'<div class="chip"><div class="k">'+k+'</div><div class="v '+c+'">'+v+'</div></div>';}

function verdict(){
  /* ===== 三层滤网纪律：大盘环境 > 板块 > 个股，任意一层不满足 → 空仓关软件 ===== */
  const zt=S.today.zt.length,zb=S.today.zb.length,dtN=S.today.dt.length;
  let maxB=0;S.today.zt.forEach(x=>{if(x.boards>maxB)maxB=x.boards;});
  const b=S.breadth;const rise=b?(b.up||0):null;
  const zbRate=zt+zb>0?zb/(zt+zb)*100:100;
  const phase=sessionPhase(); // pre/auction/am/lunch/pm/post
  const preOpen=(phase==='pre'||phase==='auction');
  const it2=w2e(S.idx.sh,S.idx.zzr); // 两市实时成交额(元)

  /* ---- 第1层（盘前）：今日预估≥2万亿 + 上涨≥2500 + 站上20日线 ---- */
  const L1=[];let l1ok=true,l1pend=false;
  const amtW=v=>(v/1e12).toFixed(2)+'万亿';
  if(preOpen){
    L1.push(mk(null,'今日预估成交额','待开盘验证'));
  }else if(it2!=null){
    const est=estTodayAmt(it2);
    if(est!=null){const ok1=est>=2e12;L1.push(mk(ok1,'今日预估成交额',amtW(est)+'≥2万亿'));if(!ok1)l1ok=false;}
    else{L1.push(mk(null,'今日预估成交额','开盘初期样本不足'));l1pend=true;}
  }else{L1.push(mk(null,'今日预估成交额','行情加载中'));l1pend=true;}
  if(rise!=null){
    const ok3=rise>=2500;L1.push(mk(ok3,'上涨家数',rise+'家≥2500'));if(!ok3)l1ok=false;
  }else{L1.push(mk(null,'上涨家数','数据加载中'));l1pend=true;}
  {
    const shq=S.idx.sh;const px=shq&&shq.price>0?shq.price:S.idx2.shPrevClose;
    if(S.idx2.ok&&S.idx2.ma20&&px){
      const ok4=px>S.idx2.ma20;L1.push(mk(ok4,'大盘站上20日线','现价'+px.toFixed(0)+' vs MA20 '+S.idx2.ma20.toFixed(0)));if(!ok4)l1ok=false;
    }else{L1.push(mk(null,'大盘站上20日线','数据加载中'));l1pend=true;}
  }

  /* ---- 第2层（9:30后） ---- */
  const L2=[];let l2ok=true,l2pend=false;
  if(preOpen){
    L2.push(mk(null,'涨停≥60','待开盘'),mk(null,'跌停≤3','待开盘'),mk(null,'炸板率≤25%','待开盘'),mk(null,'高度≥4板','待开盘'),mk(null,'昨日涨停有溢价','待开盘'));
    l2pend=true;
  }else{
    const ok21=zt>=60;L2.push(mk(ok21,'当前涨停家数≥60','现'+zt+'家'));if(!ok21)l2ok=false;
    if(S.today.dtOk){
      const ok22=dtN<=3;L2.push(mk(ok22,'跌停≤3家','现'+dtN+'家'));if(!ok22)l2ok=false;
    }else{L2.push(mk(null,'跌停≤3家','数据加载中'));l2pend=true;}
    const ok23=zbRate<=25;L2.push(mk(ok23,'炸板率≤25%','现'+zbRate.toFixed(0)+'%'));if(!ok23)l2ok=false;
    const ok24=maxB>=4;L2.push(mk(ok24,'高度≥4板','现'+maxB+'板'));if(!ok24)l2ok=false;
    const pv=S.ths.ok?S.ths.pct:yestPremium();
    if(pv==null){L2.push(mk(null,'昨日涨停有溢价','数据加载中'));l2pend=true;}
    else{const ok25=pv>0;L2.push(mk(ok25,'昨日涨停有溢价',S.ths.ok?'883900指数 '+(pv>=0?'+':'')+pv.toFixed(2)+'%':'平均溢价'+(pv>=0?'+':'')+pv.toFixed(1)+'%'));if(!ok25)l2ok=false;}
  }

  /* ---- 第3层（主线板块） ---- */
  const L3=[];let l3ok=true,l3pend=false;
  const top=(S.themes||[])[0];
  if(preOpen){
    L3.push(mk(null,'主线板块','待开盘'));l3pend=true;
  }else if(!top){
    L3.push(mk(null,'主线板块','题材聚合加载中'));l3pend=true;
  }else{
    const ok31=top.ztCount>=8;L3.push(mk(ok31,'主线涨停≥8家',esc(top.name)+' 现'+top.ztCount+'家'));if(!ok31)l3ok=false;
    const lb2=top.zt.filter(z=>z.lbc>=2).length;
    const ok32=lb2>=2||top.maxLbc>=3;L3.push(mk(ok32,'有梯队','连板'+lb2+'只 · 最高'+top.maxLbc+'板'));if(!ok32)l3ok=false;
    const hyset=top.kind==='行业'?new Set([top.name]):new Set(top.zt.map(z=>z.hybk).filter(Boolean));
    const ycnt=S.yest.zt.filter(x=>hyset.has(x.hybk)).length;
    const ok33=ycnt>=2||lb2>=1;L3.push(mk(ok33,'有持续性','昨日同主线'+ycnt+'家 · 连板续作'+lb2+'只'));if(!ok33)l3ok=false;
  }

  /* ---- 逐层闸门 → 结论 ---- */
  let tag,txt,failed='';
  const layerState=(items,ok,pend)=>pend&&ok?'pend':ok?'pass':'fail';
  if(preOpen){
    if(l1ok&&!l1pend){tag='hold';txt='第1层全绿 → 等待9:30验证第2层，盘前不动作';}
    else if(l1ok){tag='hold';txt='第1层盘前项全绿 → 等待开盘验证今日预估成交额与第2层';}
    else{tag='off';txt='第1层不过 → 空仓，关软件。大盘环境差出手必亏！';failed='第1层·大盘环境';}
  }else if(!l1ok){tag='off';txt='第1层不过 → 空仓，关软件。大盘环境 > 板块 > 个股，顺序不能乱！';failed='第1层·大盘环境';}
  else if(l1pend){tag='hold';txt='第1层数据加载中…';}
  else if(!l2ok){tag='off';txt='第2层不过 → 空仓，关软件。情绪/周期不对，出手必亏！';failed='第2层·情绪周期';}
  else if(l2pend){tag='hold';txt='第1层✅ 第2层数据加载中…';}
  else if(!l3ok){tag='off';txt='第3层不过 → 空仓。没有主线板块，模式外买一次亏一次！';failed='第3层·主线板块';}
  else if(l3pend){tag='hold';txt='第1层✅ 第2层✅ 第3层数据加载中…';}
  else{tag='go';txt='三层全绿 → 进入个股模式：分歧转一致 · 高开板上买入 · 排除首板！';}

  const box=$('verdictBox');
  const map={go:['可出手',''],hold:['不出手',''],off:['空仓','']};
  const tagTxt=failed?('❌ '+failed):(tag==='go'?'✅ 三层全绿':tag==='hold'?'⏳ 待验证':'❌ 空仓');
  box.innerHTML='<div class="funnel">'
    +'<div class="flayer '+layerState(L1,l1ok,l1pend&&!l1ok?false:l1pend)+'"><div class="fl-h">第1层 · 大盘环境（盘前）<span style="font-weight:400;color:var(--tx3)">大盘环境 > 板块 > 个股</span></div><div class="fl-items">'+L1.join('')+'</div></div>'
    +'<div class="flayer '+layerState(L2,l2ok,l2pend)+'"><div class="fl-h">第2层 · 情绪周期（9:30后五项全达标）</div><div class="fl-items">'+L2.join('')+'</div></div>'
    +'<div class="flayer '+layerState(L3,l3ok,l3pend)+'"><div class="fl-h">第3层 · 主线板块（涨停≥8+梯队+持续性）</div><div class="fl-items">'+L3.join('')+'</div></div>'
    +'<div class="verdict '+tag+'"><div class="v-tag">'+map[tag][0]+'</div><div class="v-sub"><b>'+tagTxt+'</b><br>'+txt+'</div></div>'
    +'</div>';
}
function mk(ok,name,val){
  const ico=ok===true?'✅':ok===false?'❌':'⏳';
  return'<span>'+ico+' '+name+' <b>'+val+'</b></span>';
}
function sessionPhase(){
  const d=new Date();const m=d.getHours()*60+d.getMinutes();
  if(m<565)return'pre';            // <9:25
  if(m<570)return'auction';        // 9:25-9:30 竞价
  if(m<=690)return'am';            // 9:30-11:30
  if(m<=780)return'lunch';         // 午休
  if(m<=930)return'pm';            // 13:00-15:00
  return'post';
}
function w2e(sh,zzr){ // 两市实时成交额(元)，腾讯 field37 单位万元
  if(!sh||!zzr||!(sh.amt>0)||!(zzr.amt>0))return null;
  return(sh.amt+zzr.amt)*1e4;
}
function estTodayAmt(totalYuan){ // 按已开盘时间占比外推全天
  const d=new Date();const m=d.getHours()*60+d.getMinutes();
  let el;
  if(m<570)el=0;
  else if(m<=690)el=m-570;
  else if(m<=780)el=120;
  else if(m<=930)el=120+(m-780);
  else el=240;
  if(el<=0)return null;
  if(el<10)return null; // 开盘前10分钟样本不足
  return totalYuan/Math.min(el/240,1);
}
function yestPremium(){ // 昨日涨停股今日平均溢价%
  const pcts=S.yest.zt.map(x=>{const q=S.quotes[emToTx(x.code,x.m)];return q&&isFinite(q.pct)?q.pct:null;}).filter(v=>v!=null);
  if(pcts.length<Math.max(5,S.yest.zt.length*0.5))return null;
  return pcts.reduce((a,v)=>a+v,0)/pcts.length;
}

/* ---------- 主线：题材强度榜（开盘啦式） ---------- */
function renderThemes(){
  $('switchBar').innerHTML=switchHtml(); // 监测条无条件刷新，任何状态都不卡死
  const th=S.themes||[];
  if(!S.themeOk){$('themeBody').innerHTML='<div class="empty">题材聚合暂不可用，60s自动重试…</div>';$('cMain').textContent='-';return;}
  if(!th.length){$('themeBody').innerHTML='<div class="empty">暂无涨停题材（休市或市场无涨停）</div>';$('cMain').textContent='0';return;}
  const mx=th[0].score||1;
  $('themeNote').textContent='涨停×概念聚合 · '+S.themeTime+' 更新 · 全市场涨停'+S.themeZt+'家';
  $('themeBody').innerHTML=th.slice(0,3).map((t,i)=>{
    const isNew=S.newThemes&&S.newThemes.has(t.name);
    const kd=t.kind==='行业'?' <span class="badge b-yz">行业</span>':'';
    const nm=esc(t.name)+kd+(isNew?' <span class="badge b-mz">NEW</span>':'');
    const leads=t.zt.map(z=>esc(z.name)+'<b>'+z.lbc+'板</b>').join('　');
    const sub='涨停<b>'+t.ztCount+'</b>家 · 最高<b>'+t.maxLbc+'板</b> · 板块'+(t.pct>=0?'+':'')+t.pct.toFixed(1)+'% · 净流入'+(t.inflow>=0?'+':'')+(t.inflow/1e8).toFixed(1)+'亿<br>'+leads;
    return'<div class="trow"><div class="t-main"><span class="trank">'+(i+1)+'</span><span class="tname">'+nm+'</span><span class="tscore">'+t.score+'</span></div><div class="t-sub">'+sub+'</div><div class="barc"><i style="width:'+Math.max(6,Math.round(t.score/mx*100))+'%"></i></div></div>';
  }).join('');
  $('cMain').textContent=th[0].ztCount;
}
function switchHtml(){
  const H=S.themeHist||[];const now=Date.now();
  const cur=(S.themes[0]||{}).name||'';
  if(!S.themeOk)return'<div class="swatch">⚠️ 题材数据获取失败（休市/东财限流），自动重试中…（最近主线 <b>'+esc(cur||'-')+'</b>）</div>';
  if(!(S.themes||[]).length)return'<div class="swatch">🕐 休市/暂无涨停题材，开盘后自动监测切换（最近主线 <b>'+esc(cur||'-')+'</b>）</div>';
  if(!H.length)return'<div class="swatch">🕐 主线切换监测累计中…（约5分钟后给出对比，当前主线 <b>'+esc(cur||'-')+'</b>）</div>';
  const old=[...H].reverse().find(h=>now-h.t>=5*60*1000);
  if(!old)return'<div class="swatch">🕐 切换监测累计 '+Math.max(1,Math.round((now-H[0].t)/60000))+' 分钟…当前主线 <b>'+esc(cur||'-')+'</b>（强度'+((S.themes[0]||{}).score||0)+'）</div>';
  const msgs=[];
  if(cur&&old.top1&&cur!==old.top1)msgs.push('🔁 <b>主线切换信号</b>：'+esc(old.top1)+' → <b style="color:var(--red)">'+esc(cur)+'</b>');
  (S.themes.slice(0,3)||[]).forEach(t=>{
    if(t.name!==old.top1&&!(old.ranks||[]).includes(t.name))msgs.push('🆕 <b>新题材上攻</b>：'+esc(t.name)+'（强度'+t.score+' · 涨停'+t.ztCount+'家 · 最高'+t.maxLbc+'板）');
  });
  if(cur&&old.scores&&old.scores[cur]!=null&&S.themes[0]&&S.themes[0].score<old.scores[cur]*0.7)msgs.push('⚠️ 主线 <b>'+esc(cur)+'</b> 强度较 '+Math.round((now-old.t)/60000)+' 分钟前衰减 '+Math.round((1-S.themes[0].score/old.scores[cur])*100)+'%');
  if(!msgs.length)msgs.push('✅ 主线未变：<b>'+esc(cur)+'</b> 持续领跑（强度'+((S.themes[0]||{}).score||0)+'）');
  return'<div class="swatch">'+msgs.join('<br>')+'</div>';
}
function renderIndustry(){
  const pool=S.today.zt;
  if(!S.emOk){$('indBody').innerHTML='<div class="empty">榜单数据暂不可用（东财限流/未恢复），正在自动重试…</div>';return;}
  if(!pool.length){$('indBody').innerHTML='<div class="empty">当前无封板个股。可能休市或暂无涨停。</div>';return;}
  const m={};pool.forEach(x=>{const k=x.hybk||'未知';if(!m[k])m[k]={n:0,list:[],tot:0};m[k].n++;m[k].list.push(x);m[k].tot+=x.boards;});
  const inds=Object.keys(m).map(k=>({name:k,...m[k]})).sort((a,b)=>b.n-a.n||b.tot-a.tot).slice(0,6);
  S.mainline.inds=inds;
  const mx=inds.length?inds[0].n:1;
  let html='';
  const gname=g=>g.startsWith('综合')||g==='未知'?'其他':g;
  inds.forEach((g,i)=>{
    const lead=[...g.list].sort((a,b)=>b.boards-a.boards||b.fund-a.fund)[0];
    const sub=[...g.list].sort((a,b)=>b.boards-a.boards||b.fund-a.fund).map(x=>esc(x.name)+'<b>'+x.boards+'</b>').join('　');
    html+='<div class="icluster"><div class="rank">'+(i+1)+'</div><div class="info">'
      +'<div class="t">'+esc(gname(g.name))+'<span class="n2">龙头 '+esc(lead.name)+' '+lead.boards+'板</span></div>'
      +'<div class="lead">'+sub+'</div>'
      +'<div class="barc"><i style="width:'+(g.n/mx*100)+'%"></i></div>'
      +'</div><div class="cnt">'+g.n+'<small> 家</small></div></div>';
  });
  $('indBody').innerHTML=html;
  // 高标天梯
  const tops=[...pool].sort((a,b)=>b.boards-a.boards||b.fund-a.fund).slice(0,5);
  const css4=gridCols(['nm','pr','pc'],'40px');
  if(tops.length){
    $('topLadderBody').innerHTML='<div class="rhead" style="display:grid;grid-template-columns:'+css4+'"><span>名称/行业</span><span style="text-align:right">现价</span><span style="text-align:right">状态</span></div>'
    +tops.map(x=>{
      const q=S.quotes[emToTx(x.code,x.m)];const sealed=q?q.sealed:false;const pct=q?q.pct:x.pct;const pr=q?q.price:(x.price/100);
      return'<div class="row" style="grid-template-columns:'+css4+'"><div class="cell-nm"><div class="nm">'+esc(x.name)+' <span class="badge b-yz">'+x.boards+'板</span><span class="cd">'+x.code+'</span></div><div class="ind">'+esc(x.hybk||'')+' · 封'+(x.fund/1e8).toFixed(1)+'亿'+(x.zbc>0?' · 炸'+x.zbc:'')+'</div></div>'
      +'<div class="pr '+clsPct(pct)+' mono">'+pr.toFixed(2)+'</div>'
      +'<div class="pc"><span class="'+clsPct(pct)+' mono">'+(pct>=0?'+':'')+pct.toFixed(1)+'%</span><br><span class="badge '+(sealed?'b-seal':'b-gap')+'">'+(sealed?'封板':'开板')+'</span></div></div>';
    }).join('');
  }else $('topLadderBody').innerHTML='';
}

/* ---------- 连板梯队 ---------- */
function gridCols(names){
  const map={nm:'1.7fr',cd:'55px',ind:'1fr',pr:'72px',pc:'64px',no:'42px'};
  return names.map(n=>map[n]||'1fr').join(' ');
}
const LADDER_COLS=['no','nm','ind','pr','pc'];
function renderLadder(){
  const list=[...S.today.zt].sort((a,b)=>b.boards-a.boards||b.fund-a.fund);
  $('cLadder').textContent=S.today.zt.length;
  if(!S.emOk){$('ladderBody').innerHTML='<div class="empty">榜单暂不可用，自动重试中…</div>';return;}
  if(!list.length){$('ladderBody').innerHTML='<div class="empty">暂无封板个股</div>';return;}
  const css=gridCols(LADDER_COLS);
  $('lhead').style.display='grid';$('lhead').style.gridTemplateColumns=css;
  $('lhead').innerHTML='<span>板</span><span>名称/行业</span><span class="muted" style="color:var(--tx3)">首封/封单</span><span style="text-align:right">现价</span><span style="text-align:right">涨跌/状态</span>';
  $('ladderBody').innerHTML=list.map(x=>{
    const q=S.quotes[emToTx(x.code,x.m)];const sealed=q?q.sealed:false;const pct=q?q.pct:x.pct;
    const pr=q?q.price:(x.price/100);
    const no=x.boards>=2?'<span class="badge b-yz">'+x.boards+'板</span>':(x.boards===1?'<span class="badge b-mz">首板</span>':'');
    const sealCls=sealed?'b-seal':'b-gap';const sealTxt=sealed?'封板':(pct>=0?'曾封':'炸');
    const sub=(fmtTime(x.fbt))+' · 封'+(x.fund/1e8).toFixed(1)+'亿'+(x.zbc>0?' · 炸'+x.zbc: '');
    return'<div class="row" style="grid-template-columns:'+css+'"><div class="no">'+no+'</div>'
      +'<div class="cell-nm"><div class="nm">'+esc(x.name)+'<span class="cd">'+x.code+'</span></div><div class="ind">'+esc(x.hybk||'')+'</div></div>'
      +'<div class="sub" style="font-size:10px;color:var(--tx3)">'+sub+'</div>'
      +'<div class="pr '+clsPct(pct)+' mono">'+pr.toFixed(2)+'</div>'
      +'<div class="pc"><span class="'+clsPct(pct)+' mono">'+(pct>=0?'+':'')+pct.toFixed(1)+'%</span><br><span class="badge '+sealCls+'">'+sealTxt+'</span></div></div>';
  }).join('');
}

/* ---------- 当前烂板 ---------- */
function renderBroken(){
  const list=[...S.today.zb];
  if(!S.emOk){$('brokenBody').innerHTML='<div class="empty">榜单暂不可用，自动重试中…</div>';return;}
  $('cBroken').textContent=list.length;
  if(!list.length){$('brokenBody').innerHTML='<div class="empty">今日暂无炸板个股（榜单口径）</div>';return;}
  // 附加实时状态：是否已回封
  list.forEach(x=>{const q=S.quotes[emToTx(x.code,x.m)];if(q){x._sealed=q.sealed;x._pct=q.pct;x._price=q.price;x._lim=q.limit;}else{x._sealed=false;x._pct=x.pct;x._price=x.price/100;x._lim=x.ztp||0;}});
  const sealed=list.filter(x=>x._sealed);const open=list.filter(x=>!x._sealed);
  open.sort((a,b)=>b.zbc-a.zbc||b._pct-a._pct);
  const all=[...sealed,...open];
  const css=gridCols(['nm','sub','pr','pc'],'40px');
  $('bhead').style.display='grid';$('bhead').style.gridTemplateColumns=css;
  $('bhead').innerHTML='<span>名称</span><span>炸板/封单</span><span style="text-align:right">现价</span><span style="text-align:right">距板/状态</span>';
  $('brokenBody').innerHTML=all.map(x=>{
    const q=S.quotes[emToTx(x.code,x.m)];
    const dist=x._lim>0?((x._lim-x._price)/x._lim*100):null;
    const tag=x._sealed?'<span class="badge b-seal">已回封</span>':(dist!=null&&dist<1?'<span class="badge b-yz">临近</span>':(x.zbc>=2?'<span class="badge b-gap">烂'+x.zbc+'次</span>':'<span class="badge b-wk">炸开</span>'));
    const sub=(x.zbc>0?'炸'+x.zbc+'次 · ':'')+'封单'+(x.fund/1e8).toFixed(1)+'亿 · 换'+(x.hs||0).toFixed(0)+'%';
    return'<div class="row" style="grid-template-columns:'+css+'"><div class="cell-nm"><div class="nm">'+esc(x.name)+'<span class="cd">'+x.code+'</span></div><div class="ind">'+esc(x.hybk||'')+'</div></div>'
      +'<div class="sub" style="font-size:10px;color:var(--tx3)">'+sub+'</div>'
      +'<div class="pr '+clsPct(x._pct)+' mono">'+x._price.toFixed(2)+'</div>'
      +'<div class="pc"><span class="'+clsPct(x._pct)+' mono">'+(x._pct>=0?'+':'')+x._pct.toFixed(1)+'%</span><br>'+tag+'</div></div>';
  }).join('');
}

/* ---------- 昨板今况 ---------- */
function yRow(x,isSeal){ // x from yesterday pools
  const q=S.quotes[emToTx(x.code,x.m)];
  const pr=q?q.price:(x.price/100);const pct=q?q.pct:0;
  const lim=q?q.limit:(x.price/100*1.1);
  const gap=q&&q.gap!=null?q.gap:null;
  const sealed=q?q.sealed:(pct>=9.8);
  const gtxt=gap==null?'--':(gap>=0?'+':'')+gap.toFixed(1)+'%';
  const css=gridCols(['nm','pr','pc'],'42px');
  let st;
  if(sealed)st='<span class="badge b-seal">涨停</span>';
  else if(pct>=5)st='<span class="badge b-yz">大涨</span>';
  else if(pct>0)st='<span class="badge b-gap">红盘</span>';
  else if(pct>-5)st='<span class="badge b-wk">回落</span>';
  else st='<span class="badge b-weak">重挫</span>';
  const bno=x.boards>=2?(' <span class="badge b-yz">'+x.boards+'板</span>'):(x.boards===1?'':'');
  const sub=(x.zbc>0?'昨炸'+x.zbc:'昨首板')+' · 高开'+gtxt;
  return'<div class="row" style="grid-template-columns:'+css+'"><div class="cell-nm"><div class="nm">'+esc(x.name)+bno+'<span class="cd">'+x.code+'</span></div><div class="ind">'+sub+'</div></div>'
    +'<div class="pr '+clsPct(pct)+' mono">'+pr.toFixed(2)+'</div>'
    +'<div class="pc"><span class="'+clsPct(pct)+' mono">'+(pct>=0?'+':'')+pct.toFixed(1)+'%</span><br>'+st+'</div></div>';
}
function renderYest(){
  const yy=S.yest;
  const sealList=yy.zt.filter(x=>x.zbc>0); // 昨日烂板回封
  const bkList=yy.zb;
  $('ysealNote').textContent=yy.date?('昨日 '+yy.date.slice(4,6)+'/'+yy.date.slice(6,8)+' · '+sealList.length+'只'):'';
  $('ybkNote').textContent=yy.date?('昨日 '+yy.date.slice(4,6)+'/'+yy.date.slice(6,8)+' · '+bkList.length+'只'):'';
  const css=gridCols(['nm','pr','pc'],'42px');
  $('yshead').style.display=yy.date?'grid':'none';$('yshead').style.gridTemplateColumns=css;
  $('ybhead').style.display=yy.date?'grid':'none';$('ybhead').style.gridTemplateColumns=css;
  $('yshead').innerHTML='<span>昨烂板回封（弱板转强看）</span><span style="text-align:right">现价</span><span style="text-align:right">今表现</span>';
  $('ybhead').innerHTML='<span>昨炸板未回封（模式C观察）</span><span style="text-align:right">现价</span><span style="text-align:right">今表现</span>';
  if(!yy.date){$('ysealBody').innerHTML=$('ybkBody').innerHTML='<div class="empty">昨日数据未加载</div>';return;}
  if(!sealList.length)$('ysealBody').innerHTML='<div class="empty">昨日涨停均无炸板记录</div>';
  else $('ysealBody').innerHTML=sealList.map(x=>yRow(x,true)).join('');
  if(!bkList.length)$('ybkBody').innerHTML='<div class="empty">昨日无炸板股</div>';
  else $('ybkBody').innerHTML=bkList.map(x=>yRow(x,false)).join('');
  $('cYest').textContent=sealList.length+bkList.length;
}
/* ================= 数据加载 ================= */
function updateWatch(){
  const w=new Set();
  [...S.today.zt,...S.today.zb,...S.yest.zt,...S.yest.zb].forEach(x=>w.add(emToTx(x.code,x.m)));
  w.add('sh000001');w.add('sz399001');w.add('sz399006');w.add('sz399106');
  S.watch=w;
}
async function loadTodayPools(){
  if(DEMO_MODE){S.emOk=true;S.trading=true;S.poolDate=today;S.today.zt=DEMO_ZT().map(normStock);S.today.zb=DEMO_ZB().map(normStock);S.today.dt=[];S.today.dtOk=true;S.lastEm=Date.now();updateWatch();renderAll();return;}
  // ZT/ZB 分开加载：一只失败不影响另一只
  try{
    const zt=await emPool('ZT',today);
    S.today.zt=zt.pool.map(normStock);S.poolDate=zt.qdate||today;
  }catch(e){}
  try{
    const zb=await emPool('ZB',today);
    S.today.zb=zb.pool.map(normStock);
  }catch(e){}
  try{
    const dt=await emPool('DT',today);
    S.today.dt=(dt.pool||[]).map(normStock);S.today.dtOk=true;
  }catch(e){S.today.dt=[];S.today.dtOk=false;}
  const got=S.today.zt.length||S.today.zb.length;
  if(got){S.failEm=0;S.emOk=true;S.lastEm=Date.now();banner('',null);}
  else{S.failEm++;S.emOk=false;
    if(S.failEm>=3)banner('⚠️ 涨停/炸板榜单（东财）多次获取失败，可能被临时限流。个股现价不受影响，将自动退避重试。','warn');
  }
  updateWatch();
  if(got)S.trading=true;
}
async function loadYestPools(){
  if(DEMO_MODE){S.yest={date:yest,zt:DEMO_YZ().map(normStock),zb:DEMO_YB().map(normStock)};updateWatch();renderAll();return;}
  const key='lkl_yest_'+today;
  try{
    const c=JSON.parse(localStorage.getItem(key)||'null');
    if(c&&c.date&&c.zt&&c.zb){S.yest=c;return;}
  }catch(e){}
  // 逐日回退找最近交易日
  for(let back=1;back<=4;back++){
    const d=new Date();d.setDate(d.getDate()-back);const ds=dstr(d);
    if(!isWd(ds))continue;
    try{
      const zt=await emPool('ZT',ds),zb=await emPool('ZB',ds);
      if(zt.pool.length||zb.pool.length){
        S.yest={date:ds,zt:zt.pool.map(normStock),zb:zb.pool.map(normStock)};
        try{localStorage.setItem(key,JSON.stringify(S.yest));}catch(e){}
        break;
      }
    }catch(e){}
    await sleep(1000);
  }
  if(!S.yest.date){
    // 用缓存兜底
    try{const c=JSON.parse(localStorage.getItem('lkl_yest_old')||'null');if(c)S.yest=c;}catch(e){}
  }
  updateWatch();renderAll();
}
async function loadBreadth(){
  if(DEMO_MODE){S.breadth={up:2860,down:2130,flat:160};S.ths={ok:true,pct:1.24};return;}
  try{
    const d=await jget(EM_ULIST);
    const diff=(d.data&&d.data.diff)||[];
    const get=s=>{const v=diff.find(x=>x.f12===s);return v;};
    const sh=get('000001'),sz=get('399001');
    if(sh&&sz)S.breadth={up:(sh.f104||0)+(sz.f104||0),down:(sh.f105||0)+(sz.f105||0),flat:(sh.f106||0)+(sz.f106||0)};
  }catch(e){}
}
async function loadIdx(){ // 大盘环境（三层滤网第1层）：MA20/昨日两市成交额（直连优先，函数兑底）
  if(DEMO_MODE){S.idx2={ok:true,ma20:3450.5,preAmt:2.34e12,shPrevClose:3421.18,shPreDate:''};return;}
  const parse=d=>((d.data&&d.data.klines)||[]).map(s=>{const f=s.split(',');return{date:f[0],close:+f[2],amt:+f[6]};});
  try{
    const [sh,sz]=await Promise.all([jget(EM_KL+'1.000001'),jget(EM_KL+'0.399106')]);
    const shK=parse(sh),szK=parse(sz);
    const tj=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date()).replace(/-/g,'');
    const preIdx=k=>{let i=k.length-1;if(k.length&&k[i].date===tj)i--;return i;};
    const si=preIdx(shK),zi=preIdx(szK);
    const closes=shK.slice(-20).map(x=>x.close);
    if(closes.length>=20&&shK[si]&&szK[zi]){
      S.idx2={ok:true,ma20:+(closes.reduce((a,b)=>a+b,0)/20).toFixed(2),preAmt:(shK[si].amt||0)+(szK[zi].amt||0),shPrevClose:shK[si].close,shPreDate:shK[si].date};
      return;
    }
  }catch(e){}
  try{ // 兑底：函数代理
    const d=await jget('./.netlify/functions/idx',1,12000);
    if(d&&d.rc===0)S.idx2={ok:true,ma20:d.ma20,preAmt:d.preAmt||0,shPrevClose:d.shPrevClose,shPreDate:d.shPreDate||''};
  }catch(e){}
}
async function loadThs(){ // 同花顺883900 昨日涨停表现指数（CORS开放，浏览器直连）
  if(DEMO_MODE){S.ths={ok:true,pct:1.24};return;}
  const txt=async u=>{const ctl=new AbortController();const t=setTimeout(()=>ctl.abort(),9000);
    try{const r=await fetch(u,{signal:ctl.signal});if(!r.ok)throw new Error('HTTP '+r.status);return await r.text();}finally{clearTimeout(t);}};
  const jp=s=>JSON.parse(s.substring(s.indexOf('(')+1,s.lastIndexOf(')')));
  try{
    const [lastT,todayT]=await Promise.all([txt(THS_URL+'last.js'),txt(THS_URL+'today.js')]);
    const bars=jp(lastT).data.split(';').map(r=>r.split(','));
    const td=jp(todayT).bk_883900;
    const cur=+td['11'],curDate=td['1'];
    let prev=null;
    for(let i=0;i<bars.length;i++){if(bars[i][0]===curDate&&i>0)prev=+bars[i-1][4];}
    if(prev==null){const cand=bars.filter(b=>b[0]<curDate);prev=cand.length?+cand[cand.length-1][4]:null;}
    if(cur>0&&prev>0)S.ths={ok:true,pct:+((cur/prev-1)*100).toFixed(2)};
  }catch(e){}
}
async function tickTx(){ // 秒级现价
  if(DEMO_MODE){S.quotes=demoQuotes([...S.watch]);S.lastTx=Date.now();S.txOk=true;renderDynamic();return;}
  if(!S.watch.size)return;
  const codes=[...S.watch];
  const qmap=await txQuote(codes);
  // 封板判定
  Object.keys(qmap).forEach(k=>{
    const q=qmap[k];
    q.sealed=q.limit>0&&q.price>=q.limit-0.005&&q.pct>=9.5;
  });
  S.quotes=qmap;
  S.idx.sh=qmap['sh000001'];S.idx.sz=qmap['sz399001'];S.idx.cyb=qmap['sz399006'];S.idx.zzr=qmap['sz399106'];
  S.lastTx=Date.now();
  S.txOk=Object.keys(qmap).length>0;
  // top fund for chip
  if(S.today.zt.length){S.topFund=[...S.today.zt].sort((a,b)=>b.fund-a.fund)[0];}
  renderDynamic();
}
/* ================= 渲染调度 ================= */
let lastFull=0;
function renderDynamic(){ // 高频部分：现价动的地方
  const now=Date.now();
  const d=new Date();const hh=d.getHours(),mm=d.getMinutes();
  const trading=hh*60+mm>=565&&hh*60+mm<=930; // 9:25-15:30 approximation, tick-level
  const t=$('dataTime');
  t.textContent=new Date().toTimeString().slice(0,8);
  $('clock').textContent=t.textContent;
  $('txMs').textContent=((Date.now()-S.lastTx)/1000).toFixed(0)+'s前';
  if(S.lastEm)$('emMs').textContent=Math.round((Date.now()-S.lastEm)/1000)+'s前';
  setSrc('sTx',S.txOk);setSrc('sEm',S.emOk);
  setMarket(S.trading?'live':(hh<15?'halt':'off'),S.trading?'盘中':'休市/等待开盘');
  // 节流全量表格重绘（1.5s）避免每 2s 重绘闪烁；价格数字始终更新（改文本更快——简化：整区块 1.5s 重绘）
  if(now-lastFull>1500){lastFull=now;
    renderIndex();verdict();renderLadder();renderBroken();renderYest();renderIndustry();
  }else{
    // 轻量：只更新指数条数字 & verdict?  直接复用上面低速重绘即可，避免过度优化
  }
}
function renderAll(){
  renderIndustry();renderLadder();renderBroken();renderYest();renderIndex();verdict();
}
/* tab */
document.querySelectorAll('.tab').forEach(t=>{
  t.onclick=()=>{
    document.querySelectorAll('.tab').forEach(x=>x.classList.remove('on'));
    document.querySelectorAll('section').forEach(x=>x.classList.remove('on'));
    t.classList.add('on');$('v-'+t.dataset.t).classList.add('on');
  };
});
/* ================= 主循环 ================= */
(async function(){
  banner('',null);setMarket('off','连接中…');
  // 阶段0: 判断交易日与今日池
  await loadTodayPools();
  await loadYestPools();
  await loadBreadth();
  loadIdx();
  loadThs();
  loadTheme(); // 题材聚合（异步，不阻塞首屏行情）
  setSrc('sEm',S.emOk);
  updateWatch();
  await tickTx();   // 首屏行情
  renderAll();
  const now=new Date();const h=now.getHours(),m=now.getMinutes();
  const inSession=(h===9&&m>=25)||(h===10)||(h===11&&m<=30)||(h>=13&&h<=14)||(h===15&&m<=0)||(h===9&&m<30&&m>=25);
  const inAm=h===9||h===10||(h===11&&m<=30);
  S.trading=S.emOk&&inSession;
  // 快轮: 现价 盘中1.5s / 盘外最低5s
  setInterval(async()=>{
    const d=new Date(),hh=d.getHours(),mm=d.getMinutes();
    const sess=(hh*60+mm>=560&&hh*60+mm<=930)&&isWd(today);
    if(!sess&&Date.now()-S.lastTx<5000)return; // 盘外限速5s
    await tickTx();
    if(S.watch.size<2)return;
  },1500);
  // 题材榜轮询: 30s(盘中) / 失败快速重试 / 盘外低频保活
  setInterval(async()=>{
    const d=new Date(),hh=d.getHours(),mm=d.getMinutes();
    const sess=(hh*60+mm>=560&&hh*60+mm<=930)&&isWd(today);
    if(sess)await loadTheme();
    else if(!S.themeOk){if(Math.random()<0.5)await loadTheme();} // 失败时更快重试
    else if(Math.random()<0.2)await loadTheme(); // 盘外低频保活
  },30000);
  // 慢轮: 榜单+涨跌家数 30s(盘中) / 5min(盘外)
  (async function slowLoop(){
    while(true){
      await sleep(S.trading?15000:300000);
      const d=new Date(),hh=d.getHours(),mm=d.getMinutes();
      const sess=(hh*60+mm>=560&&hh*60+mm<=930)&&isWd(today);
      S.trading=S.emOk&&sess;
      await loadTodayPools();
      await loadBreadth();
      loadIdx();
      loadThs();
      updateWatch();
      renderAll();
      setSrc('sEm',S.emOk);
      S.lastEm=Date.now();
    }
  })();
})();
