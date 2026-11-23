const test = require('node:test');
const assert = require('node:assert');
const raw = require('./fixtures/shelf-sample.json');
const { buildViewModel } = require('../shelf-data.js');

test('stats: 在读/读完/累计小时', () => {
  const vm = buildViewModel(raw);
  assert.strictEqual(vm.stats.reading, 1);    // 只有 b1（progress 40，未读完）
  assert.strictEqual(vm.stats.finished, 1);   // b2（finishReading=1 且 progress=100）
  assert.strictEqual(vm.stats.totalHours, 3); // (3600+7200+0)/3600 = 3
});

test('continueReading: 有进度者按 progress.updateTime 倒序', () => {
  const vm = buildViewModel(raw);
  assert.deepStrictEqual(vm.continueReading.map(b => b.bookId), ['b1', 'b2', 'b4']);
});

test('allBooks: 有 readUpdateTime 者在前并按其倒序，其余按 updateTime 倒序殿后', () => {
  const vm = buildViewModel(raw);
  assert.deepStrictEqual(vm.allBooks.map(b => b.bookId), ['b1', 'b2', 'b3', 'b4']);
});

test('toBookVM: 缺 cover 也不报错，progress 默认 0', () => {
  const vm = buildViewModel(raw);
  const b3 = vm.allBooks.find(b => b.bookId === 'b3');
  assert.strictEqual(b3.cover, '');
  assert.strictEqual(b3.progress, 0);
});

test('readerUrl: 从 deepLink 的 v 参数拼出 /web/reader/<v>', () => {
  const vm = buildViewModel(raw);
  const b1 = vm.allBooks.find(b => b.bookId === 'b1');
  assert.strictEqual(b1.readerUrl, 'https://weread.qq.com/web/reader/1');
});

test('toBookVM: 携带 readingTime（④退化）与 category（③退化）', () => {
  const vm = buildViewModel(raw);
  const b1 = vm.allBooks.find(b => b.bookId === 'b1');
  assert.strictEqual(b1.readingTime, 3600); // bookProgress b1.readingTime
  assert.strictEqual(b1.category, '');      // fixture 无 category → 空串不报错
});

test('finished: finishReading=1 或 progress>=100 视为读完', () => {
  const vm = buildViewModel(raw);
  assert.strictEqual(vm.allBooks.find(b => b.bookId === 'b2').finished, true);
  assert.strictEqual(vm.allBooks.find(b => b.bookId === 'b1').finished, false);
  assert.strictEqual(vm.allBooks.find(b => b.bookId === 'b3').finished, false);
  const { toBookVM } = require('../shelf-data.js');
  // 仅标记读完、进度未到 100
  assert.strictEqual(toBookVM({ bookId: 'x', finishReading: 1 }, { progress: 80 }).finished, true);
  // 未标记但进度到 100
  assert.strictEqual(toBookVM({ bookId: 'y', finishReading: 0 }, { progress: 100 }).finished, true);
  // 无进度记录
  assert.strictEqual(toBookVM({ bookId: 'z' }, null).finished, false);
});

test('filterByStatus: all/reading/finished 三态筛选', () => {
  const { filterByStatus } = require('../shelf-data.js');
  const vm = buildViewModel(raw);
  assert.strictEqual(filterByStatus(vm.allBooks, 'all').length, 4);
  // b1 progress 40 未读完；b4 progress 0、b3 无进度 → 都不算在读
  assert.deepStrictEqual(filterByStatus(vm.allBooks, 'reading').map(b => b.bookId), ['b1']);
  assert.deepStrictEqual(filterByStatus(vm.allBooks, 'finished').map(b => b.bookId), ['b2']);
  assert.deepStrictEqual(filterByStatus(null, 'finished'), []);
  assert.deepStrictEqual(filterByStatus(vm.allBooks, 'bogus').length, 4);
});

test('filterBooks: 按书名/作者子串过滤，大小写不敏感', () => {
  const { filterBooks } = require('../shelf-data.js');
  const books = [
    { title: 'JavaScript 高级程序设计', author: 'Matt Frisbie' },
    { title: '深入理解计算机系统', author: 'Randal E. Bryant' },
    { title: 'SICP', author: 'harold abelson' }
  ];
  assert.strictEqual(filterBooks(books, 'javascript').length, 1);
  assert.strictEqual(filterBooks(books, 'bryant')[0].title, '深入理解计算机系统');
  assert.strictEqual(filterBooks(books, 'HAROLD')[0].title, 'SICP');
  assert.strictEqual(filterBooks(books, '  ').length, 3);
  assert.strictEqual(filterBooks(books, '不存在的书').length, 0);
  assert.deepStrictEqual(filterBooks(null, 'x'), []);
});
