// Netlify Function: 题材强度聚合（开盘啦式主线榜）
// /.netlify/functions/theme?date=YYYYMMDD
// 逻辑（开盘啦式唯一归属）：
//  1) 拉当日涨停池 + 东财概念榜(m:90+t:3) + 行业榜(m:90+t:2)
//  2) 行业归属优先：同行业涨停>=2家 → 独立成"行业"题材（如 元件/PCB/通信设备），个股标记已归属
//  3) 概念归属兜底：未被行业归属的涨停股，归入含它的排名最高的概念 → 个股全局只计一次，不重复计数
//  4) 每题材：涨停家数/最高连板/封单/强度分；涨停个股全量返回
//
// 【重试与降级】
//   东财源站偶发 "HTTP 502"（连接重置），此前本函数没有重试逻辑，
//   一次抖动就整体 502。实测线上单次请求 200~2300ms，波动很大，
//   所以这里统一用 core.js 的 jgetR（带重试 + 预算），并让题材榜失败时
//   降级为「行业自聚合」而不是整体失败——行业归属本来就只需要涨停池。
const { jgetR, makeDeadline, ztPool, boardRank, boardMembers } = require('../../lib/core.js');
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const REF = 'https://quote.eastmoney.com/';

// 平台实测超时 30 秒；这里给 18 秒总预算，留足余量
const BUDGET_MS = 18000;

// 非题材类概念黑名单（榜单噪音：统计型/风格型/指数型）
const BLOCK = /(昨日|前日|昨日涨停|含一字|ST板块|次新|注册制|近期新高|近期新低|微盘|B股|AH|破净|高送转|低价|高价|新股|连续缩量|连续放量|大盘股|中盘股|小盘|融资融券|深股通|沪股通|标普|富时|MSCI|证金|汇金|基金重仓|社保|养老金|QFII|机构重仓|上证50|上证180|沪深300|中证|创业综|茅指数|宁组合|GDR|可转债|转债|预盈预增|预亏预减|亏损|微利|市净率|市盈率|百元股|三日|两融|举牌|壳资源|AB股|H股|F股|红旗飘飘|百元)/;

let cache = { t: 0, key: '', body: null };

// ztPool / boardRank / boardMembers 统一复用 core.js 的实现：
// 那里面带「东财主机池轮转 + 重试」，本函数原先的私有实现没有这些，
// 遇到 push2 源站 HTTP 502 会整体失败（实测失败率约 50%）。

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
    code: b ? b.f12 : '', name, kind,
    pct, inflow, up: (b && b.f104) || 0,
    lead: (b && b.f128) || '', leadPct: (b && typeof b.f136 === 'number') ? b.f136 : 0,
    ztCount: zt.length, maxLbc, sumLbc, fundSum, score: Math.round(score),
    zt
  };
}

exports.handler = async (event) => {
  const q = (event.queryStringParameters || {});
  const date = q.date || '';
  if (!/^\d{8}$/.test(date)) return { statusCode: 400, headers: hdr(), body: 'bad date' };
  const now = Date.now();
  if (cache.key === date && now - cache.t < 20000 && cache.body) {
    return { statusCode: 200, headers: hdr(), body: cache.body };
  }
  try {
    const dl = makeDeadline(BUDGET_MS);
    // 休市日回退：给定日期无涨停数据时，向前最多找5天的最近交易日。
    // 改为「并行探测」——原来串行 for 循环每次都要等一个往返，最坏 5 个 RTT。
    let effDate = date;
    // 涨停池失败时不能直接 502：题材榜本身也要靠涨停池做归属，
    // 但至少要回退到「最近有数据的交易日」，而不是整接口失败。
    let zts = await ztPool(effDate, dl).catch(() => []);
    if (!zts.length) {
      const tryDates = [];
      for (let b = 1; b <= 5; b++) {
        const dd = new Date(parseInt(date.slice(0, 4)), parseInt(date.slice(4, 6)) - 1, parseInt(date.slice(6, 8)));
        dd.setDate(dd.getDate() - b);
        const ds = dd.getFullYear() + String(dd.getMonth() + 1).padStart(2, '0') + String(dd.getDate()).padStart(2, '0');
        tryDates.push(ds);
      }
      const pools = await Promise.all(tryDates.map(ds => ztPool(ds, dl).catch(() => [])));
      for (let i = 0; i < tryDates.length && !zts.length; i++) {
        if (pools[i] && pools[i].length) { effDate = tryDates[i]; zts = pools[i]; }
      }
    }
    // 涨停池彻底拿不到（源站故障）→ 返回空题材但保持 200，
    // 让前端用行业自聚合/空态渲染，而不是整页报错。
    if (!zts.length) {
      const body = JSON.stringify({ rc: 0, date, requested: date, ztTotal: 0, concepts: [], degraded: 'zt_pool_unavailable' });
      return { statusCode: 200, headers: hdr(), body };
    }
    // 题材榜失败不阻断：降级为「行业自聚合」，页面仍有主线可看
    const [cRanks, iRanks] = await Promise.all([
      boardRank('m:90+t:3', dl).catch(() => []),
      boardRank('m:90+t:2', dl).catch(() => [])
    ]);
    const ztMap = {}; // code -> pool item
    zts.forEach(x => { ztMap[x.c] = x; });

    // ---- 第一层：行业归属（同行业涨停>=2家 → 独立行业题材，唯一归属） ----
    const indMap = {};
    iRanks.forEach(b => { if (!BLOCK.test(b.f14 || '')) indMap[b.f14] = b; });
    const indCnt = {};
    zts.forEach(x => { const k = x.hybk || ''; if (k) indCnt[k] = (indCnt[k] || 0) + 1; });
    const assigned = new Set(); // 已归属行业题材的涨停股 code
    const themes = [];
    Object.keys(indCnt).forEach(ind => {
      if (indCnt[ind] < 2) return;
      const members = zts.filter(x => (x.hybk || '') === ind)
        .map(x => ({ code: x.c, name: x.n, lbc: x.lbc || 1, fund: x.fund || 0, fbt: x.fbt || 0, zbc: x.zbc || 0, hybk: x.hybk || '' }));
      members.forEach(m => assigned.add(m.code));
      themes.push(makeTheme(indMap[ind], ind, members, '行业'));
    });

    // ---- 第二层：概念归属（仅收未归属个股；按概念榜排名优先，个股全局只计一次） ----
    const cands = cRanks.filter(x => {
      const nm = x.f14 || '';
      if (BLOCK.test(nm)) return false;
      const pct = typeof x.f3 === 'number' ? x.f3 : -99;
      const leadPct = typeof x.f136 === 'number' ? x.f136 : 0;
      return pct >= 1 || leadPct >= 8.9;
    }).slice(0, 25);
    // 分批并发（线上实测并发 10 路稳定），批次之间检查预算
    const cThemes = [];
    const BATCH = 16;
    for (let i = 0; i < cands.length; i += BATCH) {
      if (dl.expired()) break;
      const batch = cands.slice(i, i + BATCH);
      const r = await Promise.all(batch.map(async (b) => {
        const mem = await boardMembers(b.f12, dl);
        const zt = [];
        (mem || []).forEach(m => {
          const it = ztMap[m.f12];
          if (it && !assigned.has(it.c)) zt.push({ code: it.c, name: it.n, lbc: it.lbc || 1, fund: it.fund || 0, fbt: it.fbt || 0, zbc: it.zbc || 0, hybk: it.hybk || '' });
        });
        if (!zt.length) return null;
        return makeTheme(b, b.f14, zt, '概念');
      }));
      cThemes.push(...r.filter(Boolean));
    }
    themes.push(...cThemes);

    const concepts = themes.sort((a, b) => b.score - a.score).slice(0, 15);
    const body = JSON.stringify({ rc: 0, date: effDate, requested: date, ztTotal: zts.length, concepts });
    if (concepts.length) cache = { t: now, key: date, body };
    return { statusCode: 200, headers: hdr(), body };
  } catch (e) {
    return { statusCode: 502, headers: hdr(), body: JSON.stringify({ rc: -1, msg: String(e && e.message || e) }) };
  }
};
function hdr() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    // 关键：CDN 必须每次回源，否则会拿到陈旧的题材榜（曾导致返回 2 个月前的数据）
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  };
}
