// shelf-data.js — 纯函数：/web/shelf/sync 原始 JSON → 书架视图模型
// 浏览器：挂 window.ShelfData；node：module.exports（供单测）
(function (root) {
  'use strict';

  function buildProgressMap(raw) {
    const m = new Map();
    for (const p of (raw.bookProgress || [])) m.set(String(p.bookId), p);
    return m;
  }

  // 读完定义：finishReading===1 或 progress>=100
  // （不使用 book.finished，那是"作品是否完结"而非"用户是否读完"）
  function isFinished(book, prog) {
    return book.finishReading === 1 || prog >= 100;
  }

  function computeStats(raw, pm) {
    let reading = 0, finished = 0, totalSeconds = 0;
    for (const b of (raw.books || [])) {
      const p = pm.get(String(b.bookId));
      const prog = p && typeof p.progress === 'number' ? p.progress : 0;
      if (isFinished(b, prog)) finished++;
      else if (prog > 0) reading++;
      if (p && typeof p.readingTime === 'number') totalSeconds += p.readingTime;
    }
    return { reading, finished, totalHours: Math.round(totalSeconds / 3600) };
  }

  // deepLink 形如 https://weread.qq.com/book-detail?type=1&v=<TOKEN>
  // 真实阅读器 = https://weread.qq.com/web/reader/<TOKEN>（Task 1 spike 已验证）
  function readerUrlFromDeepLink(deepLink) {
    const v = (String(deepLink || '').match(/[?&]v=([^&]+)/) || [])[1] || '';
    return v ? ('https://weread.qq.com/web/reader/' + v) : '';
  }

  function toBookVM(b, p) {
    const deepLink = b.deepLink || '';
    return {
      bookId: String(b.bookId),
      title: b.title || '',
      author: b.author || '',
      cover: b.cover || '',
      category: b.category || '',                                            // ③偏好退化用（可能为空）
      progress: p && typeof p.progress === 'number' ? p.progress : 0,
      readingTime: p && typeof p.readingTime === 'number' ? p.readingTime : 0, // ④TOP5退化用
      deepLink: deepLink,
      readerUrl: readerUrlFromDeepLink(deepLink)
    };
  }

  function buildContinueReading(raw, pm, limit) {
    const rows = [];
    for (const b of (raw.books || [])) {
      const p = pm.get(String(b.bookId));
      if (p) rows.push({ b, p });
    }
    rows.sort((x, y) => (y.p.updateTime || 0) - (x.p.updateTime || 0));
    return rows.slice(0, limit).map(r => toBookVM(r.b, r.p));
  }

  function buildAllBooks(raw, pm) {
    const arr = (raw.books || []).slice();
    arr.sort((a, b) => {
      const aHas = !!a.readUpdateTime, bHas = !!b.readUpdateTime;
      if (aHas !== bHas) return aHas ? -1 : 1;
      const ka = aHas ? a.readUpdateTime : (a.updateTime || 0);
      const kb = bHas ? b.readUpdateTime : (b.updateTime || 0);
      return kb - ka;
    });
    return arr.map(x => toBookVM(x, pm.get(String(x.bookId))));
  }

  function buildViewModel(raw, opts) {
    const limit = (opts && opts.continueLimit) || 6;
    const pm = buildProgressMap(raw || {});
    return {
      stats: computeStats(raw || {}, pm),
      continueReading: buildContinueReading(raw || {}, pm, limit),
      allBooks: buildAllBooks(raw || {}, pm),
      bookCount: (raw && raw.bookCount) || ((raw && raw.books) ? raw.books.length : 0),
      fetchedAt: Date.now()
    };
  }

  const api = { buildViewModel, computeStats, buildContinueReading, buildAllBooks, toBookVM, buildProgressMap, readerUrlFromDeepLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfData = api;
})(typeof window !== 'undefined' ? window : globalThis);
