// shelf-view.js — 清爽网格书架渲染 + 虚拟滚动 + 封面懒加载
// 浏览器：挂 window.ShelfView；node：module.exports（仅 computeRange 可测）
(function (root) {
  'use strict';

  // 纯函数：给定滚动位置计算可视行区间 [first, last]（含 overscan）
  function computeRange(scrollTop, viewportH, rowHeight, totalRows, overscan) {
    if (totalRows <= 0) return { first: 0, last: -1 };
    const os = overscan || 0;
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - os);
    const last = Math.min(totalRows - 1, Math.ceil((scrollTop + viewportH) / rowHeight) + os);
    return { first, last };
  }

  // 阅读入口 URL：用 shelf-data 算好的 readerUrl（/web/reader/<v>，Task 1 spike 已验证），回退 deepLink
  function readerUrlFor(vm) {
    return vm.readerUrl || vm.deepLink || ('https://weread.qq.com/web/bookDetail?bookId=' + vm.bookId);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // 全局右键菜单（一次一个）
  let activeMenu = null;
  function closeBookMenu() {
    if (activeMenu) { activeMenu.remove(); activeMenu = null; }
  }
  function openBookMenu(vm, x, y, h) {
    closeBookMenu();
    const menu = el('div', 'book-menu');
    const items = [
      { t: '阅读', fn: () => h.onOpen && h.onOpen(vm) },
      { t: '查看详情', fn: () => h.onDetail && h.onDetail(vm) },
      { t: '查看统计', fn: () => h.onDetail && h.onDetail(vm, 'stats') }
    ];
    items.forEach(it => {
      const mi = el('div', 'book-menu-item', it.t);
      mi.addEventListener('click', (e) => {
        e.stopPropagation();
        closeBookMenu();
        it.fn();
      });
      menu.appendChild(mi);
    });
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    document.body.appendChild(menu);
    activeMenu = menu;
    // 贴边防溢出
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) menu.style.left = (x - r.width) + 'px';
    if (r.bottom > window.innerHeight) menu.style.top = (y - r.height) + 'px';
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('click', closeBookMenu);
    document.addEventListener('contextmenu', (e) => {
      if (activeMenu && !e.target.closest('.book-menu')) closeBookMenu();
    });
    window.addEventListener('blur', closeBookMenu);
  }

  // 单张书卡；handlers = { onOpen, onDetail(vm, tab?) }；lazy=true 封面走 data-src 懒加载
  // 单击→直接阅读；右键 / ⋯ → 菜单（阅读 / 详情 / 统计）
  function bookCard(vm, handlers, lazy) {
    const h = handlers || {};
    const card = el('div', 'book-card');
    const cover = el('div', 'cover');
    if (vm.cover) {
      const img = el('img');
      if (lazy) img.dataset.src = vm.cover;  // 懒加载：进入视口才赋 src
      else img.src = vm.cover;               // 立即可见，直接加载
      // 不要 alt 文案：封面加载失败时浏览器会画竖排 alt 字，像“残影”
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      cover.appendChild(img);
    }
    card.appendChild(cover);
    card.appendChild(el('div', 'book-title', vm.title));
    const bar = el('div', 'pbar');
    const fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, vm.progress || 0)) + '%';
    bar.appendChild(fill);
    card.appendChild(bar);
    // hover ⋯：右键的可发现入口
    const more = el('button', 'book-more', '⋯');
    more.title = '更多';
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      openBookMenu(vm, r.left, r.bottom + 4, h);
    });
    cover.appendChild(more);

    card.addEventListener('click', () => {
      if (h.onOpen) h.onOpen(vm);
    });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openBookMenu(vm, e.clientX, e.clientY, h);
    });
    return card;
  }

  // 虚拟网格：行式窗口化，只渲染可视行
  function VirtualGrid(viewport, items, opts) {
    this.viewport = viewport;
    this.items = items;
    this.onOpen = opts.onOpen;
    this.onDetail = opts.onDetail;
    this.gap = opts.gap || 14;
    this.minCellW = opts.minCellW || 120;
    this.textH = opts.textH || 40;   // 标题+进度条区域高度
    this.ratio = 4 / 3;              // 封面 3:4 → 高 = 宽 * 4/3
    this.sizer = el('div', 'grid-sizer');
    this.rowsEl = el('div', 'grid-rows');
    this.sizer.appendChild(this.rowsEl);
    viewport.appendChild(this.sizer);
    this._raf = null;
    this._onScroll = () => this._schedule();
    this._onResize = () => this.reflow();
    viewport.addEventListener('scroll', this._onScroll);
    root.addEventListener('resize', this._onResize);
    this.reflow();
  }
  // 销毁：移除 window/viewport 监听并取消挂起的 RAF，避免反复 render 累积泄漏
  VirtualGrid.prototype.destroy = function () {
    root.removeEventListener('resize', this._onResize);
    this.viewport.removeEventListener('scroll', this._onScroll);
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._pendingReflow) { cancelAnimationFrame(this._pendingReflow); this._pendingReflow = null; }
  };
  VirtualGrid.prototype._schedule = function () {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.paint(); });
  };
  VirtualGrid.prototype.reflow = function () {
    const w = this.viewport.clientWidth;
    // 容器尚不可见（display:none）时宽为 0，此时算出的列宽会变成 0，
    // 书名挤成竖排细条。延到下一帧/可见后再量。
    if (!w) {
      if (!this._pendingReflow) {
        this._pendingReflow = requestAnimationFrame(() => {
          this._pendingReflow = null;
          if (this.viewport.clientWidth) this.reflow();
        });
      }
      return;
    }
    this.cols = Math.max(1, Math.floor((w + this.gap) / (this.minCellW + this.gap)));
    this.cellW = (w - (this.cols - 1) * this.gap) / this.cols;
    this.cellH = this.cellW * this.ratio + this.textH;
    this.rowHeight = this.cellH + this.gap;
    this.totalRows = Math.ceil(this.items.length / this.cols);
    this.sizer.style.height = (this.totalRows * this.rowHeight) + 'px';
    this.paint();
  };
  VirtualGrid.prototype.paint = function () {
    const { first, last } = computeRange(
      this.viewport.scrollTop, this.viewport.clientHeight,
      this.rowHeight, this.totalRows, 1
    );
    // 用 top 定位而非 transform：避免 GPU 合成层在滚动/改宽时留残影
    this.rowsEl.style.top = (first * this.rowHeight) + 'px';
    this.rowsEl.textContent = '';
    for (let r = first; r <= last; r++) {
      const row = el('div', 'grid-row');
      row.style.height = this.cellH + 'px';
      row.style.marginBottom = this.gap + 'px';
      for (let c = 0; c < this.cols; c++) {
        const idx = r * this.cols + c;
        if (idx >= this.items.length) break;
        const cell = el('div', 'grid-cell');
        cell.style.width = this.cellW + 'px';
        cell.appendChild(bookCard(this.items[idx], { onOpen: this.onOpen, onDetail: this.onDetail }, true));
        row.appendChild(cell);
      }
      this.rowsEl.appendChild(row);
    }
    this._lazyLoad();
  };
  // 封面懒加载：给可视区内 data-src 的 img 赋 src（简单直接，避免额外 observer 复杂度）
  VirtualGrid.prototype._lazyLoad = function () {
    const imgs = this.rowsEl.querySelectorAll('img[data-src]');
    imgs.forEach(img => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
  };

  // 主渲染入口：把视图模型画进 container
  function render(container, vm, handlers) {
    if (container._grid) { container._grid.destroy(); container._grid = null; }
    container.textContent = '';
    const head = el('div', 'shelf-head');
    head.appendChild(el('span', 'shelf-title', '我的书架'));
    head.appendChild(pill('pill-read', '在读 ' + vm.stats.reading));
    head.appendChild(pill('pill-done', '读完 ' + vm.stats.finished));
    head.appendChild(pill('pill-time', '累计 ' + vm.stats.totalHours + 'h'));
    const spacer = el('span', 'spacer');
    head.appendChild(spacer);
    const refresh = el('button', 'shelf-refresh', '刷新');
    refresh.addEventListener('click', () => handlers.onRefresh && handlers.onRefresh());
    head.appendChild(refresh);
    container.appendChild(head);

    const body = el('div', 'shelf-body');
    if (vm.continueReading.length) {
      body.appendChild(el('div', 'shelf-subhead', '继续阅读'));
      const row = el('div', 'continue-row');
      vm.continueReading.forEach(b => row.appendChild(bookCard(b, { onOpen: handlers.onOpen, onDetail: handlers.onDetail })));
      body.appendChild(row);
    }
    body.appendChild(el('div', 'shelf-subhead', '全部藏书 · ' + vm.allBooks.length + ' 本'));
    const viewport = el('div', 'grid-viewport');
    body.appendChild(viewport);
    container.appendChild(body);
    container._grid = new VirtualGrid(viewport, vm.allBooks, { onOpen: handlers.onOpen, onDetail: handlers.onDetail });
  }

  function pill(cls, text) {
    const p = el('span', 'pill ' + cls);
    p.textContent = text;
    return p;
  }

  function renderEmpty(container, msg, onRetry) {
    container.textContent = '';
    const box = el('div', 'shelf-empty');
    box.appendChild(el('div', 'shelf-empty-msg', msg || '书架为空'));
    if (onRetry) {
      const b = el('button', 'shelf-refresh', '重试');
      b.addEventListener('click', onRetry);
      box.appendChild(b);
    }
    container.appendChild(box);
  }

  const api = { computeRange, readerUrlFor, render, renderEmpty, VirtualGrid, bookCard };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfView = api;
})(typeof window !== 'undefined' ? window : globalThis);
