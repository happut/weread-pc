const test = require('node:test');
const assert = require('node:assert');
const api = require('../weread-api.js');
const annually = require('./fixtures/readdata-annually.json');
const overall = require('./fixtures/readdata-overall.json');
const bookInfo = require('./fixtures/book-info.json');
const bookProgress = require('./fixtures/book-progress.json');
const reviewList = require('./fixtures/review-list.json');

test('buildGatewayBody: api_name+skill_version+参数平铺，不嵌套 params', () => {
  const b = api.buildGatewayBody('/readdata/detail', { mode: 'annually' });
  assert.strictEqual(b.api_name, '/readdata/detail');
  assert.strictEqual(b.skill_version, '1.0.4');
  assert.strictEqual(b.mode, 'annually');
  assert.strictEqual(b.params, undefined);
});

test('pickError: errcode=0→null；非0→message；upgrade_info→upgrade', () => {
  assert.strictEqual(api.pickError({ errcode: 0 }), null);
  assert.ok(api.pickError({ errcode: -2012, errmsg: '未登录' }).message);
  assert.ok(api.pickError({ upgrade_info: { message: '请升级' } }).upgrade);
});

test('toDailyMap: 秒时间戳→YYYY-MM-DD 键，值累加', () => {
  const m = api.toDailyMap({ 1735660800: 600, 1735747200: 1200 });
  assert.strictEqual(Object.values(m).reduce((a, b) => a + b, 0), 1800);
  assert.ok(Object.keys(m).every(k => /^\d{4}-\d{2}-\d{2}$/.test(k)));
});

test('toDailyMap: 毫秒时间戳也识别', () => {
  const m = api.toDailyMap({ 1735660800000: 300 });
  assert.strictEqual(Object.values(m)[0], 300);
});

test('normalizeReaddataOne: 提取 seconds/topBooks/preference/daily', () => {
  const n = api.normalizeReaddataOne(annually);
  assert.strictEqual(typeof n.seconds, 'number');
  assert.ok(Array.isArray(n.topBooks));
  assert.ok(Array.isArray(n.preference));
  assert.strictEqual(typeof n.daily, 'object');
});

test('assembleStatsBundle: 合并 4 周期，daily/topBooks 取先有值者', () => {
  const year = api.normalizeReaddataOne(annually);
  const ov = api.normalizeReaddataOne(overall);
  const b = api.assembleStatsBundle({ year, overall: ov, month: null, week: null });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.source, 'agent');
  assert.ok(b.totals.year.seconds >= 0);
});

test('normalizeBookInfo: newRating→rating，缺字段降级为空串/0', () => {
  const n = api.normalizeBookInfo(bookInfo);
  assert.strictEqual(typeof n.rating, 'number');
  assert.strictEqual(typeof n.title, 'string');
  assert.strictEqual(api.normalizeBookInfo(null).title, '');
});

test('normalizeProgress: book.progress→percent（0-100 整数）', () => {
  const n = api.normalizeProgress(bookProgress);
  assert.ok(n.percent >= 0 && n.percent <= 100);
  assert.strictEqual(api.normalizeProgress(null).percent, 0);
});

test('normalizeReviews: 双层嵌套 reviews[].review.review 拍平', () => {
  const n = api.normalizeReviews(reviewList);
  assert.ok(Array.isArray(n.reviews));
  if (n.reviews.length) {
    assert.strictEqual(typeof n.reviews[0].content, 'string');
    assert.strictEqual(typeof n.reviews[0].star, 'number');
  }
});

test('assembleBookBundle: 三部分合成，myReviews 恒空数组', () => {
  const b = api.assembleBookBundle(
    api.normalizeBookInfo(bookInfo),
    api.normalizeProgress(bookProgress),
    api.normalizeReviews(reviewList)
  );
  assert.strictEqual(b.ok, true);
  assert.deepStrictEqual(b.myReviews, []);
});
