'use strict';
/* GitHub Actions 定时任务：用与服务端完全相同的 lib/core.js 生成静态快照，
   写入 public/data/snapshot.json。GitHub Pages 无服务端函数，前端优先读这个文件。
   用法：node scripts/gen-snapshot.js  [YYYYMMDD]
   不带参数时按 17:40 闸门选目标交易日（17:40 前取上一交易日）。 */
const fs = require('fs');
const path = require('path');
const { buildSnapshot, targetDate, bjParts, prevWd, ztPool, boardRank, boardMembers, jgetR } = require('../lib/core.js');
const { buildDragonPool } = require('../lib/dragon.js');

/* 全市场题材族映射（2026-11-27 重构）：
   不再写死「机器人」单一主线，也不硬编码板块代码（实测代码会失效/归错类）。
   改为【按板块名称关键词动态发现】：翻页取全部东财概念板块(~500)，
   用族关键词匹配板块名，归并成若干题材族，每族取全量成分股（boardMembers 已支持分页）。
   一只票可同时属于多个族。族关键词可用环境变量 A_TOPIC_DEFS 覆盖。 */
const TOPIC_DEFS = {
  '半导体芯片': ['半导体', '芯片', '光刻', '存储', 'MCU'],
  '算力光模块': ['算力', 'CPO', '光模块', '光通信', '液冷', '通信技术', '智算'],
  '人工智能': ['人工智能', 'AI', 'AIGC', '多模态', '智谱', '语料', '智能体'],
  '机器人概念': ['机器人', '人形', '减速器', '伺服', '执行器', '机器视觉', '虚拟机器人'],
  '新能源车': ['新能源车', '锂电', '固态电池', '智能驾驶', '汽车芯片'],
  '军工航天': ['军工', '航天', '航空', '商业航天', '国防'],
  '医药生物': ['医药', '创新药', '中药', '生物', '疫苗', '合成生物'],
  '消费零售': ['消费', '零售', '白酒', '食品', '文娱']
};
async function buildScopeGroups() {
  // 1) 翻页取全部概念板块名
  const bmap = {};
  for (let pn = 1; pn <= 8; pn++) {
    const d = await jgetR(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f12&fs=m:90+t:3&fields=f12,f14`, 15000, 3).catch(() => ({}));
    const diff = (d.data && d.data.diff) || [];
    diff.forEach(b => { bmap[b.f12] = b.f14; });
    if (diff.length < 100) break;
  }
  // 2) 按族关键词归类板块代码
  const groups = {}, names = [];
  for (const [name, kws] of Object.entries(TOPIC_DEFS)) {
    const bks = Object.keys(bmap).filter(code => kws.some(k => String(bmap[code]).includes(k)));
    if (!bks.length) continue;
    const mem = await Promise.all(bks.map(b => boardMembers(b).catch(() => [])));
    const set = {};
    bks.forEach((b, i) => (mem[i] || []).forEach(m => { set[m.f12] = true; }));
    if (Object.keys(set).length) { groups[name] = set; names.push(name + '(' + Object.keys(set).length + ')'); }
  }
  return { groups, names };
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
    const scope = await buildScopeGroups();
    // 把题材归属打到每只涨停票上（第一族）；同时保留行业名做兜底
    pools.forEach(pool => pool.forEach(x => {
      let theme = '';
      Object.keys(scope.groups).forEach(g => { if (!theme && scope.groups[g][x.c]) theme = g; });
      x.theme = theme;
      x.hybk = x.hybk || '其他';
    }));
    best.dragon = buildDragonPool(pools, { scopeGroups: scope.groups });
    best.dragon.topicGroups = scope.names;
    console.log('龙空龙：', JSON.stringify(best.dragon.funnel),
      '主线', (best.dragon.mains || []).map(m => m.name + '(' + m.stocks + ')').join('/') || '无',
      '题材族', scope.names.join(' ') || '无',
      '买点', best.dragon.leaders.map(x => x.name + '/' + x.type + '@' + x.main).join(',') || '无');
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
