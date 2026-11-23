'use strict';
/* GitHub Actions 定时任务：用与服务端完全相同的 lib/core.js 生成静态快照，
   写入 public/data/snapshot.json。GitHub Pages 无服务端函数，前端优先读这个文件。
   用法：node scripts/gen-snapshot.js  [YYYYMMDD]
   不带参数时按 17:40 闸门选目标交易日（17:40 前取上一交易日）。 */
const fs = require('fs');
const path = require('path');
const { buildSnapshot, targetDate, bjParts } = require('../lib/core.js');

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

  // 数据质量守门：一条预警都算不出来，说明上游挂了，别把坏快照提交上线
  const bad = all.length === 0 || all.filter(x => x && x.alert).length === 0;
  if (bad) { console.error('FAIL: 快照无任何预警价位，判定为上游异常，退出码 1 不提交'); process.exit(1); }
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });
