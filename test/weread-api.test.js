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
  assert.strictEqual(b.skill_version, '1.0.5');
  assert.strictEqual(b.mode, 'annually');
  assert.strictEqual(b.params, undefined);
});

test('pickError: errcode=0→null；非0→message；纯 upgrade_info→upgrade；带业务数据的 upgrade_info 不拦截', () => {
  assert.strictEqual(api.pickError({ errcode: 0 }), null);
  assert.ok(api.pickError({ errcode: -2012, errmsg: '未登录' }).message);
  assert.ok(api.pickError({ upgrade_info: { message: '请升级' } }).upgrade);
  // 网关在回包带业务数据时仍可能附 upgrade_info，此时应继续用数据，而不是整包丢弃
  assert.strictEqual(api.pickError({ readTimes: {}, upgrade_info: { message: '请升级' } }), null);
  assert.strictEqual(api.pickError({ bookId: 'b1', upgrade_info: { message: '请升级' } }), null);
});

test('nextSkillVersion: 只在 latest_version 真的不同才跳转', () => {
  assert.strictEqual(api.nextSkillVersion('1.0.5', {}), null);
  assert.strictEqual(api.nextSkillVersion('1.0.5', { upgrade_info: {} }), null);
  assert.strictEqual(api.nextSkillVersion('1.0.5', { upgrade_info: { latest_version: '1.0.5' } }), null);
  assert.strictEqual(api.nextSkillVersion('1.0.5', { upgrade_info: { latest_version: '1.0.6' } }), '1.0.6');
  assert.strictEqual(api.nextSkillVersion('1.0.5', { upgrade_info: { latest_version: 123 } }), null);
});

test('hasBusinessPayload: 唯 errcode/upgrade_info 等提示字段 → false', () => {
  assert.strictEqual(api.hasBusinessPayload({ errcode: 0, upgrade_info: { message: 'x' } }), false);
  assert.strictEqual(api.hasBusinessPayload({ readTimes: {} }), true);
  assert.strictEqual(api.hasBusinessPayload({ bookId: 'b1' }), true);
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

test('normalizeReaddataOne: annually → 粒度 month，readTimes 键为 YYYY-MM', () => {
  const n = api.normalizeReaddataOne(annually, 'annually');
  assert.strictEqual(typeof n.seconds, 'number');
  assert.ok(Array.isArray(n.topBooks));
  assert.ok(Array.isArray(n.preference));
  assert.strictEqual(n.granularity, 'month');
  assert.ok(Object.keys(n.readTimes).length > 0);
  assert.ok(/^2025-\d{2}$/.test(Object.keys(n.readTimes)[0]));
});

test('normalizeReaddataOne: weekly → 粒度 day，readTimes 键为 YYYY-MM-DD', () => {
  const n = api.normalizeReaddataOne({ readTimes: { 1767196800: 600 } }, 'weekly');
  assert.strictEqual(n.granularity, 'day');
  assert.ok(Object.keys(n.readTimes)[0].match(/^\d{4}-\d{2}-\d{2}$/));
});

test('assembleStatsBundle: monthBuckets 取 annually，daily 取 monthly>weekly，weekDaily 取 weekly', () => {
  const year = api.normalizeReaddataOne(annually, 'annually');
  const ov = api.normalizeReaddataOne(overall, 'overall');
  const month = api.normalizeReaddataOne({ readTimes: { 1767196800: 600 } }, 'monthly');
  const week = api.normalizeReaddataOne({ readTimes: { 1767196800: 600 }, readDays: 3 }, 'weekly');
  const b = api.assembleStatsBundle({ year, overall: ov, month, week });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.source, 'agent');
  assert.ok(b.totals.year.seconds >= 0);
  assert.ok(Object.keys(b.monthBuckets).length > 0);   // 按月
  assert.ok(Object.keys(b.daily).length > 0);          // 按天（来自 monthly）
  assert.ok(Object.keys(b.weekDaily).length > 0);      // 按天（来自 weekly）
  assert.strictEqual(b.totals.week.readDays, 3);       // 每周期 readDays 进 totals
  assert.strictEqual(b.totals.year.readDays, 116);
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
