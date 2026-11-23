// shelf-view.js — 清爽网格书架渲染 + 虚拟滚动 + 封面懒加载
// 浏览器：挂 window.ShelfView；node：module.exports（仅 computeRange 可测）
(function (root) {
  'use strict';

  // 纯函数：给定各行顶部偏移 tops（长度 = 行数+1，tops[0]=0），
  // 二分计算可视行区间 [first, last]（含 overscan）
  function computeRange(scrollTop, viewportH, tops, overscan) {
    const n = tops.length - 1;
    if (n <= 0) return { first: 0, last: -1 };
    const os = overscan || 0;
    const at = (y) => {
      let lo = 0, hi = n;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (tops[mid] <= y) lo = mid; else hi = mid - 1;
      }
      return lo;
    };
    const first = Math.max(0, at(scrollTop) - os);
    const last = Math.min(n - 1, at(scrollTop + viewportH) + os);
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
    const bar = el('div', 'pbar' + (vm.finished ? ' pbar-done' : ''));
    const fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, vm.progress || 0)) + '%';
    bar.appendChild(fill);
    card.appendChild(bar);
    if (vm.finished) {
      const badge = el('span', 'done-badge', '✓ 已读完');
      badge.title = '已读完';
      cover.appendChild(badge);
    }
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

  // 文件夹卡片：单封面卡面 + 文件夹徽章(本数) + 名称 + 本数；点击下钻该书文件夹
  // 用 div 而非 button：Chrome 对 button 的固有高度不计 aspect-ratio 子元素，
  // 会把 grid 行轨算塌导致卡片叠盖
  function folderSvg() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 13');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', 'M0 1.5A1.5 1.5 0 0 1 1.5 0h4l1.5 2h7.5A1.5 1.5 0 0 1 16 3.5v8A1.5 1.5 0 0 1 14.5 13h-13A1.5 1.5 0 0 1 0 11.5z');
    svg.appendChild(p);
    return svg;
  }
  function coverImg(src) {
    const img = el('img');
    img.src = src;
    img.loading = 'lazy';
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
    return img;
  }
  function folderCard(tile, onEnter) {
    const b = el('div', 'folder-tile');
    b.role = 'button';
    b.tabIndex = 0;
    b.title = tile.name + ' · ' + tile.count + ' 本';
    const face = el('div', 'folder-face');
    for (const cell of tile.cells) {
      const c = el('div', 'folder-cell');
      if (cell.mini) {
        const m = el('div', 'folder-mini');
        for (const src of cell.mini) {
          const slot = el('i');
          if (src) slot.appendChild(coverImg(src));
          m.appendChild(slot);
        }
        c.appendChild(m);
      } else if (cell.cover) {
        c.appendChild(coverImg(cell.cover));
      }
      face.appendChild(c);
    }
    const badge = el('span', 'folder-badge');
    badge.appendChild(folderSvg());
    badge.appendChild(document.createTextNode(String(tile.count)));
    face.appendChild(badge);
    b.appendChild(face);
    b.appendChild(el('div', 'folder-name', tile.name));
    b.appendChild(el('div', 'folder-count', tile.count + ' 本'));
    b.addEventListener('click', onEnter);
    b.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEnter(); }
    });
    return b;
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
  VirtualGrid.prototype.setItems = function (items) {
    this.items = items || [];
    this.viewport.scrollTop = 0;
    this.reflow();
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
    this._buildRows();
    this.sizer.style.height = this.totalH + 'px';
    this.paint();
  };
  // 把 items 铺成行：书按 cols 打包；tops 为行顶偏移前缀和
  VirtualGrid.prototype._buildRows = function () {
    const rows = [];
    let cur = null;
    const flush = () => { if (cur) { rows.push(cur); cur = null; } };
    for (const it of this.items) {
      if (!cur) cur = { kind: 'b', items: [], h: this.cellH + this.gap };
      cur.items.push(it);
      if (cur.items.length >= this.cols) flush();
    }
    flush();
    this.rows = rows;
    this.tops = [0];
    for (const r of rows) this.tops.push(this.tops[this.tops.length - 1] + r.h);
    this.totalH = this.tops[this.tops.length - 1];
  };
  VirtualGrid.prototype.paint = function () {
    const { first, last } = computeRange(
      this.viewport.scrollTop, this.viewport.clientHeight, this.tops, 1
    );
    // 用 top 定位而非 transform：避免 GPU 合成层在滚动/改宽时留残影
    this.rowsEl.style.top = (this.tops[first] || 0) + 'px';
    this.rowsEl.textContent = '';
    for (let r = first; r <= last; r++) {
      const row = this.rows[r];
      const rowEl = el('div', 'grid-row');
      rowEl.style.height = this.cellH + 'px';
      rowEl.style.marginBottom = this.gap + 'px';
      for (const vm of row.items) {
        const cell = el('div', 'grid-cell');
        cell.style.width = this.cellW + 'px';
        cell.appendChild(bookCard(vm, { onOpen: this.onOpen, onDetail: this.onDetail }, true));
        rowEl.appendChild(cell);
      }
      this.rowsEl.appendChild(rowEl);
    }
    this._lazyLoad();
  };
  // 封面懒加载：给可视区内 data-src 的 img 赋 src（简单直接，避免额外 observer 复杂度）
  VirtualGrid.prototype._lazyLoad = function () {
    const imgs = this.rowsEl.querySelectorAll('img[data-src]');
    imgs.forEach(img => { img.src = img.dataset.src; img.removeAttribute('data-src'); });
  };

  // 状态筛选（跨 render 保持）：全部 / 在读 / 已读完
  const STATUS_OPTIONS = [
    { key: 'all', label: '全部' },
    { key: 'reading', label: '在读' },
    { key: 'finished', label: '已读完' }
  ];
  const STATUS_TITLE = { all: '全部藏书', reading: '在读', finished: '已读完' };
  let statusFilter = 'all';
  // 当前下钻的文件夹：null = 顶层文件夹卡片；'ungrouped' 或 archive id
  let currentFolder = null;

  // 主渲染入口：把视图模型画进 container
  function render(container, vm, handlers) {
    if (container._grid) { container._grid.destroy(); container._grid = null; }
    container.textContent = '';
    const head = el('div', 'shelf-head');
    head.appendChild(el('span', 'shelf-title', '我的书架'));
    head.appendChild(pill('pill-read', '在读 ' + vm.stats.reading));
    head.appendChild(pill('pill-done', '读完 ' + vm.stats.finished));
    head.appendChild(pill('pill-time', '累计 ' + vm.stats.totalHours + 'h'));
    const search = el('input', 'shelf-search');
    search.type = 'text';
    search.placeholder = '搜索书名 / 作者';
    head.appendChild(search);
    const spacer = el('span', 'spacer');
    head.appendChild(spacer);
    const refresh = el('button', 'shelf-refresh', '刷新');
    refresh.addEventListener('click', () => handlers.onRefresh && handlers.onRefresh());
    head.appendChild(refresh);
    container.appendChild(head);

    const body = el('div', 'shelf-body');
    let continueSec = null;
    if (vm.continueReading.length) {
      continueSec = el('div');
      continueSec.appendChild(el('div', 'shelf-subhead', '继续阅读'));
      const row = el('div', 'continue-row');
      vm.continueReading.forEach(b => row.appendChild(bookCard(b, { onOpen: handlers.onOpen, onDetail: handlers.onDetail })));
      continueSec.appendChild(row);
      body.appendChild(continueSec);
    }
    const subRow = el('div', 'shelf-subrow');
    const back = el('button', 'shelf-back', '← 我的书架');
    back.type = 'button';
    back.addEventListener('click', () => { currentFolder = null; applyList(); });
    subRow.appendChild(back);
    const allSub = el('div', 'shelf-subhead');
    subRow.appendChild(allSub);
    const filters = el('div', 'shelf-filters');
    const seg = el('div', 'shelf-filter');
    const segBtns = {};
    STATUS_OPTIONS.forEach(o => {
      const b = el('button', 'shelf-filter-btn', o.label);
      b.dataset.status = o.key;
      b.addEventListener('click', () => { statusFilter = o.key; applyList(); });
      segBtns[o.key] = b;
      seg.appendChild(b);
    });
    filters.appendChild(seg);
    const archives = vm.archives || [];
    const groupSel = el('select', 'shelf-group');
    groupSel.title = '按书架文件夹跳转';
    const optAll = el('option', '', '全部分组');
    optAll.value = 'all';
    groupSel.appendChild(optAll);
    archives.forEach(a => {
      const o = el('option', '', a.name + '（' + a.bookIds.length + '）');
      o.value = a.id;
      groupSel.appendChild(o);
    });
    groupSel.style.display = archives.length ? '' : 'none';
    groupSel.addEventListener('change', () => {
      currentFolder = groupSel.value === 'all' ? null : groupSel.value;
      if (search.value.trim()) search.value = '';
      applyList();
    });
    filters.appendChild(groupSel);
    subRow.appendChild(filters);
    body.appendChild(subRow);
    const folderGrid = el('div', 'folder-grid');
    body.appendChild(folderGrid);
    const viewport = el('div', 'grid-viewport');
    body.appendChild(viewport);
    const gridEmpty = el('div', 'shelf-grid-empty');
    body.appendChild(gridEmpty);
    container.appendChild(body);
    container._grid = new VirtualGrid(viewport, [], { onOpen: handlers.onOpen, onDetail: handlers.onDetail });
    function applyList() {
      const q = search.value;
      const searching = !!q.trim();
      let books = vm.allBooks;
      if (root.ShelfData) {
        books = root.ShelfData.filterByStatus(books, statusFilter);
        books = root.ShelfData.filterBooks(books, q);
      }
      const sections = root.ShelfData
        ? root.ShelfData.buildSections(books, archives)
        : [{ id: 'ungrouped', name: '未分组', books: books }];
      STATUS_OPTIONS.forEach(o => segBtns[o.key].classList.toggle('active', o.key === statusFilter));
      // 继续阅读常驻；仅搜索时让位给结果
      if (continueSec) continueSec.style.display = searching ? 'none' : '';
      if (!searching && currentFolder && !sections.some(s => s.id === currentFolder)) currentFolder = null;
      const inFolder = !searching && currentFolder != null;
      back.style.display = inFolder ? '' : 'none';
      groupSel.value = inFolder ? currentFolder : 'all';
      gridEmpty.style.display = 'none';
      if (!searching && !inFolder) {
        // 顶层：文件夹卡片（数量少，无需窗口化）
        const tiles = root.ShelfData ? root.ShelfData.buildFolderTiles(sections) : [];
        folderGrid.style.display = tiles.length ? '' : 'none';
        viewport.style.display = 'none';
        folderGrid.textContent = '';
        tiles.forEach(t => folderGrid.appendChild(folderCard(t, () => { currentFolder = t.id; applyList(); })));
        // 重建卡片会保留旧滚动位置，回到顶层应从第一行开始
        folderGrid.scrollTop = 0;
        const shown = tiles.reduce((n, t) => n + t.count, 0);
        allSub.textContent = STATUS_TITLE[statusFilter] + ' · ' + shown + ' 本';
        if (!tiles.length) {
          gridEmpty.textContent = '暂无符合筛选的文件夹';
          gridEmpty.style.display = '';
        }
        container._grid.setItems([]);
        return;
      }
      folderGrid.style.display = 'none';
      let items, title;
      if (searching) {
        items = books;
        title = '搜索结果';
      } else {
        const s = sections.find(x => x.id === currentFolder);
        items = s.books;
        title = s.name;
      }
      viewport.style.display = items.length ? '' : 'none';
      allSub.textContent = title + ' · ' + items.length + ' 本';
      if (!items.length) {
        gridEmpty.textContent = searching ? '没有匹配的书' : '该文件夹暂无符合筛选的书';
        gridEmpty.style.display = '';
      }
      container._grid.setItems(items);
    }
    search.addEventListener('input', applyList);
    applyList();
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
