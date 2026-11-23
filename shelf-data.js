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
    const progress = p && typeof p.progress === 'number' ? p.progress : 0;
    return {
      bookId: String(b.bookId),
      title: b.title || '',
      author: b.author || '',
      cover: b.cover || '',
      category: b.category || '',                                            // ③偏好退化用（可能为空）
      progress: progress,
      finished: isFinished(b, progress),
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

  // 书架文件夹（用户自建分组）：archive 回包 → 视图模型
  function toArchiveVM(a) {
    return {
      id: String(a.archiveId != null ? a.archiveId : a.name),
      name: a.name || '',
      bookIds: (a.bookIds || []).map(String)
    };
  }

  // 按文件夹分区：未分组在前，其余保持 archive 原始顺序；
  // 一本书出现在多个分组时只归入第一个，避免重复展示
  function buildSections(books, archives) {
    const list = books || [];
    const byId = new Map(list.map(b => [b.bookId, b]));
    const seen = new Set();
    const sections = [];
    for (const a of (archives || [])) {
      const members = [];
      for (const id of (a.bookIds || [])) {
        if (seen.has(id)) continue;
        const b = byId.get(id);
        if (b) { seen.add(id); members.push(b); }
      }
      sections.push({ id: a.id, name: a.name, books: members });
    }
    const rest = list.filter(b => !seen.has(b.bookId));
    if (rest.length) sections.unshift({ id: 'ungrouped', name: '未分组', books: rest });
    return sections;
  }

  // 文件夹卡片模型：空分区不出卡；成员顺序即书架"最近阅读优先"序
  // ≤4 本：四格按序铺封面，不足留空；>4 本：前 3 格最近 3 本，
  // 第 4 格内嵌 2×2 拼贴放其后最近 4 本，不足留空
  function buildFolderTiles(sections) {
    const tiles = [];
    for (const s of (sections || [])) {
      const books = s.books || [];
      if (!books.length) continue;
      const cells = books.slice(0, 3).map(b => ({ cover: b.cover || '' }));
      if (books.length <= 4) {
        if (books[3]) cells.push({ cover: books[3].cover || '' });
        while (cells.length < 4) cells.push({ cover: '' });
      } else {
        const mini = books.slice(3, 7).map(b => b.cover || '');
        while (mini.length < 4) mini.push('');
        cells.push({ mini });
      }
      tiles.push({ id: s.id, name: s.name, count: books.length, cells });
    }
    return tiles;
  }

  function buildViewModel(raw, opts) {
    const limit = (opts && opts.continueLimit) || 6;
    const pm = buildProgressMap(raw || {});
    return {
      stats: computeStats(raw || {}, pm),
      continueReading: buildContinueReading(raw || {}, pm, limit),
      // 侧栏「继续阅读」需要全量（首页行仍截取 limit 条）
      continueReadingAll: buildContinueReading(raw || {}, pm, Infinity),
      allBooks: buildAllBooks(raw || {}, pm),
      archives: ((raw && raw.archive) || []).map(toArchiveVM),
      bookCount: (raw && raw.bookCount) || ((raw && raw.books) ? raw.books.length : 0),
      fetchedAt: Date.now()
    };
  }

  // 状态筛选：all / reading（未读完且有进度）/ finished
  function filterByStatus(books, status) {
    if (status === 'reading') return (books || []).filter(b => !b.finished && (b.progress || 0) > 0);
    if (status === 'finished') return (books || []).filter(b => b.finished);
    return (books || []).slice();
  }

  // 本地搜索：按书名/作者子串过滤（大小写不敏感，空白忽略；空 query 原样返回）
  function filterBooks(books, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return (books || []).slice();
    return (books || []).filter(b =>
      String(b.title || '').toLowerCase().includes(q) ||
      String(b.author || '').toLowerCase().includes(q)
    );
  }

  const api = { buildViewModel, computeStats, buildContinueReading, buildAllBooks, toBookVM, buildProgressMap, readerUrlFromDeepLink, filterBooks, filterByStatus, buildSections, buildFolderTiles };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfData = api;
})(typeof window !== 'undefined' ? window : globalThis);
