// Netlify Blobs 存取层（snapshot.js / snapcron.js 共用）
//
// 存储布局（site store 名 "prepool"）：
//   latest.json          最新一次成功快照（页面默认读这个）
//   daily/{YYYYMMDD}.json 按日期归档，便于回溯
//
// 为什么单独成文件：
//   Netlify scheduled function 一旦带 schedule 就没有公共 HTTP URL（直连必 403），
//   所以必须拆成两个函数：
//     snapcron.js  带 schedule，只负责「算 + 写」
//     snapshot.js  不带 schedule，只负责「读」
//   两者共用本模块，保证键名与序列化格式一致。

const { getStore, connectLambda } = require('@netlify/blobs');

const STORE = 'prepool';
const KEY_LATEST = 'latest.json';
const KEY_BY_DATE = 'daily';

/* Blobs 在 Lambda 运行时通过 event.blobs + event.headers 注入上下文。
   定时任务与 HTTP 函数都能拿到 event；拿不到时静默跳过（走实时计算）。 */
function tryConnect(event) {
  try {
    if (event && event.blobs && event.headers) connectLambda(event);
  } catch (e) { /* 未注入则忽略 */ }
}

async function saveSnapshot(obj) {
  const store = getStore(STORE);
  const body = JSON.stringify(obj);
  // 最新快照（页面默认读这个）
  await store.set(KEY_LATEST, body, { contentType: 'application/json' });
  // 按日期归档
  try {
    await store.set(KEY_BY_DATE + '/' + obj.date + '.json', body, { contentType: 'application/json' });
  } catch (e) { /* 归档失败不影响主快照 */ }
  return body.length;
}

async function loadStored() {
  try {
    const store = getStore(STORE);
    // 注意：SDK 的 store.get(key, {type:'json'}) 返回的是「裸 JSON」，
    // 不是 { data: ... } 信封。解构 data 会得到 undefined，
    // 于是永远走不到「已落盘快照」分支（表现为 stored=1 恒 404）。
    const data = await store.get(KEY_LATEST, { type: 'json' });
    return data || null;
  } catch (e) { return null; }
}

async function loadByDate(date) {
  try {
    const store = getStore(STORE);
    const data = await store.get(KEY_BY_DATE + '/' + date + '.json', { type: 'json' });
    return data || null;
  } catch (e) { return null; }
}

function hdr() {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    'Pragma': 'no-cache', 'Expires': '0'
  };
}

module.exports = { STORE, KEY_LATEST, KEY_BY_DATE, tryConnect, saveSnapshot, loadStored, loadByDate, hdr };
