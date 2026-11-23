// Netlify Function: 大盘环境数据（三层滤网第1层用） v2
// /.netlify/functions/idx
// 返回: 上证MA20、上证昨收、两市(沪000001+深综399106)昨日成交额(元)、昨日期
const UT = 'fa5fd1943c7b386f172d6893dbfba10b';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';

let cache = { t: 0, body: null };

async function kline(secid) {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&end=20500101&lmt=30&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&ut=${UT}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = await r.json();
    const ks = (d.data && d.data.klines) || [];
    return ks.map(s => { const f = s.split(','); return { date: f[0], close: +f[2], amt: +f[6] }; });
  } finally { clearTimeout(timer); }
}

function bjToday() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()).replace(/-/g, '');
}

exports.handler = async () => {
  const now = Date.now();
  if (cache.body && now - cache.t < 60000) return { statusCode: 200, headers: hdr(), body: cache.body };
  try {
    const [sh, sz] = await Promise.all([kline('1.000001'), kline('0.399106')]);
    const today = bjToday();
    const split = arr => {
      let lastIdx = arr.length - 1;
      if (arr.length && arr[lastIdx].date === today) lastIdx -= 1; // 最后一根是今日(盘中/盘后)，昨日取前一根
      return { pre: arr[lastIdx], prevClose: arr[lastIdx] ? arr[lastIdx].close : null };
    };
    const shS = split(sh), szS = split(sz);
    // MA20：含今日实时bar（与行情软件一致）
    const closes = sh.slice(-20).map(k => k.close);
    const ma20 = closes.length >= 20 ? closes.reduce((a, b) => a + b, 0) / 20 : null;
    const preAmt = (shS.pre ? shS.pre.amt : 0) + (szS.pre ? szS.pre.amt : 0);
    const body = JSON.stringify({
      rc: 0,
      ma20: ma20 ? +ma20.toFixed(2) : null,
      shPrevClose: shS.prevClose,
      shPreDate: shS.pre ? shS.pre.date : '',
      preAmt, // 两市昨日成交额(元)
      shTodayAmt: sh.length && sh[sh.length - 1].date === today ? sh[sh.length - 1].amt : null
    });
    cache = { t: now, body };
    return { statusCode: 200, headers: hdr(), body };
  } catch (e) {
    return { statusCode: 502, headers: hdr(), body: JSON.stringify({ rc: -1, msg: String(e && e.message || e) }) };
  }
};
function hdr() {
  return { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
}
