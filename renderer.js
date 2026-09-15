// renderer.js — 控制条逻辑：字号缩放 / 自动翻页 / 快捷键
const webview = document.getElementById('weread');
const fontLabel = document.getElementById('fontLabel');
const fontMinus = document.getElementById('fontMinus');
const fontPlus = document.getElementById('fontPlus');
const intervalInput = document.getElementById('interval');
const autoToggle = document.getElementById('autoToggle');
const homeBtn = document.getElementById('homeBtn');
const rerenderBtn = document.getElementById('rerenderBtn');
const singlePageBtn = document.getElementById('singlePageBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const statusEl = document.getElementById('status');
const shelfEl = document.getElementById('shelf');
const loadingEl = document.getElementById('loading');
const libtabsEl = document.getElementById('libtabs');
const tabShelf = document.getElementById('tabShelf');
const tabStats = document.getElementById('tabStats');
const settingsBtn = document.getElementById('settingsBtn');
const statsEl = document.getElementById('stats');
const detailEl = document.getElementById('detail');
const settingsEl = document.getElementById('settings');

let mode = 'shelf';         // 'shelf' | 'reader'
let shelfBooted = false;    // 首次取数是否已发起
let currentVM = null;       // 当前视图模型
let pendingOpen = false;    // 正在打开某本书：等 reader 正文就绪再撤 loading
let libTab = 'shelf';       // 'shelf' | 'stats'，仅 mode==='shelf' 时有意义

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
    webview.executeJavaScript(zoomJs(fontSize)).catch(() => {});
  }
}

function setStatus(text, on) {
  statusEl.textContent = text || '';
  statusEl.className = on ? 'on' : '';
}

// ---- 书库层显隐（书架 / 统计 双 Tab 互斥；进阅读时整层撤下）----
function setLibraryMode(on) {
  document.body.classList.toggle('library-mode', !!on);
}
function showShelf() {
  mode = 'shelf'; libTab = 'shelf';
  setLibraryMode(true);
  shelfEl.classList.add('show');
  statsEl.classList.remove('show');
  tabShelf.classList.add('active'); tabStats.classList.remove('active');
}
function showStats() {
  mode = 'shelf'; libTab = 'stats';
  setLibraryMode(true);
  shelfEl.classList.remove('show');
  statsEl.classList.add('show');
  tabStats.classList.add('active'); tabShelf.classList.remove('active');
  loadStats();
}
function hideShelf() {          // 进阅读：撤下整个书库层（含顶栏）
  mode = 'reader';
  setLibraryMode(false);
  shelfEl.classList.remove('show');
  statsEl.classList.remove('show');
}

// ---- 全屏 loading（不透明盖住 webview，官方网页界面永不露出）----
function showLoading() { loadingEl.classList.add('show'); }
function hideLoading() { loadingEl.classList.remove('show'); }

// 轮询 reader 正文 canvas 是否就绪；就绪或超时后回调（超时兜底，绝不卡死）
function waitReaderReady(cb, timeoutMs) {
  const limit = timeoutMs || 6000;
  const start = Date.now();
  const timer = setInterval(async () => {
    let ready = false;
    try {
      ready = await webview.executeJavaScript("!!document.querySelector('.wr_canvasContainer canvas')");
    } catch (_) { ready = false; }
    if (ready || Date.now() - start > limit) { clearInterval(timer); cb(); }
  }, 120);
}

// 正文就绪：先在 loading 遮盖下撤书架层，再撤 loading，露出已渲染好的 reader
function revealReader() {
  hideShelf();
  hideLoading();
}

function openBook(vm) {
  const url = window.ShelfView.readerUrlFor(vm);
  // 盖不透明 loading 后再导航；等 reader 正文 canvas 就绪才撤，全程不露官方网页书架
  pendingOpen = true;
  showLoading();
  webview.loadURL(url).catch(() => {
    pendingOpen = false;
    hideLoading();
    setStatus('打开失败，请重试');
  });
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
    onRefresh: () => refreshShelf()
  });
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
async function loadStats() {
  const handlers = { onSettings: () => openSettings(), onOpenBook: (id) => openDetailById(id) };
  let cached = null;
  try { cached = await window.wereadPC.readStatsCache(); } catch (_) { cached = null; }
  if (cached) window.StatsView.render(statsEl, cached, handlers);
  else window.StatsView.render(statsEl, window.StatsData.buildStatsViewModel({ ok: false }, currentVM, new Date().getFullYear()), handlers);
  try { await tryAutoKey(); } catch (_) {}
  let bundle = null;
  try { bundle = await window.wereadPC.fetchStats(); } catch (_) { bundle = null; }
  const year = new Date().getFullYear();
  const vm = window.StatsData.buildStatsViewModel(bundle || { ok: false }, currentVM, year);
  window.StatsView.render(statsEl, vm, handlers);
  if (bundle && bundle.ok) { try { await window.wereadPC.writeStatsCache(vm); } catch (_) {} }
}

function startAuto() {
  const sec = Math.max(3, parseInt(intervalInput.value, 10) || 30);
  intervalInput.value = sec;
  autoTimer = setInterval(() => {
    webview.executeJavaScript(TURN_JS).catch(() => {});
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
  webview.executeJavaScript(TURN_PREV_JS).catch(() => {});
});
nextBtn.addEventListener('click', () => {
  webview.executeJavaScript(TURN_JS).catch(() => {});
});
rerenderBtn.addEventListener('click', () => {
  if (window.wereadPC) window.wereadPC.forceRerender();
  setTimeout(applyFont, 400); // 重排后补回缩放样式
});
singlePageBtn.addEventListener('click', () => {
  // 阅读器在窗口 <=1000px 时自动切单页（实测），中缝消失、正文字号等效变大
  if (window.wereadPC) window.wereadPC.setWindowWidth(1000);
});
homeBtn.addEventListener('click', () => {
  closeDetail();   // Task 10 定义
  showShelf();
  refreshShelf();  // 返回书架时后台刷新进度
});
tabShelf.addEventListener('click', () => { if (mode === 'shelf') showShelf(); });
tabStats.addEventListener('click', () => { if (mode === 'shelf') showStats(); });
settingsBtn.addEventListener('click', () => openSettings());
intervalInput.addEventListener('change', () => {
  if (autoTimer) { stopAuto(); startAuto(); } // 修改间隔后重启
});

window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 'ArrowRight') {
    webview.executeJavaScript(TURN_JS).catch(() => {});
  } else if (e.key === 'ArrowLeft') {
    webview.executeJavaScript(TURN_PREV_JS).catch(() => {});
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
  let cached = null;
  try { cached = await window.wereadPC.readShelfCache(); } catch (_) { cached = null; }
  if (cached && mode === 'shelf') {
    paintShelf(cached);
    showShelf();
  } else {
    showLoading();
  }
})();
