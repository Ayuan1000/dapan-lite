'use strict';
/* GitHub Actions 定时任务：用与服务端完全相同的 lib/core.js 生成静态快照，
   写入 public/data/snapshot.json。GitHub Pages 无服务端函数，前端优先读这个文件。
   用法：node scripts/gen-snapshot.js  [YYYYMMDD]
   不带参数时按 17:40 闸门选目标交易日（17:40 前取上一交易日）。 */
const fs = require('fs');
const path = require('path');
const { buildSnapshot, targetDate, bjParts, prevWd, ztPool, boardRank, boardMembers } = require('../lib/core.js');
const { buildDragonPool } = require('../lib/dragon.js');

/* 机器人主线范围：东财概念板块「机器人概念/人形机器人/减速器/机器人执行器/机器视觉」
   的成分股并集 = 主营业务涉及机器人。可用 A_SCOPE_KEYWORDS 覆盖。

   【重要修复 2026-11-26】不能只从 boardRank('m:90+t:3') 涨幅榜前 100 里按关键词找板块：
   机器人退潮时这些板块跌出前 100，映射会退化成只剩「虚拟机器人」16 只，
   主线被误判为「无」，预选池凭空变空。改用【固定板块代码】直接取成分股，
   与当日涨跌无关；boardRank 仅用于补充发现新板块。 */
const SCOPE_KEYWORDS = (process.env.A_SCOPE_KEYWORDS || '机器人,人形,减速器,丝杠,伺服,执行器,机器视觉,工业自动化,智能装备').split(',');
const SCOPE_NAME = process.env.A_SCOPE_NAME || '机器人概念';
// 固定板块代码：机器人主线族的核心成分来源（退潮期也稳定可取）
const SCOPE_BOARDS = (process.env.A_SCOPE_BOARDS ||
  'BK1100:减速器,BK1145:机器人执行器,BK1184:人形机器人,BK1090:机器人概念,BK0998:机器视觉,BK1190:虚拟机器人')
  .split(',').map(s => { const [code, name] = s.split(':'); return { f12: code, f14: name }; });
async function buildScopeMap() {
  // 固定板块为主（不受涨幅榜波动影响）
  let hit = SCOPE_BOARDS.slice();
  const seen = new Set(hit.map(b => b.f12));
  // 补充：从涨幅榜前 100 里发现关键词命中的新板块（不重复）
  const ranks = await boardRank('m:90+t:3').catch(() => []);
  ranks.filter(b => SCOPE_KEYWORDS.some(k => String(b.f14 || '').includes(k)))
    .forEach(b => { if (!seen.has(b.f12)) { seen.add(b.f12); hit.push(b); } });
  const mem = await Promise.all(hit.map(b => boardMembers(b.f12).catch(() => [])));
  const map = {};
  // 相关概念合并成同一个主线族，避免票被拆成多个概念各算各的
  hit.forEach((b, i) => (mem[i] || []).forEach(m => { map[m.f12] = SCOPE_NAME; }));
  return { map, boards: hit.map(b => b.f14) };
}

const uniqCodes = snap => Object.keys(
  [...(snap.cand || []), ...(snap.watch || [])]
    .reduce((m, x) => (x && x.code ? (m[x.code] = 1) : 0, m), {})
).length;

/* 可选风控增强：配置 TUSHARE_TOKEN 后补三项免费源拿不到的剔除项——
   业绩预告负面（亏/减/预警）、近年曾用名含 ST、最近两期连续亏损 proxy。
   未配置时保持现有结果，并在快照 warnings 里标注不完整。 */
const tsCode = c => String(c) + (/^6/.test(String(c)) ? '.SH' : '.SZ');
async function tushare(api, params, fields) {
  const r = await fetch('https://api.tushare.pro', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_name: api, token: process.env.TUSHARE_TOKEN, params, fields })
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(api + ' code=' + j.code + ' ' + j.msg);
  const f = (j.data && j.data.fields) || [];
  return ((j.data && j.data.items) || []).map(row => {
    const o = {}; f.forEach((k, i) => { o[k] = row[i]; }); return o;
  });
}
async function applyTushareRisk(snap) {
  const all = [...(snap.cand || []), ...(snap.watch || [])];
  const ts = [...new Set(all.map(x => x.code))].map(tsCode).join(',');
  if (!ts) return;
  const [fc, nc, fi] = await Promise.all([
    tushare('forecast', { ts_code: ts }, 'ts_code,end_date,type').catch(() => []),
    tushare('namechange', { ts_code: ts }, 'ts_code,name').catch(() => []),
    tushare('fina_indicator', { ts_code: ts }, 'ts_code,end_date,netprofit').catch(() => [])
  ]);
  // 只认本次入池标的的数据；Tushare 有时忽略 ts_code 返回全局前 100 条
  const wanted = new Set(ts.split(','));
  const f2 = fc.filter(r => wanted.has(r.ts_code));
  const n2 = nc.filter(r => wanted.has(r.ts_code));
  const i2 = fi.filter(r => wanted.has(r.ts_code));
  // 三项全空说明 token 无效/无权限，不能当成「风控已通过」
  if (!f2.length && !n2.length && !i2.length) throw new Error('Tushare 三项接口均无本池标的数据，风控未生效');
  const partial = [];
  if (!f2.length) partial.push('forecast');
  if (!n2.length) partial.push('namechange');
  if (!i2.length) partial.push('fina');
  const bad = {};
  f2.forEach(r => { if (/亏|减|预警/.test(String(r.type || ''))) bad[r.ts_code] = '业绩预告负面'; });
  n2.forEach(r => { if (/ST/.test(String(r.name || '').toUpperCase())) bad[r.ts_code] = '曾用名含 ST'; });
  const byCode = {};
  i2.forEach(r => { (byCode[r.ts_code] || (byCode[r.ts_code] = [])).push(r); });
  Object.keys(byCode).forEach(k => {
    const arr = byCode[k].sort((a, b) => String(b.end_date).localeCompare(String(a.end_date))).slice(0, 2);
    if (arr.length === 2 && arr.every(r => +(r.netprofit || 0) < 0)) bad[k] = '最近两期连续亏损';
  });
  const keep = x => !bad[tsCode(x.code)];
  snap.cand = (snap.cand || []).filter(keep);
  snap.watch = (snap.watch || []).filter(keep);
  snap.tushareRisk = bad;
  snap.tushareRows = { forecast: f2.length, namechange: n2.length, fina: i2.length };
  snap.warnings = (snap.warnings || []).filter(w => w !== 'tushare_risk_not_loaded');
  if (partial.length) snap.warnings.push('tushare_risk_partial_' + partial.join('+'));
}

/* 数据中心出口（Actions runner 在海外）抓东财板块榜会偶发全线失败，
   表现为 warnings 里出现 concept_rank_empty，此时题材退化为行业聚合，容易漏票。
   策略：最多跑 2 轮，取「去重标的数最多、告警最少」的那一份。 */
(async () => {
  const now = new Date();
  const date = process.argv[2] || targetDate(now);
  console.log('目标交易日:', date, '| 北京时间:', JSON.stringify(bjParts(now)));

  const rounds = [];
  for (let i = 0; i < 2; i++) {
    const t = Date.now();
    let snap;
    try {
      snap = await buildSnapshot(date, now, 26000);
    } catch (e) {
      console.log('第 ' + (i + 1) + ' 轮失败:', e && e.message);
      continue;
    }
    const ms = Date.now() - t;
    const w = snap.warnings || [];
    rounds.push({ snap, ms, uniq: uniqCodes(snap), warn: w.length });
    console.log('第 ' + (i + 1) + ' 轮 buildMs', ms, '| 去重', uniqCodes(snap),
      '| ztTotal', snap.ztTotal, '| warnings', JSON.stringify(w),
      '| klineSrc', JSON.stringify(snap.klineSrc || {}));
    // 一轮就干净（板块榜没挂、且有标的）→ 不必再跑，省一半时间
    const thin = w.indexOf('concept_rank_empty') > -1 || uniqCodes(snap) === 0;
    if (!thin) break;
    if (i === 0) console.log('上游偏薄（' + (w.join(',') || '无标的') + '），再跑一轮…');
  }

  if (!rounds.length) { console.error('FAIL: 两轮都没能生成快照'); process.exit(1); }

  // 先比标的数，再比告警数
  rounds.sort((a, b) => b.uniq - a.uniq || a.warn - b.warn);
  const best = rounds[0].snap;
  if (rounds.length > 1) console.log('两轮取优：去重 ' + rounds[0].uniq + ' 只、告警 ' + rounds[0].warn + ' 条');

  if (process.env.TUSHARE_TOKEN) {
    try {
      await applyTushareRisk(best);
      console.log('Tushare 风控已应用', JSON.stringify(best.tushareRows || {}),
        '剔除', Object.keys(best.tushareRisk || {}).length, '只');
    } catch (e) {
      console.log('Tushare 风控不可用（保留原结果）:', e && e.message);
      best.warnings = (best.warnings || []).concat('tushare_risk_not_loaded');
    }
  }

  /* 龙空龙选股：额外抓最近 3 个交易日涨停池，按「出身→地位→买点」三要素选总龙头。
     这是预选池唯一权威结果；旧的 cand/watch 仅保留为数据兜底，不再参与展示。 */
  try {
    const dates = [date, prevWd(date, 1), prevWd(date, 2), prevWd(date, 3)];
    const pools = await Promise.all(dates.map(d => ztPool(d).catch(() => [])));
    const scope = await buildScopeMap();
    // 把概念归属打到每只涨停票上；同时保留行业名做兜底
    pools.forEach(pool => pool.forEach(x => {
      x.theme = scope.map[x.c] || '';
      x.hybk = x.hybk || '其他';
    }));
    best.dragon = buildDragonPool(pools, {
      scopeMap: scope.map,
      scopeName: scope.boards.join('/')
    });
    best.dragon.scopeBoards = scope.boards;
    console.log('龙空龙：', JSON.stringify(best.dragon.funnel),
      '主线', best.dragon.main && best.dragon.main.name,
      '概念范围', scope.boards.join('/') || '无',
      '买点', best.dragon.leaders.map(x => x.name + '/' + x.type).join(',') || '无');
  } catch (e) {
    console.log('龙空龙选股失败:', e && e.message);
    best.dragon = { ok: false, why: '数据不足', main: null, leaders: [], removed: [], funnel: { zt: 0, main: 0, leader: 0 } };
  }

  const all = [...(best.cand || []), ...(best.watch || [])];
  console.log('ztTotal', best.ztTotal, '| hasMain', best.hasMain, '| cand', (best.cand || []).length,
    '| watch', (best.watch || []).length, '| 去重', uniqCodes(best),
    '| alert覆盖', all.filter(x => x && x.alert).length + '/' + all.length,
    '| stage覆盖', all.filter(x => x && x.stage).length + '/' + all.length);

  const dir = path.resolve(__dirname, '..', 'public', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'snapshot.json');
  fs.writeFileSync(out, JSON.stringify(best));
  console.log('写入', out, fs.statSync(out).size, 'bytes');

  /* 数据质量守门：
     旧逻辑(cand/watch)与龙空龙(dragon)是两套独立口径——普涨日旧口径可能判无主线、
     cand/watch 为空，但 dragon 仍能正常选出主线与买点。只要任一路径产出有效结果，
     就说明上游数据到手，不能误判为异常拒绝发布（否则线上一直卡在昨日快照）。 */
  const oldOk = all.length > 0 && all.filter(x => x && x.alert).length > 0;
  const dragonOk = !!(best.dragon && best.dragon.ok && best.dragon.funnel && best.dragon.funnel.zt > 0);
  if (!oldOk && !dragonOk) {
    console.error('FAIL: 旧池与龙空龙均无有效结果，判定为上游异常，退出码 1 不提交');
    process.exit(1);
  }
  if (!oldOk) console.log('守门提示: 旧口径无候选，但龙空龙结果有效，允许发布');
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });
