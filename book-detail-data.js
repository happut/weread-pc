// book-detail-data.js — 纯函数：BookBundle（weread-api 归一化）→ 详情侧栏视图模型
(function (root) {
  'use strict';

  function starOf(star) { return Math.round((Number(star) || 0) / 20); }   // 20→1 … 100→5
  function secToHours1(s) { return Math.round((Number(s) || 0) / 3600 * 10) / 10; }
  function formatDate(ts) {
    const n = Number(ts) || 0; if (!n) return '';
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function formatWordCount(n) {
    const w = Number(n) || 0; if (!w) return '';
    return w >= 10000 ? (Math.round(w / 1000) / 10) + '万字' : w + '字';
  }

  // 元信息行：有值才列（缺失单项降级）
  function buildMetaRows(info) {
    const i = info || {};
    const rows = [];
    const push = (k, v) => { if (v) rows.push({ k: k, v: String(v) }); };
    push('作者', i.author);
    push('译者', i.translator);
    push('出版社', i.publisher);
    push('分类', i.category);
    push('出版年', i.publishTime);
    push('ISBN', i.isbn);
    push('字数', formatWordCount(i.wordCount));
    return rows;
  }

  function buildDetailViewModel(bundle) {
    const b = bundle || {};
    const info = b.info || {};
    const prog = b.progress || {};
    const connected = !!(b.ok && b.source === 'agent');
    const community = (b.communityReviews || []).map(r => ({
      reviewId: r.reviewId || '', content: r.content || '', star: starOf(r.star),
      authorName: r.authorName || '', authorAvatar: r.authorAvatar || '', date: formatDate(r.createTime)
    }));
    return {
      connected: connected,
      bookId: info.bookId || '', cover: info.cover || '', title: info.title || '', author: info.author || '',
      rating: typeof info.rating === 'number' ? info.rating : 0,        // 百分制
      ratingCount: typeof info.ratingCount === 'number' ? info.ratingCount : 0,
      intro: info.intro || '',
      metaRows: buildMetaRows(info),
      myReviews: b.myReviews || [],
      communityReviews: community,
      recommendPercent: b.reviewsMeta ? Math.round((b.reviewsMeta.recommendValue || 0) / 10) : 0, // 862→86
      bookStats: {
        hours: secToHours1(prog.seconds),
        progress: typeof prog.percent === 'number' ? prog.percent : 0,
        lastRead: formatDate(prog.lastReadAt),
        finishTime: formatDate(prog.finishTime)
      }
    };
  }

  const api = { starOf, secToHours1, formatDate, formatWordCount, buildMetaRows, buildDetailViewModel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BookDetailData = api;
})(typeof window !== 'undefined' ? window : globalThis);
