// 预选池快照核心逻辑（服务端生成脚本 scripts/gen-snapshot.js 使用）
// 供 snapshot.js（HTTP + 定时）复用；单独成文件便于 esbuild 打包时共享。
//
// 数据口径（与前端 public/index.html 的 preCompute/preKline/preAlert 保持一致）：
//   L0 全市场涨停 → L1 主线内 → L2 连板≥2 → L3 当日无炸板 → L4 主板非ST非退市
//   连板周期形态回溯 → 买点阶段(accel/resume/fresh) → 明日弱转强预警

const UT = '7eea3edcaed734bea9cbfc24409ed989';
const UT_K = 'fa5fd1943c7b386f172d6893dbfba10b';

/* 东财 ut token 会把请求路由到不同的后端集群，部分集群是坏的。
   实测（2026-11-19）：
     涨停池 getTopicZTPool：ut=7eea3edc → rc=0 pool=41（唯一有效）
                            ut=fa5fd194 / b2884a39 → rc=205 pool=0（集群无数据）
     K 线  stock/kline    ：三个 token 全部 rc=0 klines=30
   rc=205 表示「HTTP 成功但该集群没有这份数据」，所以不能只看状态码，
   必须校验 rc 与数据是否真的非空。
   注意：token 有效集合按接口不同，轮换只能用于涨停池。 */
const UT_POOL = [
  '7eea3edcaed734bea9cbfc24409ed989',
  'fa5fd1943c7b386f172d6893dbfba10b',
  'b2884a393a859ad320422752cc11691c'
];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const REF = 'https://quote.eastmoney.com/';

const BLOCK = /(昨日|前日|昨日涨停|含一字|ST板块|次新|注册制|近期新高|近期新低|微盘|B股|AH|破净|高送转|低价|高价|新股|连续缩量|连续放量|大盘股|中盘股|小盘|融资融券|深股通|沪股通|标普|富时|MSCI|证金|汇金|基金重仓|社保|养老金|QFII|机构重仓|上证50|上证180|沪深300|中证|创业综|茅指数|宁组合|GDR|可转债|转债|预盈预增|预亏预减|亏损|微利|市净率|市盈率|百元股|三日|两融|举牌|壳资源|AB股|H股|F股|百元)/;

async function jget(url, to = 15000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), to);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': REF }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

/* ---------------- 预算控制 ----------------
   快照由 GitHub Actions 定时任务生成（scripts/gen-snapshot.js），跑完还要在同一次
   部署里上线，所以必须自我约束：任何一步都不能无限等，总耗时落在预算内，
   宁可个别票标「数据不足」，也不能因为超时整份快照缺失。

   deadline 对象提供：
     left()      剩余毫秒（不小于 0）
     expired()   是否已超时
     stage(ms)   派生一个子预算（阶段级上限），不突破总上限 */
function makeDeadline(budgetMs) {
  const end = Date.now() + budgetMs;
  const dl = {
    end,
    left: () => Math.max(0, end - Date.now()),
    expired: () => Date.now() >= end,
    stage: (ms) => makeDeadline(Math.min(ms, Math.max(0, end - Date.now())))
  };
  return dl;
}

/* ---------------- 东财主机池 ----------------
   实测（服务端 Node 环境，并发 4 路/主机）：
     push2.eastmoney.com        OK 3/4
     push2delay.eastmoney.com   OK 3/4
     1.push2.eastmoney.com      OK 2/4
     82.push2.eastmoney.com     OK 4/4   ← 最稳
     48.push2.eastmoney.com     OK 2/4
   单个主机失败率约 25~50%，且失败形态多样（HTTP 502 / 连接重置 / 超时）。
   死磕单主机必然间歇性拿不到数据，所以按「轮转主机 + 重试」来请求，
   任一主机成功即返回。 */
const HOST_POOL = [
  'push2.eastmoney.com',
  '82.push2.eastmoney.com',
  'push2delay.eastmoney.com',
  '1.push2.eastmoney.com',
  '48.push2.eastmoney.com'
];
/* 专用主机：接口路径各主机不一致，不能互相替代，只能原样使用。
   注意：这里必须用数组而不是对象字面量——for...of 无法迭代对象，
   写成对象会在运行时报 "HOST_EX is not iterable"，让整个函数 502。 */
const HOST_EX = [
  'push2ex.eastmoney.com',   // 涨停池：专用主机，不参与轮转
  'push2his.eastmoney.com'   // K 线：专用主机，不参与轮转
];

/* ---------------- K 线多源主机池 ----------------
   2026-11-23 实测（Node fetch，每源 5 次，带 UA/Referer）：
     push2his.eastmoney.com   0/5  ← 本机 TLS 重协商失败 / fetch failed（kline_failed_N 的根因）
     33.push2his.eastmoney.com 5/5
     44.push2his.eastmoney.com 1/5
     23.push2his.eastmoney.com 0/5
     腾讯 web.ifzq.gtimg.cn     5/5（53ms）
     新浪 quotes.sina.cn        5/5（53ms）
   单主机不可靠，必须多源；成功主机在进程内记忆，后续标的不再重撞故障机。 */
const K_HOSTS = [
  'push2his.eastmoney.com',      // 本地实测 0/5，仅作兜底；成功主机仍会被记忆
  '33.push2his.eastmoney.com',
  '44.push2his.eastmoney.com',
  '23.push2his.eastmoney.com'
];
let kHostPref = 0;
let K_SRC_STAT = {};             // 本次快照各源命中次数，便于诊断
function kSrcBump(n) { K_SRC_STAT[n] = (K_SRC_STAT[n] || 0) + 1; }

/* 把 URL 里的主机名替换成池中的另一个主机 */
function rotateHost(url, idx) {
  // 只对东财「通用接口」轮转；腾讯/新浪等兜底源必须原样使用，
  // 否则域名会被替换成 push2.eastmoney.com，路径必然 404。
  if (url.indexOf('eastmoney.com') < 0) return url;
  // K 线接口只在 push2his 系列（含数字前缀 CDN）上有效，不参与通用轮转，
  // 由 kline() 自己按 K_HOSTS 逐台回退。
  if (url.indexOf('/api/qt/stock/kline/get') > -1) return url;
  for (const h of HOST_EX) {
    if (url.indexOf('https://' + h) === 0) return url;   // 专用主机不轮转
  }
  const m = /^https:\/\/([^/]+)(\/.*)$/.exec(url);
  if (!m) return url;
  const host = HOST_POOL[idx % HOST_POOL.length];
  return 'https://' + host + m[2];
}

/* 带重试的抓取：东财偶发连接重置（ECONNRESET / fetch failed / HTTP 502），
   单次失败不该让整条定时任务报废。
   dl 为可选的 deadline：
     - 单次超时收缩到剩余预算（但不低于 minTo，保证关键请求不被压死）
     - 预算不足时自动减少重试次数
     - 预算耗尽立即抛错，让上层降级
   minTo：单次请求的最小超时（毫秒）。用于「这一步比预算更重要」的场合——
   比如 K 线：阶段 3 开始时总预算可能只剩 300ms，若把超时压到 300ms，
   本该 200ms 就能成功的请求会被 AbortError 掐死，预警整片丢失。
   此时宁可让整体略微超预算（平台上限 30 秒），也要保住这一步。 */
async function jgetR(url, to = 15000, tries = 3, dl = null, minTo = 0) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    if (dl) {
      if (dl.expired()) throw new Error('budget exhausted before ' + url.slice(0, 60));
      // 剩余预算连一次完整尝试都放不下 → 不再重试，直接抛错
      if (i > 0 && dl.left() < 1200) break;
    }
    // 超时 = 剩余预算与「最小保底」的较大者；minTo 会突破总预算，
    // 但只在关键步骤使用，且总预算由外层硬闸门兜底。
    const cap = dl ? Math.min(to, Math.max(minTo, dl.left())) : to;
    // 每次重试换一个主机，避免在同一台故障机上反复撞墙
    const u = rotateHost(url, i);
    try { return await jget(u, cap); }
    catch (e) {
      lastErr = e;
      if (i < tries - 1) {
        const wait = 400 * (i + 1);
        if (dl && dl.left() < wait + 600) break;
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/* ---------------- 时区：GitHub Actions runner 运行在 UTC，显式使用 Asia/Shanghai ---------------- */
const TZ = 'Asia/Shanghai';

function bjParts(now) {
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(now).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return {
    date: p.year + p.month + p.day,
    hh: +p.hour % 24,   // Intl 在午夜可能返回 24，规整为 0
    mm: +p.minute
  };
}

function dstr(d) {
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
}
function isWd(s) {
  const d = new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)).getDay();
  return d >= 1 && d <= 5;
}
// 基准交易日：北京时间当日 17:40 后取当日，否则取上一工作日
function targetDate(now) {
  const b = bjParts(now);
  const t = b.date, m = b.hh * 60 + b.mm;
  if (isWd(t) && m >= 1060) return t;
  const x = new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8));
  do { x.setDate(x.getDate() - 1); } while (!isWd(dstr(x)));
  return dstr(x);
}
function prevWd(date, back) {
  const dd = new Date(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8));
  dd.setDate(dd.getDate() - back);
  while (!isWd(dstr(dd))) dd.setDate(dd.getDate() - 1);
  return dstr(dd);
}

/* ---------------- 数据抓取（全部接受可选 deadline） ---------------- */

/* 涨停池：东财专用主机 push2ex（该接口路径只有这一台能用，其他 push2ex 主机不通）。
   已知三个 ut token 里只有 7eea3edc 的集群真正返回涨停池，其余返回 rc=205（空）。
   所以策略是：
     - 每次重试换一个 token（绕开故障集群，未来东财修复某个集群也能自动受益）
     - 校验 pool 是否真的非空——rc=0 但 pool 为空同样是「没拿到数据」
     - 全部失败时抛错而不是返回空数组，让上层能明确降级
   实测有效 token 连续 6 次均 rc=0 pool=41，稳定性好。 */
async function ztPool(date, dl = null) {
  const base = `https://push2ex.eastmoney.com/getTopicZTPool?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=500&sort=fbt:asc&date=${date}`;
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    if (dl && dl.expired()) break;
    const ut = UT_POOL[i % UT_POOL.length];
    const url = base.replace('ut=' + UT, 'ut=' + ut);
    try {
      const d = await jgetR(url, 15000, 1, dl);
      if (d && d.rc === 0 && d.data && d.data.pool && d.data.pool.length) return d.data.pool;
      lastErr = new Error('zt pool empty rc=' + (d && d.rc) + ' ut=' + ut.slice(0, 8));
    } catch (e) {
      lastErr = e;
    }
    if (i < 2) await new Promise(r => setTimeout(r, 400 * (i + 1)));
  }
  throw lastErr || new Error('zt pool unavailable for ' + date);
}
async function boardRank(fs, dl = null) {
  // 重试 5 次：每次自动换一台东财主机（见 HOST_POOL），
  // 单主机失败率 25~50%，轮转后成功率显著提升。
  const d = await jgetR(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=${fs}&fields=f3,f12,f14,f62,f104,f128,f136`, 15000, 5, dl);
  return (d.data && d.data.diff) || [];
}
async function boardMembers(bk, dl = null) {
  try {
    const d = await jgetR(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=400&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${bk}&fields=f12,f14,f3`, 12000, 4, dl);
    return (d.data && d.data.diff) || [];
  } catch (e) { return []; }
}
/* K 线统一输出 11 列（东财 fields2=f51..f61）：
     [日期, 开, 收, 高, 低, 量, 额, 振幅, 涨幅, 涨跌额, 换手]
   analyzeCycle 只依赖 f[1..5] 与 f[10]；腾讯/新浪只有前 6 列，补空列即可，
   stage 判定与 makeAlert 价位完全不受影响（仅换手率展示值记 0）。 */
function kSecSym(secid) {
  const p = String(secid).split('.');
  return (p[0] === '1' ? 'sh' : 'sz') + p[1];
}
async function kline(secid, dl = null) {
  const t0 = Date.now();
  // 单只票所有源的总墙钟上限：正常 <1s，全挂时也不拖垮 30s 平台上限。
  const CAP = dl ? Math.max(4000, Math.min(12000, dl.left())) : 12000;
  const left = () => Math.max(0, CAP - (Date.now() - t0));
  /* lmt=120：A 扫描要拿「连板首个涨停日之前 60 个日历日」的波段前高，
     30 根日线不够；120 根约覆盖半年，足够 2~6 连板 + 60 日回溯。 */
  const path = `/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&end=20500101&lmt=120&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&ut=${UT_K}`;

  // 源 1：东财 K 线（原生 11 列），按「最近成功主机优先」逐台回退
  for (let i = 0; i < K_HOSTS.length && left() > 600; i++) {
    const idx = (kHostPref + i) % K_HOSTS.length;
    try {
      const d = await jget('https://' + K_HOSTS[idx] + path, Math.min(4000, left()));
      const rows = ((d.data && d.data.klines) || []).map(s => s.split(','));
      if (rows.length >= 3) { kHostPref = idx; kSrcBump('em:' + K_HOSTS[idx]); return rows; }
    } catch (e) { /* 换下一台 */ }
  }
  // 源 2：腾讯前复权日 K（服务端无 CORS 限制，实测 5/5）
  if (left() > 600) {
    try {
      const sym = kSecSym(secid);
      const d = await jget(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,120,qfq`, Math.min(4000, left()));
      const o = d && d.data && d.data[sym];
      const rows = (o && (o.qfqday || o.day)) || [];
      if (rows.length >= 3) {
        kSrcBump('tencent');
        return rows.map(r => [r[0], r[1], r[2], r[3], r[4], r[5], '', '', '', '', '']);
      }
    } catch (e) { }
  }
  // 源 3：新浪日 K
  if (left() > 600) {
    try {
      const sym = kSecSym(secid);
      const d = await jget(`https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${sym}&scale=240&ma=no&datalen=120`, Math.min(4000, left()));
      const rows = Array.isArray(d) ? d : [];
      if (rows.length >= 3) {
        kSrcBump('sina');
        // 新浪 volume 单位是「股」，东财/腾讯是「手」；统一成手，换算换手率才准
        return rows.map(r => [r.day, r.open, r.close, r.high, r.low, (+r.volume || 0) / 100, '', '', '', '', '']);
      }
    } catch (e) { }
  }
  throw new Error('kline all sources failed ' + secid);
}

function makeTheme(b, name, zt, kind) {
  const maxLbc = Math.max(...zt.map(z => z.lbc));
  const sumLbc = zt.reduce((a, z) => a + z.lbc, 0);
  const fundSum = zt.reduce((a, z) => a + (z.fund || 0), 0);
  const pct = b && typeof b.f3 === 'number' ? b.f3 : 0;
  const inflow = b && typeof b.f62 === 'number' ? b.f62 : 0;
  let score = zt.length * 10 + sumLbc * 6 + maxLbc * 10 + Math.min(fundSum / 1e8 * 0.5, 15);
  if (pct >= 3) score += 8; else if (pct >= 2) score += 5;
  score += Math.min(Math.max(inflow, 0) / 1e8 * 0.3, 10);
  zt.sort((a, b2) => b2.lbc - a.lbc || b2.fund - a.fund);
  return {
    code: b ? b.f12 : '', name, kind, pct, inflow, up: (b && b.f104) || 0,
    lead: (b && b.f128) || '', leadPct: (b && typeof b.f136 === 'number') ? b.f136 : 0,
    ztCount: zt.length, maxLbc, sumLbc, fundSum, score: Math.round(score), zt
  };
}

/* ---------------- A 扫描：≥2板「今日一致」观察池 ----------------
   用户口径（2026-11-23）：扫描日只建观察池、当天不买；基准日必须是连板段内
   最小量的一致缩量板，段内此前未出现「首次放量分歧买日」，收盘还要破掉
   首个涨停日之前 60 个日历日内的波段前高。次日才等真分歧放量回封（A 模式）。
   阈值全部可由环境变量覆盖，默认即用户口径。 */
const A_SCAN = {
  swingDays: +(process.env.A_SCAN_SWING_LOOKBACK || 60),
  volFlat: +(process.env.A_SCAN_VOL_FLAT || 0.98),
  requireBreakHigh: process.env.A_SCAN_REQUIRE_BREAK_HIGH !== '0',
  requireVolShrink: process.env.A_SCAN_REQUIRE_VOL_SHRINK !== '0',
  minCircMvYuan: +(process.env.A_SCAN_MIN_CIRC_MV_WAN || 20000) * 1e4,
  maxBaseHs: +(process.env.A_SCAN_MAX_BASE_HS || 10),
  divVolX: +(process.env.A_SCAN_DIV_VOL_X || 1.5),
  maxBoards: +(process.env.A_SCAN_MAX_BOARDS || 6)
};
function shiftYmd(n, days) {
  const s = String(n).padStart(8, '0');
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() - days);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}
const ymd = s => +String(s == null ? '' : s).replace(/-/g, '');

function scanWatch(ks, base, date, cfg) {
  const c = Object.assign({}, A_SCAN, cfg || {});
  const out = { watchOk: false, watchWhy: '', volSeq: [], hsSeq: [], volFlat: null,
    minVolBoard: false, breakHigh: null, swingHigh: null, firstDivDay: null, scanBoards: 0 };
  const fail = why => { out.watchWhy = why; return out; };
  if (!ks || ks.length < 3) return fail('K线数据不足');
  let i = ks.length - 1;
  const want = ymd(date);
  if (want) {
    while (i > 0 && ymd(ks[i][0]) > want) i--;
    if (ymd(ks[i][0]) !== want) return fail('基准日无K线');
  }
  const f = ks[i];
  const close = +f[2];
  const sharesRef = (base && base.ltsz > 0 && close > 0) ? base.ltsz / close : 0;
  // 用基准日已知换手率反推成交量单位：东财/腾讯按「手」，个别源按「股」（差 100 倍）。
  // 不校准会把换手率放大 100 倍，全部票被误判成「全天高换手」而错杀。
  let volUnit = 1;
  if (sharesRef > 0 && base && base.hs > 0) {
    const est = (+f[5] || 0) * 10000 / sharesRef;
    const r = est > 0 ? base.hs / est : 0;
    if (r > 0.005 && r < 0.02) volUnit = 0.01;
  }
  const volAt = row => (+row[5] || 0) * volUnit;
  const turnAt = row => {
    const hs = +(row[10] || 0);
    if (hs > 0) return hs;
    // 缺换手列时用「量×100 / 流通股本」反推
    return sharesRef > 0 ? volAt(row) * 10000 / sharesRef : 0;
  };
  const isLimit = k => {
    if (k < 1 || k >= ks.length) return false;
    const pc = +ks[k - 1][2], cc = +ks[k][2];
    if (!(pc > 0 && cc > 0)) return false;
    const lim = Math.round(pc * 1.1 * 100) / 100;
    return cc >= lim - 0.011 && cc / pc >= 1.09;
  };
  if (!isLimit(i)) return fail('基准日不是涨停板');
  let s = i;
  while (isLimit(s - 1) && (i - s) < 40) s--;
  const n = i - s + 1;
  out.scanBoards = n;
  if (n > c.maxBoards) return fail('连板超过 ' + c.maxBoards + ' 板');
  if (n < 2) return fail('连板不足 2 板');
  for (let k = s; k <= i; k++) {
    out.volSeq.push(Math.round(volAt(ks[k]) * 100) / 100);
    out.hsSeq.push(Math.round(turnAt(ks[k]) * 100) / 100);
  }
  const vols = out.volSeq, hss = out.hsSeq;
  if (vols.some(v => !(v > 0))) return fail('成交量数据不足');
  if (hss.some(h => !(h > 0))) return fail('换手数据不足');
  const minVol = Math.min(...vols);
  out.minVolBoard = vols[n - 1] <= minVol * 1.000001;
  if (!out.minVolBoard) return fail('基准日不是段内最小量板');
  if (hss.every(h => h >= 10)) return fail('连板段全程高换手，非一致锁仓');
  // 此前是否已有「首次放量分歧买日」：量 ≥1.5×段内最小量，且换手台阶抬高或已达标
  for (let k = s; k < i; k++) {
    const q = k - s;
    if (vols[q] >= c.divVolX * minVol && (hss[q] >= c.maxBaseHs || hss[q] >= hss[n - 1] * 1.3)) {
      out.firstDivDay = ymd(ks[k][0]);
      return fail('段内此前已出现首次放量分歧买日，已错过');
    }
  }
  if (hss[n - 1] >= c.maxBaseHs) return fail('基准日换手 ' + hss[n - 1] + '% 不低于 ' + c.maxBaseHs + '%');
  const flat = vols[n - 1] / vols[n - 2];
  out.volFlat = Math.round(flat * 1000) / 1000;
  if (c.requireVolShrink && !(flat < c.volFlat)) return fail('与前一板量能基本持平（假一致）');
  // 破前高：首个涨停日之前 swingDays 个日历日内的摆动最高价（非一年山顶）
  const cut = shiftYmd(ymd(ks[s][0]), c.swingDays);
  let hi = -Infinity, cnt = 0;
  for (let k = s - 1; k >= 0; k--) {
    const dk = ymd(ks[k][0]);
    if (dk < cut) break;
    const h = +ks[k][3];
    if (h > 0) { if (h > hi) hi = h; cnt++; }
  }
  out.swingHigh = cnt ? Math.round(hi * 100) / 100 : null;
  if (c.requireBreakHigh) {
    if (!cnt) return fail('无前高可比样本');
    out.breakHigh = close > hi;
    if (!out.breakHigh) return fail('收盘仍在前高压制下');
  }
  // 风控：主板 / ST / 退市 / 流通市值下限
  // （业绩预告、曾用名 ST、连续亏损 proxy 需 Tushare，当前数据源不具备，另记不完整）
  if (base) {
    if (!(base.ltsz > 0)) return fail('流通市值数据不足');
    if (base.ltsz < c.minCircMvYuan) return fail('流通市值低于 ' + (c.minCircMvYuan / 1e8).toFixed(1) + ' 亿');
    if (!mainBoard(base.code, base.name)) return fail('非主板 / ST / 退市');
  }
  out.watchOk = true;
  out.watchWhy = '最小量一致 · 段内无首次分歧 · 换手<10% · ' + (c.requireBreakHigh ? '已破波段前高' : '未校验前高');
  return out;
}

/* ---------------- 连板周期形态回溯 + 买点阶段 ---------------- */
function analyzeCycle(ks, boards, base, date) {
  if (!ks || ks.length < 3) return null;
  const i = ks.length - 1;
  const n = Math.min(Math.max(boards || 1, 1), i);
  let cumHs = 0, divN = 0, tzN = 0, last = null;
  let cycLow = Infinity;          // 连板周期内最低价（真正的防守位）
  for (let k = i - n + 1; k <= i; k++) {
    const f = ks[k], pf = ks[k - 1];
    const o = +f[1], c = +f[2], h = +f[3], l = +f[4], pc = +pf[2], hs = +f[10] || 0;
    const lim = Math.round(pc * 1.1 * 100) / 100;
    const YZ = o >= lim - 0.011 && l >= lim - 0.011;
    const TZ = o >= lim - 0.011 && l < lim - 0.011;
    const LO = o < pc - 0.001;
    const sw = pc > 0 ? (h - l) / pc : 0;
    const XH = !YZ && !TZ && sw >= 0.05;
    cumHs += hs;
    if (TZ || LO || XH) divN++;
    if (TZ) tzN++;
    if (l > 0 && l < cycLow) cycLow = l;
    if (k === i) last = { YZ, TZ, LO, XH, sw, hs, c, l, lim, pc };
  }
  const pv = +ks[i - 1][5], v = +ks[i][5];
  const ratio = (pv > 0 && v > 0) ? v / pv : null;
  const histDiv = divN > 0;
  // 【弱转强只认首次分歧】今日为分歧日时，只有「整个连板周期内第一次分歧」才算
  // 弱转强标的；此前已经分歧过、今日再次分歧（divN>1）属于反复分歧的尾声板，
  // 不是弱转强买点。用户口径：要首次分歧后预测次日能否转强，不要二次分歧。
  const firstDiv = (last.TZ || last.LO || last.XH) && divN === 1;
  let stage, stageTxt, stageCls, advice;
  if (last.YZ) {
    stage = 'accel'; stageCls = 'r';
    if (histDiv) { stageTxt = '一字加速·无买点'; advice = '周期内已分歧 ' + divN + ' 次，缩量加速属尾声，仅持仓不加'; }
    else { stageTxt = '连续一字·买不到'; advice = '零换手无承接位，等开板看资金接力'; }
  } else if (last.TZ || last.LO || last.XH) {
    if (firstDiv) {
      stage = 'resume'; stageCls = 'g';
      stageTxt = last.TZ ? '炸板回封·首次分歧' : (last.LO ? '低开回封·首次分歧' : '换手板·首次分歧');
      advice = '连板周期内首次真分歧（' + divN + ' 次）完成转一致；明日低开不破位再封可接力';
    } else {
      // 二次及以上分歧：尾声板，明确不给买点
      stage = 'late'; stageCls = 'r';
      stageTxt = '多次分歧·尾声';
      advice = '周期内已分歧 ' + divN + ' 次，今日再次分歧属尾声，不是首次弱转强，别接';
    }
  } else {
    stage = 'fresh'; stageCls = histDiv ? 'b' : 'p';
    stageTxt = histDiv ? '缩量一致·分歧已过' : '一致未分歧·待首次换手';
    advice = histDiv ? '分歧已消化且今日缩量一致，等下一次回封' : '尚未真换手，首次回封是买点';
  }
  const scan = scanWatch(ks, base, date);
  return {
    ratio: ratio, ok: ratio != null && ratio < 1, stage, stageTxt, stageCls, advice,
    histDiv, divN, tzN, firstDiv, cumHs, chs: last.hs, sw: last.sw,
    close: last.c, low: last.l, limUp: last.lim, prevClose: last.pc,
    cycLow: cycLow === Infinity ? last.l : cycLow,
    ...scan
  };
}

/* ---------------- 明日弱转强预警 ----------------
   文案目标：让人一眼看出「什么时候动手」「什么时候放弃」。
   本卡片只回答「明天要不要买」，是买入决策，不是持仓管理。
   A 股 T+1：当日买入当日不能卖，所以绝不能写「买了再止损卖出」——
   那条指令在实盘里执行不了。所有放弃条件一律前置为「别买」。
   放弃线取「连板周期内最低价」而非「当日最低价」——
   当日若一字板/封死收盘，当日最低价 = 收盘价 = 涨停价，
   会高于低开买入区间，变成「一买就破线」，逻辑自相矛盾。
   注：字段 stop 是历史命名，语义为「放弃线 / 入场否决线」，不是持仓止损位。 */
function makeAlert(a, boards) {
  if (!a || !a.close || !a.limUp) return null;
  const c = a.close;
  const nLim = Math.round(c * 1.1 * 100) / 100;
  const lo = Math.round(c * 0.97 * 100) / 100;
  const hi = Math.round(c * 0.93 * 100) / 100;
  const gapHi = Math.round(c * 1.05 * 100) / 100;
  // 放弃线必须严格低于「买入区下沿 hi」：盘中跌破它 = 弱势坐实，直接别买。
  // 旧写法用 lo*0.98 退化，lo 是买入区上沿，结果 stop 仍落在 [hi, lo] 区间内。
  // 现改为：优先连板周期最低价，只要它 < hi 就用；否则退化到 hi 下方一档。
  let stop = (a.cycLow && a.cycLow < hi) ? a.cycLow
    : (a.low && a.low < hi ? a.low : Math.round(hi * 0.98 * 100) / 100);

  if (a.stage === 'accel') {
    return { ready: false, cls: 'r', title: '别买 · 今天一字板',
      trigger: '今天' + boards + '板一字封死，全天没给换手机会',
      tip: '明天基本不会低开，也就没有「低开捡便宜」这个机会',
      doTxt: '今天一字封死，明天基本不会低开，等不到这个买点',
      skipTxt: '直接跳过，别等也别追 || 手里有就拿着，不加仓',
      nextLim: nLim, lo, hi, gapHi, stop, stopReason: '一字板无承接位' };
  }
  if (a.stage === 'resume') {
    return { ready: true, cls: 'g', title: '可以买',
      trigger: '开盘价在 ' + hi.toFixed(2) + ' ~ ' + lo.toFixed(2) + ' 之间，且 30 分钟内封到 ' + nLim.toFixed(2),
      tip: '只要高开过 ' + gapHi.toFixed(2) + '、或没封板、或跌破 ' + stop.toFixed(2) + '，一律放弃',
      // 大白话：用 || 分隔成逐条清单，前端渲染为独立行。
      // 「可以买」= 两条必须同时满足；「立刻放弃」= 任意一条触发即不买。
      // T+1 下三条放弃条件全部前置到「别买」，不写任何持仓卖出动作。
      doTxt: '明天开盘价落在 ' + hi.toFixed(2) + ' ~ ' + lo.toFixed(2) + ' 之间（比今天收盘低 3%~7%）'
        + '|| 开盘半小时内涨到 ' + nLim.toFixed(2) + ' 并且封住涨停'
        + '|| 上面两条都做到才买，缺一条都不买',
      skipTxt: '开盘价高过 ' + gapHi.toFixed(2) + ' → 太强了，不是低开捡便宜，别追'
        + '|| 低开是低开了，但半小时没封到 ' + nLim.toFixed(2) + ' → 没拉起来，别买'
        + '|| 盘中跌破 ' + stop.toFixed(2) + ' → 弱势坐实，别买',
      nextLim: nLim, lo, hi, gapHi, stop, stopReason: '跌破连板周期最低价即放弃买入' };
  }
  if (a.stage === 'fresh' && a.histDiv) {
    return { ready: false, cls: 'b', title: '别买 · 首次分歧已过',
      trigger: '连板周期内已经出现过放量分歧买日，今天只是缩量一致',
      tip: '首次分歧买点已经错过；一致板不是接力点，不进「等首次分歧」观察池',
      doTxt: '今天别买：周期内首次放量分歧已经出现过，这不是首次分歧后的弱转强',
      skipTxt: '明天直接跳过 || 已错过首次分歧的缩量一致板不进观察池',
      nextLim: nLim, lo, hi, gapHi, stop, stopReason: '首次分歧买日已在段内出现' };
  }
  if (a.stage === 'late') {
    return { ready: false, cls: 'r', title: '别买 · 多次分歧尾声',
      trigger: '连板周期内已分歧 ' + (a.divN || 2) + ' 次，今天是再次分歧',
      tip: '弱转强只做首次分歧后的转强；反复分歧说明接力资金已疲，不是买点',
      doTxt: '今天别买：这是周期内第 ' + (a.divN || 2) + ' 次分歧，不是首次，不做弱转强',
      skipTxt: '明天直接跳过，别追 || 反复分歧的尾声板不在本策略买点内',
      nextLim: nLim, lo, hi, gapHi, stop, stopReason: '多次分歧属尾声，非首次弱转强' };
  }
  return { ready: false, cls: 'b', title: '再等等',
    trigger: '今天还没真分歧（没换手、没炸板）',
    tip: '缺「低开再拉板」的基础，明天先看着',
    doTxt: '今天别买：还没换手分歧过，缺「低开再拉板」的基础',
    skipTxt: '明天先不动手 || 等它换手分歧一次，下个交易日再重新判断；' + nLim.toFixed(2) + ' 是它的涨停价',
    nextLim: nLim, lo, hi, gapHi, stop, stopReason: '尚未出现分歧' };
}

function scoreOf(x, th, isMain) {
  const fundS = Math.min((x.fund || 0) / 3e8, 1) * 40;
  const thS = th ? Math.min((th.score || 0) / 200, 1) * 30 : 0;
  const hS = Math.min(Math.max((x.boards || 1) - 1, 0) / 4, 1) * 20;
  const fb = x.fbt || 0;
  const tS = fb > 0 && fb <= 100000 ? 10 : fb > 0 && fb <= 113000 ? 7 : fb > 0 ? 3 : 0;
  let sc = fundS + thS + hS + tS;
  if (isMain) sc *= 1.08;
  if (x.zbc > 0) sc *= 0.85;
  if ((x.hs || 0) > 25) sc *= 0.92;
  return Math.round(sc);
}
function mainBoard(c, n) {
  const code = String(c || ''), name = String(n || '').toUpperCase();
  if (!/^(600|601|603|605|000|001|002|003)/.test(code)) return false;
  if (/ST|退/.test(name)) return false;
  if (/^(N|C)/.test(name)) return false;
  return true;
}

/* ---------------- 主流程 ---------------- */
// 平台实测超时 30 秒，这里留出充足余量：
//   总预算 22 秒 < 30 秒平台上限，留 8 秒给冷启动与 Blob 落盘。
//   三个阶段的分配原则：K 线（弱转强预警的生命线）必须拿到够用的时间，
//   题材榜（可降级为行业自聚合）拿次要份额，涨停池（不可降级）保底。
async function buildSnapshot(date, now, budgetMs = 22000) {
  const t0 = Date.now();
  const dl = makeDeadline(budgetMs);
  const warnings = [];
  K_SRC_STAT = {};              // 每次快照重新统计 K 线数据源命中情况

  // ---- 阶段 1：涨停池 ----
  // 优先只打目标日；只有在目标日无数据（休市/延迟）时才并行回退探测。
  // 这样正常交易日只需 1 次请求，把预算留给题材与 K 线。
  //
  // RESERVE_K：阶段 3（K 线回溯 + 弱转强预警）的专属保底预算。
  // 线上网络慢时，题材阶段最容易被吃满，若不做保底，预警会全军覆没——
  // 而预警正是这个看板的最终产出，所以必须硬性预留。
  const RESERVE_K = 9000;
  const st1 = dl.stage(Math.max(0, Math.min(6000, dl.left() - RESERVE_K)));
  let effDate = date;
  let zts = await ztPool(date, st1).catch(() => []);
  if (!zts.length) {
    // 回退：并行探测最多 5 个前序交易日，取第一个有数据的
    const tryDates = [];
    for (let b = 1; b <= 5; b++) tryDates.push(prevWd(date, b));
    const pools = await Promise.all(tryDates.map(ds => ztPool(ds, st1).catch(() => [])));
    for (let i = 0; i < tryDates.length && !zts.length; i++) {
      if (pools[i] && pools[i].length) { effDate = tryDates[i]; zts = pools[i]; }
    }
  }
  if (!zts.length) throw new Error('no zt pool for ' + date);

  // ---- 阶段 2：题材榜 ----
  // 数据中心出口（Actions runner）比本机慢，题材榜 + 概念成员是耗时大头。
  // 策略：板块榜失败不阻断（概念降级为行业自聚合）；概念成员分批处理，
  // 每批之间用剩余预算做闸门，预算不足时提前收手（少几个概念不影响主结论）。
  // 阶段预算取 min(阶段上限, 剩余总预算 - K线保底)，保证三阶段相加不超过总预算，
  // 且 K 线阶段永远留得下时间。
  const st2 = dl.stage(Math.max(0, Math.min(8000, dl.left() - RESERVE_K)));
  const [cRanks, iRanks] = await Promise.all([
    boardRank('m:90+t:3', st2).catch(() => []),
    boardRank('m:90+t:2', st2).catch(() => [])
  ]);
  if (!cRanks.length) warnings.push('concept_rank_empty');
  const ztMap = {};
  zts.forEach(x => { ztMap[x.c] = x; });
  const indMap = {};
  iRanks.forEach(b => { if (!BLOCK.test(b.f14 || '')) indMap[b.f14] = b; });
  const indCnt = {};
  zts.forEach(x => { const k = x.hybk || ''; if (k) indCnt[k] = (indCnt[k] || 0) + 1; });
  const assigned = new Set();
  const themes = [];
  Object.keys(indCnt).forEach(ind => {
    if (indCnt[ind] < 2) return;
    const members = zts.filter(x => (x.hybk || '') === ind)
      .map(x => ({ code: x.c, name: x.n, lbc: x.lbc || 1, fund: x.fund || 0, fbt: x.fbt || 0, zbc: x.zbc || 0, hybk: x.hybk || '' }));
    members.forEach(m => assigned.add(m.code));
    themes.push(makeTheme(indMap[ind], ind, members, '行业'));
  });
  const cands = cRanks.filter(x => {
    const nm = x.f14 || '';
    if (BLOCK.test(nm)) return false;
    const pct = typeof x.f3 === 'number' ? x.f3 : -99;
    const leadPct = typeof x.f136 === 'number' ? x.f136 : 0;
    return pct >= 1 || leadPct >= 8.9;
  }).slice(0, 25);

  // 概念板块成员：分批并发，每批 16 个；批次之间检查预算，不够就停。
  // 线上实测并发 10 路稳定，故批次从 8 提到 16，减少往返轮次（每轮 = 1 个 RTT）。
  // 单个板块成员查询失败只影响该题材，不阻断整体。
  const cResults = [];
  const BATCH = 16;
  for (let i = 0; i < cands.length; i += BATCH) {
    if (st2.expired()) { warnings.push('concept_batches_cut_' + Math.ceil((cands.length - i) / BATCH)); break; }
    const batch = cands.slice(i, i + BATCH);
    const r = await Promise.all(batch.map(async (b) => {
      const mem = await boardMembers(b.f12, st2);
      const zt = [];
      (mem || []).forEach(m => {
        const it = ztMap[m.f12];
        if (it && !assigned.has(it.c)) zt.push({ code: it.c, name: it.n, lbc: it.lbc || 1, fund: it.fund || 0, fbt: it.fbt || 0, zbc: it.zbc || 0, hybk: it.hybk || '' });
      });
      if (!zt.length) return null;
      return makeTheme(b, b.f14, zt, '概念');
    }));
    cResults.push(...r.filter(Boolean));
  }
  themes.push(...cResults);
  const concepts = themes.sort((a, b) => b.score - a.score).slice(0, 15);

  // 五级漏斗
  const L0 = zts.length;
  const all = concepts.filter(t => (t.ztCount || 0) >= 2);
  const thFloor = Math.max(4, Math.ceil(L0 * 0.12));
  const strong = all.filter(t => (t.ztCount || 0) >= thFloor || ((t.maxLbc || 0) >= 3 && (t.ztCount || 0) >= 3));
  const hasMain = strong.length > 0;
  const topTh = (hasMain ? strong : all).slice(0, 3);
  const themeOf = (code, hybk) => {
    for (const t of topTh) if ((t.zt || []).some(z => z.code === code)) return t;
    for (const t of all) if ((t.zt || []).some(z => z.code === code)) return t;
    for (const t of concepts) if (t.name === hybk) return t;
    return null;
  };
  const norm = zts.map(x => ({
    code: x.c, name: x.n, price: x.p / 100, zdp: x.zdp, amount: x.amount, ltsz: x.ltsz,
    hs: x.hs, boards: x.lbc || 1, fbt: x.fbt, lbt: x.lbt, fund: x.fund || 0, zbc: x.zbc || 0,
    hybk: x.hybk || '', m: x.m, seal: x.seal || 0
  }));
  // 第一级：板块最强 → 只留「属于已成型题材」的票。
  // 例外：连板 ≥2 的票不因「没被任何题材收录」而消失。
  //   - 东财板块榜偶发全线失败（warnings 里会出现 concept_rank_empty），题材表仅剩行业聚合，
  //     行业里只有它一只涨停的龙头（萌芽期刚启动）就会没有题材归属，被这一级静默误杀；
  //   - 用户口径明确：主线萌芽期不能因板块未成型误杀真龙头。
  //   这里放宽只影响「有题材 vs 无题材」的取舍，连板 ≥2 的硬门槛在 L2 依然生效。
  const L1 = hasMain ? norm.filter(x => !!themeOf(x.code, x.hybk) || (x.boards || 0) >= 2) : norm.slice();
  const L2 = L1.filter(x => (x.boards || 0) >= 2);
  const L3 = L2.filter(x => !x.zbc || x.zbc <= 0);
  const L4 = L3.filter(x => mainBoard(x.code, x.name));

  const tagOf = x => {
    const t = themeOf(x.code, x.hybk);
    return t || { name: x.hybk || '其他', kind: '行业', ztCount: 1, maxLbc: x.boards || 1, zt: [], score: 0 };
  };
  const mkCand = x => {
    const th = tagOf(x);
    const isMain = hasMain && topTh.some(t => (t.zt || []).some(z => z.code === x.code));
    const bs = scoreOf(x, th, isMain);
    return { ...x, th: { name: th.name, kind: th.kind, ztCount: th.ztCount, maxLbc: th.maxLbc, score: th.score }, sc: bs, baseSc: bs, inMain: isMain };
  };
  let cand = L4.map(mkCand);
  const watch = L2.filter(x => mainBoard(x.code, x.name)).map(mkCand)
    .sort((a, b) => b.sc - a.sc || b.boards - a.boards || a.fbt - b.fbt).slice(0, 5);

  // ---- 阶段 3：K线回溯 + 买点阶段 + 预警 ----
  // 剩余预算全给这一段；K线失败只影响该股的阶段标注，不影响预选池主体
  const candMap = {}, watchMap = {};
  cand.forEach(x => candMap[x.code] = x);
  watch.forEach(x => watchMap[x.code] = x);
  const codes = [];
  cand.slice(0, 6).forEach(x => { if (codes.indexOf(x.code) < 0) codes.push(x.code); });
  watch.forEach(x => { if (codes.length < 10 && codes.indexOf(x.code) < 0) codes.push(x.code); });

  // 阶段 3 预算 = 剩余总预算再留 100ms 余量给后续收尾。
  // 注意：dl.stage() 自身会再对总上限做一次 min()，所以这里取不到超过总预算的值。
  const st3 = dl.stage(Math.max(0, dl.left() - 100));
  let klineFail = 0;
  // 优先级：候选池前 6 只 > 观察池 5 只。
  // 线上慢时预算可能只够算前几只，此时预警只在部分标的上有——优先保证排名靠前的。
  const ordered = codes.slice(0, 6).concat(codes.slice(6));
  // K 线请求并发执行（线上实测 10 路并发全部成功），
  // 但每个请求有独立的 6 秒绝对超时保底，不会因总预算耗尽而被误杀。
  await Promise.all(ordered.map(async (code) => {
    const base = candMap[code] || watchMap[code];
    if (!base) return;
    const sec = (base.m === 1 ? '1.' : '0.') + code;
    let ks = null;
    try { ks = await kline(sec, st3); } catch (e) { ks = null; klineFail++; }
    /* K 线接口返回最近 30 根，盘中会带上「目标交易日之后」的未完成日线。
       快照是收盘后算定的静态口径，必须截到目标日（含）为止，否则页面标着
       11-20 的数据日、价位却按 11-23 盘中算，属于数据不准。 */
    if (ks && ks.length) {
      const ds = String(effDate).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');
      let j = ks.length - 1;
      while (j > 0 && String(ks[j][0]) > ds) j--;
      ks = ks.slice(0, j + 1);
    }
    const a = analyzeCycle(ks, base.boards, base, effDate);
    if (!a) return;
    let m = 1;
    if (a.ratio != null) m *= a.ok ? 1.06 : 0.93;
    if (a.stage === 'accel') m *= 0.90;
    else if (a.stage === 'resume') m *= 1.05;
    else if (a.stage === 'diverge') m *= 0.95;
    const alert = makeAlert(a, base.boards);
    [candMap[code], watchMap[code]].forEach(t => {
      if (!t) return;
      t.shrink = a.ratio == null ? '?' : (a.ok ? 'yes' : 'no');
      t.volR = a.ratio; t.stage = a.stage; t.stageTxt = a.stageTxt; t.stageCls = a.stageCls;
      t.advice = a.advice; t.histDiv = a.histDiv; t.divN = a.divN; t.tzN = a.tzN; t.firstDiv = a.firstDiv;
      t.cumHs = a.cumHs; t.sw = a.sw; t.close = a.close; t.low = a.low; t.limUp = a.limUp;
      t.prevClose = a.prevClose; t.alert = alert; t.cycLow = a.cycLow;
      t.watchOk = a.watchOk; t.watchWhy = a.watchWhy; t.volSeq = a.volSeq; t.hsSeq = a.hsSeq;
      t.volFlat = a.volFlat; t.minVolBoard = a.minVolBoard; t.breakHigh = a.breakHigh;
      t.swingHigh = a.swingHigh; t.firstDivDay = a.firstDivDay; t.scanBoards = a.scanBoards;
      t.mul = m; t.sc = Math.round((t.baseSc != null ? t.baseSc : t.sc) * m);
    });
  }));
  if (klineFail) warnings.push('kline_failed_' + klineFail);
  // A 扫描风控里的「业绩预告负面 / 曾用名 ST / 连续亏损 proxy」需要 Tushare
  // 日线以外的财务与改名接口；当前免费数据源拿不到，显式标注不完整。
  if (!process.env.TUSHARE_TOKEN) warnings.push('tushare_risk_not_loaded');
  cand.sort((a, b) => b.sc - a.sc || b.boards - a.boards || a.fbt - b.fbt);

  return {
    rc: 0,
    date: effDate,
    requested: date,
    poolKind: effDate === date ? 'next_trading_day_watch' : 'wait_first_divergence_prev_day',
    generatedAt: (now || new Date()).toISOString(),
    generatedAtBJ: bjParts(now || new Date()).date + ' ' + String(bjParts(now || new Date()).hh).padStart(2, '0') + ':' + String(bjParts(now || new Date()).mm).padStart(2, '0'),
    buildMs: Date.now() - t0,
    ztTotal: L0,
    hasMain,
    mainName: topTh.length ? topTh[0].name : '',
    L: { L0, L1: L1.length, L2: L2.length, L3: L3.length, L4: L4.length },
    topTh: topTh.map(t => ({ name: t.name, kind: t.kind, ztCount: t.ztCount, maxLbc: t.maxLbc, score: t.score })),
    warnings,
    klineSrc: K_SRC_STAT,
    concepts, cand, watch
  };
}

module.exports = {
  buildSnapshot, targetDate, bjParts, isWd, prevWd, dstr, makeDeadline, jgetR,
  ztPool, boardRank, boardMembers, kline, analyzeCycle, makeAlert, scoreOf, mainBoard,
  scanWatch, A_SCAN, shiftYmd
};
