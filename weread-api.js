// weread-api.js — 主进程：微信读书官方 Agent Gateway 客户端 + 回包归一化
// CommonJS（仅主进程 require）。纯函数可单测；gatewayFetch 懒加载 electron net，不在顶层 require。
'use strict';

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const SKILL_VERSION = '1.0.4';

// 参数平铺在顶层（禁止包进 params）
function buildGatewayBody(apiName, params, version) {
  return Object.assign({ api_name: apiName, skill_version: version || SKILL_VERSION }, params || {});
}

// null=正常；{upgrade:message}=需升级 skill_version；{errcode,message}=业务错误
function pickError(json) {
  if (!json || typeof json !== 'object') return { errcode: -1, message: '空回包' };
  if (json.upgrade_info && json.upgrade_info.message) return { upgrade: json.upgrade_info.message };
  const code = typeof json.errcode === 'number' ? json.errcode : 0;
  if (code !== 0) return { errcode: code, message: json.errmsg || json.message || ('errcode ' + code) };
  return null;
}

// 官方时间戳可能秒或毫秒；统一成键 'YYYY-MM-DD'（本地日）→ 秒数（同键累加）
function toDailyMap(dailyReadTimes) {
  const out = {};
  const src = dailyReadTimes || {};
  for (const k of Object.keys(src)) {
    const n = Number(k);
    if (!isFinite(n)) continue;
    const ms = n > 1e12 ? n : n * 1000;   // >1e12 视为毫秒
    const d = new Date(ms);
    const key = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    out[key] = (out[key] || 0) + (Number(src[k]) || 0);
  }
  return out;
}

// 单次 /readdata/detail → 该周期归一化片段
function normalizeReaddataOne(json) {
  const j = json || {};
  const num = (x) => (typeof x === 'number' ? x : 0);
  const topBooks = (Array.isArray(j.readLongest) ? j.readLongest : []).map(it => {
    const b = (it && it.book) || {};
    return { bookId: String(b.bookId || ''), title: b.title || '', cover: b.cover || '', seconds: num(it && it.readTime) };
  }).filter(x => x.bookId);
  const preference = (Array.isArray(j.preferCategory) ? j.preferCategory : []).map(c => ({
    category: (c && c.categoryTitle) || '', seconds: num(c && c.readingTime),
    count: num(c && c.readingCount), val: num(c && c.val)
  })).filter(x => x.category);
  return {
    seconds: num(j.totalReadTime),
    dayAvgSeconds: num(j.dayAverageReadTime),
    compare: typeof j.compare === 'number' ? j.compare : null,
    readDays: num(j.readDays),
    daily: toDailyMap(j.dailyReadTimes),
    topBooks, preference,
    medals: Array.isArray(j.medals) ? j.medals : []
  };
}

// 4 周期片段 → StatsBundle（daily/topBooks/preference/medals 从最先有值的周期取：年>总>月>周）
function assembleStatsBundle(parts) {
  const p = parts || {};
  const modes = ['year', 'overall', 'month', 'week'];
  const mkTotals = (x) => ({
    seconds: (x && x.seconds) || 0,
    dayAvgSeconds: (x && x.dayAvgSeconds) || 0,
    compare: x && typeof x.compare === 'number' ? x.compare : null
  });
  const pickArr = (f) => { for (const m of modes) { const v = p[m] && p[m][f]; if (Array.isArray(v) && v.length) return v; } return []; };
  const pickObj = (f) => { for (const m of modes) { const v = p[m] && p[m][f]; if (v && Object.keys(v).length) return v; } return {}; };
  const pickNum = (f) => { for (const m of modes) { const v = p[m] && p[m][f]; if (typeof v === 'number' && v > 0) return v; } return 0; };
  return {
    ok: true, source: 'agent', fetchedAt: Date.now(),
    totals: { week: mkTotals(p.week), month: mkTotals(p.month), year: mkTotals(p.year), overall: mkTotals(p.overall) },
    daily: pickObj('daily'), readDays: pickNum('readDays'),
    topBooks: pickArr('topBooks'), preference: pickArr('preference'), medals: pickArr('medals')
  };
}

function normalizeBookInfo(json) {
  const j = json || {};
  return {
    bookId: String(j.bookId || ''), title: j.title || '', author: j.author || '',
    translator: j.translator || '', cover: j.cover || '', intro: j.intro || '',
    category: j.category || '', publisher: j.publisher || '', publishTime: j.publishTime || '',
    isbn: j.isbn || '', wordCount: typeof j.wordCount === 'number' ? j.wordCount : 0,
    rating: typeof j.newRating === 'number' ? j.newRating : 0,          // 百分制
    ratingCount: typeof j.newRatingCount === 'number' ? j.newRatingCount : 0,
    deepLink: j.deepLink || ''
  };
}

function normalizeProgress(json) {
  const b = (json && json.book) || {};
  return {
    percent: typeof b.progress === 'number' ? b.progress : 0,           // 0-100 整数，1=1%
    seconds: typeof b.recordReadingTime === 'number' ? b.recordReadingTime : 0,
    lastReadAt: typeof b.updateTime === 'number' ? b.updateTime : 0,
    finishTime: typeof b.finishTime === 'number' ? b.finishTime : 0,
    started: !!b.isStartReading
  };
}

function normalizeReviews(json) {
  const j = json || {};
  const list = Array.isArray(j.reviews) ? j.reviews : [];
  const reviews = list.map(w => {
    const r = (w && w.review && w.review.review) || {};   // 双层嵌套
    const a = r.author || {};
    return {
      reviewId: String(r.reviewId || ''), content: r.content || '',
      star: typeof r.star === 'number' ? r.star : 0,      // 20/40/60/80/100
      authorName: a.name || '', authorAvatar: a.avatar || '',
      createTime: typeof r.createTime === 'number' ? r.createTime : 0
    };
  }).filter(x => x.content || x.reviewId);
  return {
    count: typeof j.reviewsCnt === 'number' ? j.reviewsCnt : reviews.length,
    recommendValue: typeof j.deepVRecommendValue === 'number' ? j.deepVRecommendValue : 0, // 862=86.2%
    reviews
  };
}

function assembleBookBundle(info, progress, reviews) {
  return {
    ok: true, source: 'agent', fetchedAt: Date.now(),
    info: info || {}, progress: progress || {},
    communityReviews: (reviews && reviews.reviews) || [],
    reviewsMeta: { count: (reviews && reviews.count) || 0, recommendValue: (reviews && reviews.recommendValue) || 0 },
    myReviews: []
  };
}

// ---- 网络（不写单测）----
async function gatewayFetch(key, apiName, params) {
  const { net } = require('electron');   // 懒加载：主进程运行时才有
  const res = await net.fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGatewayBody(apiName, params))
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  const err = pickError(json);
  if (err) { const e = new Error(err.upgrade ? ('需升级: ' + err.upgrade) : (err.message || 'gateway error')); e.detail = err; throw e; }
  return json;
}

async function fetchStatsBundle(key) {
  const modes = { week: 'weekly', month: 'monthly', year: 'annually', overall: 'overall' };
  const parts = {};
  for (const k of Object.keys(modes)) {
    try { parts[k] = normalizeReaddataOne(await gatewayFetch(key, '/readdata/detail', { mode: modes[k] })); }
    catch (_) { parts[k] = null; }   // 单周期失败不拖垮整体
  }
  if (!parts.week && !parts.month && !parts.year && !parts.overall) throw new Error('readdata 全部失败');
  return assembleStatsBundle(parts);
}

async function fetchBookBundle(key, bookId) {
  const [info, progress, reviews] = await Promise.all([
    gatewayFetch(key, '/book/info', { bookId }).then(normalizeBookInfo).catch(() => null),
    gatewayFetch(key, '/book/getprogress', { bookId }).then(normalizeProgress).catch(() => null),
    gatewayFetch(key, '/review/list', { bookId, reviewListType: 1, count: 10 }).then(normalizeReviews).catch(() => null)
  ]);
  if (!info && !progress && !reviews) throw new Error('book 全部失败');
  return assembleBookBundle(info, progress, reviews);
}

module.exports = {
  GATEWAY, SKILL_VERSION,
  buildGatewayBody, pickError, toDailyMap,
  normalizeReaddataOne, assembleStatsBundle,
  normalizeBookInfo, normalizeProgress, normalizeReviews, assembleBookBundle,
  gatewayFetch, fetchStatsBundle, fetchBookBundle
};
