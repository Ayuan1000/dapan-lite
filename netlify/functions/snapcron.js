// Netlify Scheduled Function: 预选池快照「定时生成 + 落盘」
//
// 定时注册（Deploy API function_schedules）：
//   { "name": "snapcron", "cron": "45 9 * * 1-5" }
//   cron 按 UTC 解释 → 09:45 UTC = 17:45 Asia/Shanghai（工作日收盘后）
//
// 【为什么单独拆一个函数】
//   Netlify 官方明确：带 schedule 的函数没有公共 HTTP URL，
//   直接访问 /.netlify/functions/snapcron 必然 403。
//   所以职责必须分开：
//     snapcron.js（本文件）带 schedule → 只负责「算 + 写 Blob」
//     snapshot.js                不带 schedule → 只负责「读 Blob / 实时算」
//
// 【执行时长】
//   实测本平台（Free 计划）函数超时上限为 30 秒：
//   sleep 26 秒正常返回，40 秒触发 "Inactivity Timeout" 504。
//   由于走 Deploy API 自定义上传，netlify.toml 的 timeout 配置不保证被解析，
//   所以仍然在代码内部自我约束：
//     - buildSnapshot 内部按预算分段（涨停池 / 题材 / K线），总预算 22 秒
//     - 外面再套一层 26 秒硬闸，超时即返回，不再继续等
//   失败时保留上一次已落盘快照，页面不会空白。
//
// 【时区】
//   函数运行在 UTC，"17:40 闸门"必须显式用 Asia/Shanghai 判断，
//   否则 17:45 CST 触发时会被当成 09:45 而回退到上一交易日。

const { buildSnapshot, targetDate, bjParts } = require('../../lib/core.js');
const { tryConnect, saveSnapshot, loadStored, hdr } = require('../../lib/blobs.js');

// 总预算：buildSnapshot 用 22 秒，外层闸门 26 秒，留 4 秒给冷启动与写 Blob
const BUILD_BUDGET_MS = 22000;
const HARD_LIMIT_MS = 26000;

exports.handler = async (event) => {
  const t0 = Date.now();
  tryConnect(event);
  const now = new Date();
  const bj = bjParts(now);
  const date = targetDate(now);
  const log = {
    fn: 'snapcron', date,
    bjNow: bj.date + ' ' + String(bj.hh).padStart(2, '0') + ':' + String(bj.mm).padStart(2, '0')
  };

  try {
    // 外层硬闸：无论内部发生什么，都不越过 HARD_LIMIT_MS
    const snap = await Promise.race([
      buildSnapshot(date, now, BUILD_BUDGET_MS),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error('hard timeout after ' + HARD_LIMIT_MS + 'ms')), HARD_LIMIT_MS))
    ]);

    const saved = await saveSnapshot(snap);
    log.ok = true;
    log.ms = Date.now() - t0;
    log.buildMs = snap.buildMs;
    log.saved = saved;
    log.ztTotal = snap.ztTotal;
    log.L = snap.L;
    log.hasMain = snap.hasMain;
    log.mainName = snap.mainName;
    log.cand = (snap.cand || []).length;
    log.watch = (snap.watch || []).length;
    log.alerts = (snap.cand || []).filter(x => x.alert && x.alert.ready).length;
    log.warnings = snap.warnings || [];
    console.log('[snapcron] ' + JSON.stringify(log));
    return { statusCode: 200, headers: hdr(), body: JSON.stringify(log) };
  } catch (e) {
    log.ok = false;
    log.ms = Date.now() - t0;
    log.err = String((e && e.message) || e);
    // 失败时回填上一次快照，避免页面完全空白
    try {
      const st = await loadStored();
      if (st) { log.keptPrev = st.date; }
    } catch (e2) { }
    console.error('[snapcron] ' + JSON.stringify(log));
    return { statusCode: 500, headers: hdr(), body: JSON.stringify(log) };
  }
};
