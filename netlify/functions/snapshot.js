// Netlify Function: 预选池快照「HTTP 读取端点」（普通函数，可被前端直接访问）
//
// /.netlify/functions/snapshot               → 按北京时间 17:40 闸门选目标交易日：优先读已落盘快照，没有则实时算
// /.netlify/functions/snapshot?stored=1      → 强制只读已落盘快照（最快，页面首选）
// /.netlify/functions/snapshot?date=YYYYMMDD → 读该日快照；没有则实时算该日并尝试补写
//
// 【重要】本函数「不能」带 schedule：
//   Netlify scheduled function 没有公共 HTTP URL，带 schedule 直连必 403。
//   定时任务由 snapcron.js 承担（见 netlify.toml / tools/deploy.py 的 function_schedules）。
//
// 【数据流】
//   snapcron.js（定时 17:45 CST）→ buildSnapshot → 写 Blob
//                                  ↓
//   snapshot.js（本函数，前端调用）→ 读 Blob（毫秒级）→ 无快照时降级实时计算
//
// 【时区】
//   函数运行在 UTC，"17:40 闸门"必须显式用 Asia/Shanghai（lib/core.js 的 bjParts）。

const { buildSnapshot, targetDate, bjParts } = require('../../lib/core.js');
const { tryConnect, saveSnapshot, loadStored, loadByDate, hdr } = require('../../lib/blobs.js');

// 实时计算的预算：buildSnapshot 默认 22 秒，这里给 24 秒上限，
// 仍小于平台实测的 30 秒超时上限，留 6 秒给冷启动与 Blob 落盘。
const BUILD_BUDGET_MS = 24000;

exports.handler = async (event) => {
  tryConnect(event);
  const q = event.queryStringParameters || {};
  const now = new Date();
  const bj = bjParts(now);
  const bjNow = bj.date + ' ' + String(bj.hh).padStart(2, '0') + ':' + String(bj.mm).padStart(2, '0');

  try {
    // ---- 强制实时重算（代码更新后清掉旧快照的逃生口）----
    // ?refresh=1：忽略已落盘快照，重新抓取并覆盖写入。
    // 场景：改了核心算法后，Blob 里仍是旧逻辑的降级快照，需要立即重算。
    if (q.refresh === '1' || q.refresh === 'true') {
      const date = q.date || targetDate(now);
      const snap = await buildSnapshot(date, now, BUILD_BUDGET_MS);
      let saved = 0, saveErr = '';
      try { saved = await saveSnapshot(snap); } catch (e) { saveErr = String((e && e.message) || e); }
      snap.saved = saved;
      if (saveErr) snap.saveErr = saveErr;
      snap.bjNow = bjNow;
      snap.live = true;
      snap.refreshed = true;
      return { statusCode: 200, headers: hdr(), body: JSON.stringify(snap) };
    }

    // ---- 显式只读快照 ----
    if (q.stored === '1' || q.stored === 'true') {
      const st = await loadStored();
      if (st && st.rc === 0) {
        return { statusCode: 200, headers: hdr(), body: JSON.stringify(st) };
      }
      return { statusCode: 404, headers: hdr(), body: JSON.stringify({ rc: -1, msg: 'no stored snapshot yet' }) };
    }

    // ---- 指定日期：先查该日归档快照 ----
    if (q.date) {
      const byDate = await loadByDate(q.date);
      if (byDate && byDate.rc === 0) {
        byDate.bjNow = bjNow;
        return { statusCode: 200, headers: hdr(), body: JSON.stringify(byDate) };
      }
    }

    // ---- 默认：闸门选目标交易日，优先用已落盘快照 ----
    const date = q.date || targetDate(now);
    const st = await loadStored();
    if (st && st.rc === 0 && st.date === date) {
      st.bjNow = bjNow;
      return { statusCode: 200, headers: hdr(), body: JSON.stringify(st) };
    }

    // ---- 快照缺失或不是目标日 → 实时计算 ----
    const snap = await buildSnapshot(date, now, BUILD_BUDGET_MS);
    let saved = 0, saveErr = '';
    try {
      saved = await saveSnapshot(snap);
    } catch (e) {
      saveErr = String((e && e.message) || e);
    }
    snap.saved = saved;
    if (saveErr) snap.saveErr = saveErr;
    snap.bjNow = bjNow;
    snap.live = true;
    return { statusCode: 200, headers: hdr(), body: JSON.stringify(snap) };

  } catch (e) {
    // 实时抓取失败 → 兜底返回已落盘快照，保证页面有数据可看
    try {
      const st = await loadStored();
      if (st && st.rc === 0) {
        st.stale = true;
        st.staleMsg = String((e && e.message) || e);
        st.bjNow = bjNow;
        // 明确标注兜底快照的日期，避免前端把旧数据误认为目标交易日的数据
        st.staleDate = st.date;
        st.requestedDate = q.date || targetDate(now);
        return { statusCode: 200, headers: hdr(), body: JSON.stringify(st) };
      }
    } catch (e2) { }
    return { statusCode: 502, headers: hdr(), body: JSON.stringify({ rc: -1, msg: String((e && e.message) || e) }) };
  }
};
