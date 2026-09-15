const test = require('node:test');
const assert = require('node:assert');
const S = require('../stats-data.js');
const ShelfData = require('../shelf-data.js');
const shelfRaw = require('./fixtures/shelf-sample.json');

const bundle = {
  ok: true, source: 'agent', fetchedAt: 1,
  totals: {
    week:    { seconds: 3600 * 5,    dayAvgSeconds: 1800, compare: 0.2 },
    month:   { seconds: 3600 * 40,   dayAvgSeconds: 3600, compare: -0.1 },
    year:    { seconds: 3600 * 300,  dayAvgSeconds: 3000, compare: null },
    overall: { seconds: 3600 * 1000, dayAvgSeconds: 2500, compare: null }
  },
  daily: { '2026-01-01': 600, '2026-01-02': 1200, '2026-01-03': 3600, '2026-01-05': 300 },
  readDays: 116,
  topBooks: [
    { bookId: 'x1', title: '书A', cover: 'c1', seconds: 3600 * 10 },
    { bookId: 'x2', title: '书B', cover: 'c2', seconds: 3600 * 6 }
  ],
  preference: [
    { category: '文学', seconds: 3600 * 20, count: 5, val: 1 },
    { category: '历史', seconds: 3600 * 10, count: 3, val: 0.5 }
  ],
  medals: [{ title: '坚持阅读' }]
};

test('levelOf: 分档 0/1/2/3/4', () => {
  assert.strictEqual(S.levelOf(0), 0);
  assert.strictEqual(S.levelOf(600), 1);   // <15min
  assert.strictEqual(S.levelOf(1200), 2);  // <30min
  assert.strictEqual(S.levelOf(2400), 3);  // <60min
  assert.strictEqual(S.levelOf(3600), 4);  // ≥60min
});

test('buildHeatmap: 补齐整年（2026=365），已知日填 seconds+level，未知日=0', () => {
  const cells = S.buildHeatmap(bundle.daily, 2026);
  assert.strictEqual(cells.length, 365);
  const d1 = cells.find(c => c.day === '2026-01-01');
  assert.strictEqual(d1.seconds, 600);
  assert.strictEqual(d1.level, 1);
  const d9 = cells.find(c => c.day === '2026-09-09');
  assert.strictEqual(d9.seconds, 0);
  assert.strictEqual(d9.level, 0);
});

test('buildDurations: 秒→小时（年/月/周/总）', () => {
  const d = S.buildDurations(bundle.totals);
  assert.strictEqual(d.week.hours, 5);
  assert.strictEqual(d.overall.hours, 1000);
  assert.strictEqual(d.month.dayAvgHours, 1);
  assert.strictEqual(d.week.compare, 0.2);
});

test('buildPreference: 占比降序，四舍五入', () => {
  const p = S.buildPreference(bundle.preference);
  assert.strictEqual(p[0].category, '文学');
  assert.strictEqual(p[0].percent, 67);   // 20/(20+10)=66.7→67
});

test('buildTopBooks: Agent 优先，前5，秒→小时', () => {
  const t = S.buildTopBooks(bundle.topBooks);
  assert.strictEqual(t[0].title, '书A');
  assert.strictEqual(t[0].hours, 10);
});

test('buildTopBooks: Agent 空 → 退化 shelf readingTime 降序', () => {
  const vm = ShelfData.buildViewModel(shelfRaw);
  const t = S.buildTopBooks([], vm);
  assert.strictEqual(t[0].bookId, 'b2');  // readingTime 7200 > b1 3600
  assert.strictEqual(t[0].hours, 2);
});

test('buildStreak: today 已打卡 → 当前连续回数', () => {
  const daily = { '2026-01-01': 600, '2026-01-02': 600, '2026-01-03': 600 };
  const s = S.buildStreak(daily, 3, '2026-01-03');
  assert.strictEqual(s.current, 3);
  assert.strictEqual(s.longest, 3);
});

test('buildStreak: today 未打卡 → 从昨天回数', () => {
  const daily = { '2026-01-01': 600, '2026-01-02': 600 };
  const s = S.buildStreak(daily, 2, '2026-01-03');
  assert.strictEqual(s.current, 2);
});

test('buildStreak: 中断 → longest 取历史最长', () => {
  const daily = { '2026-01-01': 600, '2026-01-02': 600, '2026-01-04': 600, '2026-01-05': 600, '2026-01-06': 600 };
  const s = S.buildStreak(daily, 5, '2026-01-06');
  assert.strictEqual(s.longest, 3);   // 1/4-1/6
  assert.strictEqual(s.current, 3);
});

test('buildStatsViewModel: 未连接 → connected=false，③④ 仍退化 shelf', () => {
  const vm = ShelfData.buildViewModel(shelfRaw);
  const s = S.buildStatsViewModel({ ok: false, source: 'none' }, vm, 2026);
  assert.strictEqual(s.connected, false);
  assert.strictEqual(s.heatmap.length, 0);
  assert.ok(s.topBooks.length > 0);   // 退化 shelf
});

test('buildStatsViewModel: 已连接 → 全模块有值', () => {
  const s = S.buildStatsViewModel(bundle, null, 2026);
  assert.strictEqual(s.connected, true);
  assert.strictEqual(s.heatmap.length, 365);
  assert.ok(s.durations.year.hours > 0);
  assert.strictEqual(s.streak.readDays, 116);
});
