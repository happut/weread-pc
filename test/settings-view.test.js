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

test('wrThemeFor: 应用外观 → 阅读器 wr_theme（white/dark）', () => {
  assert.strictEqual(SV.wrThemeFor('dark', false), 'dark');
  assert.strictEqual(SV.wrThemeFor('dark', true), 'dark');
  assert.strictEqual(SV.wrThemeFor('light', true), 'white');
  assert.strictEqual(SV.wrThemeFor('light', false), 'white');
  assert.strictEqual(SV.wrThemeFor('system', true), 'dark');
  assert.strictEqual(SV.wrThemeFor('system', false), 'white');
  assert.strictEqual(SV.wrThemeFor('bogus', true), 'dark');   // 归一为 system
});
