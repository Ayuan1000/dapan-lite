// Netlify Function: 东财涨停/炸板/跌停池 代理兜底
// 用途：当浏览器直连 push2ex.eastmoney.com 被限流(rc=102)时，经由 Netlify 出口转发。
// 用法: /.netlify/functions/pool?date=20260909&kind=ZT|ZB|DT|YZ|YB
// kind: ZT今日涨停 ZB今日炸板 DT今日跌停 YZ昨日涨停 YB昨日炸板 (YZ/YB 时 date 为昨日)
const UT = '7eea3edcaed734bea9cbfc24409ed989';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

let cache = { t: 0, key: '', body: null };

async function grab(kind, date) {
  const api = kind === 'ZB' ? 'getTopicZBPool' : kind === 'DT' ? 'getTopicDTPool' : 'getTopicZTPool';
  const url = `https://push2ex.eastmoney.com/${api}?ut=${UT}&dpt=wz.ztzt&Pageindex=0&pagesize=400&sort=fbt:asc&date=${date}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), kind === 'DT' ? 12000 : 8000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const date = q.date || '';
  const kind = (q.kind || 'ZT').toUpperCase();
  if (!/^\d{8}$/.test(date)) return { statusCode: 400, body: 'bad date' };
  const key = kind + date;
  const now = Date.now();
  if (cache.key === key && now - cache.t < 15000 && cache.body) {
    return { statusCode: 200, headers: hdr(), body: cache.body };
  }
  try {
    const d = await grab(kind, date);
    const body = JSON.stringify(d);
    if (d && d.rc === 0 && d.data) { cache = { t: now, key, body }; }
    return { statusCode: 200, headers: hdr(), body };
  } catch (e) {
    return { statusCode: 502, headers: hdr(), body: JSON.stringify({ rc: -1, msg: String(e && e.message || e) }) };
  }
};
function hdr() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    // 防 CDN 陈旧：涨停池必须实时
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0'
  };
}
