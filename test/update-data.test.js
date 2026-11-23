const test = require('node:test');
const assert = require('node:assert');
const { compareVersions, pickAsset } = require('../update-data.js');

test('compareVersions: 按数字段比较，v 前缀忽略，缺段补 0', () => {
  assert.strictEqual(compareVersions('0.9.1', '0.9.2'), -1);
  assert.strictEqual(compareVersions('0.9.2', '0.9.1'), 1);
  assert.strictEqual(compareVersions('v0.9.1', '0.9.1'), 0);
  assert.strictEqual(compareVersions('0.9', '0.9.0'), 0);
  assert.strictEqual(compareVersions('v0.10.0', '0.9.1'), 1); // 数字比较而非字典序
  assert.strictEqual(compareVersions('1.0.0', '0.99.99'), 1);
});

const assets = [
  { name: 'WeRead-PC-linux-x64-0.9.2.zip', size: 1, browser_download_url: 'u-linux' },
  { name: 'WeRead-PC-macOS-arm64-0.9.2.zip', size: 2, browser_download_url: 'u-arm64' },
  { name: 'WeRead-PC-macOS-x64-0.9.2.zip', size: 3, browser_download_url: 'u-x64' },
  { name: 'WeRead-PC-win32-x64-0.9.2.zip', size: 4, browser_download_url: 'u-win' }
];

test('pickAsset: darwin 映射 macOS，按平台+架构选 zip', () => {
  assert.strictEqual(pickAsset(assets, 'darwin', 'arm64').browser_download_url, 'u-arm64');
  assert.strictEqual(pickAsset(assets, 'darwin', 'x64').browser_download_url, 'u-x64');
  assert.strictEqual(pickAsset(assets, 'win32', 'x64').browser_download_url, 'u-win');
  assert.strictEqual(pickAsset(assets, 'linux', 'x64').browser_download_url, 'u-linux');
});

test('pickAsset: 无匹配/空列表返回 null', () => {
  assert.strictEqual(pickAsset(assets, 'darwin', 'ia32'), null);
  assert.strictEqual(pickAsset([], 'darwin', 'arm64'), null);
  assert.strictEqual(pickAsset(null, 'darwin', 'arm64'), null);
});
