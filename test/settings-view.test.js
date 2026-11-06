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

test('normalizeRtInterval: 合法分钟值原样，越界夹到 5–240', () => {
  assert.strictEqual(SV.normalizeRtInterval('30'), 30);
  assert.strictEqual(SV.normalizeRtInterval(60), 60);
  assert.strictEqual(SV.normalizeRtInterval('1'), 5);
  assert.strictEqual(SV.normalizeRtInterval('999'), 240);
});

test('normalizeRtInterval: 非法/空值回落 30', () => {
  assert.strictEqual(SV.normalizeRtInterval(null), 30);
  assert.strictEqual(SV.normalizeRtInterval(undefined), 30);
  assert.strictEqual(SV.normalizeRtInterval(''), 30);
  assert.strictEqual(SV.normalizeRtInterval('abc'), 30);
});
