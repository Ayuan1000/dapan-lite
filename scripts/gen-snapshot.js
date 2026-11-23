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
