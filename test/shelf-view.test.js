const test = require('node:test');
const assert = require('node:assert');
const { computeRange } = require('../shelf-view.js');

test('computeRange: 顶部', () => {
  // rowHeight=100, viewport=350, totalRows=100, overscan=1
  const r = computeRange(0, 350, 100, 100, 1);
  assert.strictEqual(r.first, 0);            // max(0, floor(0/100)-1)=0
  assert.strictEqual(r.last, 5);             // min(99, ceil(350/100)+1)=min(99,4+1)=5
});

test('computeRange: 中部带 overscan', () => {
  const r = computeRange(1000, 350, 100, 100, 1);
  assert.strictEqual(r.first, 9);            // max(0, floor(1000/100)-1)=9
  assert.strictEqual(r.last, 15);            // min(99, ceil(1350/100)+1)=min(99,14+1)=15
});

test('computeRange: 底部 clamp', () => {
  const r = computeRange(9700, 350, 100, 100, 1);
  assert.strictEqual(r.last, 99);            // 不超过 totalRows-1
});

test('computeRange: 空列表', () => {
  const r = computeRange(0, 350, 100, 0, 1);
  assert.strictEqual(r.first, 0);
  assert.strictEqual(r.last, -1);
});
