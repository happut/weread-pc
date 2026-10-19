// renderer.js — 控制条逻辑：字号缩放 / 自动翻页 / 快捷键
const webview = document.getElementById('weread');   // 服务 webview：书架取数 / 登录 / 自动 Key
const wrapEl = document.getElementById('wrap');
const fontLabel = document.getElementById('fontLabel');
const fontMinus = document.getElementById('fontMinus');
const fontPlus = document.getElementById('fontPlus');
const intervalInput = document.getElementById('interval');
const autoToggle = document.getElementById('autoToggle');
const homeBtn = document.getElementById('homeBtn');
const rerenderBtn = document.getElementById('rerenderBtn');
const singlePageBtn = document.getElementById('singlePageBtn');
const modeBtn = document.getElementById('modeBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const statusEl = document.getElementById('status');
const shelfEl = document.getElementById('shelf');
const loadingEl = document.getElementById('loading');
const navShelfBtn = document.getElementById('navShelf');
const navStatsBtn = document.getElementById('navStats');
const settingsBtn = document.getElementById('settingsBtn');
const statsEl = document.getElementById('stats');
const detailEl = document.getElementById('detail');
const settingsEl = document.getElementById('settings');
const floatTurnEl = document.getElementById('floatTurn');
const floatPrevBtn = document.getElementById('floatPrevBtn');
const floatNextBtn = document.getElementById('floatNextBtn');

let mode = 'shelf';         // 'shelf' | 'reader'
let shelfBooted = false;    // 首次取数是否已发起
let currentVM = null;       // 当前视图模型
let pendingOpen = false;    // 正在打开某本书：等 reader 正文就绪再撤 loading
let pendingOpenBookId = null;
let libTab = 'shelf';       // 'shelf' | 'stats'，仅 mode==='shelf' 时有意义
let bubbleEl = null;      // 首次引导气泡节点

// ---- 多 book webview 保活：切换书不重载 ----
// 每本书一个 webview，隐藏（display:none）但不销毁，阅读进度/滚动/画布均保留
const bookWebviews = new Map(); // bookId -> webview element
function activeWv() {
  const wv = currentOpenBookId ? bookWebviews.get(currentOpenBookId) : null;
  return wv || webview;
}
function activeGuestId() {
  try { return activeWv().getWebContentsId(); } catch (_) { return null; }
}
function showOnlyBookWebview(bookId) {
  for (const [id, wv] of bookWebviews) {
    wv.classList.toggle('is-hidden', id !== String(bookId));
  }
  // 服务 webview 仅在首页/统计时露出；阅读时藏起来，避免与 book webview 叠加
  webview.classList.toggle('is-hidden', !!bookId);
  if (!bookId) {
    for (const wv of bookWebviews.values()) wv.classList.add('is-hidden');
    webview.classList.remove('is-hidden');
  }
}
function destroyBookWebview(bookId) {
  const wv = bookWebviews.get(String(bookId));
  if (!wv) return;
  bookWebviews.delete(String(bookId));
  try { wv.remove(); } catch (_) {}
}

// Task 1 spike 若发现免交互取 Key 端点，填此常量（同源、带登录态）；留空 = 不支持自动取 Key，走手动粘贴。
const AUTO_KEY_ENDPOINT = '';

let fontSize = 1.0;       // 缩放系数：1.0 = 100%，即网页版当前档位字号（最小档 18px）
let autoTimer = null;
let domReady = false;     // 由 webview dom-ready 事件维护，比 readyState 属性可靠

// ---- 字号（缩放）----
// 2026-09 网页版正文是 canvas 渲染（.wr_canvasContainer > canvas），CSS font-size 对它无效，
// 网页版字号滑块最小一级 = 18px，只能靠浏览器级缩放把正文进一步缩小。
// 有效字号 ≈ 网页版当前档位字号 × zoom（按最小档 18px 估算）
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.05;
const BASE_PX = 18; // 网页版最小一级的字号


// ---- 翻页：优先点新版底部分页按钮，否则模拟方向键 + 滚动兜底 ----
const TURN_JS = `
(function () {
  const btns = [...document.querySelectorAll('.renderTarget_pager_button')];
  const next = btns.length > 1 ? btns[btns.length - 1] : btns[0];
  if (next && next.offsetParent !== null) { next.click(); return 'click'; }
  const oldBtn = document.querySelector('.readerFooter_button');
  if (oldBtn && oldBtn.offsetParent !== null) { oldBtn.click(); return 'click-old'; }
  const ev = new KeyboardEvent('keydown', {
    key: 'ArrowRight', code: 'ArrowRight',
    keyCode: 39, which: 39, bubbles: true, cancelable: true
  });
  (document.activeElement || document.body).dispatchEvent(ev);
  document.dispatchEvent(ev);
  window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'smooth' });
  return 'key+scroll';
})();
`;

const TURN_PREV_JS = `
(function () {
  const btns = [...document.querySelectorAll('.renderTarget_pager_button')];
  const prev = btns[0];
  if (btns.length > 1 && prev && prev.offsetParent !== null) { prev.click(); return 'click'; }
  const ev = new KeyboardEvent('keydown', {
    key: 'ArrowLeft', code: 'ArrowLeft',
    keyCode: 37, which: 37, bubbles: true, cancelable: true
  });
  (document.activeElement || document.body).dispatchEvent(ev);
  document.dispatchEvent(ev);
  return 'ok';
})();
`;

// ---- 阅读模式（上下滚动 / 翻页）----
// 该模式由微信读书服务端按账号保存，本地存储里没有可改的键；
// 唯一稳妥路径是"点阅读页内那个模式切换控件"（等价用户点击，走官方逻辑）。
// 控件选择器未知且易变，故按"可见 + 短文本命中模式字样"动态定位，不写死 class。
const MODE_LABEL_RE = '上下滚动|翻页阅读|左右翻页|仿真翻页';
// 真实控件：阅读页工具栏里的 <div class="wr_tooltip_container">，文案即当前/目标模式。
// 合成 .click() 打不动它（监听的是 pointer/mouse 事件序列，或绑在子节点上），
// 所以定位后派发完整的 pointerdown→mousedown→pointerup→mouseup→click，并兜底点子节点。
const MODE_FIND_JS = `
(function () {
  var re = /${MODE_LABEL_RE}/;
  var boxes = [].slice.call(document.querySelectorAll('.wr_tooltip_container'));
  for (var i = 0; i < boxes.length; i++) {
    var t = (boxes[i].textContent || '').replace(/\\s/g, '');
    var r = boxes[i].getBoundingClientRect();
    if (re.test(t) && r.width > 0 && r.height > 0) return boxes[i].textContent.trim();
  }
  return null;
})();
`;
const MODE_CLICK_JS = `
(function () {
  var re = /${MODE_LABEL_RE}/;
  var boxes = [].slice.call(document.querySelectorAll('.wr_tooltip_container'));
  for (var i = 0; i < boxes.length; i++) {
    var t = (boxes[i].textContent || '').replace(/\\s/g, '');
    var r = boxes[i].getBoundingClientRect();
    if (re.test(t) && r.width > 0 && r.height > 0) {
      return { label: boxes[i].textContent.trim(), x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }
  return null;
})();
`;

// 读阅读页当前模式控件文案，镜像到外壳按钮；找不到则回落到"模式"
async function refreshModeLabel() {
  let label = null;
  try { label = await activeWv().executeJavaScript(MODE_FIND_JS); } catch (_) { label = null; }
  modeBtn.textContent = label || '模式';
  modeBtn.title = label
    ? '当前阅读页模式控件：' + label + '（点击切换）'
    : '切换阅读页的 上下滚动 / 翻页 模式（需在阅读页内）';
}

// 临时探针：dump 阅读页模式相关 DOM 候选到 .userdata/modeprobe.json，用于定位真实选择器
// 注意：模式控件常在阅读器自带设置弹层里，弹层没开时节点可能 display:none，
// 所以这里不要求可见，连隐藏节点一并抓，并标注可见性与 display，一次抓全。
const MODE_PROBE_JS = `
(function () {
  var out = { url: location.href, bodyClass: document.body.className, iframes: [], candidates: [] };
  var ifr = [].slice.call(document.querySelectorAll('iframe'));
  for (var f = 0; f < ifr.length; f++) {
    out.iframes.push({ src: String(ifr[f].src || '').slice(0, 120), id: ifr[f].id, cls: String(ifr[f].className).slice(0, 60) });
  }
  var re = /滚动|翻页|模式|仿真|上下|自动|设置/;
  var els = [].slice.call(document.querySelectorAll('*'));
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var t = (el.textContent || '').replace(/\\s/g, '');
    if (!t || t.length > 14 || !re.test(t)) continue;
    var r = el.getBoundingClientRect();
    var disp = '';
    try { disp = getComputedStyle(el).display; } catch (_) {}
    out.candidates.push({
      tag: el.tagName, cls: String(el.className).slice(0, 80),
      text: (el.textContent || '').trim().slice(0, 24),
      kids: el.children.length, w: Math.round(r.width), h: Math.round(r.height),
      vis: (r.width > 0 && r.height > 0), disp: disp
    });
    if (out.candidates.length >= 150) break;
  }
  var rc = document.querySelector('.readerContainer, .wr_reader, .renderTarget, [class*=reader]');
  out.readerCls = rc ? String(rc.className).slice(0, 120) : null;
  out.total = els.length;
  // 针对模式控件本体：看中心点最上层是谁、pointer-events 是否被关、子节点结构
  var re2 = /${MODE_LABEL_RE}/;
  var box = null;
  var all = [].slice.call(document.querySelectorAll('.wr_tooltip_container'));
  for (var b = 0; b < all.length; b++) {
    var bt = (all[b].textContent || '').replace(/\\s/g, '');
    var br = all[b].getBoundingClientRect();
    if (re2.test(bt) && br.width > 0 && br.height > 0) { box = all[b]; break; }
  }
  if (box) {
    var r2 = box.getBoundingClientRect();
    var cx2 = r2.left + r2.width / 2, cy2 = r2.top + r2.height / 2;
    var top = null;
    try { top = document.elementFromPoint(cx2, cy2); } catch (_) {}
    var cs = getComputedStyle(box);
    out.modeCtl = {
      cls: String(box.className).slice(0, 80),
      pe: cs.pointerEvents, pos: cs.position, z: cs.zIndex,
      rect: [Math.round(r2.left), Math.round(r2.top), Math.round(r2.width), Math.round(r2.height)],
      topAtCenter: top ? { tag: top.tagName, cls: String(top.className).slice(0, 80) } : null,
      children: [].slice.call(box.children).map(function (k) {
        var ks = getComputedStyle(k);
        return { tag: k.tagName, cls: String(k.className).slice(0, 60), pe: ks.pointerEvents };
      })
    };
  }
  return JSON.stringify(out);
})();
`;
async function dumpModeProbe() {
  if (!window.wereadPC || !window.wereadPC.writeProbe) return;
  try {
    const dump = await activeWv().executeJavaScript(MODE_PROBE_JS);
    await window.wereadPC.writeProbe(dump);
  } catch (_) {}
}

function clampZoom(z) {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
}

// CSS zoom 只作用于 canvas 页容器：位图整体等比缩小（2x DPR 降采样，清晰），
// 不改 devicePixelRatio，阅读器自身 UI 保持原大小。已验证无字形错位。
const zoomJs = (z) => `
(function () {
  const id = 'wb-canvas-zoom';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = '.wr_canvasContainer { zoom: ' + ${z} + ' !important; }';
})();
`;

function applyFont() {
  fontSize = clampZoom(fontSize);
  const approxPx = Math.round(BASE_PX * fontSize);
  fontLabel.textContent = Math.round(fontSize * 100) + '% ≈ ' + approxPx + 'px';
  if (domReady) {
    activeWv().executeJavaScript(zoomJs(fontSize)).catch(() => {});
  }
}

function setStatus(text, on) {
  statusEl.textContent = text || '';
  statusEl.className = on ? 'on' : '';
}

// ---- 书库层显隐（书架 / 统计 双 Tab 互斥；进阅读时整层撤下）----
function setReaderMode(on) {
  document.body.classList.toggle('reader-mode', !!on);
}
function setFloatTurn(on) { floatTurnEl.classList.toggle('show', !!on); }

// ---- 常驻左侧栏（类微信左右结构）：本地「上次打开的书」，点侧栏只换右侧 ----
const readSideListEl = document.getElementById('readSideList');
let openBooks = [];            // [{ bookId, title, author, cover, vm }]，本地持久化
let currentOpenBookId = null;

const OPEN_BOOKS_KEY = 'wereadpc.openBooks';
function loadOpenBooks() {
  try {
    const raw = JSON.parse(localStorage.getItem(OPEN_BOOKS_KEY) || '[]');
    if (Array.isArray(raw)) {
      openBooks = raw.filter(x => x && x.bookId && x.vm).map(x => ({
        bookId: String(x.bookId),
        title: x.title || '',
        author: x.author || '',
        cover: x.cover || '',
        vm: x.vm
      }));
    }
  } catch (_) { openBooks = []; }
}
function saveOpenBooks() {
  try { localStorage.setItem(OPEN_BOOKS_KEY, JSON.stringify(openBooks)); } catch (_) {}
}

// 侧栏折叠：导航收成图标，书收成封面小图；右缘有显著把手
const SIDEBAR_COLLAPSED_KEY = 'wereadpc.sideCollapsed';
const rsCollapseBtn = document.getElementById('rsCollapse');
const rsHandleBtn = document.getElementById('rsHandle');
function setSideCollapsed(on) {
  document.body.classList.toggle('side-collapsed', !!on);
  const arrow = on ? '⟩' : '⟨';
  const title = on ? '展开侧栏' : '折叠侧栏';
  if (rsCollapseBtn) { rsCollapseBtn.textContent = arrow; rsCollapseBtn.title = title; }
  if (rsHandleBtn) { rsHandleBtn.textContent = arrow; rsHandleBtn.title = title; }
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, on ? '1' : '0'); } catch (_) {}
  // 主区 left 随 --side-w 瞬时变化，强制一次重绘，避免合成层残影
  requestAnimationFrame(() => {
    shelfEl.style.display = shelfEl.style.display;
    if (statsEl) statsEl.style.opacity = '0.999';
    requestAnimationFrame(() => { if (statsEl) statsEl.style.opacity = ''; });
  });
}
function toggleSideCollapsed() {
  setSideCollapsed(!document.body.classList.contains('side-collapsed'));
}
if (rsCollapseBtn) rsCollapseBtn.addEventListener('click', toggleSideCollapsed);
if (rsHandleBtn) rsHandleBtn.addEventListener('click', toggleSideCollapsed);
try {
  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') setSideCollapsed(true);
} catch (_) {}

// 只切高亮，不整表重绘（左栏不重载）
function updateSidebarHighlight() {
  if (!readSideListEl) return;
  for (const row of readSideListEl.querySelectorAll('.rs-item')) {
    row.classList.toggle('current', row.getAttribute('data-book-id') === currentOpenBookId);
  }
}

function paintReadSide() {
  if (!readSideListEl) return;
  readSideListEl.textContent = '';
  if (!openBooks.length) {
    const em = document.createElement('div');
    em.className = 'rs-empty';
    em.textContent = '暂无本地打开记录';
    readSideListEl.appendChild(em);
    return;
  }
  for (const item of openBooks) {
    const id = String(item.bookId);
    const row = document.createElement('div');
    row.className = 'rs-item' + (id === currentOpenBookId ? ' current' : '');
    row.setAttribute('data-book-id', id);
    row.title = item.title + (item.author ? ' · ' + item.author : '');
    if (item.cover) {
      const img = document.createElement('img');
      img.className = 'rs-cover';
      img.src = item.cover;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      row.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'rs-cover';
      row.appendChild(ph);
    }
    const meta = document.createElement('div');
    meta.className = 'rs-meta';
    const t = document.createElement('div');
    t.className = 'rs-title';
    t.textContent = item.title || '未命名';
    meta.appendChild(t);
    if (item.author) {
      const a = document.createElement('div');
      a.className = 'rs-author';
      a.textContent = item.author;
      a.title = item.author;
      meta.appendChild(a);
    }
    row.appendChild(meta);
    const x = document.createElement('button');
    x.className = 'rs-close';
    x.title = '从列表移除';
    x.textContent = '✕';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      closeOpenBook(id);
    });
    row.appendChild(x);
    row.addEventListener('click', () => {
      // 仅在已在读这本书时忽略；从书架/统计点回同一本也要切右侧进阅读
      if (id === currentOpenBookId && mode === 'reader') return;
      openBook(item.vm);
    });
    readSideListEl.appendChild(row);
  }
}

function rememberOpenBook(vm) {
  if (!vm || !vm.bookId) return;
  const id = String(vm.bookId);
  const item = {
    bookId: id,
    title: vm.title || '',
    author: vm.author || '',
    cover: vm.cover || '',
    vm: { bookId: vm.bookId, title: vm.title, author: vm.author, cover: vm.cover,
          deepLink: vm.deepLink, readerUrl: vm.readerUrl }
  };
  // 最近点击置顶：新书/已点都挪到最前，持久化
  const idx = openBooks.findIndex(x => x.bookId === id);
  if (idx === -1) {
    openBooks.unshift(item);
    saveOpenBooks();
    currentOpenBookId = id;
    paintReadSide();
  } else {
    openBooks.splice(idx, 1);
    openBooks.unshift(item);
    saveOpenBooks();
    currentOpenBookId = id;
    paintReadSide();   // 顺序变了，需要重排
  }
}

// 从本地列表移除：销毁保活 webview；若关的是当前，切到下一本或回书架
function closeOpenBook(bookId) {
  const id = String(bookId);
  const wasCurrent = id === currentOpenBookId;
  openBooks = openBooks.filter(x => x.bookId !== id);
  saveOpenBooks();
  destroyBookWebview(id);
  paintReadSide();
  if (!wasCurrent) return;
  currentOpenBookId = null;
  if (openBooks.length) {
    openBook(openBooks[0].vm);
  } else {
    showShelf();
    refreshShelf();
    updateSidebarHighlight();
  }
}

function setNavActive(which) {
  navShelfBtn.classList.toggle('active', which === 'shelf');
  navStatsBtn.classList.toggle('active', which === 'stats');
}

function showShelf() {
  mode = 'shelf'; libTab = 'shelf';
  setReaderMode(false);
  setFloatTurn(false);
  showOnlyBookWebview(null);   // 露出服务 webview；book webview 保活但隐藏
  shelfEl.classList.add('show');
  statsEl.classList.remove('show');
  setNavActive('shelf');
  // 书架在 display:none 时可能已绘制虚拟网格（clientWidth=0 → 单元格 0 宽），
  // 显示后必须重排，否则「全部藏书」只剩竖条碎字（假残影）
  if (shelfEl._grid) requestAnimationFrame(() => shelfEl._grid.reflow());
}
function showStats() {
  mode = 'shelf'; libTab = 'stats';
  setReaderMode(false);
  setFloatTurn(false);
  showOnlyBookWebview(null);
  shelfEl.classList.remove('show');
  statsEl.classList.add('show');
  setNavActive('stats');
  loadStats();
}
function hideShelf() {          // 进阅读：主区改显示 webview
  mode = 'reader';
  setReaderMode(true);
  shelfEl.classList.remove('show');
  statsEl.classList.remove('show');
  setFloatTurn(true);
}

// ---- 全屏 loading（不透明盖住 webview，官方网页界面永不露出）----
function showLoading() { loadingEl.classList.add('show'); }
function hideLoading() { loadingEl.classList.remove('show'); }

// 轮询 reader 正文 canvas 是否就绪；就绪或超时后回调（超时兜底，绝不卡死）
function waitReaderReady(cb, timeoutMs, wv) {
  const target = wv || activeWv();
  const limit = timeoutMs || 6000;
  const start = Date.now();
  const timer = setInterval(async () => {
    let ready = false;
    try {
      ready = await target.executeJavaScript("!!document.querySelector('.wr_canvasContainer canvas')");
    } catch (_) { ready = false; }
    if (ready || Date.now() - start > limit) { clearInterval(timer); cb(); }
  }, 120);
}

// 正文就绪：撤 loading 露出已渲染好的 reader（侧栏始终不动）
function revealReader() {
  hideShelf();
  hideLoading();
  setFloatTurn(true);   // 阅读视图才露出右下角悬浮翻页钮
  setTimeout(refreshModeLabel, 800);   // 正文就绪后回读阅读页模式控件
  setTimeout(dumpModeProbe, 1200);     // 临时探针：dump 模式控件 DOM
}

function openBook(vm) {
  closeDetail();
  closeBubble();
  const id = String(vm && vm.bookId);
  if (!id) return;
  rememberOpenBook(vm);

  // 已有保活 webview：热切换，右侧内容不重载、侧栏也不重绘
  const existing = bookWebviews.get(id);
  if (existing) {
    currentOpenBookId = id;
    showOnlyBookWebview(id);
    updateSidebarHighlight();
    domReady = true;
    applyFont();
    hideLoading();
    if (mode !== 'reader') revealReader();
    else setFloatTurn(true);
    return;
  }

  const url = window.ShelfView.readerUrlFor(vm);
  // 新书：独立 webview 首次加载。右侧立刻切到阅读区（左栏不动），
  // loading 只盖主区，等正文 canvas 就绪再撤
  const wv = document.createElement('webview');
  wv.className = 'book-wv';
  wv.setAttribute('partition', 'persist:weread');
  wv.setAttribute('allowpopups', 'false');
  wv.setAttribute('data-book-id', id);
  wrapEl.appendChild(wv);
  bookWebviews.set(id, wv);

  currentOpenBookId = id;
  hideShelf();                 // 右侧立即进入阅读布局，避免“整页刷新”错觉
  showOnlyBookWebview(id);
  pendingOpen = true;
  pendingOpenBookId = id;
  showLoading();

  wv.addEventListener('dom-ready', () => {
    if (currentOpenBookId !== id) return;
    domReady = true;
    applyFont();
    if (pendingOpen && pendingOpenBookId === id) {
      pendingOpen = false;
      pendingOpenBookId = null;
      waitReaderReady(revealReader, 6000, wv);
    }
  });
  wv.addEventListener('did-fail-load', () => {
    if (currentOpenBookId !== id) return;
    if (pendingOpen && pendingOpenBookId === id) {
      pendingOpen = false;
      pendingOpenBookId = null;
      hideLoading();
      setStatus('打开失败，请重试');
    }
  });

  // 用 src 触发加载（动态 webview 需挂载后设置）
  wv.src = url;
}

// 渲染书架；vm 为空则显示空态
function paintShelf(vm, hintErr) {
  if (!vm) {
    window.ShelfView.renderEmpty(shelfEl, hintErr ? '加载失败，请重试' : '书架为空', () => refreshShelf());
    return;
  }
  currentVM = vm;
  window.ShelfView.render(shelfEl, vm, {
    onOpen: openBook,
    onDetail: openDetail,
    onRefresh: () => refreshShelf()
  });
  showBubbleOnce();   // 首次提示单击/双击
}

// 取数并渲染：先缓存秒开，再后台刷新
async function refreshShelf() {
  const r = await window.ShelfFetch.loadShelf(webview, window.wereadPC);
  const vm = r.fresh || r.cached;
  if (vm) {
    paintShelf(vm);
    showShelf();
    hideLoading();
    if (r.err && r.cached) setStatus('刷新失败，展示上次数据');
  } else {
    // 无数据（多半未登录）：撤 loading，停在 webview 登录页
    hideShelf();
    hideLoading();
  }
}

// 自动取 Key：spike 发现端点才生效；成功写回 auth.json 的 autoKey。失败静默（走手动兜底）。
async function tryAutoKey() {
  if (!AUTO_KEY_ENDPOINT || !webview) return false;
  try {
    const js = `fetch(${JSON.stringify(AUTO_KEY_ENDPOINT)}, { credentials: 'include' })`
      + `.then(r => r.json()).then(j => (j && (j.key || j.apiKey || '')) || '').catch(() => '')`;
    const key = await webview.executeJavaScript(js);
    if (key && /^wrk-/.test(key)) {
      const auth = (await window.wereadPC.readAuth()) || {};
      auth.autoKey = key;
      auth.autoKeyAt = Date.now();
      auth.autoKeyInvalid = false;
      if (!auth.source) auth.source = 'auto';
      await window.wereadPC.writeAuth(auth);
      return true;
    }
  } catch (_) { /* 静默：自动取 Key 属尽力而为 */ }
  return false;
}

// 统计看板取数：缓存秒开 → （无 Key 先试自动取）→ 后台刷新 → 派生视图模型 → 渲染 → 写缓存
let statsCurDim = 'month';
let statsVm = null;
function statsHandlers() {
  return {
    onSettings: () => openSettings(),
    onOpenBook: (id) => openDetailById(id),
    // 切维度不重新请求：缓存 vm 带全三维度数据，本地派生
    onDim: (d) => {
      statsCurDim = d;
      if (!statsVm) return;
      statsVm = window.StatsData.withDim(statsVm, d);
      window.StatsView.render(statsEl, statsVm, statsHandlers());
    }
  };
}
async function loadStats() {
  const handlers = statsHandlers();
  let cached = null;
  try { cached = await window.wereadPC.readStatsCache(); } catch (_) { cached = null; }
  if (cached) {
    statsVm = window.StatsData.withDim(cached, statsCurDim);
    window.StatsView.render(statsEl, statsVm, handlers);
  }
  else window.StatsView.render(statsEl, window.StatsData.buildStatsViewModel({ ok: false }, currentVM, new Date().getFullYear(), statsCurDim), handlers);
  try { await tryAutoKey(); } catch (_) {}
  let bundle = null;
  try { bundle = await window.wereadPC.fetchStats(); } catch (_) { bundle = null; }
  const year = new Date().getFullYear();
  statsVm = window.StatsData.buildStatsViewModel(bundle || { ok: false }, currentVM, year, statsCurDim);
  window.StatsView.render(statsEl, statsVm, handlers);
  if (bundle && bundle.ok) { try { await window.wereadPC.writeStatsCache(statsVm); } catch (_) {} }
}

// ---- 详情侧栏 ----
const DETAIL_TTL = 7 * 24 * 3600 * 1000;   // 7 天
let currentDetailBookId = null;   // 当前详情侧栏对应的 bookId，用于异步竞态守卫
function detailHandlers(vm) {
  return { onClose: closeDetail, onRead: () => openBook(vm) };
}
// vm = 书架 book VM（含 bookId/title/cover/deepLink/readerUrl）
function openDetail(vm) {
  if (!vm || !vm.bookId) return;
  closeBubble();
  currentDetailBookId = vm.bookId;   // 标记当前请求，供 loadDetail 竞态守卫
  detailEl.classList.add('show');
  const h = detailHandlers(vm);
  // 先用书架 VM 画占位（封面/书名立即可见），再后台补详情
  window.DetailView.render(detailEl, window.BookDetailData.buildDetailViewModel({
    ok: false, info: { bookId: vm.bookId, title: vm.title, author: vm.author, cover: vm.cover }
  }), h);
  loadDetail(vm.bookId, h);
}
// 书架 VM 里找该书（含 bookId/title/cover 等）；找不到退化为最小信息
function shelfBookInfo(bookId) {
  if (currentVM && currentVM.allBooks) {
    const b = currentVM.allBooks.filter(x => String(x.bookId) === String(bookId))[0];
    if (b) return b;
  }
  return { bookId: String(bookId) };
}
// 从统计 TOP5 点开：先在书架 VM 里找，找不到用最小信息
function openDetailById(bookId) {
  openDetail(shelfBookInfo(bookId));
}
async function loadDetail(bookId, handlers) {
  const h = handlers || { onClose: closeDetail };
  let cached = null;
  try { cached = await window.wereadPC.readBookCache(bookId); } catch (_) { cached = null; }
  if (currentDetailBookId !== bookId) return;   // 已切到别的书/已关闭，丢弃过期结果
  if (cached && cached.vm && cached.fetchedAt && (Date.now() - cached.fetchedAt) < DETAIL_TTL) {
    window.DetailView.render(detailEl, cached.vm, h);
    return;   // 命中未过期缓存，不再打网络
  }
  let bundle = null;
  try { bundle = await window.wereadPC.fetchBook(bookId); } catch (_) { bundle = null; }
  if (currentDetailBookId !== bookId) return;   // 已切到别的书/已关闭，丢弃过期结果
  // 取数失败（无 Key/离线）时用书架信息兜底，避免占位的书名/封面被冲成“未知书名”
  const vm = window.BookDetailData.buildDetailViewModel(
    (bundle && bundle.ok) ? bundle : { ok: false, info: shelfBookInfo(bookId) });
  window.DetailView.render(detailEl, vm, h);
  if (bundle && bundle.ok) {
    try { await window.wereadPC.writeBookCache(bookId, { fetchedAt: Date.now(), vm: vm }); } catch (_) {}
  }
}
function closeDetail() { detailEl.classList.remove('show'); currentDetailBookId = null; }

// ---- 首次气泡引导（localStorage 记忆，只弹一次）----
function showBubbleOnce() {
  try { if (localStorage.getItem('wrpc-detail-bubble')) return; } catch (_) {}
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = '单击书卡看详情，双击直接阅读';
  b.style.left = '50%'; b.style.bottom = '28px'; b.style.transform = 'translateX(-50%)';
  document.body.appendChild(b);
  bubbleEl = b;
  setTimeout(closeBubble, 5000);
  try { localStorage.setItem('wrpc-detail-bubble', '1'); } catch (_) {}
}
function closeBubble() { if (bubbleEl) { bubbleEl.remove(); bubbleEl = null; } }

// ---- 设置模态 ----
function openSettings() {
  settingsEl.classList.add('show');
  renderSettings();
}
function closeSettings() { settingsEl.classList.remove('show'); }
async function renderSettings() {
  let auth = null;
  try { auth = await window.wereadPC.readAuth(); } catch (_) { auth = null; }
  auth = auth || {};
  const resolved = window.WereadAuth.resolveAuth(auth);
  const model = {
    mode: resolved.mode,
    source: resolved.source,
    maskedKey: resolved.key ? window.WereadAuth.maskKey(resolved.key) : '',
    manualKey: auth.manualKey || '',
    manualCookie: auth.manualCookie || ''
  };
  window.SettingsView.render(settingsEl, model, {
    onClose: closeSettings,
    onSaveManual: async (m) => {
      const next = Object.assign({}, auth, {
        manualKey: String((m && m.key) || '').trim(),
        manualCookie: String((m && m.cookie) || '').trim()
      });
      await window.wereadPC.writeAuth(next);
      await renderSettings();
      if (libTab === 'stats') loadStats();   // 保存后立即用新凭证重取
    },
    onClearManual: async () => {
      const next = Object.assign({}, auth, { manualKey: '', manualCookie: '' });
      await window.wereadPC.writeAuth(next);
      await renderSettings();
    },
    onRetryAuto: async () => {
      await tryAutoKey();
      await renderSettings();
      if (libTab === 'stats') loadStats();
    },
    onRefreshStats: () => { closeSettings(); showStats(); }
  });
}

function startAuto() {
  const sec = Math.max(3, parseInt(intervalInput.value, 10) || 30);
  intervalInput.value = sec;
  autoTimer = setInterval(() => {
    activeWv().executeJavaScript(TURN_JS).catch(() => {});
  }, sec * 1000);
  autoToggle.textContent = '停止翻页';
  autoToggle.classList.add('primary');
  setStatus(`自动翻页中 · 每 ${sec}s`);
  if (window.wereadPC) window.wereadPC.setPowerSave(true); // 防止后台挂起
}

function stopAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  autoToggle.textContent = '自动翻页';
  autoToggle.classList.remove('primary');
  setStatus('');
  if (window.wereadPC) window.wereadPC.setPowerSave(false);
}

// ---- 事件绑定 ----
fontMinus.addEventListener('click', () => {
  if (fontSize > MIN_ZOOM + 0.001) {
    fontSize = clampZoom(fontSize - ZOOM_STEP);
    applyFont();
  }
});
fontPlus.addEventListener('click', () => {
  if (fontSize < MAX_ZOOM - 0.001) {
    fontSize = clampZoom(fontSize + ZOOM_STEP);
    applyFont();
  }
});
autoToggle.addEventListener('click', () => autoTimer ? stopAuto() : startAuto());
prevBtn.addEventListener('click', () => {
  activeWv().executeJavaScript(TURN_PREV_JS).catch(() => {});
});
nextBtn.addEventListener('click', () => {
  activeWv().executeJavaScript(TURN_JS).catch(() => {});
});
floatPrevBtn.addEventListener('click', () => {
  activeWv().executeJavaScript(TURN_PREV_JS).catch(() => {});
});
floatNextBtn.addEventListener('click', () => {
  activeWv().executeJavaScript(TURN_JS).catch(() => {});
});
rerenderBtn.addEventListener('click', () => {
  if (window.wereadPC) window.wereadPC.forceRerender();
  setTimeout(applyFont, 400); // 重排后补回缩放样式
});
singlePageBtn.addEventListener('click', () => {
  // 阅读器在窗口 <=1000px 时自动切单页（实测），中缝消失、正文字号等效变大
  if (window.wereadPC) window.wereadPC.setWindowWidth(1000);
});
const VIEWPORT_JS = `(function(){ return { w: window.innerWidth, h: window.innerHeight }; })();`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 阅读页工具栏 idle 会自动隐藏（图标 rect 归 0），定位前先注入鼠标移动把它唤出来
async function locateModeControl() {
  for (let attempt = 0; attempt < 2; attempt++) {
    let vp = null;
    try { vp = await activeWv().executeJavaScript(VIEWPORT_JS); } catch (_) { vp = null; }
    if (vp && window.wereadPC && window.wereadPC.moveGuest) {
      try { await window.wereadPC.moveGuest(activeGuestId(), vp.w / 2, vp.h / 2); } catch (_) {}
    }
    await sleep(attempt === 0 ? 500 : 700);
    let hit = null;
    try { hit = await activeWv().executeJavaScript(MODE_CLICK_JS); } catch (_) { hit = null; }
    if (hit) return hit;
  }
  return null;
}
modeBtn.addEventListener('click', async () => {
  await dumpModeProbe();               // 临时探针：先 dump 当前阅读页 DOM（弹层开着也一并抓）
  const hit = await locateModeControl();
  if (!hit) { setStatus('未找到模式控件'); return; }
  // 合成 .click() 无效，改用主进程向 guest 注入真实鼠标事件（isTrusted），指向当前 book webview
  let ok = false;
  if (window.wereadPC && window.wereadPC.clickGuest) {
    try { ok = await window.wereadPC.clickGuest(activeGuestId(), hit.x, hit.y); } catch (_) { ok = false; }
  }
  setStatus(ok ? '已切换模式' : '点击失败');
  setTimeout(refreshModeLabel, 700);   // 等阅读页重排后回读新状态
});
homeBtn.addEventListener('click', () => {
  closeDetail();
  showShelf();
  refreshShelf();
});
navShelfBtn.addEventListener('click', () => {
  closeDetail();
  showShelf();
  refreshShelf();
});
navStatsBtn.addEventListener('click', () => {
  closeDetail();
  showStats();
});
settingsBtn.addEventListener('click', () => openSettings());
intervalInput.addEventListener('change', () => {
  if (autoTimer) { stopAuto(); startAuto(); } // 修改间隔后重启
});

window.addEventListener('keydown', (e) => {
  // Esc：设置模态优先关，其次关详情侧栏
  if (e.key === 'Escape') {
    if (settingsEl.classList.contains('show')) closeSettings();
    else if (detailEl.classList.contains('show')) closeDetail();
    return;
  }
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 'ArrowRight') {
    activeWv().executeJavaScript(TURN_JS).catch(() => {});
  } else if (e.key === 'ArrowLeft') {
    activeWv().executeJavaScript(TURN_PREV_JS).catch(() => {});
  }
});

// ---- webview 生命周期 ----
webview.addEventListener('dom-ready', () => {
  domReady = true;
  applyFont(); // 整页跳转后缩放会丢失，重新应用
  // 正在打开某本书：等 reader 正文 canvas 就绪后再撤 loading（全程不露网页版）
  if (pendingOpen) {
    pendingOpen = false;
    waitReaderReady(revealReader);
    return;
  }
  // 仅在书架模式下、且首次：拉取书架数据并展示覆盖层
  if (mode === 'shelf' && !shelfBooted) {
    shelfBooted = true;
    refreshShelf();
  }
});

// 启动：有缓存则秒开书架（无需 loading）；无缓存则盖不透明 loading，
// 等 dom-ready→refreshShelf 决定（书架 or 未登录登录页）。官方网页书架全程不露出。
(async function bootShelfFromCache() {
  if (!window.wereadPC || !window.ShelfView) return;
  loadOpenBooks();     // 侧栏默认展示本地上次打开的书（不依赖「最近阅读」）
  paintReadSide();
  let cached = null;
  try { cached = await window.wereadPC.readShelfCache(); } catch (_) { cached = null; }
  if (cached && mode === 'shelf') {
    paintShelf(cached);
    showShelf();
  } else {
    showLoading();
  }
})();
