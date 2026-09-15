const test = require('node:test');
const assert = require('node:assert');
const { resolveAuth, maskKey } = require('../weread-auth.js');

test('resolveAuth: 手动 Key 非空 → 最高优先（覆盖自动）', () => {
  const r = resolveAuth({ manualKey: 'wrk-manual', autoKey: 'wrk-auto', manualCookie: 'wr_vid=1' });
  assert.strictEqual(r.mode, 'key');
  assert.strictEqual(r.key, 'wrk-manual');
  assert.strictEqual(r.source, 'manual');
});

test('resolveAuth: 无手动 Key、自动 Key 有效 → 用自动', () => {
  const r = resolveAuth({ manualKey: '', autoKey: 'wrk-auto', manualCookie: '' });
  assert.strictEqual(r.mode, 'key');
  assert.strictEqual(r.key, 'wrk-auto');
  assert.strictEqual(r.source, 'auto');
});

test('resolveAuth: 无 Key、有手动 cookie → cookie 模式', () => {
  const r = resolveAuth({ manualKey: '', autoKey: '', manualCookie: 'wr_vid=1; wr_skey=x' });
  assert.strictEqual(r.mode, 'cookie');
  assert.strictEqual(r.source, 'manual');
});

test('resolveAuth: 全空 → webview 同源兜底', () => {
  const r = resolveAuth({ manualKey: '', autoKey: '', manualCookie: '' });
  assert.strictEqual(r.mode, 'webview');
});

test('resolveAuth: autoKey 失效标记 → 跳过自动，落到 cookie', () => {
  const r = resolveAuth({ manualKey: '', autoKey: 'wrk-auto', autoKeyInvalid: true, manualCookie: 'wr_vid=1' });
  assert.strictEqual(r.mode, 'cookie');
});

test('resolveAuth: 入参缺失不抛错', () => {
  assert.strictEqual(resolveAuth().mode, 'webview');
  assert.strictEqual(resolveAuth(null).mode, 'webview');
});

test('maskKey: wrk- 前缀保留 + 尾 4 位，中间掩码', () => {
  assert.strictEqual(maskKey('wrk-a3f2b1c9d8e7'), 'wrk-••••d8e7');
});

test('maskKey: 空/短值安全', () => {
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey(null), '');
  assert.strictEqual(maskKey('abc'), '••••');
});
