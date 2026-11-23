// update-data.js — 更新检查纯函数：版本比较 / release 资产选择（node 侧，可单测）
'use strict';

function segs(v) {
  return String(v || '').replace(/^v/i, '').split('.').map(s => parseInt(s, 10) || 0);
}

function compareVersions(a, b) {
  const x = segs(a);
  const y = segs(b);
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// release 资产命名 WeRead-PC-<平台目录>-<arch>-<ver>.zip，darwin 的目录名是 macOS
const PLATFORM_DIR = { darwin: 'macOS' };

function pickAsset(assets, platform, arch) {
  const plat = PLATFORM_DIR[platform] || platform;
  const prefix = 'WeRead-PC-' + plat + '-' + arch + '-';
  for (const a of (assets || [])) {
    if (a && typeof a.name === 'string' && a.name.startsWith(prefix) && a.name.endsWith('.zip')) return a;
  }
  return null;
}

module.exports = { compareVersions, pickAsset };
