const { app, BrowserWindow, ipcMain, powerSaveBlocker, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const WereadAuth = require('./weread-auth.js');
const WereadApi = require('./weread-api.js');

let win = null;
let powerSaveId = null;
let guest = null;        // webview 的 webContents
let lastDisplayId = null;

// 跨屏拖动会改变 devicePixelRatio，而正文是 canvas 位图，不随 DPR 变化重绘 -> 字形错位
// 做法：换屏时派发 resize 事件 + 抖动 1px 触发真实重排，让阅读器重新排版
function forceRerender() {
  if (!win) return;
  const [w, h] = win.getSize();
  if (guest) guest.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  win.setSize(w, h + 1);
  setTimeout(() => win.setSize(w, h), 150);
}

// 应用数据（登录态、缓存）存到项目内，保持自包含
app.setPath('userData', path.join(__dirname, '.userdata'));

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

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'WeRead PC',
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  // 网页内新开链接 -> 在 webview 内打开，不弹新窗口
  win.webContents.on('did-attach-webview', (_, wc) => {
    guest = wc;
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

// 书籍详情缓存（按 bookId 分文件）
ipcMain.handle('book-cache-read', (_, bookId) => readJson(path.join(BOOK_CACHE_DIR, String(bookId) + '.json')));
ipcMain.handle('book-cache-write', (_, bookId, vm) => { ensureDir(BOOK_CACHE_DIR); return writeJson(path.join(BOOK_CACHE_DIR, String(bookId) + '.json'), vm); });

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
