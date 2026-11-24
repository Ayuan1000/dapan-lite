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

/* 封板时间：东财 fbt = HHMMSS，越早越强 */
function sealTime(x) {
  const t = fnum(x != null && x.fbt != null ? x.fbt : x);
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
   按行业(hybk)聚合当日涨停池，硬性要求：
     · 梯队：有 ≥3 板高标 + 2 板助攻 + ≥3 只首板小弟 + 中军容量票(流通市值≥50亿)
     · 持续：最近 3 个交易日该行业每天都有 ≥3 只涨停（不是一日游）
     · 容错：这 3 天里出现过分歧(炸板/高换手)，但仍保持活跃 → 分歧能被修复
   全部满足才算主线；不满足就空仓，不勉强找替代。 */
function pickMainline(daily, opts) {
  const o = Object.assign({ minTop: 3, minFirst: 3, minPerDay: 3, days: 3, minMv: 5e9 }, opts || {});
  const days = (daily || []).filter(d => d && d.length).slice(0, o.days);
  if (days.length < o.days) return { ok: false, why: '历史涨停数据不足 ' + o.days + ' 天', list: [] };
  const today = days[0];
  const groups = {};
  today.forEach(x => {
    const k = x.hybk || '其他';
    if (!groups[k]) groups[k] = [];
    groups[k].push(x);
  });
  const list = [];
  Object.keys(groups).forEach(k => {
    const s = groups[k];
    const boards = s.map(x => fnum(x.boards || x.lbc || 1));
    const top = Math.max.apply(null, boards);
    const first = boards.filter(b => b === 1).length;
    const second = boards.filter(b => b === 2).length;
    const mid = boards.filter(b => b >= 2 && b < top).length;
    const hasZhongjun = s.some(x => fnum(x.ltsz) >= o.minMv);
    // 连续活跃：最近 N 天每天该行业涨停数都达门槛
    const counts = days.map(d => d.filter(x => (x.hybk || '其他') === k).length);
    const continuous = counts.every(n => n >= o.minPerDay);
    // 容错：出现过炸板或高换手，但次日/今日仍有 ≥门槛 的涨停 → 分歧被修复
    const hadDiv = days.some(d => d.some(x => (x.hybk || '其他') === k && (fnum(x.zbc) > 0 || fnum(x.hs) >= 15)));
    const resilient = hadDiv && continuous;
    const ladderOk = top >= o.minTop && mid >= 1 && first >= o.minFirst && hasZhongjun;
    const ok = ladderOk && continuous && resilient;
    if (!ok) return;
    list.push({
      name: k, top, second, mid, first, hasZhongjun, continuous, resilient, counts,
      score: top * 12 + mid * 8 + Math.min(first, 12) * 2 + hasZhongjun * 10 + continuous * 20,
      stocks: s
    });
  });
  list.sort((a, b) => b.score - a.score || b.top - a.top || b.counts[0] - a.counts[0]);
  if (!list.length) return { ok: false, why: '无主线：梯队/持续性/容错未同时达标', list: [] };
  return { ok: true, main: list[0], list };
}

/* ---------- 要素 2 & 3：地位 + 买点 ----------
   主线内只认「总龙头」：连板最高；并列取封板最早；午后板直接淘汰。
   买点只认两种：
     A 首次分歧转一致（first_div）：今日炸板回封，且本轮连板此前未炸过板
     B 弱转强加速（weak_strong）：昨日烂板/大分歧，今日早盘快速上板
   其余连板票全部淘汰，并在 removed 里写明原因。 */
function pickDragons(main, yesterday, opts) {
  const o = Object.assign({ max: MAX_CAND, amCut: AM_CUT, amLate: AM_LATE }, opts || {});
  const out = { leaders: [], removed: [], setups: [] };
  if (!main || !main.stocks || !main.stocks.length) return out;
  const today = main.stocks;
  const prevMap = {};
  (yesterday || []).forEach(x => { prevMap[x.code || x.c] = x; });

  // 只保留主线内、主板由上层保证；按高度 + 封板时间选总龙头
  const pool = today.filter(x => {
    const b = fnum(x.boards || x.lbc || 1);
    return b >= 2;
  });
  const sorted = pool.slice().sort((a, b) =>
    (fnum(b.boards || b.lbc || 1) - fnum(a.boards || a.lbc || 1))
    || (sealTime(a) - sealTime(b)));
  const topCode = sorted.length ? (sorted[0].code || sorted[0].c) : '';
  const topBoard = sorted.length ? fnum(sorted[0].boards || sorted[0].lbc || 1) : 0;

  sorted.forEach(x => {
    const code = x.code || x.c;
    const b = fnum(x.boards || x.lbc || 1);
    const t = sealTime(x);
    const pv = prevMap[code];
    const prevDiv = pv && (fnum(pv.zbc) > 0 || fnum(pv.hs) >= 15);
    const todayDiv = fnum(x.zbc) > 0 || fnum(x.hs) >= 15;
    let drop = '';

    if (t > o.amLate || t === 0) drop = '午后板/封板时间不明，按套利板淘汰';
    else if (code !== topCode) drop = '非板块最高板，只做总龙头';
    else if (b < o.max || b < 2) drop = '连板高度不足';

    if (drop) { out.removed.push({ code, name: x.name || x.n, why: drop }); return; }

    // 买点 A：今日首次开板放量回封，且此前连板段没分歧过
    if (todayDiv && !prevDiv) {
      out.setups.push({ code, name: x.name || x.n, type: 'first_div',
        title: '首次分歧转一致', boards: b, fbt: t,
        why: '本轮连板首次开板放量后强势回封，龙头第一次换手承接',
        entry: '回封瞬间打板', boardsTop: topBoard });
      return;
    }
    // 买点 B：昨日分歧/烂板，今日超预期早盘上板
    if (prevDiv && isEarly(x)) {
      out.setups.push({ code, name: x.name || x.n, type: 'weak_strong',
        title: '弱转强加速', boards: b, fbt: t,
        why: '昨日炸板/高换手分歧，今日早盘快速上板，超预期转强',
        entry: '开盘快速上板时打板', boardsTop: topBoard });
      return;
    }
    out.removed.push({ code, name: x.name || x.n, why: '无模式内买点（既非首次分歧回封，也非昨分歧今加速）' });
  });

  out.setups.sort((a, b) => (a.fbt - b.fbt) || (b.boards - a.boards));
  out.leaders = out.setups.slice(0, o.max);
  return out;
}

/* 统一的入口：给 4 天涨停池（今日在前），返回可直接渲染的池子 */
function buildDragonPool(daily, opts) {
  const ml = pickMainline(daily, opts);
  if (!ml.ok) return { ok: false, why: ml.why, main: null, leaders: [], removed: [], funnel: { zt: (daily && daily[0] || []).length, main: 0, leader: 0 } };
  const dg = pickDragons(ml.main, daily[1] || [], opts);
  return {
    ok: true,
    why: '',
    main: { name: ml.main.name, top: ml.main.top, second: ml.main.second,
      first: ml.main.first, zhongjun: ml.main.hasZhongjun, counts: ml.main.counts,
      resilient: ml.main.resilient, score: ml.main.score },
    leaders: dg.leaders,
    removed: dg.removed,
    funnel: { zt: (daily && daily[0] || []).length, main: ml.main.stocks.length, leader: dg.leaders.length }
  };
}

module.exports = { buildDragonPool, pickMainline, pickDragons, sealTime, isMorning, isEarly, AM_CUT, AM_LATE, MAX_CAND };
