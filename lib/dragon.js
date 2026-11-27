/* ================================================================
   龙空龙战法 · 选股与买点（职业短线口径，极简三要素）
   ----------------------------------------------------------------
   只做三件事：
     1) 出身：只认当下最强主线（梯队完整 + 连续活跃 + 能容错）
     2) 地位：只认板块总龙头（连板最高 + 早盘封板 + 带动力）
     3) 买点：只认两种模式内确认点
        - 首次分歧转一致：龙头第一次开板放量后强势回封
        - 弱转强加速：昨日烂板/大分歧，今日超预期高开快速上板
   下午板一律淘汰（套利/跟风，次日溢价不确定，不符合只做最强）。
   ================================================================ */
'use strict';

const AM_CUT = 100000;      // 10:00 前封板才算早盘强板
const AM_LATE = 113000;     // 11:30 前尚可，午后一律淘汰
const MAX_CAND = 3;         // 预选池最多 3 只，宁缺毋滥

const fnum = x => {
  const n = +x;
  return Number.isFinite(n) ? n : 0;
};
const label = x => String(x || '').toUpperCase();

/* 封板时间：东财 fbt = 首次封板 HHMMSS，lbt = 最后封板 HHMMSS。
   烂板识别：fbt 早但 lbt 拖到午后（反复炸板尾盘封）≠ 强势，必须看最后封板。 */
function sealTime(x) {
  const t = fnum(x != null && x.fbt != null ? x.fbt : x);
  return t > 0 && t < 240000 ? t : 0;
}
function finalSealTime(x) {
  const t = fnum(x != null && x.lbt != null ? x.lbt : (x && x.fbt));
  return t > 0 && t < 240000 ? t : 0;
}
function isMorning(x) {
  const t = sealTime(x);
  return t > 0 && t <= AM_LATE;
}
function isEarly(x) {
  const t = sealTime(x);
  return t > 0 && t <= AM_CUT;
}

/* ---------- 要素 1：主线 ----------
   主线 = 当下公认、持续最强的题材。按【概念族成分股】聚合（不是行业！）——
   行业会把龙头错归到「元件」，而真正的主线是「机器人概念」这类题材。
   opts.scopeMap = { code: '机器人概念' } 由服务端从东财概念板块成分生成；
   没有 scopeMap 时退回按 hybk 聚合（仅用于离线测试）。

   硬门槛：
     · 梯队：≥3 板高标 + 2 板助攻 + ≥3 首板小弟 + 中军容量票(≥50亿)
     · 持续：最近 3 天题材相对全市场占比持续走高（今日占比 ≥ 前日占比），
       或题材绝对涨停数今日 ≥10；一天爆发不算，3 天累计要够
     · 容错：期间出现分歧(炸板/高换手)但次日被修复，今日仍有足够涨停
   全部满足才算主线，否则空仓。 */
function pickMainline(daily, opts) {
  const o = Object.assign({ minTop: 3, minFirst: 3, minPerDay: 3, days: 3, minMv: 5e9,
    minToday: 10, minTotal: 15 }, opts || {});
  const days = (daily || []).filter(d => d && d.length).slice(0, o.days);
  if (days.length < o.days) return { ok: false, why: '历史涨停数据不足 ' + o.days + ' 天', list: [] };
  const scopeMap = o.scopeMap || null;
  const scopeGroups = o.scopeGroups || null; // { 族名: { code:true } }，同一票可属多族

  /* 返回票所属的族名数组。
     - scopeGroups：全市场多族模式，一只票可同时计入半导体/算力等多个族
     - scopeMap：单族覆盖模式（旧接口，兼容测试）
     - 都没有：退回按行业 hybk 聚合（离线测试） */
  const groupsOf = x => {
    const code = x.code || x.c;
    if (scopeGroups) {
      const gs = [];
      Object.keys(scopeGroups).forEach(k => { if (scopeGroups[k] && scopeGroups[k][code]) gs.push(k); });
      return gs.length ? gs : [x.hybk || '其他'];
    }
    return [(scopeMap && scopeMap[code]) || x.hybk || '其他'];
  };
  const inGroup = (x, k) => groupsOf(x).indexOf(k) >= 0;
  const keys = [];
  if (scopeGroups) keys.push(...Object.keys(scopeGroups));
  days[0].forEach(x => groupsOf(x).forEach(k => { if (keys.indexOf(k) < 0) keys.push(k); }));

  const list = [];
  keys.forEach(k => {
    const s = days[0].filter(x => inGroup(x, k));
    if (!s.length) return;
    const boards = s.map(x => fnum(x.boards || x.lbc || 1));
    const top = Math.max.apply(null, boards);
    const first = boards.filter(b => b === 1).length;
    const second = boards.filter(b => b === 2).length;
    const mid = boards.filter(b => b >= 2 && b < top).length;
    const hasZhongjun = s.some(x => fnum(x.ltsz) >= o.minMv);
    const cs = days.map(d => d.filter(x => inGroup(x, k)).length);
    const rs = days.map((d, i) => d.length ? cs[i] / d.length : 0);
    // 持续性：今日绝对数够多，或占比逐日走高且 3 天累计够
    const strongToday = cs[0] >= o.minToday;
    const rising = cs.reduce((a, b) => a + b, 0) >= o.minTotal && rs[0] >= rs[1] * 0.9;
    const continuous = strongToday || rising;
    const hadDiv = days.some(d => d.some(x => inGroup(x, k) && (fnum(x.zbc) > 0 || fnum(x.hs) >= 15)));
    const resilient = hadDiv && continuous;
    const ladderOk = top >= o.minTop && mid >= 1 && first >= o.minFirst && hasZhongjun;
    if (!(ladderOk && continuous && resilient)) return;
    list.push({
      name: k, top, second, mid, first, hasZhongjun, continuous, resilient,
      counts: cs, ratios: rs.map(r => +(r * 100).toFixed(1)),
      score: top * 12 + mid * 8 + Math.min(first, 12) * 2 + hasZhongjun * 10 + continuous * 20 + cs[0] * 2,
      stocks: s
    });
  });
  list.sort((a, b) => b.score - a.score || b.top - a.top || b.counts[0] - a.counts[0]);
  if (!list.length) return { ok: false, why: '无主线：梯队/持续性/容错未同时达标', list: [] };
  return { ok: true, main: list[0], list };
}

/* ---------- 要素 2 & 3：地位 + 双池 ----------
   范围：主线内 + 主板 + 连板≥2 + 早盘封板（午后板一律淘汰）。

   池①（first_div）：今日【首次】分歧转一致——本轮连板此前未分歧，今日开板放量回封。
     语义：今日回封瞬间是买点；收盘后入池，等待明日弱转强确认。
     严格剔除：此前（昨日或更早）已分歧过、今日才转强的票 = 错过买点后的追高。
   池②（consistent）：≥2板、今日一致（无开板/低换手）、且本轮连板从未出现首次大分歧。
     语义：尚未分歧的一致板，列入观察，等待未来首次分歧回封再出手；今日只看不买。

   history = 最近 N 日涨停池（今日在前），用于回溯本轮连板是否已有分歧。 */
function isMainBoard(x) {
  const c = String((x && (x.code || x.c)) || '');
  const n = String((x && (x.name || x.n)) || '').toUpperCase();
  return /^(600|601|603|605|000|001|002|003)/.test(c) && !/ST|退/.test(n) && !/^(N|C)/.test(n);
}
function pickDragons(main, history, opts) {
  const o = Object.assign({ max: MAX_CAND, amCut: AM_CUT, amLate: AM_LATE }, opts || {});
  const out = { pool1: [], pool2: [], removed: [], leaders: [] };
  if (!main || !main.stocks || !main.stocks.length) return out;
  const today = main.stocks;
  const days = (history || []).filter(d => d && d.length);

  const hasDiv = x => fnum(x && x.zbc) > 0 || fnum(x && x.hs) >= 15;
  // 本轮连板在【今日之前】是否已分歧过
  const hadDivBefore = code => days.slice(1).some(d =>
    d.some(x => (x.code || x.c) === code && hasDiv(x)));

  const pool = today.filter(x => isMainBoard(x) && fnum(x.boards || x.lbc || 1) >= 2);
  const sorted = pool.slice().sort((a, b) =>
    (fnum(b.boards || b.lbc || 1) - fnum(a.boards || a.lbc || 1))
    || (sealTime(a) - sealTime(b)));
  const topBoard = sorted.length ? fnum(sorted[0].boards || sorted[0].lbc || 1) : 0;

  sorted.forEach(x => {
    const code = x.code || x.c;
    const b = fnum(x.boards || x.lbc || 1);
    const t = sealTime(x);
    const ft = finalSealTime(x);
    const todayDiv = hasDiv(x);
    const beforeDiv = hadDivBefore(code);
    const row = {
      code, name: x.name || x.n, boards: b, fbt: t, boardsTop: topBoard,
      zbc: fnum(x.zbc), hs: +fnum(x.hs).toFixed(1)
    };

    // 硬门槛：午后板 / 尾盘烂板 / 封板时间不明 → 一律淘汰
    if (t > o.amLate || t === 0) {
      out.removed.push(Object.assign({}, row, { why: '午后板/封板时间不明，按套利板淘汰' })); return;
    }
    if (ft > o.amLate) {
      out.removed.push(Object.assign({}, row, { why: '早封尾盘烂板（反复炸板到午后才封死），按套利板淘汰' })); return;
    }
    // 已过首次分歧的，无论今日转强还是一致，都不进池
    if (beforeDiv) {
      out.removed.push(Object.assign({}, row, { why: '本轮连板此前已分歧过，今日再进属错过买点后的追高，剔除' })); return;
    }

    if (todayDiv) {
      // 池①：今日首次分歧转一致，等待明日弱转强
      out.pool1.push(Object.assign({}, row, {
        type: 'first_div', title: '首次分歧转一致',
        why: '本轮连板首次开板放量后强势回封，龙头第一次换手承接',
        entry: '今日回封瞬间打板；收盘后入池等明日弱转强'
      }));
    } else {
      // 池②：今日一致、本轮从未分歧，等未来首次分歧
      out.pool2.push(Object.assign({}, row, {
        type: 'consistent', title: '一致未分歧',
        why: '连板至今未出现首次大分歧，今日一致锁筹',
        entry: '只看不买，等未来首次开板放量回封再出手'
      }));
    }
  });

  const cmp = (a, b) => (a.fbt - b.fbt) || (b.boards - a.boards);
  out.pool1.sort(cmp); out.pool2.sort(cmp);
  out.pool1 = out.pool1.slice(0, o.max);
  out.pool2 = out.pool2.slice(0, o.max);
  out.leaders = out.pool1; // 兼容旧字段
  return out;
}

/* 统一的入口：给 4 天涨停池（今日在前），返回可直接渲染的池子。
   多主线模式：每条达标主线各选自己的总龙头，合并成池；同一票在多主线重复时只留一次，
   按【封板时间优先 → 连板高度 → 主线score】排序，宁缺毋滥（max 只）。 */
function buildDragonPool(daily, opts) {
  const o = opts || {};
  let ml = pickMainline(daily, opts);
  const zt = (daily && daily[0] || []).length;
  // 只取今日涨停数前三强的板块作主线（用户口径：今日前三强板块即主线）
  if (ml.ok && o.topN) ml = Object.assign({}, ml, { list: ml.list.slice(0, o.topN) });
  if (!ml.ok || !(ml.list || []).length) return { ok: false, why: ml.why || '无达标主线', main: null, mains: [],
    pool1: [], pool2: [], leaders: [], removed: [], funnel: { zt, main: 0, leader: 0 } };

  const max = o.max || MAX_CAND;
  const p1 = [], p2 = [], allRemoved = [], mains = [];
  const seen1 = {}, seen2 = {};
  ml.list.forEach(m => {
    const dg = pickDragons(m, daily, opts);
    mains.push({
      name: m.name, top: m.top, second: m.second, mid: m.mid, first: m.first,
      zhongjun: m.hasZhongjun, counts: m.counts, ratios: m.ratios,
      resilient: m.resilient, score: m.score, stocks: m.stocks.length
    });
    const merge = (arr, seen, key) => {
      dg[key].forEach(x => {
        const row = Object.assign({}, x, { main: m.name, mainScore: m.score });
        if (seen[x.code]) return; // 同票已在更强主线入池，保留先入的
        seen[x.code] = 1; arr.push(row);
      });
    };
    merge(p1, seen1, 'pool1');
    merge(p2, seen2, 'pool2');
    dg.removed.forEach(x => { if (!allRemoved.some(r => r.code === x.code)) allRemoved.push(Object.assign({}, x, { main: m.name })); });
  });

  const cmp = (a, b) => (a.fbt - b.fbt) || (b.boards - a.boards) || (b.mainScore - a.mainScore);
  p1.sort(cmp); p2.sort(cmp);
  const pool1 = p1.slice(0, max), pool2 = p2.slice(0, max);
  const mainTotal = ml.list.reduce((n, m) => n + m.stocks.length, 0);
  return {
    ok: true,
    why: '',
    main: { name: ml.main.name, top: ml.main.top, second: ml.main.second,
      first: ml.main.first, zhongjun: ml.main.hasZhongjun, counts: ml.main.counts,
      resilient: ml.main.resilient, score: ml.main.score },
    mains: mains,
    pool1: pool1, pool2: pool2,
    leaders: pool1, // 兼容旧字段
    removed: allRemoved,
    funnel: { zt, main: mainTotal, leader: pool1.length + pool2.length }
  };
}

module.exports = { buildDragonPool, pickMainline, pickDragons, sealTime, isMorning, isEarly, AM_CUT, AM_LATE, MAX_CAND };
