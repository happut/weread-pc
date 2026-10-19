const { app, BrowserWindow, ipcMain, powerSaveBlocker, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const WereadAuth = require('./weread-auth.js');
const WereadApi = require('./weread-api.js');

let win = null;
let powerSaveId = null;
let guest = null;        // 最近附着的 webview webContents（兜底）
const guests = new Map(); // webContentsId -> webContents（多书 webview 保活）
let lastDisplayId = null;

// 阅读页 webview 用 persist:weread 分区。默认 Electron UA 含 "Electron/xx" 和 app 名，
// 被官方识别为非标准客户端后不计阅读时长。这里伪装成标准桌面 Chrome，使时长正常上报。
const WEREAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function resolveGuest(webContentsId) {
  if (webContentsId != null && webContentsId !== '') {
    const g = guests.get(Number(webContentsId));
    if (g && !g.isDestroyed()) return g;
    return null;
  }
  // 未指定 id：优先未销毁的任一 guest
  for (const g of guests.values()) {
    if (!g.isDestroyed()) return g;
  }
  return guest && !guest.isDestroyed() ? guest : null;
}

// 跨屏拖动会改变 devicePixelRatio，而正文是 canvas 位图，不随 DPR 变化重绘 -> 字形错位
// 做法：换屏时派发 resize 事件 + 抖动 1px 触发真实重排，让阅读器重新排版
function forceRerender() {
  if (!win) return;
  const [w, h] = win.getSize();
  for (const g of guests.values()) {
    if (!g.isDestroyed()) g.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  }
  if (guest && !guest.isDestroyed() && !guests.has(guest.id)) {
    guest.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  }
  win.setSize(w, h + 1);
  setTimeout(() => win.setSize(w, h), 150);
}

// 应用数据（登录态、缓存）路径：
// - 开发态（electron .）：存项目内 .userdata，保持自包含
// - 安装态（.app 包内）：存 ~/Library/Application Support/WeRead-PC。
//   不能继续用 __dirname/.userdata —— 那会落到 /Applications/.../Resources/app/ 下，
//   包内不可靠（重装即丢），且读不到开发期配置，统计页会报「未连接微信读书」
const isInstalled = app.isPackaged || !process.defaultApp || String(__dirname).includes('.app/Contents/Resources');
const userDataDir = isInstalled
  ? path.join(app.getPath('appData'), 'WeRead-PC')
  : path.join(__dirname, '.userdata');
app.setPath('userData', userDataDir);

// 升级迁移：老版本把数据放在 app 包内 __dirname/.userdata，首次用新路径时搬过来，
// 避免重装/升级后丢失登录态、API Key 与缓存（目标已有同名文件时不覆盖，以新路径为准）
function migrateLegacyUserData() {
  const legacy = path.join(__dirname, '.userdata');
  if (!isInstalled || path.resolve(legacy) === path.resolve(userDataDir)) return;
  if (!fs.existsSync(legacy)) return;
  const hasOwn = fs.existsSync(path.join(userDataDir, 'auth.json')) || fs.existsSync(path.join(userDataDir, 'Cookies'));
  if (hasOwn) return;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    for (const name of fs.readdirSync(legacy)) {
      const src = path.join(legacy, name);
      const dst = path.join(userDataDir, name);
      if (fs.existsSync(dst)) continue;
      fs.cpSync(src, dst, { recursive: true });
    }
    console.log('[userData] migrated legacy data ->', userDataDir);
  } catch (e) {
    console.warn('[userData] migrate failed:', e && e.message);
  }
}
migrateLegacyUserData();

// 书架缓存目录（跟随 userData，位于 .userdata/shelf-cache/，已被 .gitignore 忽略）
const SHELF_CACHE_DIR = path.join(app.getPath('userData'), 'shelf-cache');
function ensureShelfCacheDir() {
  try { fs.mkdirSync(SHELF_CACHE_DIR, { recursive: true }); } catch (_) {}
}

// auth / 统计 / 详情缓存（均在 .userdata/ 下，已 gitignore）
const AUTH_PATH = path.join(app.getPath('userData'), 'auth.json');
const STATS_CACHE_DIR = path.join(app.getPath('userData'), 'stats-cache');
const BOOK_CACHE_DIR = path.join(app.getPath('userData'), 'book-cache');
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
function readJson(p) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (_) { return null; } }
function writeJson(p, v) { try { fs.writeFileSync(p, JSON.stringify(v), 'utf8'); return true; } catch (_) { return false; } }
// 缓存文件名白名单清洗：防止 bookId 含 ../ 等造成路径穿越（防御纵深）
function safeCacheName(id) { return String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128) || '_unknown'; }

function createWindow() {
  // 必须在 webview 加载前设置该分区的 UA，否则首屏请求仍走默认 Electron UA
  session.fromPartition('persist:weread').setUserAgent(WEREAD_UA);

  win = new BrowserWindow({
    // 默认单页展示：阅读器在宽 ≤1000px 时自动单页（消除双页中缝）；
    // 想双页时手动拉宽窗口即可
    width: 1000,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'WeRead PC',
    // 去掉系统标题栏，红绿灯嵌进左侧栏头部（隐藏 inset）
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  // 网页内新开链接 -> 在 webview 内打开，不弹新窗口；登记多 book webContents
  win.webContents.on('did-attach-webview', (_, wc) => {
    guest = wc;
    guests.set(wc.id, wc);
    wc.once('destroyed', () => { guests.delete(wc.id); });
    // 重置可能被持久化的页面级缩放（会破坏 canvas 渲染，产生字形错位）
    wc.setZoomFactor(1);
    wc.setWindowOpenHandler(({ url }) => {
      if (url && url.startsWith('http')) wc.loadURL(url);
      return { action: 'deny' };
    });
  });

  // 跨屏拖动后强制重绘，修复 canvas 字形错位
  lastDisplayId = screen.getDisplayMatching(win.getBounds()).id;
  win.on('moved', () => {
    const d = screen.getDisplayMatching(win.getBounds());
    if (d.id !== lastDisplayId) {
      lastDisplayId = d.id;
      setTimeout(forceRerender, 250); // 等系统完成 DPR 切换
    }
  });
}

ipcMain.handle('power-save', (_, on) => {
  if (on) {
    if (powerSaveId === null) {
      powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return true;
  }
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
  return false;
});

ipcMain.handle('force-rerender', () => {
  forceRerender();
  return true;
});

// 向 webview guest 注入真实鼠标点击（isTrusted），用于点那些无视合成 .click() 的阅读页控件。
// webContentsId 指定目标 book webview（多书保活时点当前那本）；x/y 为 guest 视口内 CSS 像素。
ipcMain.handle('guest-click', (_, webContentsId, x, y) => {
  const g = resolveGuest(webContentsId);
  if (!g) return false;
  const px = Math.round(Number(x)), py = Math.round(Number(y));
  if (!isFinite(px) || !isFinite(py)) return false;
  try {
    g.sendInputEvent({ type: 'mouseMove', x: px, y: py });
    g.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
    g.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
    return true;
  } catch (_) { return false; }
});

// 向 webview guest 注入真实鼠标移动（isTrusted），用于唤出会自动隐藏的阅读页工具栏。
ipcMain.handle('guest-move', (_, webContentsId, x, y) => {
  const g = resolveGuest(webContentsId);
  if (!g) return false;
  const px = Math.round(Number(x)), py = Math.round(Number(y));
  if (!isFinite(px) || !isFinite(py)) return false;
  try { g.sendInputEvent({ type: 'mouseMove', x: px, y: py }); return true; }
  catch (_) { return false; }
});

// 把窗口宽度调到单页模式阈值（≤1000px 时阅读器自动单页，消除双页中缝）
ipcMain.handle('set-window-width', (_, width) => {
  if (!win) return false;
  // 读内容高度（getContentSize）与 setContentSize 配对；若误用 getSize（外层含标题栏）
  // 会把外层高当内容高写入，每点一次窗口就累加一个标题栏高度
  const height = win.getContentSize()[1];
  win.setContentSize(Math.min(1600, Math.max(800, width)), height);
  return true;
});

// 读取书架缓存（视图模型），无缓存或损坏返回 null
ipcMain.handle('shelf-cache-read', () => {
  try {
    const p = path.join(SHELF_CACHE_DIR, 'shelf.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return null; }
});

// 写入书架缓存（视图模型）
ipcMain.handle('shelf-cache-write', (_, viewModel) => {
  try {
    ensureShelfCacheDir();
    const p = path.join(SHELF_CACHE_DIR, 'shelf.json');
    fs.writeFileSync(p, JSON.stringify(viewModel), 'utf8');
    return true;
  } catch (_) { return false; }
});

// 认证：auth.json（自动 Key + 手动覆盖 + 失效标记 + 来源 + 更新时间；敏感，不打印）
ipcMain.handle('auth-read', () => readJson(AUTH_PATH));
ipcMain.handle('auth-write', (_, auth) => writeJson(AUTH_PATH, auth || {}));

// 统计缓存（看板视图模型）
ipcMain.handle('stats-cache-read', () => readJson(path.join(STATS_CACHE_DIR, 'stats.json')));
ipcMain.handle('stats-cache-write', (_, vm) => { ensureDir(STATS_CACHE_DIR); return writeJson(path.join(STATS_CACHE_DIR, 'stats.json'), vm); });

// 临时探针落盘（定位阅读页模式控件选择器），用完即删
ipcMain.handle('probe-write', (_, text) => {
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'modeprobe.json'), String(text), 'utf8'); return true; }
  catch (_) { return false; }
});

// 书籍详情缓存（按 bookId 分文件）
ipcMain.handle('book-cache-read', (_, bookId) => readJson(path.join(BOOK_CACHE_DIR, safeCacheName(bookId) + '.json')));
ipcMain.handle('book-cache-write', (_, bookId, vm) => { ensureDir(BOOK_CACHE_DIR); return writeJson(path.join(BOOK_CACHE_DIR, safeCacheName(bookId) + '.json'), vm); });

// Agent 取数：主进程读 auth → resolveAuth → key 模式才能走网关（cookie 模式无法驱动 Bearer 网关，降级）
function resolveCurrentAuth() { return WereadAuth.resolveAuth(readJson(AUTH_PATH) || {}); }
ipcMain.handle('weread-fetch-stats', async () => {
  const r = resolveCurrentAuth();
  if (r.mode !== 'key') return { ok: false, reason: 'no-key' };
  try { return await WereadApi.fetchStatsBundle(r.key); }
  catch (e) { return { ok: false, reason: 'fetch-failed', message: String((e && e.message) || e) }; }
});
ipcMain.handle('weread-fetch-book', async (_, bookId) => {
  const r = resolveCurrentAuth();
  if (r.mode !== 'key') return { ok: false, reason: 'no-key' };
  try { return await WereadApi.fetchBookBundle(r.key, String(bookId)); }
  catch (e) { return { ok: false, reason: 'fetch-failed', message: String((e && e.message) || e) }; }
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
