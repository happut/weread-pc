const { app, BrowserWindow, ipcMain, nativeTheme, net, powerSaveBlocker, screen, session, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const WereadAuth = require('./weread-auth.js');
const WereadApi = require('./weread-api.js');
const { compareVersions, pickAsset } = require('./update-data.js');

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
const IDENTITY_PATH = path.join(app.getPath('userData'), 'identity.json');
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
    // Windows/Linux 窗口与任务栏图标；macOS 用 .icns（忽略此项）
    icon: path.join(__dirname, 'assets', 'icons', 'icon-b-cat-book-512.png'),
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

// 退出登录：只清 weread 分区的 Cookie（auth.json 里的统计 Key 不动）
ipcMain.handle('logout', async () => {
  try {
    await session.fromPartition('persist:weread').clearStorageData({ storages: ['cookies'] });
    return true;
  } catch (_) { return false; }
});

// 外观：system/light/dark → nativeTheme，壳页 CSS 的 prefers-color-scheme 随之切换
ipcMain.handle('set-theme', (_, v) => {
  nativeTheme.themeSource = (v === 'light' || v === 'dark') ? v : 'system';
  return nativeTheme.themeSource;
});

// 清除本地缓存：书架 / 统计 / 书籍详情 / 身份四个缓存整体删除
ipcMain.handle('clear-cache', () => {
  let ok = true;
  for (const dir of [SHELF_CACHE_DIR, STATS_CACHE_DIR, BOOK_CACHE_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { ok = false; }
  }
  try { fs.rmSync(IDENTITY_PATH, { force: true }); } catch (_) { ok = false; }
  return ok;
});

// 侧栏身份条缓存（昵称/头像/资深会员），几乎不变，单独一个文件
ipcMain.handle('identity-cache-read', () => readJson(IDENTITY_PATH));
ipcMain.handle('identity-cache-write', (_, vm) => writeJson(IDENTITY_PATH, vm));

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

// 自己的昵称/头像只能从个人点评回包的 author 取；一条点评都没有时确实取不到
ipcMain.handle('weread-fetch-identity', async () => {
  const r = resolveCurrentAuth();
  if (r.mode !== 'key') return { ok: false, reason: 'no-key' };
  try {
    const identity = await WereadApi.fetchIdentity(r.key);
    return identity ? { ok: true, identity, fetchedAt: Date.now() } : { ok: false, reason: 'no-identity' };
  }
  catch (e) { return { ok: false, reason: 'fetch-failed', message: String((e && e.message) || e) }; }
});

// ---- 检查更新与一键更新（源：GitHub releases）----
ipcMain.handle('app-version', () => app.getVersion());
const RELEASE_API = 'https://api.github.com/repos/happut/weread-pc/releases/latest';
const RELEASE_PAGE = 'https://github.com/happut/weread-pc/releases/latest';
let updating = false;

function sendUpdateProgress(p) {
  if (win && !win.isDestroyed()) win.webContents.send('update-progress', p);
}

ipcMain.handle('update-check', async () => {
  const current = app.getVersion();
  try {
    const res = await net.fetch(RELEASE_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'WeRead-PC-update' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { ok: false, current, message: 'GitHub 返回 HTTP ' + res.status };
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    if (!latest) return { ok: false, current, message: 'release 回包缺少 tag_name' };
    const asset = pickAsset(rel.assets, process.platform, process.arch);
    return {
      ok: true,
      current,
      latest,
      newer: compareVersions(current, latest) < 0,
      notes: String(rel.body || ''),
      page: String(rel.html_url || RELEASE_PAGE),
      asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null
    };
  } catch (e) {
    return { ok: false, current, message: String((e && e.message) || e) };
  }
});

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      if (e) reject(new Error(String(stderr || e.message).trim()));
      else resolve(stdout);
    });
  });
}

// 安装态 exe 形如 /Applications/WeRead-PC.app/Contents/MacOS/WeRead-PC，向上找 .app 包根
function currentBundlePath() {
  let p = app.getPath('exe');
  while (p && p !== path.dirname(p)) {
    if (p.endsWith('.app')) return p;
    p = path.dirname(p);
  }
  return null;
}

async function downloadZip(url, dest) {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error('下载返回 HTTP ' + res.status);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  let lastPct = -1;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    if (total) {
      const pct = Math.min(99, Math.floor(got * 100 / total));
      if (pct !== lastPct) { lastPct = pct; sendUpdateProgress({ phase: 'download', percent: pct }); }
    }
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

// 一键更新：下载 zip → 解压校验 → 旧包备份到 /tmp → ditto 替换 → 重启。
// 仅 darwin 安装态；其余情况返回 manual 让渲染层给下载页链接。
ipcMain.handle('update-apply', async (_, info) => {
  if (updating) return { ok: false, message: '更新正在进行中' };
  const current = app.getVersion();
  const latest = String((info && info.latest) || '');
  const url = String((info && info.url) || '');
  if (!latest || compareVersions(current, latest) >= 0) return { ok: false, message: '已是最新，无需更新' };
  if (!/^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(url)) return { ok: false, message: '下载地址不合法' };
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return {
      ok: false,
      manual: true,
      page: RELEASE_PAGE,
      message: process.platform !== 'darwin' ? '当前平台仅支持手动下载更新' : '开发态不支持自更新，请使用安装版'
    };
  }
  const bundle = currentBundlePath();
  if (!bundle) return { ok: false, message: '定位当前应用包失败' };
  updating = true;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'weread-update-'));
  try {
    sendUpdateProgress({ phase: 'download', percent: 0 });
    const zip = path.join(tmp, 'update.zip');
    await downloadZip(url, zip);
    sendUpdateProgress({ phase: 'install' });
    const extract = path.join(tmp, 'extract');
    await execFileP('ditto', ['-x', '-k', zip, extract]);
    const srcApp = path.join(extract, 'WeRead-PC.app');
    if (!fs.existsSync(path.join(srcApp, 'Contents', 'Info.plist'))) throw new Error('安装包内未找到 WeRead-PC.app');
    const base = path.basename(bundle, '.app');
    const stamp = new Date().toISOString().slice(0, 10);
    let backup = path.join(os.tmpdir(), base + '.bak-' + stamp + '.app');
    for (let i = 2; fs.existsSync(backup); i++) backup = path.join(os.tmpdir(), base + '.bak-' + stamp + '-' + i + '.app');
    fs.renameSync(bundle, backup);
    try {
      // ditto 保留签名与权限位，cp 会丢扩展属性
      await execFileP('ditto', [srcApp, bundle]);
      if (!fs.existsSync(path.join(bundle, 'Contents', 'Info.plist'))) throw new Error('替换后校验失败');
    } catch (e) {
      fs.renameSync(backup, bundle);
      throw e;
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    app.relaunch();
    app.exit(0);
    return { ok: true };
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    updating = false;
    return { ok: false, message: String((e && e.message) || e) };
  }
});

// 手动下载兜底：只允许打开 GitHub 域链接
ipcMain.handle('update-open-page', (_, url) => {
  const u = String(url || '');
  if (!/^https:\/\/github\.com\//.test(u)) return false;
  shell.openExternal(u);
  return true;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
