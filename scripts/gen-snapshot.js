'use strict';
/* GitHub Actions 定时任务：用与服务端完全相同的 lib/core.js 生成静态快照，
   写入 public/data/snapshot.json。GitHub Pages 无服务端函数，前端优先读这个文件。
   用法：node scripts/gen-snapshot.js  [YYYYMMDD]
   不带参数时按 17:40 闸门选目标交易日（17:40 前取上一交易日）。 */
const fs = require('fs');
const path = require('path');
const { buildSnapshot, targetDate, bjParts } = require('../lib/core.js');

(async () => {
  const now = new Date();
  const date = process.argv[2] || targetDate(now);
  console.log('目标交易日:', date, '| 北京时间:', JSON.stringify(bjParts(now)));

  const t = Date.now();
  const snap = await buildSnapshot(date, now, 26000);
  const ms = Date.now() - t;

  const all = [...(snap.cand || []), ...(snap.watch || [])];
  const uniq = Object.keys(all.reduce((m, x) => (x && x.code ? (m[x.code] = 1) : 0, m), {})).length;
  console.log('buildMs', ms, '| warnings', JSON.stringify(snap.warnings || []), '| klineSrc', JSON.stringify(snap.klineSrc || {}));
  console.log('ztTotal', snap.ztTotal, '| hasMain', snap.hasMain, '| cand', (snap.cand || []).length,
    '| watch', (snap.watch || []).length, '| 去重', uniq,
    '| alert覆盖', all.filter(x => x && x.alert).length + '/' + all.length,
    '| stage覆盖', all.filter(x => x && x.stage).length + '/' + all.length);

  const dir = path.resolve(__dirname, '..', 'public', 'data');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'snapshot.json');
  fs.writeFileSync(out, JSON.stringify(snap));
  console.log('写入', out, fs.statSync(out).size, 'bytes');

  // 数据质量守门：一条预警都算不出来，说明上游挂了，别把坏快照提交上线
  const bad = all.length === 0 || all.filter(x => x && x.alert).length === 0;
  if (bad) { console.error('FAIL: 快照无任何预警价位，判定为上游异常，退出码 1 不提交'); process.exit(1); }
})().catch(e => { console.error('FAIL', e && e.message); process.exit(1); });
