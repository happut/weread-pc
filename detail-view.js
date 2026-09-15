// detail-view.js — 书籍详情侧栏渲染（概览 / 书评 / 统计 三 Tab）
// 浏览器：挂 window.DetailView；node：module.exports（仅 stars 可测）。不发请求，只消费视图模型。
(function (root) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  // star 已在 buildDetailViewModel 里归一为 1~5 整数
  function stars(n) {
    const full = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
  }
  function fmtDate(ts) {
    return (root.BookDetailData && root.BookDetailData.formatDate) ? root.BookDetailData.formatDate(ts) : '';
  }

  function paneOverview(vm) {
    const p = el('div');
    if (vm.intro) p.appendChild(el('div', 'intro', vm.intro));
    (vm.metaRows || []).forEach(function (r) {
      const row = el('div', 'meta-row');
      row.appendChild(el('div', 'k', r.k));
      row.appendChild(el('div', 'v', r.v));
      p.appendChild(row);
    });
    if (!vm.intro && !(vm.metaRows || []).length) p.appendChild(el('div', 'dt-empty', '暂无更多元信息'));
    return p;
  }

  function reviewBlock(r) {
    const b = el('div', 'review');
    const who = el('div', 'who');
    who.textContent = (r.authorName || '匿名') + (r.star ? ' · ' + stars(r.star) : '') + (r.date ? ' · ' + r.date : '');
    b.appendChild(who);
    b.appendChild(el('div', 'txt', r.content || ''));
    return b;
  }

  function paneReviews(vm) {
    const p = el('div');
    if (vm.recommendPercent) p.appendChild(el('div', 'stat-h', '推荐率 ' + vm.recommendPercent + '%'));
    const mine = vm.myReviews || [];
    if (mine.length) {
      p.appendChild(el('div', 'stat-h', '我的书评'));
      mine.forEach(function (r) {
        p.appendChild(reviewBlock({ authorName: r.authorName || '我', star: r.star, content: r.content, date: fmtDate(r.createTime) }));
      });
    }
    const comm = vm.communityReviews || [];
    if (comm.length) {
      p.appendChild(el('div', 'stat-h', '社区点评 · ' + comm.length));
      comm.forEach(function (r) { p.appendChild(reviewBlock(r)); });
    }
    if (!mine.length && !comm.length) p.appendChild(el('div', 'dt-empty', '暂无书评'));
    return p;
  }

  function paneStats(vm) {
    const p = el('div');
    const s = vm.bookStats || {};
    const row = function (k, v) {
      const d = el('div', 'meta-row');
      d.appendChild(el('div', 'k', k));
      d.appendChild(el('div', 'v', (v == null || v === '') ? '—' : String(v)));
      p.appendChild(d);
    };
    row('已读', (s.progress || 0) + '%');
    row('本书时长', (s.hours || 0) + ' 小时');
    row('最近阅读', s.lastRead || '');
    if (s.finishTime) row('读完时间', s.finishTime);
    return p;
  }

  // 主入口：container = #detail；vm = buildDetailViewModel 产出；handlers = { onClose, onRead }
  function render(container, vm, handlers) {
    container.textContent = '';
    const h = handlers || {};
    const v = vm || {};

    const close = el('button', 'dt-close', '✕');
    close.addEventListener('click', function () { h.onClose && h.onClose(); });
    container.appendChild(close);

    const head = el('div', 'dt-head');
    if (v.cover) { const img = el('img'); img.src = v.cover; img.alt = v.title || ''; head.appendChild(img); }
    const m = el('div', 'm');
    m.appendChild(el('div', 'ti', v.title || '未知书名'));
    if (v.author) m.appendChild(el('div', 'au', v.author));
    if (v.rating) m.appendChild(el('div', 'ra', (v.rating / 10).toFixed(1) + ' 分' + (v.ratingCount ? ' · ' + v.ratingCount + '人评' : '')));
    head.appendChild(m);
    container.appendChild(head);

    const readBtn = el('button', 'primary dt-read', '开始阅读');
    readBtn.addEventListener('click', function () { h.onRead && h.onRead(v); });
    container.appendChild(readBtn);

    const tabs = el('div', 'dt-tabs');
    const body = el('div', 'dt-body');
    const defs = [['概览', paneOverview], ['书评', paneReviews], ['统计', paneStats]];
    defs.forEach(function (d, i) {
      const b = el('button', i === 0 ? 'active' : null, d[0]);
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(tabs.children, function (c) { c.classList.remove('active'); });
        b.classList.add('active');
        body.textContent = '';
        body.appendChild(d[1](v));
      });
      tabs.appendChild(b);
    });
    container.appendChild(tabs);
    body.appendChild(defs[0][1](v));   // 默认概览
    container.appendChild(body);
  }

  const api = { el, stars, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DetailView = api;
})(typeof window !== 'undefined' ? window : globalThis);
