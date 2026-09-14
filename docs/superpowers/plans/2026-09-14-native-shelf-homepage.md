# 原生书架首页 v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 启动即显示一个自有的、清爽好看的原生书架首页（数据来自 `/web/shelf/sync`），点书进入 webview 阅读，「书架」按钮返回，秒开且可离线兜底。

**Architecture:** webview 一物两用——既提供 `weread.qq.com` 同源取数上下文，又承载阅读。书架是一个盖在 webview 之上的全屏原生 DOM 覆盖层（clean grid 风格）。现有工具栏、阅读器控件、webview 基本不动，仅新增覆盖层 + 复用 `homeBtn` 作返回。数据经纯函数层转成视图模型，落地 `.userdata/shelf-cache/` 做秒开缓存。

**Tech Stack:** Electron 33（webview、ipcMain/ipcRenderer、session.webRequest）、原生 JS（无框架、无打包，`<script>` 直接加载）、`node:test`（零依赖单测）。

**关联设计文档:** `docs/superpowers/specs/2026-09-14-native-shelf-homepage-design.md`

---

## 文件结构（本次新增/修改）

**新增：**
- `shelf-data.js` — 纯函数：原始 JSON → 视图模型 + 统计（浏览器挂 `window.ShelfData`，node 可 `require`）
- `shelf-fetch.js` — 经 webview 同源取数 + 缓存编排（浏览器挂 `window.ShelfFetch`，node 可 `require`）
- `shelf-view.js` — 清爽网格 DOM 渲染 + 虚拟滚动 + 封面懒加载（浏览器挂 `window.ShelfView`）
- `test/shelf-data.test.js` — `shelf-data` 单测
- `test/shelf-fetch.test.js` — `shelf-fetch` 单测（用 stub webview/api）
- `test/shelf-view.test.js` — 虚拟滚动纯函数 `computeRange` 单测
- `test/fixtures/shelf-sample.json` — **合成**书架样本（不含真实阅读历史）
- `probe-cover.js` — Spike：验证封面直连是否需要 Referer

**修改：**
- `index.html` — 新增书架覆盖层 DOM + clean grid CSS + 3 个 `<script>` 引用
- `renderer.js` — 新增视图切换（show/hide 覆盖层）、dom-ready 取数、点击进阅读、`homeBtn` 复用为返回、刷新
- `main.js` — 新增缓存读写 IPC（`shelf-cache-read`/`shelf-cache-write`）；（条件）封面 Referer 注入
- `preload.js` — 暴露 `readShelfCache`/`writeShelfCache`

**职责边界：** `shelf-data` 只算不碰 DOM/网络；`shelf-fetch` 只管取数与缓存；`shelf-view` 只管把视图模型画成 DOM；`renderer.js` 只做编排与视图切换。四者通过明确接口通信，可独立测试/替换。

---

## Task 1: Spike — 封面直连 & reader URL 直达

**目的：** 先验证两个影响后续写法的关键事实，再动手：
1. **封面**：宿主页面直连 `cdn.weread.qq.com` 是否被 Referer 校验挡（决定是否需要 Task 8 注入 Referer）。
2. **reader URL**：点书应该 `loadURL` 哪个地址才能**直达 canvas 阅读器**（`deepLink` 指向 book-detail 详情页，可能需再点一次「阅读」，破坏「点封面即读」体验）。决定 Task 5 `readerUrlFor` 的返回形式。

**Files:**
- Create: `probe-cover.js`（封面 Referer 校验）
- Create: `probe-reader3.js`（从官方书架页发现真实 reader URL 模式）
- Create: `probe-reader4.js`（验证 deepLink 的 `v` → `/web/reader/<v>` 映射）
- 依赖本地已存在的 `/tmp/weread_shelf_full.json`（由 probe-shelf3.js 生成；若无，先 `npx electron probe-shelf3.js`）

> 运行探针前请**先关闭正在运行的 app**，避免 `persist:weread` 分区被占用。

- [ ] **Step 1: 写探针脚本**

创建 `probe-cover.js`：

```js
// probe-cover.js — 验证 cdn.weread.qq.com 封面是否校验 Referer
// 运行：npx electron probe-cover.js
const { app, net } = require('electron');
const fs = require('fs');

function pickCoverUrl() {
  const p = '/tmp/weread_shelf_full.json';
  if (!fs.existsSync(p)) { console.error('缺少 /tmp/weread_shelf_full.json，请先运行 probe-shelf3.js'); return null; }
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const b = (d.books || []).find(x => x.cover);
  return b ? b.cover : null;
}

app.whenReady().then(async () => {
  const url = pickCoverUrl();
  if (!url) { app.quit(); return; }
  console.log('cover url =', url);
  const probe = async (label, headers) => {
    try {
      const r = await net.fetch(url, { headers });
      const ct = r.headers.get('content-type');
      console.log(`[${label}] status=${r.status} content-type=${ct}`);
    } catch (e) {
      console.log(`[${label}] ERROR ${e.message}`);
    }
  };
  await probe('no-referer', {});                                   // ≈ file:// 页面里的 <img>
  await probe('with-referer', { Referer: 'https://weread.qq.com/' }); // 注入 Referer 后
  app.quit();
});
```

- [ ] **Step 2: 运行探针**

Run: `npx electron probe-cover.js`

Expected 输出两行 `[no-referer]` 与 `[with-referer]` 的 status。

- [ ] **Step 3: 按封面结果记录决策**

判定规则：
- 若 `[no-referer] status=200` → **封面可直连**，Task 8（Referer 注入）**跳过**，`shelf-view` 直接用远程 URL 作 `<img src>`。
- 若 `[no-referer]` 非 200 但 `[with-referer] status=200` → **需要注入 Referer**，Task 8 **必须做**。
- 若两者都非 200 → 记为异常，采用设计文档兜底 B（经 webview 转 base64），在本计划末尾追加应急任务（先不展开，YAGNI，等真遇到再补）。

- [x] **Step 4: 发现 reader URL 模式（probe-reader3.js）**

> 实测记录：最初猜的两个候选都失败——`web/reader?bookId=<数字id>` 直接 **服务器 404**；book-detail 点「阅读」跳 `#/download`（SPA 内部路由，不可直连）。于是加载官方书架页取证。

创建并运行 `probe-reader3.js`（加载 `web/shelf`，dump 所有 `a[href]` + 点击首个书卡观察跳转）：

Run: `npx electron probe-reader3.js`

**实测结论：** 书架页每本书是 `<a class="shelfBook" href="/web/reader/<TOKEN>">`；点击后跳 `https://weread.qq.com/web/reader/<TOKEN>`，`title=书名`、`canvasCount=1`、`hasWrCanvas=true`。`<TOKEN>` 不是数字 bookId，而与 `deepLink` 的 `v=` 参数同格式。

- [x] **Step 5: 验证映射（probe-reader4.js）**

**假设：** `readerUrl = https://weread.qq.com/web/reader/<v>`，`<v>` 从该书 `deepLink` 的 `v=` 提取。创建并运行 `probe-reader4.js`（取 3 本有进度的书，提取 `v` → 加载 `/web/reader/<v>` → 校验 canvas + 标题命中）：

```js
// 核心：从 deepLink 提取 v，拼成 reader URL
const v = (b.deepLink.match(/[?&]v=([^&]+)/) || [])[1] || '';
const url = 'https://weread.qq.com/web/reader/' + v;
```

Run: `npx electron probe-reader4.js`

**实测结论：** 3/3 命中（数字 id `3300202587`、短 id `695233`、`CB_` 前缀各一），`canvasOK=true` 且 `titleHit=true`。假设成立。

- [x] **Step 6: 确认结论，回写 `readerUrlFor`**

两个 spike 的最终决策：
- **封面**：`no-referer` 实测 `status=200` → 封面可直连，**Task 8 跳过**，`shelf-view` 直接用远程 URL 作 `<img src>`。
- **reader URL**：确认 `https://weread.qq.com/web/reader/<v>`（`v` 来自 `deepLink`）。这是纯函数可算的，故**放在 `shelf-data` 层**（可单测）：`toBookVM` 增加 `readerUrl` 字段，新增纯函数 `readerUrlFromDeepLink(deepLink)`；Task 5 `readerUrlFor(vm)` 改为返回 `vm.readerUrl`（回退 `vm.deepLink`）。

- [ ] **Step 7: 提交探针**

```bash
git add probe-cover.js probe-reader3.js probe-reader4.js
git commit -m "chore: 新增封面/reader URL 直达探针（spike，确认 /web/reader/<v> 映射）"
```

---

## Task 2: shelf-data.js 纯函数 + 单测（TDD）

**Files:**
- Create: `test/fixtures/shelf-sample.json`
- Create: `test/shelf-data.test.js`
- Create: `shelf-data.js`

- [ ] **Step 1: 写合成 fixture（不含真实阅读历史）**

创建 `test/fixtures/shelf-sample.json`：

```json
{
  "bookCount": 4,
  "books": [
    {"bookId":"b1","title":"书一","author":"甲","cover":"https://cdn.weread.qq.com/x1.jpg","deepLink":"https://weread.qq.com/book-detail?v=1","readUpdateTime":300,"updateTime":100,"finishReading":0},
    {"bookId":"b2","title":"书二","author":"乙","cover":"https://cdn.weread.qq.com/x2.jpg","deepLink":"https://weread.qq.com/book-detail?v=2","readUpdateTime":200,"updateTime":90,"finishReading":1},
    {"bookId":"b3","title":"书三","author":"丙","deepLink":"https://weread.qq.com/book-detail?v=3","updateTime":50},
    {"bookId":"b4","title":"书四","author":"丁","cover":"https://cdn.weread.qq.com/x4.jpg","deepLink":"https://weread.qq.com/book-detail?v=4","updateTime":40,"finishReading":0}
  ],
  "bookProgress": [
    {"bookId":"b1","progress":40,"readingTime":3600,"updateTime":300},
    {"bookId":"b2","progress":100,"readingTime":7200,"updateTime":200},
    {"bookId":"b4","progress":0,"readingTime":0,"updateTime":10}
  ]
}
```

- [ ] **Step 2: 写失败测试**

创建 `test/shelf-data.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const raw = require('./fixtures/shelf-sample.json');
const { buildViewModel } = require('../shelf-data.js');

test('stats: 在读/读完/累计小时', () => {
  const vm = buildViewModel(raw);
  assert.strictEqual(vm.stats.reading, 1);    // 只有 b1（progress 40，未读完）
  assert.strictEqual(vm.stats.finished, 1);   // b2（finishReading=1 且 progress=100）
  assert.strictEqual(vm.stats.totalHours, 3); // (3600+7200+0)/3600 = 3
});

test('continueReading: 有进度者按 progress.updateTime 倒序', () => {
  const vm = buildViewModel(raw);
  assert.deepStrictEqual(vm.continueReading.map(b => b.bookId), ['b1', 'b2', 'b4']);
});

test('allBooks: 有 readUpdateTime 者在前并按其倒序，其余按 updateTime 倒序殿后', () => {
  const vm = buildViewModel(raw);
  assert.deepStrictEqual(vm.allBooks.map(b => b.bookId), ['b1', 'b2', 'b3', 'b4']);
});

test('toBookVM: 缺 cover 也不报错，progress 默认 0', () => {
  const vm = buildViewModel(raw);
  const b3 = vm.allBooks.find(b => b.bookId === 'b3');
  assert.strictEqual(b3.cover, '');
  assert.strictEqual(b3.progress, 0);
});

test('readerUrl: 从 deepLink 的 v 参数拼出 /web/reader/<v>', () => {
  const vm = buildViewModel(raw);
  const b1 = vm.allBooks.find(b => b.bookId === 'b1');
  assert.strictEqual(b1.readerUrl, 'https://weread.qq.com/web/reader/1');
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `node --test test/shelf-data.test.js`
Expected: FAIL —— `Cannot find module '../shelf-data.js'`。

- [ ] **Step 4: 写最小实现**

创建 `shelf-data.js`：

```js
// shelf-data.js — 纯函数：/web/shelf/sync 原始 JSON → 书架视图模型
// 浏览器：挂 window.ShelfData；node：module.exports（供单测）
(function (root) {
  'use strict';

  function buildProgressMap(raw) {
    const m = new Map();
    for (const p of (raw.bookProgress || [])) m.set(String(p.bookId), p);
    return m;
  }

  // 读完定义：finishReading===1 或 progress>=100（不使用 book.finished，那是"作品是否完结"而非"用户是否读完"）
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
    return {
      bookId: String(b.bookId),
      title: b.title || '',
      author: b.author || '',
      cover: b.cover || '',
      progress: p && typeof p.progress === 'number' ? p.progress : 0,
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

  function buildViewModel(raw, opts) {
    const limit = (opts && opts.continueLimit) || 6;
    const pm = buildProgressMap(raw || {});
    return {
      stats: computeStats(raw || {}, pm),
      continueReading: buildContinueReading(raw || {}, pm, limit),
      allBooks: buildAllBooks(raw || {}, pm),
      bookCount: (raw && raw.bookCount) || ((raw && raw.books) ? raw.books.length : 0),
      fetchedAt: Date.now()
    };
  }

  const api = { buildViewModel, computeStats, buildContinueReading, buildAllBooks, toBookVM, buildProgressMap, readerUrlFromDeepLink };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShelfData = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `node --test test/shelf-data.test.js`
Expected: PASS（5 tests）。

- [ ] **Step 6: 提交**

```bash
git add shelf-data.js test/shelf-data.test.js test/fixtures/shelf-sample.json
git commit -m "feat: shelf-data 纯函数（视图模型+统计）及单测"
```

---

## Task 3: 缓存 IPC（main.js + preload.js）

**Files:**
- Modify: `main.js`（新增 `fs` 引入、缓存目录、两个 IPC handler）
- Modify: `preload.js`（暴露两个方法）

- [ ] **Step 1: main.js 顶部引入 fs 并定义缓存目录**

在 `main.js` 第 2 行 `const path = require('path');` 之后新增一行：

```js
const fs = require('fs');
```

在 `app.setPath('userData', path.join(__dirname, '.userdata'));`（第 20 行）之后新增：

```js
// 书架缓存目录（跟随 userData，位于 .userdata/shelf-cache/，已被 .gitignore 忽略）
const SHELF_CACHE_DIR = path.join(app.getPath('userData'), 'shelf-cache');
function ensureShelfCacheDir() {
  try { fs.mkdirSync(SHELF_CACHE_DIR, { recursive: true }); } catch (_) {}
}
```

- [ ] **Step 2: main.js 新增两个 IPC handler**

在 `ipcMain.handle('set-window-width', ...)`（第 81-86 行）之后、`app.whenReady()`（第 88 行）之前新增：

```js
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
```

- [ ] **Step 3: preload.js 暴露方法**

把 `preload.js` 的 `contextBridge.exposeInMainWorld` 对象改为（新增最后两行）：

```js
contextBridge.exposeInMainWorld('wereadPC', {
  setPowerSave: (on) => ipcRenderer.invoke('power-save', on),
  forceRerender: () => ipcRenderer.invoke('force-rerender'),
  setWindowWidth: (width) => ipcRenderer.invoke('set-window-width', width),
  readShelfCache: () => ipcRenderer.invoke('shelf-cache-read'),
  writeShelfCache: (vm) => ipcRenderer.invoke('shelf-cache-write', vm)
});
```

- [ ] **Step 4: 冒烟验证（应用能启动、无语法错误）**

Run: `npm run start`
Expected: 应用正常启动，无控制台报错（缓存此时还未被调用，仅验证不破坏现有启动）。关闭应用。

- [ ] **Step 5: 提交**

```bash
git add main.js preload.js
git commit -m "feat: 新增书架缓存读写 IPC（.userdata/shelf-cache）"
```

--

## Task 4: shelf-fetch.js 取数桥 + 单测（TDD）

**Files:**
- Create: `test/shelf-fetch.test.js`
- Create: `shelf-fetch.js`

- [ ] **Step 1: 写失败测试（用 stub webview / stub api，不依赖 Electron）**

创建 `test/shelf-fetch.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
// shelf-fetch 依赖 ShelfData（浏览器里是 window.ShelfData）；node 下手动注入
const ShelfData = require('../shelf-data.js');
globalThis.ShelfData = ShelfData;
const { loadShelf } = require('../shelf-fetch.js');
const raw = require('./fixtures/shelf-sample.json');

function stubWebview(payloadText, { reject = false } = {}) {
  return {
    executeJavaScript: async () => {
      if (reject) throw new Error('net down');
      return payloadText;
    }
  };
}

function stubApi(cache) {
  const store = { written: null };
  return {
    store,
    readShelfCache: async () => cache,
    writeShelfCache: async (vm) => { store.written = vm; return true; }
  };
}

test('loadShelf: 取到新数据 → fresh 有值并写缓存', async () => {
  const wv = stubWebview(JSON.stringify(raw));
  const api = stubApi(null);
  const r = await loadShelf(wv, api);
  assert.ok(r.fresh);
  assert.strictEqual(r.fresh.stats.reading, 1);
  assert.strictEqual(r.err, null);
  assert.ok(api.store.written); // 已写缓存
});

test('loadShelf: 取数失败但有缓存 → 返回 cached + err', async () => {
  const cachedVm = ShelfData.buildViewModel(raw);
  const wv = stubWebview(null, { reject: true });
  const api = stubApi(cachedVm);
  const r = await loadShelf(wv, api);
  assert.strictEqual(r.fresh, null);
  assert.ok(r.cached);
  assert.ok(r.err);
});

test('loadShelf: 载荷非法（无 books）→ 抛错视为失败', async () => {
  const wv = stubWebview(JSON.stringify({ foo: 1 }));
  const api = stubApi(null);
  const r = await loadShelf(wv, api);
  assert.strictEqual(r.fresh, null);
  assert.ok(r.err);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/shelf-fetch.test.js`
Expected: FAIL —— `Cannot find module '../shelf-fetch.js'`。

- [ ] **Step 3: 写最小实现**

创建 `shelf-fetch.js`：

```js
// shelf-fetch.js — 经 webview 同源上下文取书架 + 缓存编排
// 浏览器：挂 window.ShelfFetch；node：module.exports（供单测）
// 依赖：root.ShelfData（buildViewModel）
(function (root) {
  'use strict';

  // 在 webview 页面上下文里执行：同源 cookie fetch，返回文本（executeJavaScript 会等待返回的 Promise）
  const FETCH_JS =
    "fetch('/web/shelf/sync', { credentials: 'include' })" +
    ".then(function (r) { return r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)); })";

  async function fetchShelf(webview) {
    const text = await webview.executeJavaScript(FETCH_JS);
    const raw = JSON.parse(text);
    if (!raw || !Array.isArray(raw.books)) throw new Error('shelf payload invalid');
    return raw;
  }

  // 返回 { cached, fresh, err }：cached=上次视图模型；fresh=本次视图模型（失败为 null）；err=本次错误（成功为 null）
  async function loadShelf(webview, api) {
    let cached = null;
    try { cached = await api.readShelfCache(); } catch (_) { cached = null; }

    let fresh = null, err = null;
    try {
      const raw = await fetchShelf(webview);
      fresh = root.ShelfData.buildViewModel(raw);
      try { await api.writeShelfCache(fresh); } catch (_) {}
    } catch (e) {
      err = e;
    }
    return { cached, fresh, err };
  }

  const out = { fetchShelf, loadShelf, FETCH_JS };
  if (typeof module !== 'undefined' && module.exports) module.exports = out;
  else root.ShelfFetch = out;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test test/shelf-fetch.test.js`
Expected: PASS（3 tests）。

- [ ] **Step 5: 跑全部单测，确认无回归**

Run: `node --test test/`
Expected: 全部 PASS（shelf-data 4 + shelf-fetch 3）。

- [ ] **Step 6: 提交**

```bash
git add shelf-fetch.js test/shelf-fetch.test.js
git commit -m "feat: shelf-fetch 取数桥（webview 同源 fetch + 缓存编排）及单测"
```

---

## Task 5: shelf-view.js — 虚拟滚动纯函数 + 渲染

**Files:**
- Create: `test/shelf-view.test.js`
- Create: `shelf-view.js`

> 说明：DOM 渲染无法在 node 下单测，但**可视行区间计算**是纯函数，抽出来单测（TDD）。DOM 部分在 Task 7 集成后手动验收。

- [ ] **Step 1: 写失败测试（computeRange 纯函数）**

创建 `test/shelf-view.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert');
const { computeRange } = require('../shelf-view.js');

test('computeRange: 顶部', () => {
  // rowHeight=100, viewport=350, totalRows=100, overscan=1
  const r = computeRange(0, 350, 100, 100, 1);
  assert.strictEqual(r.first, 0);            // max(0, floor(0/100)-1)=0
  assert.strictEqual(r.last, 5);             // min(99, ceil(350/100)+1)=min(99,4+1)=5
});

test('computeRange: 中部带 overscan', () => {
  const r = computeRange(1000, 350, 100, 100, 1);
  assert.strictEqual(r.first, 9);            // max(0, floor(1000/100)-1)=9
  assert.strictEqual(r.last, 15);            // min(99, ceil(1350/100)+1)=min(99,14+1)=15
});

test('computeRange: 底部 clamp', () => {
  const r = computeRange(9700, 350, 100, 100, 1);
  assert.strictEqual(r.last, 99); // 不超过 totalRows-1
});

test('computeRange: 空列表', () => {
  const r = computeRange(0, 350, 100, 0, 1);
  assert.strictEqual(r.first, 0);
  assert.strictEqual(r.last, -1);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `node --test test/shelf-view.test.js`
Expected: FAIL —— `Cannot find module '../shelf-view.js'`。

- [ ] **Step 3: 写实现（纯函数 + DOM 渲染 + VirtualGrid）**

创建 `shelf-view.js`：

```js
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

  // 单张书卡（继续阅读用横排卡，全部藏书网格用同款）
  function bookCard(vm, onOpen) {
    const card = el('div', 'book-card');
    const cover = el('div', 'cover');
    if (vm.cover) {
      const img = el('img');
      img.dataset.src = vm.cover;      // 懒加载：进入视口才赋 src
      img.alt = vm.title;
      cover.appendChild(img);
    }
    card.appendChild(cover);
    card.appendChild(el('div', 'book-title', vm.title));
    const bar = el('div', 'pbar');
    const fill = el('i');
    fill.style.width = Math.max(0, Math.min(100, vm.progress || 0)) + '%';
    bar.appendChild(fill);
    card.appendChild(bar);
    card.addEventListener('click', () => onOpen(vm));
    return card;
  }

  // 虚拟网格：行式窗口化，只渲染可视行
  function VirtualGrid(viewport, items, opts) {
    this.viewport = viewport;
    this.items = items;
    this.onOpen = opts.onOpen;
    this.gap = opts.gap || 14;
    this.minCellW = opts.minCellW || 120;
    this.textH = opts.textH || 40;   // 标题+进度条区域高度
    this.ratio = 4 / 3;              // 封面 3:4 → 高 = 宽 * 4/3
    this.sizer = el('div', 'grid-sizer');
    this.rowsEl = el('div', 'grid-rows');
    this.sizer.appendChild(this.rowsEl);
    viewport.appendChild(this.sizer);
    this._raf = null;
    viewport.addEventListener('scroll', () => this._schedule());
    root.addEventListener('resize', () => this.reflow());
    this.reflow();
  }
  VirtualGrid.prototype._schedule = function () {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this.paint(); });
  };
  VirtualGrid.prototype.reflow = function () {
    const w = this.viewport.clientWidth || 1;
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
    this.rowsEl.style.transform = 'translateY(' + (first * this.rowHeight) + 'px)';
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
        cell.appendChild(bookCard(this.items[idx], this.onOpen));
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
      vm.continueReading.forEach(b => row.appendChild(bookCard(b, handlers.onOpen)));
      body.appendChild(row);
    }
    body.appendChild(el('div', 'shelf-subhead', '全部藏书 · ' + vm.allBooks.length + ' 本'));
    const viewport = el('div', 'grid-viewport');
    body.appendChild(viewport);
    container.appendChild(body);
    new VirtualGrid(viewport, vm.allBooks, { onOpen: handlers.onOpen });
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
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `node --test test/shelf-view.test.js`
Expected: PASS（4 tests）。

- [ ] **Step 5: 提交**

```bash
git add shelf-view.js test/shelf-view.test.js
git commit -m "feat: shelf-view 渲染 + 虚拟网格（computeRange 单测）"
```

---

## Task 6: index.html — 覆盖层 DOM + clean grid CSS + script 引用

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 在 `</head>` 前追加书架样式**

在 `index.html` 第 126 行 `webview { flex: 1; width: 100%; }` 之后、`</style>`（第 127 行）之前，插入：

```css

    /* ===== 原生书架覆盖层（方向2 清爽网格）===== */
    #shelf {
      position: fixed; inset: 0; z-index: 10;
      display: none; flex-direction: column;
      background: #fafbfc; color: var(--text);
    }
    #shelf.show { display: flex; }
    .shelf-head {
      height: 52px; flex: none; display: flex; align-items: center; gap: 8px;
      padding: 0 16px; background: var(--bar-bg); border-bottom: 1px solid var(--bar-border);
      -webkit-user-select: none; user-select: none;
    }
    .shelf-title { font-size: 15px; font-weight: 600; margin-right: 6px; }
    .pill { font-size: 12px; padding: 3px 10px; border-radius: 12px; font-variant-numeric: tabular-nums; }
    .pill-read { background: #e8f1fd; color: #2f7de1; }
    .pill-done { background: #eafaf1; color: #1f9254; }
    .pill-time { background: #f3f0ff; color: #7a5af5; }
    .shelf-refresh { margin-left: 8px; height: 30px; padding: 0 12px; }
    .shelf-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; padding: 16px 20px 0; }
    .shelf-subhead { font-size: 13px; color: var(--text-dim); margin: 6px 0 10px; }
    .continue-row { display: flex; gap: 14px; overflow-x: auto; padding-bottom: 8px; flex: none; }
    .continue-row .book-card { width: 110px; flex: none; }

    .book-card { cursor: pointer; }
    .book-card .cover {
      position: relative; aspect-ratio: 3 / 4; border-radius: 8px; overflow: hidden;
      background: linear-gradient(135deg, #eef1f5, #dfe4ea);
      border: 1px solid #eef0f3; box-shadow: 0 1px 3px rgba(16,18,24,.08);
    }
    .book-card .cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .book-card .book-title {
      font-size: 12px; line-height: 1.3; margin-top: 6px; height: 32px; overflow: hidden;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    }
    .book-card .pbar { height: 3px; border-radius: 2px; background: rgba(128,128,128,.2); overflow: hidden; margin-top: 4px; }
    .book-card .pbar > i { display: block; height: 100%; background: var(--accent); }
    .book-card:hover .cover { box-shadow: 0 3px 10px rgba(16,18,24,.16); }

    .grid-viewport { flex: 1; overflow-y: auto; position: relative; }
    .grid-sizer { position: relative; width: 100%; }
    .grid-rows { position: absolute; top: 0; left: 0; width: 100%; }
    .grid-row { display: flex; gap: 14px; }
    .grid-cell { flex: none; }
    .grid-cell .book-card { width: 100%; }

    .shelf-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--text-dim); }
```

- [ ] **Step 2: 在 `#wrap` 之后、`renderer.js` 之前插入覆盖层与脚本**

把 `index.html` 第 170-173 行：

```html
  <div id="wrap" data-page-node-id="ZsOtHB5CM0U8vtMH9SotTI">
    <webview id="weread" src="https://weread.qq.com/web/shelf" partition="persist:weread" allowpopups="false" data-page-node-id="GYiNRdTz0mMYnG1HhzsmSg"></webview>
  </div>
  <script src="renderer.js"></script>
```

替换为：

```html
  <div id="wrap" data-page-node-id="ZsOtHB5CM0U8vtMH9SotTI">
    <webview id="weread" src="https://weread.qq.com/web/shelf" partition="persist:weread" allowpopups="false" data-page-node-id="GYiNRdTz0mMYnG1HhzsmSg"></webview>
  </div>
  <div id="shelf"></div>
  <script src="shelf-data.js"></script>
  <script src="shelf-fetch.js"></script>
  <script src="shelf-view.js"></script>
  <script src="renderer.js"></script>
```

- [ ] **Step 3: 冒烟验证**

Run: `npm run start`
Expected: 应用启动，`#shelf` 存在但 `display:none`（未加 `.show`），界面与改动前一致（仍显示官方书架）。关闭应用。

- [ ] **Step 4: 提交**

```bash
git add index.html
git commit -m "feat: index.html 新增书架覆盖层 DOM 与清爽网格样式"
```

---

## Task 7: renderer.js — 视图切换与编排

**Files:**
- Modify: `renderer.js`

- [ ] **Step 1: 新增元素引用与状态**

在 `renderer.js` 第 13 行 `const statusEl = document.getElementById('status');` 之后新增：

```js
const shelfEl = document.getElementById('shelf');

let mode = 'shelf';         // 'shelf' | 'reader'
let shelfBooted = false;    // 首次取数是否已发起
let currentVM = null;       // 当前视图模型
```

- [ ] **Step 2: 新增视图切换与取数编排函数**

在 `setStatus` 函数（第 91-94 行）之后新增：

```js
// ---- 书架视图切换 ----
function showShelf() {
  mode = 'shelf';
  shelfEl.classList.add('show');
}
function hideShelf() {
  mode = 'reader';
  shelfEl.classList.remove('show');
}

function openBook(vm) {
  const url = window.ShelfView.readerUrlFor(vm);
  hideShelf();
  webview.loadURL(url);
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
    if (r.err && r.cached) setStatus('刷新失败，展示上次数据');
  } else {
    // 无数据（多半未登录）：留在 webview 官方页/登录页
    hideShelf();
  }
}
```

- [ ] **Step 3: 改写 homeBtn 行为（复用为「← 书架」）**

把第 145-147 行：

```js
homeBtn.addEventListener('click', () => {
  webview.loadURL('https://weread.qq.com/web/shelf');
});
```

替换为：

```js
homeBtn.addEventListener('click', () => {
  showShelf();
  refreshShelf(); // 返回书架时后台刷新进度
});
```

- [ ] **Step 4: 改写 webview dom-ready（首屏取数 + 保持缩放）**

把第 161-165 行：

```js
// ---- webview 生命周期 ----
webview.addEventListener('dom-ready', () => {
  domReady = true;
  applyFont(); // 整页跳转后缩放会丢失，重新应用
});
```

替换为：

```js
// ---- webview 生命周期 ----
webview.addEventListener('dom-ready', () => {
  domReady = true;
  applyFont(); // 整页跳转后缩放会丢失，重新应用
  // 仅在书架模式下、且首次：拉取书架数据并展示覆盖层
  if (mode === 'shelf' && !shelfBooted) {
    shelfBooted = true;
    refreshShelf();
  }
});
```

- [ ] **Step 5: 手动集成验证**

Run: `npm run start`
Expected 逐项确认：
1. 启动后（webview 加载完 weread）自动出现**清爽网格书架覆盖层**，顶栏 pill 显示在读/读完/累计时长。
2. 「继续阅读」横排显示最近在读的书 + 进度条。
3. 「全部藏书」网格可滚动，滚动流畅（5548 本只渲染可视行），封面逐步加载。
4. 点任意封面 → 覆盖层隐藏，webview 进入该书阅读。
5. 点顶栏「书架」按钮 → 回到书架覆盖层。
6. 「刷新」按钮 → 重新取数渲染。

若第 1 步未出现覆盖层（停在官方书架/登录页），多为未登录或取数失败——查看 DevTools 控制台报错定位。

- [ ] **Step 6: 提交**

```bash
git add renderer.js
git commit -m "feat: renderer 接入书架覆盖层（视图切换/取数/进阅读/返回刷新）"
```

---

## Task 8: （条件）封面 Referer 注入

> **仅当 Task 1 判定为「需要注入 Referer」时执行本任务；否则跳过。**

**Files:**
- Modify: `main.js`

- [ ] **Step 1: 引入 session 并注入 Referer**

把 `main.js` 第 1 行：

```js
const { app, BrowserWindow, ipcMain, powerSaveBlocker, screen } = require('electron');
```

改为（新增 `session`）：

```js
const { app, BrowserWindow, ipcMain, powerSaveBlocker, screen, session } = require('electron');
```

在 `app.whenReady().then(createWindow);`（第 88 行）之前新增：

```js
// 封面 CDN 校验 Referer：给宿主页面（默认 session）发出的 cdn.weread.qq.com 图片请求补上合法 Referer
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://cdn.weread.qq.com/*', 'https://*.myqcloud.com/*'] },
    (details, callback) => {
      details.requestHeaders['Referer'] = 'https://weread.qq.com/';
      callback({ requestHeaders: details.requestHeaders });
    }
  );
});
```

- [ ] **Step 2: 手动验证封面显示**

Run: `npm run start`
Expected: 书架封面正常显示（非灰块）。若仍为灰块，转设计文档兜底 B（经 webview 转 base64），另开任务。

- [ ] **Step 3: 提交**

```bash
git add main.js
git commit -m "feat: 为封面 CDN 请求注入 Referer（宿主默认 session）"
```

---

## Task 9: 端到端验收 + 回归

**Files:** 无（验证任务）

- [ ] **Step 1: 全量单测**

Run: `node --test test/`
Expected: 全部 PASS（12 tests：shelf-data 5 + shelf-fetch 3 + shelf-view 4）。

- [ ] **Step 2: 冷启动秒开（缓存生效）**

1. `npm run start`，等书架出现后关闭。
2. 再次 `npm run start`。
Expected: 第二次启动**几乎立即**显示书架（先渲染 `.userdata/shelf-cache/shelf.json` 缓存），随后后台刷新。

- [ ] **Step 3: 未登录兜底**

1. 临时把 `.userdata/Partitions/weread/` 移走（或用一个干净分区）模拟未登录。
2. `npm run start`。
Expected: 不显示空书架覆盖层，而是停在 webview 的 weread 登录/官方页；登录完成后书架出现。
3. 验证后恢复原 `.userdata`。

> 注意：`.userdata/` 含真实登录态，操作前确认已备份或可重新登录；此步骤可选，风险自负。

- [ ] **Step 4: 阅读器回归**

Expected: 进入阅读后，原有字号 `A−/A＋`、单页、重绘、自动翻页、`⌘+←/→` 翻页均正常（这些逻辑未改）。

- [ ] **Step 5: 隐私自检**

Run: `git status --short && git diff --cached --stat`
Expected: 提交内容**不含** `.userdata/`、真实书 ID、`/tmp` 数据；`test/fixtures/shelf-sample.json` 仅为合成数据。

- [ ] **Step 6: 收尾**

如有零散改动，提交：

```bash
git add -A
git commit -m "chore: 原生书架首页 v1 端到端验收收尾"
```

---

## 自检记录（写计划者已核对）

- **Spec 覆盖**：设计文档第 3（架构/双视图）→ Task 6+7；第 4（数据契约/统计/缓存）→ Task 2+3+4；第 5（组件划分）→ shelf-data/fetch/view/renderer 四文件；第 6（清爽网格视觉）→ Task 6 CSS；第 7 风险1（封面）→ Task 1+8；风险2（reader URL）→ Task 1+`readerUrlFor`；风险3（虚拟滚动）→ Task 5；风险4（登录兜底）→ Task 7+9；第 8（错误处理）→ Task 4 `loadShelf` + Task 7 `paintShelf`；第 9（测试）→ Task 2/4/5 单测 + Task 9 手动；第 10（v1 边界）→ 未纳入看板/搜索/分组，符合 YAGNI。
- **类型/命名一致**：`buildViewModel`→`{stats:{reading,finished,totalHours},continueReading[],allBooks[]}`；`loadShelf`→`{cached,fresh,err}`；`readerUrlFor(vm)`、`computeRange(scrollTop,viewportH,rowHeight,totalRows,overscan)` 跨任务引用一致。
- **占位符扫描**：无 TODO/TBD；每个改代码的步骤均附完整代码与确切行号锚点。
- **隐私**：测试 fixture 全合成；Task 9 Step 5 专门校验不泄露真实阅读历史。

