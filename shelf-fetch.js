// shelf-fetch.js — 经 webview 同源上下文取书架 + 缓存编排
// 浏览器：挂 window.ShelfFetch；node：module.exports（供单测）
// 依赖：root.ShelfData（buildViewModel）
(function (root) {
  'use strict';

  // 在 webview 页面上下文里执行：同源 cookie fetch，返回文本
  // （executeJavaScript 会等待返回的 Promise 并 resolve 其值）
  const FETCH_JS =
    "fetch('/web/shelf/sync', { credentials: 'include' })" +
    ".then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); })";

  async function fetchShelf(webview) {
    const text = await webview.executeJavaScript(FETCH_JS);
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.books)) throw new Error('shelf payload invalid');
    return raw;
  }

  // 返回 { cached, fresh, err }：
  //   cached = 上次视图模型（无则 null）
  //   fresh  = 本次视图模型（失败为 null）
  //   err    = 本次错误（成功为 null）
  async function loadShelf(webview, api) {
    let cached = null;
    try { cached = await api.readShelfCache(); } catch (_) { cached = null; }

    let fresh = null, err = null;
    try {
      const raw = await fetchShelf(webview);
      fresh = root.ShelfData.buildViewModel(raw);
      try { await api.writeShelfCache(fresh); } catch (_) {}
    } catch (e) {
      err = e;
    }
    return { cached, fresh, err };
  }

  const out = { fetchShelf, loadShelf, FETCH_JS };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  else root.ShelfFetch = out;
})(typeof window !== 'undefined' ? window : globalThis);
