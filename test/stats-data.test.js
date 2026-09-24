const test = require('node:test');
const assert = require('node:assert');
const S = require('../stats-data.js');
const ShelfData = require('../shelf-data.js');
const shelfRaw = require('./fixtures/shelf-sample.json');

const bundle = {
  ok: true, source: 'agent', fetchedAt: 1,
  totals: {
    week:    { seconds: 3600 * 5,    dayAvgSeconds: 1800, compare: 0.2,  readDays: 3 },
    month:   { seconds: 3600 * 40,   dayAvgSeconds: 3600, compare: -0.1, readDays: 20 },
    year:    { seconds: 3600 * 300,  dayAvgSeconds: 3000, compare: null, readDays: 116 },
    overall: { seconds: 3600 * 1000, dayAvgSeconds: 2500, compare: null, readDays: 300 }
  },
  daily: { '2026-01-01': 600, '2026-01-02': 1200, '2026-01-03': 3600, '2026-01-05': 300 },
  weekDaily: { '2026-09-21': 600, '2026-09-24': 3600 },
  monthBuckets: { '2026-01': 36000, '2026-02': 54000, '2026-04': 108000 },
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

test('fmtDur: 含分钟的可读时长', () => {
  assert.strictEqual(S.fmtDur(0), '0m');
  assert.strictEqual(S.fmtDur(600), '10m');
  assert.strictEqual(S.fmtDur(3600), '1h');
  assert.strictEqual(S.fmtDur(5400), '1h30m');
  assert.strictEqual(S.fmtDur(3600 * 300), '300h');
});

test('buildMonthHeat: 最近一年=回溯 12 格，缺失月=0', () => {
  const cells = S.buildMonthHeat(bundle.monthBuckets, 2026, 9);
  assert.strictEqual(cells.length, 12);
  assert.strictEqual(cells[0].key, '2025-10');
  assert.strictEqual(cells[11].key, '2026-09');
  const m1 = cells.find(c => c.key === '2026-01');
  assert.strictEqual(m1.seconds, 36000);
  assert.strictEqual(m1.level, 2);   // 10h <15h
  assert.strictEqual(m1.label, '1');
  assert.strictEqual(m1.text, '10h');
  const m4 = cells.find(c => c.key === '2026-04');
  assert.strictEqual(m4.level, 4);   // 30h ≥30h
  const m3 = cells.find(c => c.key === '2026-03');
  assert.strictEqual(m3.seconds, 0);
  assert.strictEqual(m3.level, 0);
});

test('buildMonthHeat: 不传参=截止当前月，末格 isCurrent 唯一', () => {
  const cells = S.buildMonthHeat(bundle.monthBuckets);
  assert.strictEqual(cells[11].isCurrent, true);
  assert.strictEqual(cells.filter(c => c.isCurrent).length, 1);
});

test('buildDayHeat: 补齐整月（2026-01=31），已知日填值，未知日=0', () => {
  const cells = S.buildDayHeat(bundle.daily, 2026, 1, '2026-01-05');
  assert.strictEqual(cells.length, 31);
  const d1 = cells.find(c => c.key === '2026-01-01');
  assert.strictEqual(d1.seconds, 600);
  assert.strictEqual(d1.level, 1);
  assert.strictEqual(d1.label, '1');
  assert.strictEqual(d1.text, '10m');
  const d9 = cells.find(c => c.key === '2026-01-09');
  assert.strictEqual(d9.seconds, 0);
  assert.strictEqual(d9.level, 0);
  assert.strictEqual(cells.find(c => c.key === '2026-01-05').isCurrent, true);
});

test('buildWeekDays: 周一~周日 7 格，标 isCurrent', () => {
  const daily = { '2026-09-21': 600, '2026-09-24': 3600 };
  const cells = S.buildWeekDays(daily, '2026-09-24');   // 周四
  assert.strictEqual(cells.length, 7);
  assert.strictEqual(cells[0].key, '2026-09-21');       // 周一
  assert.strictEqual(cells[0].label, '一');
  assert.strictEqual(cells[0].seconds, 600);
  assert.strictEqual(cells[0].text, '10m');
  assert.strictEqual(cells[3].text, '1h');
  assert.strictEqual(cells[3].isCurrent, true);
  assert.strictEqual(cells[6].seconds, 0);
});

test('buildMetric: 维度标签/环比文案/读天数/含分钟时长 随 dim', () => {
  const w = S.buildMetric(bundle.totals, 'week');
  assert.strictEqual(w.label, '本周');
  assert.strictEqual(w.compareLabel, '环比上周');
  assert.strictEqual(w.totalText, '5h');
  assert.strictEqual(w.dayAvgText, '30m');
  assert.strictEqual(w.readDays, 3);
  const m = S.buildMetric(bundle.totals, 'month');
  assert.strictEqual(m.compare, -0.1);
  assert.strictEqual(m.readDays, 20);
  const y = S.buildMetric(bundle.totals, 'year');
  assert.strictEqual(y.label, '今年');
  assert.strictEqual(y.totalText, '300h');
  assert.strictEqual(y.compare, null);
  assert.strictEqual(y.readDays, 116);
  assert.strictEqual(S.buildMetric(bundle.totals, 'bogus').label, '本月');   // 非法 dim 归月
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

test('dedupeMedals: 同名合并计数，保首次顺序，空值跳过', () => {
  const d = S.dedupeMedals([
    { title: '21天阅读挑战' }, { title: '21天阅读挑战' }, { title: '世界读书日' },
    { title: '  ' }, null
  ]);
  assert.strictEqual(d.length, 2);
  assert.strictEqual(d[0].title, '21天阅读挑战');
  assert.strictEqual(d[0].count, 2);
  assert.strictEqual(d[1].count, 1);
});

test('buildStatsViewModel: 未连接 → connected=false，三维度 cells 空，③④ 仍退化 shelf', () => {
  const vm = ShelfData.buildViewModel(shelfRaw);
  const s = S.buildStatsViewModel({ ok: false, source: 'none' }, vm, 2026);
  assert.strictEqual(s.connected, false);
  assert.strictEqual(s.cellsByDim.week.length, 0);
  assert.strictEqual(s.cellsByDim.month.length, 0);
  assert.strictEqual(s.cellsByDim.year.length, 0);
  assert.ok(s.topBooks.length > 0);   // 退化 shelf
});

test('buildStatsViewModel: 默认月维度 → metric/cells 对齐，三维度 cells 齐', () => {
  const s = S.buildStatsViewModel(bundle, null, 2026);
  assert.strictEqual(s.connected, true);
  assert.strictEqual(s.dim, 'month');
  assert.strictEqual(s.metric.label, '本月');
  assert.strictEqual(s.metric.totalText, '40h');
  assert.strictEqual(s.cells.length, new Date(2026, s.heatMonth, 0).getDate());
  assert.strictEqual(s.cellsByDim.week.length, 7);
  assert.strictEqual(s.cellsByDim.year.length, 12);
  assert.strictEqual(s.cellsByDim.year[11].isCurrent, true);   // 最近一年末格=当前月
  assert.strictEqual(s.streak.readDays, 116);
  assert.strictEqual(s.medals[0].title, '坚持阅读');
  assert.strictEqual(s.medals[0].count, 1);
});

test('withDim: 切周/年只换 dim/metric/cells，其余字段不变', () => {
  const s = S.buildStatsViewModel(bundle, null, 2026);
  const w = S.withDim(s, 'week');
  assert.strictEqual(w.dim, 'week');
  assert.strictEqual(w.metric.label, '本周');
  assert.strictEqual(w.metric.readDays, 3);
  assert.strictEqual(w.cells.length, 7);
  const y = S.withDim(w, 'year');
  assert.strictEqual(y.dim, 'year');
  assert.strictEqual(y.metric.label, '今年');
  assert.strictEqual(y.cells.length, 12);
  assert.strictEqual(y.streak.readDays, s.streak.readDays);
  assert.strictEqual(S.withDim(y, 'bogus').dim, 'month');
});
