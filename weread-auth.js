// weread-auth.js — 纯函数：认证来源路由 + Key 掩码（不含任何真实凭据）
(function (root) {
  'use strict';

  // 四级优先级：手动 Key > 自动 Key（未失效）> 手动 cookie > webview 同源
  // 入参 state: { manualKey, autoKey, autoKeyInvalid, manualCookie }
  // 返回: { mode:'key'|'cookie'|'webview', key?, cookie?, source:'manual'|'auto'|'none' }
  function resolveAuth(state) {
    const s = state || {};
    const manualKey = (s.manualKey || '').trim();
    const autoKey = (s.autoKey || '').trim();
    const manualCookie = (s.manualCookie || '').trim();

    if (manualKey) return { mode: 'key', key: manualKey, source: 'manual' };
    if (autoKey && !s.autoKeyInvalid) return { mode: 'key', key: autoKey, source: 'auto' };
    if (manualCookie) return { mode: 'cookie', cookie: manualCookie, source: 'manual' };
    return { mode: 'webview', source: 'none' };
  }

  // wrk-a3f2b1c9d8e7 → wrk-••••d8e7；仅用于展示，绝不打印完整 Key
  function maskKey(key) {
    const k = String(key || '');
    if (!k) return '';
    if (k.length <= 8) return '••••';
    const prefix = k.startsWith('wrk-') ? 'wrk-' : '';
    return prefix + '••••' + k.slice(-4);
  }

  const api = { resolveAuth, maskKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WereadAuth = api;
})(typeof window !== 'undefined' ? window : globalThis);
