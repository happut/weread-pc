// settings-view 纯函数单测：外观取值归一
const test = require('node:test');
const assert = require('node:assert');
const SV = require('../settings-view.js');

test('normalizeTheme: 合法值原样返回', () => {
  assert.strictEqual(SV.normalizeTheme('light'), 'light');
  assert.strictEqual(SV.normalizeTheme('dark'), 'dark');
  assert.strictEqual(SV.normalizeTheme('system'), 'system');
});

test('normalizeTheme: 非法/空值回落 system', () => {
  assert.strictEqual(SV.normalizeTheme(null), 'system');
  assert.strictEqual(SV.normalizeTheme(undefined), 'system');
  assert.strictEqual(SV.normalizeTheme(''), 'system');
  assert.strictEqual(SV.normalizeTheme('BLACK'), 'system');
  assert.strictEqual(SV.normalizeTheme(42), 'system');
});
