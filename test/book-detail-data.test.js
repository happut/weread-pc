const test = require('node:test');
const assert = require('node:assert');
const D = require('../book-detail-data.js');
const api = require('../weread-api.js');
const bookInfo = require('./fixtures/book-info.json');
const bookProgress = require('./fixtures/book-progress.json');
const reviewList = require('./fixtures/review-list.json');

const bundle = {
  ok: true, source: 'agent', fetchedAt: 1,
  info: { bookId:'b1', title:'书一', author:'甲', translator:'', cover:'c', intro:'简介',
          category:'文学', publisher:'某社', publishTime:'2020', isbn:'123', wordCount:250000, rating:85, ratingCount:1200 },
  progress: { percent:45, seconds:3600*8, lastReadAt:1735660800, finishTime:0, started:true },
  communityReviews: [ { reviewId:'r1', content:'很好看', star:100, authorName:'读者A', authorAvatar:'a', createTime:1735660800 } ],
  reviewsMeta: { count: 2337, recommendValue: 862 },
  myReviews: []
};

test('starOf: 20..100 → 1..5', () => {
  assert.strictEqual(D.starOf(100), 5);
  assert.strictEqual(D.starOf(60), 3);
  assert.strictEqual(D.starOf(0), 0);
});

test('formatDate: 秒/毫秒时间戳 → YYYY-MM-DD（一致）', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(D.formatDate(1735660800)));
  assert.strictEqual(D.formatDate(1735660800), D.formatDate(1735660800000));
  assert.strictEqual(D.formatDate(0), '');
});

test('formatWordCount: ≥1万→万字，否则→字', () => {
  assert.strictEqual(D.formatWordCount(250000), '25万字');
  assert.strictEqual(D.formatWordCount(8000), '8000字');
});

test('buildMetaRows: 有值才列，空字段跳过', () => {
  const rows = D.buildMetaRows(bundle.info);
  assert.strictEqual(rows.find(r => r.k === 'ISBN').v, '123');
  assert.strictEqual(rows.find(r => r.k === '字数').v, '25万字');
  assert.strictEqual(rows.find(r => r.k === '译者'), undefined);
});

test('buildDetailViewModel: 形状完整，star/recommend 换算', () => {
  const vm = D.buildDetailViewModel(bundle);
  assert.strictEqual(vm.title, '书一');
  assert.strictEqual(vm.rating, 85);
  assert.strictEqual(vm.bookStats.hours, 8);
  assert.strictEqual(vm.bookStats.progress, 45);
  assert.strictEqual(vm.communityReviews[0].star, 5);
  assert.strictEqual(vm.recommendPercent, 86);   // 862→86
});

test('buildDetailViewModel: 未连接 → connected=false，不报错', () => {
  const vm = D.buildDetailViewModel({ ok:false, source:'none' });
  assert.strictEqual(vm.connected, false);
  assert.deepStrictEqual(vm.communityReviews, []);
  assert.deepStrictEqual(vm.metaRows, []);
});

test('buildDetailViewModel: 真实 fixture 归一化后仍可构建', () => {
  const b = api.assembleBookBundle(api.normalizeBookInfo(bookInfo), api.normalizeProgress(bookProgress), api.normalizeReviews(reviewList));
  const vm = D.buildDetailViewModel(b);
  assert.strictEqual(typeof vm.title, 'string');
  assert.ok(Array.isArray(vm.metaRows));
});
