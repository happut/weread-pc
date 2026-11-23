const test = require('node:test');
const assert = require('node:assert');
const { computeRange } = require('../shelf-view.js');

//  uniform 100px × 100 行的 tops 前缀和
const uniformTops = Array.from({ length: 101 }, (_, i) => i * 100);

test('computeRange: 顶部', () => {
  const r = computeRange(0, 350, uniformTops, 1);
  assert.strictEqual(r.first, 0);
  assert.strictEqual(r.last, 4); // 可视到第 3 行（300-400）+ overscan 1
});

test('computeRange: 中部带 overscan', () => {
  const r = computeRange(1000, 350, uniformTops, 1);
  assert.strictEqual(r.first, 9);
  assert.strictEqual(r.last, 14);
});

test('computeRange: 底部 clamp', () => {
  const r = computeRange(9700, 350, uniformTops, 1);
  assert.strictEqual(r.last, 99); // 不超过 totalRows-1
});

test('computeRange: 空列表', () => {
  const r = computeRange(0, 350, [0], 1);
  assert.strictEqual(r.first, 0);
  assert.strictEqual(r.last, -1);
});

test('computeRange: 变高行（分区标题 44 + 书行 200）', () => {
  const tops = [0, 44, 244, 444, 644];
  assert.deepStrictEqual(computeRange(0, 300, tops, 0), { first: 0, last: 2 });
  assert.deepStrictEqual(computeRange(44, 200, tops, 0), { first: 1, last: 2 });
  assert.deepStrictEqual(computeRange(600, 300, tops, 1), { first: 2, last: 3 });
});