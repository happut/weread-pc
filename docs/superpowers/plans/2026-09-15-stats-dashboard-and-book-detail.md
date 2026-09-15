# 阅读统计看板 + 书籍详情 + API 认证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有原生书架之上，新增「统计看板 / 书籍详情侧栏 / 设置面板」三块原生界面，用微信读书官方 Agent Gateway（`wrk-` API Key）从主进程取阅读统计、书评、书籍元信息并本地缓存。

**Architecture:** 沿用现有 `shelf-*` 的纯函数分层——`weread-api.js`（主进程 `net.fetch`，不可测）把官方回包**归一化**成稳定内部结构，`stats-data.js` / `book-detail-data.js`（纯函数，node:test 单测）把内部结构派生成视图模型，`*-view.js`（DOM 渲染）只消费视图模型。认证走「手动 Key → 自动 Key → 手动 cookie → webview 同源」四级回退，路由决策 `resolveAuth` 是纯函数。阅读正文仍留在 webview（硬约束不变），单击书→详情、双击书→复用现有 `openBook` 进阅读。

**Tech Stack:** Electron 33（主进程 `net.fetch` + `ipcMain.handle`）、原生 JS（IIFE 双导出：浏览器挂 `window.Xxx` / node `module.exports`）、`node:test` + `node:assert` + JSON fixture、`<webview partition="persist:weread">` 同源取登录态。

**关联 spec：** `docs/superpowers/specs/2026-09-15-stats-dashboard-and-book-detail-design.md`（已批准）。本 plan 在 spec 基础上，用官方 skill 文档把「Agent API 具体端点/字段」从"待 spike 探明"升级为"已知契约 + spike 实测确认"。

---

## 0. 既有代码约定（实现者必须先读，照抄风格）

实现者对本仓库零上下文，以下是必须遵守的既有模式（都已读源码确认）：

1. **纯函数文件模板**（见 `shelf-data.js`）：IIFE 包裹，末尾双导出。
   ```js
   // xxx.js — 一句话职责
   (function (root) {
     'use strict';
     function foo() { /* ... */ }
     const api = { foo };
     if (typeof module !== 'undefined' && module.exports) module.exports = api;
     else root.Xxx = api;
   })(typeof window !== 'undefined' ? window : globalThis);
   ```
2. **防御式取值**：所有入参 `raw || {}`、数组 `(raw.books || [])`、数字 `typeof x === 'number' ? x : 0`。缺失字段单项降级，绝不抛错。
3. **IPC 模板**（见 `main.js`）：`ipcMain.handle('channel', (_, arg) => {...})`；缓存目录 `path.join(app.getPath('userData'), '<dir>')` + `ensureXxxDir()`（`fs.mkdirSync(dir,{recursive:true})` 包 try/catch）；读：`existsSync`→`JSON.parse(readFileSync)`→出错返 `null`；写：`ensureDir`→`writeFileSync(JSON.stringify(vm))`→返 `true/false`。
4. **preload 模板**（见 `preload.js`）：`contextBridge.exposeInMainWorld('wereadPC', { methodName: (a) => ipcRenderer.invoke('channel', a) })`。渲染进程一律用 `window.wereadPC.methodName(...)`。
5. **取数桥模板**（见 `shelf-fetch.js`）：同源 fetch 字符串常量 + `webview.executeJavaScript(JS)`；`loadXxx(webview, api)` 返回 `{ cached, fresh, err }`（先读缓存秒开，再后台刷新）。
6. **渲染模板**（见 `shelf-view.js`）：`el(tag, cls, text)` 建节点；`render(container, vm, handlers)` 先 `container.textContent=''` 再重建；只消费视图模型，不发请求。
7. **测试模板**（见 `test/shelf-data.test.js`）：`require('node:test')` + `require('node:assert')`；fixture 放 `test/fixtures/*.json`；`test('中文描述', () => {...})`；跨文件依赖用 `globalThis.ShelfData = require('../shelf-data.js')` 手动注入（见 `test/shelf-fetch.test.js`）。
8. **测试命令**：`node --test test/`（`package.json` **没有** test 脚本，不要新增；当前 12 测全绿，本 plan 结束应 ≥12 且全绿）。
9. **提交规范**：中文 Conventional Commits（`feat:` / `test:` / `docs:` / `chore:`），一个 Task 一个（或数个）提交。
10. **覆盖层 z-index 时序**（见 `index.html` + `renderer.js`）：`webview`（底）＜ `#shelf`（`z-index:10`）＜ `#loading`（`z-index:20`，不透明翻书动画）。新增 `#stats` 与 `#shelf` 同级（`z-index:10`），`#detail`（侧栏，`z-index:15`）、`#settings`（模态，`z-index:30`）。进阅读仍走 `openBook`→`showLoading`→`webview.loadURL`→`waitReaderReady`（轮询 `.wr_canvasContainer canvas`）→`revealReader`。
11. **隐私红线**：任何日志/错误信息**不得**打印完整 `wrk-` Key 或 cookie；缓存文件只落 `.userdata/`（已 gitignore）。

---

## 1. 文件结构（新建 / 修改，职责单一）

**新建（纯函数，可单测）：**
- `weread-auth.js` — 认证：`resolveAuth` 四级路由决策、`maskKey` 掩码。（纯函数）
- `stats-data.js` — 归一化统计内部结构 → 看板视图模型（热力图/时长/偏好/TOP5/打卡）。（纯函数）
- `book-detail-data.js` — 归一化书籍内部结构 → 详情视图模型（元信息/书评/本书统计）。（纯函数）

**新建（主进程 / 渲染，网络与 DOM，不写单测，仅集成手测）：**
- `weread-api.js` — 主进程 Agent Gateway 客户端：`net.fetch` + Bearer；把官方回包**归一化**成内部结构（`normalizeReaddata` / `normalizeBookInfo` / `normalizeProgress` / `normalizeReviews`）。归一化里的纯计算（`buildGatewayBody`、`pickErrcode`）单独导出以便薄单测。
- `stats-view.js` — 统计看板 DOM（热力图网格/时长卡/偏好条/TOP5/打卡）。（`levelClass` 等 helper 可测）
- `detail-view.js` — 详情侧栏 DOM（三 Tab 切换）。
- `settings-view.js` — 设置模态 DOM（连接状态/高级手动/缓存控制/隐私）。

**修改：**
- `main.js` — 引入 `net`；新增 auth/stats/book 缓存读写 IPC + `weread-agent-call` IPC（转调 `weread-api.js`）。
- `preload.js` — 暴露上述 IPC 方法。
- `index.html` — 顶栏加「书架｜统计」双 Tab + ⚙；新增 `#stats` / `#detail` / `#settings` 容器 + CSS；引入新 `<script>`。
- `renderer.js` — Tab 切换、统计取数编排、单击→详情 / 双击→阅读、设置接线、首次气泡引导。
- `README.md` — 新增界面与认证说明。

**新建（临时，spike 用，最后删除，不提交）：**
- `spike/probe-agent-api.js` — 复用 `persist:weread` 登录态，发现取 Key 端点 + 实测 4 个数据端点，落 findings 与脱敏 fixture。

**新建（提交）：**
- `docs/superpowers/spikes/2026-09-15-weread-agent-api.md` — spike 实测结论（端点/字段/单位/取 Key 方式）。
- `test/fixtures/readdata-annually.json`、`readdata-overall.json`、`book-info.json`、`book-progress.json`、`review-list.json` — 脱敏后的真实回包片段。

---

## 2. 官方 Agent Gateway 契约（附录 · 已确认，Task 直接引用）

> 来源：微信读书官方 skill `Tencent/WeChatReading`（`weread-skills` v1.0.4）的 `SKILL.md` / `readdata.md` / `review.md` / `book.md`。spike（Task 1）对**当前登录账号**实测确认后再冻结 fixture。

**统一入口：**
```
POST https://i.weread.qq.com/api/agent/gateway
Header: Authorization: Bearer wrk-<key>
Header: Content-Type: application/json
Body:   { "api_name": "<端点>", "skill_version": "1.0.4", ...业务参数平铺在顶层 }
```
- 参数**必须平铺**在 body 顶层，**禁止**包进 `params`/`data`。
- 回包 JSON：`errcode` 非 0 = 错误（中文提示在 `errmsg`/`message`）；出现 `upgrade_info` 字段须按其 `message` 提示升级 `skill_version`。
- `{"api_name":"/_list","skill_version":"1.0.4"}` 返回全部可用端点及参数定义（spike 发现用）。

**本项目用到的 4 个端点：**

| 端点 | 参数 | 关键回包字段（单位） |
|---|---|---|
| `/readdata/detail` | `mode`∈`weekly/monthly/annually/overall`（默认 monthly）、`baseTime`（int 时间戳，0=当前周期） | `totalReadTime`(秒)、`dayAverageReadTime`(秒)、`compare`(比例,0.2=+20%)、`readDays`(天,≥1分钟算)、`readTimes`({桶起始时间戳:秒}；annually 按月/overall 按年)、`dailyReadTimes`({日时间戳:秒}；**annually 可能返回**，喂热力图)、`readLongest[]`(≤10,按 readTime 降序,`<5min` 过滤；`.book{bookId,title,author,cover}`/`.readTime`秒/`.tags[]`)、`preferCategory[]`(≤8,`.categoryTitle`/`.readingTime`秒/`.readingCount`本/`.val`归一权重)、`preferCategoryWord`、`preferTime[]`(24h 秒,从 6 点起)、`medals[]`(≥3 才返回)、`readStat[]`(`.stat`名/`.counts`文案) |
| `/book/info` | `bookId` | `title`/`author`/`translator`/`cover`/`intro`/`category`/`publisher`/`publishTime`/`isbn`/`wordCount`/`newRating`(百分制)/`newRatingCount`/`deepLink` |
| `/book/getprogress` | `bookId` | `book.progress`(0-100 整数,**1=1%**,100=读完)/`book.recordReadingTime`(秒)/`book.updateTime`(末次阅读戳)/`book.finishTime`(仅 progress=100)/`book.isStartReading` |
| `/review/list` | `bookId`(必)、`reviewListType`(0全部/1推荐/2不行/3最新/4一般,默认0)、`count`(默认20)、`maxIdx`、`synckey` | `reviewsCnt`、`reviewsHasMore`、`deepVRecommendValue`(862=86.2%)、`reviews[]`（**双层嵌套** `reviews[].review.review.{reviewId,content,htmlContent,star,createTime,author{name,avatar},book{title}}`；`star`：20/40/60/80/100=1~5星） |

**模块 ↔ 端点映射：**
- ① 全年热力图 ← `/readdata/detail mode=annually` 的 `dailyReadTimes`（缺失则退化为 `readTimes` 按月）。
- ② 时长汇总卡 ← 4 次 `/readdata/detail`（weekly/monthly/annually/overall）的 `totalReadTime` + `dayAverageReadTime` + `compare`。
- ③ 阅读偏好 ← `/readdata/detail` 的 `preferCategory[]`（主）；Agent 不可用时退化用 shelf/sync 的 `books[].category` × `bookProgress[].readingTime`（尽力，缺 category 则隐藏）。
- ④ 读最久 TOP5 ← `/readdata/detail` 的 `readLongest[]` 前 5（主）；退化用 shelf/sync 的 `bookProgress[].readingTime` 降序（**已确认可用**）。
- ⑥ 连续打卡/成就 ← `dailyReadTimes` 推导连续天数 + `readDays` + `medals[]`。
- 详情·概览 ← `/book/info`；详情·统计 ← `/book/getprogress`；详情·书评 ← `/review/list`（社区公开点评）。
- 「我的书评」：`/review/list` 是**公开点评**，非本人书评；本人书评属 notes 域（用户已排除）。Task 1 spike 用 `/_list` 顺带查是否有轻量「本人对某书书评」端点：有则纳入详情 `myReviews[]`，无则详情书评 Tab 只显示社区点评（`myReviews` 恒空，UI 自动隐藏该块）。

**取 API Key（`wrk-`）：** 官方流程 = 访问 `weread.qq.com/r/weread-skills` → 扫码登录 → 生成并复制 Key。**无可确认的免交互端点**，故 Task 1 spike 在已登录 webview 里加载该页、用 `webRequest` 抓它实际调用的取 Key 接口：
- 抓到 → `weread-auth.js` 的自动取 Key 走该端点（同源 fetch，复用登录态）。
- 抓不到 / 需扫码 → **手动粘贴 Key 为主路径**（设置面板高级区），自动获取降级为"尝试但可失败"。这不阻塞：用户明确要"开放 token 配置"。

**内部归一化契约（`weread-api.js` 产出，`*-data.js` 消费，屏蔽官方字段漂移）：**
```js
// StatsBundle —— 喂 stats-data.buildStatsViewModel
{
  ok: true,                       // false 时其余字段可缺省
  source: 'agent' | 'shelf' | 'none',
  fetchedAt: 1736900000000,
  totals: {                       // ②：各周期总时长（秒）与日均（秒）、环比
    week:   { seconds, dayAvgSeconds, compare },
    month:  { seconds, dayAvgSeconds, compare },
    year:   { seconds, dayAvgSeconds, compare },
    overall:{ seconds, dayAvgSeconds, compare }
  },
  daily: { '2026-01-01': 1234, ... },  // ①⑥：每日秒数（由 dailyReadTimes 归一；键=YYYY-MM-DD 本地日）
  readDays: 116,                       // ⑥
  topBooks: [ { bookId, title, cover, seconds } ],  // ④：来自 readLongest（已降序，≤10）
  preference: [ { category, seconds, count, val } ],// ③：来自 preferCategory（已降序，≤8）
  medals: [ { title, ... } ]           // ⑥：可空数组
}
// BookBundle —— 喂 book-detail-data.buildDetailViewModel
{
  ok: true, source: 'agent' | 'none', fetchedAt,
  info: { bookId, title, author, translator, cover, intro, category, publisher, publishTime, isbn, wordCount, rating, ratingCount },
  progress: { percent, seconds, lastReadAt, finishTime, started },
  communityReviews: [ { reviewId, content, star, authorName, authorAvatar, createTime } ],
  myReviews: []                        // spike 有端点才填，否则恒空
}
```

---

## 阶段 A：认证与数据后端（Task 1–6，产出可单测的纯函数 + 可用数据层）

### Task 1: Spike —— 实测官方 Agent API 与取 Key 方式

**为什么不是 TDD：** 本任务是**探索性实测**，产出是"结论 + 脱敏 fixture"，为后续 Task 冻结内部契约。需要开发者的**真实登录会话**。

**Files:**
- Create（临时，最后删）：`spike/probe-agent-api.js`
- Create（提交）：`docs/superpowers/spikes/2026-09-15-weread-agent-api.md`
- Create（提交）：`test/fixtures/readdata-annually.json`、`readdata-overall.json`、`book-info.json`、`book-progress.json`、`review-list.json`
- Modify：`.gitignore`（加 `spike/`，防止临时探针误入库）

- [ ] **Step 1: gitignore 掉 spike 目录**

在 `.gitignore` 的"构建产物"段之前插入：
```
# Agent API spike 临时探针（实测用，不入库）
spike/
```

- [ ] **Step 2: 写探针脚本**

创建 `spike/probe-agent-api.js`（复用 `persist:weread` 登录态；`WEREAD_API_KEY` 可选，未提供则先尝试自动发现取 Key 端点）：
```js
// spike/probe-agent-api.js —— 一次性实测脚本，用完即删（勿提交）
// 用法：
//   自动发现取 Key 端点：  npx electron spike/probe-agent-api.js
//   已有 Key 直接实测：    WEREAD_API_KEY=wrk-xxxx npx electron spike/probe-agent-api.js
const { app, BrowserWindow, session, net } = require('electron');
const path = require('path');
const fs = require('fs');

app.setPath('userData', path.join(__dirname, '..', '.userdata'));
const OUT = path.join(__dirname, 'findings');
const KEY = process.env.WEREAD_API_KEY || '';
const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const VER = '1.0.4';

function dump(name, obj) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(obj, null, 2), 'utf8');
  console.log('[dumped]', name);
}

// 用主进程 net.fetch 打 gateway（无 CORS）
async function call(apiName, params) {
  const body = JSON.stringify(Object.assign({ api_name: apiName, skill_version: VER }, params || {}));
  const res = await net.fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
    body
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = { _raw: text }; }
  return { status: res.status, json };
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:weread' } });

  // 抓 skills 页调用的取 Key 端点（URL 含 skill/apikey/key）
  const keyHits = [];
  const filter = { urls: ['*://weread.qq.com/*', '*://i.weread.qq.com/*'] };
  session.fromPartition('persist:weread').webRequest.onBeforeRequest(filter, (d, cb) => {
    if (/skill|apikey|api[_-]?key|\/key/i.test(d.url)) keyHits.push({ method: d.method, url: d.url });
    cb({});
  });

  console.log('== 加载 skills 页，发现取 Key 端点 ==');
  try {
    await win.loadURL('https://weread.qq.com/r/weread-skills');
    await new Promise(r => setTimeout(r, 6000)); // 等页面自身 XHR
  } catch (e) { console.log('load skills page err', e.message); }
  dump('key-endpoint-hits', keyHits);
  console.log('== 取 Key 端点候选 ==', JSON.stringify(keyHits, null, 2));

  if (!KEY) {
    console.log('!! 未提供 WEREAD_API_KEY。若上面发现了取 Key 端点，请据此在 weread-auth 里实现自动获取；');
    console.log('!! 否则去 https://weread.qq.com/r/weread-skills 扫码复制 wrk- Key，用 WEREAD_API_KEY=wrk-xxx 重跑本脚本。');
    app.quit(); return;
  }

  console.log('== /_list 全部端点 =='); dump('_list', await call('/_list'));
  console.log('== /shelf/sync 取一个 bookId ==');
  const shelf = await call('/shelf/sync');
  dump('shelf-sync', shelf.json);
  const firstBook = (shelf.json && (shelf.json.books || [])[0]) || null;
  const bookId = firstBook ? String(firstBook.bookId) : '';
  console.log('样本 bookId =', bookId);

  if (bookId) {
    dump('readdata-annually', (await call('/readdata/detail', { mode: 'annually' })).json);
    dump('readdata-overall',  (await call('/readdata/detail', { mode: 'overall'  })).json);
    dump('readdata-monthly',  (await call('/readdata/detail', { mode: 'monthly'  })).json);
    dump('readdata-weekly',   (await call('/readdata/detail', { mode: 'weekly'   })).json);
    dump('book-info',      (await call('/book/info',       { bookId })).json);
    dump('book-progress',  (await call('/book/getprogress',{ bookId })).json);
    dump('review-list',    (await call('/review/list',     { bookId, reviewListType: 1, count: 10 })).json);
  }
  console.log('== DONE，见 spike/findings/ ==');
  app.quit();
});
```

- [ ] **Step 3: 跑探针（自动发现取 Key 端点）**

Run: `npx electron spike/probe-agent-api.js`
Expected: 控制台打印 `== 取 Key 端点候选 ==` 后的 JSON 数组；`spike/findings/key-endpoint-hits.json` 生成。
- 若数组非空 → 记下真实取 Key 端点（写进 findings 文档，供 `weread-auth.js` 自动获取用）。
- 若为空 → 记录"需扫码，自动取 Key 不可行，走手动粘贴"。

- [ ] **Step 4: 拿到 Key 后跑探针（实测 4 端点）**

去 `https://weread.qq.com/r/weread-skills` 扫码复制 `wrk-` Key，然后：
Run: `WEREAD_API_KEY=wrk-你的key npx electron spike/probe-agent-api.js`
Expected: `spike/findings/` 下生成 `_list.json`、`readdata-annually.json`、`readdata-overall.json`、`readdata-monthly.json`、`readdata-weekly.json`、`book-info.json`、`book-progress.json`、`review-list.json`，且各文件 `errcode` 为 0（或缺省）。

- [ ] **Step 5: 核对关键字段是否如契约**

打开 `spike/findings/readdata-annually.json` 核对（逐项在 findings 文档记"✔/✘ + 实际字段名"）：
- `dailyReadTimes` 是否返回？键是**秒**还是**毫秒**时间戳？（决定 `stats-data.toDailyMap` 的归一）
- `totalReadTime` / `dayAverageReadTime` 是否为秒？
- `readLongest[].book.cover` 是否有值？`readLongest[].readTime` 单位？
- `preferCategory[].categoryTitle` / `.readingTime` 是否有值？
- `book-info.json`：`newRating` 是否百分制？`intro`/`isbn`/`publisher` 是否有值？
- `review-list.json`：确认双层 `reviews[].review.review.content` / `.star` 结构。

- [ ] **Step 6: 写 findings 文档**

创建 `docs/superpowers/spikes/2026-09-15-weread-agent-api.md`，据实填（不留 TODO）：
```markdown
# Spike 结论：微信读书官方 Agent API（2026-09-15）

## 取 API Key
- 实测端点：<填 key-endpoint-hits 里发现的真实 URL，或"无免交互端点，需扫码">
- 结论：<自动取 Key 可行 / 不可行 → 手动粘贴为主>

## /readdata/detail
- mode=annually 是否返回 dailyReadTimes：<是/否>；时间戳单位：<秒/毫秒>
- totalReadTime/dayAverageReadTime 单位：秒（确认）
- readLongest：实测条数 <n>，字段 book.cover/readTime <有/无>
- preferCategory：实测条数 <n>，categoryTitle/readingTime <有/无>
- medals：<有/无>

## /book/info、/book/getprogress、/review/list
- newRating 百分制：<确认>；intro/isbn/publisher：<有/无>
- progress 语义（1=1%）：<确认>；recordReadingTime 单位：秒
- review 双层嵌套 reviews[].review.review：<确认>；star 取值：<实测样例>

## 契约调整（相对 plan 附录）
- <如某字段名/单位与附录不符，在此写最终以实测为准的调整；无则写"无，与附录一致">

## 降级结论
- ③ 偏好：<能用 preferCategory / 需退化 shelf>
- ④ TOP5：<能用 readLongest / 退化 shelf readingTime>
- ① 热力图：<dailyReadTimes 可用 → 按日 / 不可用 → 按月 readTimes>
- 我的书评：<发现端点 xxx / 未发现 → myReviews 恒空>
```

- [ ] **Step 7: 生成脱敏 fixture**

从 `spike/findings/*.json` 各取**一小段真实结构**，脱敏（改书名/昵称/头像 URL 为占位、时长数值可保留量级），存到 `test/fixtures/`：
- `readdata-annually.json`：含 `totalReadTime`、`dayAverageReadTime`、`readDays`、`dailyReadTimes`（3~5 天样例）、`readLongest`（2 条）、`preferCategory`（2 条）。
- `readdata-overall.json`：含 `totalReadTime`、`dayAverageReadTime`。
- `book-info.json`：含 `title/author/cover/intro/category/publisher/isbn/newRating/newRatingCount`。
- `book-progress.json`：含 `book.progress/recordReadingTime/updateTime`。
- `review-list.json`：含 `reviewsCnt` + `reviews`（1~2 条，双层嵌套结构完整）。

> fixture 的**字段结构必须与实测一致**（后续 Task 4/5 的单测按此断言）。若 Step 5 发现字段名与 plan 附录不符，以 fixture（实测）为准，并在实现对应 Task 时同步调整。

- [ ] **Step 8: 删除临时探针**

Run: `rm -rf spike/`
Expected: `spike/` 消失（`.gitignore` 里保留 `spike/` 一行无妨，防将来再探）。

- [ ] **Step 9: 提交**

```bash
git add docs/superpowers/spikes/2026-09-15-weread-agent-api.md test/fixtures/ .gitignore
git commit -m "docs: Agent API spike 实测结论 + 脱敏 fixture"
```

---

### Task 2: weread-auth.js —— 认证路由纯函数

**Files:**
- Create: `weread-auth.js`
- Test: `test/weread-auth.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/weread-auth.test.js`：
```js
const test = require('node:test');
const assert = require('node:assert');
const { resolveAuth, maskKey } = require('../weread-auth.js');

test('resolveAuth: 手动 Key 非空 → 最高优先（覆盖自动）', () => {
  const r = resolveAuth({ manualKey: 'wrk-manual', autoKey: 'wrk-auto', manualCookie: 'wr_vid=1' });
  assert.strictEqual(r.mode, 'key');
  assert.strictEqual(r.key, 'wrk-manual');
  assert.strictEqual(r.source, 'manual');
});

test('resolveAuth: 无手动 Key、自动 Key 有效 → 用自动', () => {
  const r = resolveAuth({ manualKey: '', autoKey: 'wrk-auto', manualCookie: '' });
  assert.strictEqual(r.mode, 'key');
  assert.strictEqual(r.key, 'wrk-auto');
  assert.strictEqual(r.source, 'auto');
});

test('resolveAuth: 无 Key、有手动 cookie → cookie 模式', () => {
  const r = resolveAuth({ manualKey: '', autoKey: '', manualCookie: 'wr_vid=1; wr_skey=x' });
  assert.strictEqual(r.mode, 'cookie');
  assert.strictEqual(r.source, 'manual');
});

test('resolveAuth: 全空 → webview 同源兜底', () => {
  const r = resolveAuth({ manualKey: '', autoKey: '', manualCookie: '' });
  assert.strictEqual(r.mode, 'webview');
});

test('resolveAuth: autoKey 失效标记 → 跳过自动，落到 cookie', () => {
  const r = resolveAuth({ manualKey: '', autoKey: 'wrk-auto', autoKeyInvalid: true, manualCookie: 'wr_vid=1' });
  assert.strictEqual(r.mode, 'cookie');
});

test('resolveAuth: 入参缺失不抛错', () => {
  assert.strictEqual(resolveAuth().mode, 'webview');
  assert.strictEqual(resolveAuth(null).mode, 'webview');
});

test('maskKey: wrk- 前缀保留 + 尾 4 位，中间掩码', () => {
  assert.strictEqual(maskKey('wrk-a3f2b1c9d8e7'), 'wrk-••••d8e7');
});

test('maskKey: 空/短值安全', () => {
  assert.strictEqual(maskKey(''), '');
  assert.strictEqual(maskKey(null), '');
  assert.strictEqual(maskKey('abc'), '••••');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/weread-auth.test.js`
Expected: FAIL —— `Cannot find module '../weread-auth.js'`。

- [ ] **Step 3: 写实现**

创建 `weread-auth.js`：
```js
// weread-auth.js — 纯函数：认证来源路由 + Key 掩码（不含任何真实凭据）
(function (root) {
  'use strict';

  // 四级优先级：手动 Key > 自动 Key（未失效）> 手动 cookie > webview 同源
  // 入参 state: { manualKey, autoKey, autoKeyInvalid, manualCookie }
  // 返回: { mode:'key'|'cookie'|'webview', key?, cookie?, source:'manual'|'auto'|'none' }
  function resolveAuth(state) {
    const s = state || {};
    const manualKey = (s.manualKey || '').trim();
    const autoKey = (s.autoKey || '').trim();
    const manualCookie = (s.manualCookie || '').trim();

    if (manualKey) return { mode: 'key', key: manualKey, source: 'manual' };
    if (autoKey && !s.autoKeyInvalid) return { mode: 'key', key: autoKey, source: 'auto' };
    if (manualCookie) return { mode: 'cookie', cookie: manualCookie, source: 'manual' };
    return { mode: 'webview', source: 'none' };
  }

  // wrk-a3f2b1c9d8e7 → wrk-a3f2...；仅用于展示，绝不打印完整 Key
  function maskKey(key) {
    const k = String(key || '');
    if (!k) return '';
    if (k.length <= 8) return '••••';
    const prefix = k.startsWith('wrk-') ? 'wrk-' : '';
    return prefix + '••••' + k.slice(-4);
  }

  const api = { resolveAuth, maskKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WereadAuth = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

> 注意：`maskKey('wrk-a3f2b1c9d8e7')` 长度 16 > 8，前缀 `wrk-` + `••••` + 尾 4 位 `d8e7` = `wrk-••••d8e7`，与测试一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/weread-auth.test.js`
Expected: PASS（8 测全绿）。

- [ ] **Step 5: 全量回归**

Run: `node --test test/`
Expected: PASS（原 12 + 新 8 = 20 测全绿）。

- [ ] **Step 6: 提交**

```bash
git add weread-auth.js test/weread-auth.test.js
git commit -m "feat: weread-auth 认证路由 resolveAuth + Key 掩码 + 单测"
```

---

### Task 3: weread-api.js —— 主进程 Agent Gateway 客户端 + 回包归一化

**职责边界：** 本文件是**适配层**——把官方回包归一化成第 2 节定义的 `StatsBundle`/`BookBundle`，屏蔽字段漂移。纯函数（`buildGatewayBody`/`pickError`/`toDailyMap`/`normalize*`/`assemble*`）用 Task 1 fixture 单测；`gatewayFetch`/`fetchStatsBundle`/`fetchBookBundle` 依赖 electron `net`，**懒加载 require**（不在模块顶层 require electron），故本文件能被 `node --test` 加载、纯函数可测，网络部分集成手测。

**Files:**
- Create: `weread-api.js`（CommonJS，仅主进程 require；不走 window/globalThis 双导出）
- Test: `test/weread-api.test.js`
- 依赖 fixture（Task 1 产出）：`test/fixtures/readdata-annually.json`、`readdata-overall.json`、`book-info.json`、`book-progress.json`、`review-list.json`

- [ ] **Step 1: 写失败测试**

创建 `test/weread-api.test.js`：
```js
const test = require('node:test');
const assert = require('node:assert');
const api = require('../weread-api.js');
const annually = require('./fixtures/readdata-annually.json');
const overall = require('./fixtures/readdata-overall.json');
const bookInfo = require('./fixtures/book-info.json');
const bookProgress = require('./fixtures/book-progress.json');
const reviewList = require('./fixtures/review-list.json');

test('buildGatewayBody: api_name+skill_version+参数平铺，不嵌套 params', () => {
  const b = api.buildGatewayBody('/readdata/detail', { mode: 'annually' });
  assert.strictEqual(b.api_name, '/readdata/detail');
  assert.strictEqual(b.skill_version, '1.0.4');
  assert.strictEqual(b.mode, 'annually');
  assert.strictEqual(b.params, undefined);
});

test('pickError: errcode=0→null；非0→message；upgrade_info→upgrade', () => {
  assert.strictEqual(api.pickError({ errcode: 0 }), null);
  assert.ok(api.pickError({ errcode: -2012, errmsg: '未登录' }).message);
  assert.ok(api.pickError({ upgrade_info: { message: '请升级' } }).upgrade);
});

test('toDailyMap: 秒时间戳→YYYY-MM-DD 键，值累加', () => {
  const m = api.toDailyMap({ 1735660800: 600, 1735747200: 1200 });
  assert.strictEqual(Object.values(m).reduce((a, b) => a + b, 0), 1800);
  assert.ok(Object.keys(m).every(k => /^\d{4}-\d{2}-\d{2}$/.test(k)));
});

test('toDailyMap: 毫秒时间戳也识别', () => {
  const m = api.toDailyMap({ 1735660800000: 300 });
  assert.strictEqual(Object.values(m)[0], 300);
});

test('normalizeReaddataOne: 提取 seconds/topBooks/preference/daily', () => {
  const n = api.normalizeReaddataOne(annually);
  assert.strictEqual(typeof n.seconds, 'number');
  assert.ok(Array.isArray(n.topBooks));
  assert.ok(Array.isArray(n.preference));
  assert.strictEqual(typeof n.daily, 'object');
});

test('assembleStatsBundle: 合并 4 周期，daily/topBooks 取先有值者', () => {
  const year = api.normalizeReaddataOne(annually);
  const ov = api.normalizeReaddataOne(overall);
  const b = api.assembleStatsBundle({ year, overall: ov, month: null, week: null });
  assert.strictEqual(b.ok, true);
  assert.strictEqual(b.source, 'agent');
  assert.ok(b.totals.year.seconds >= 0);
});

test('normalizeBookInfo: newRating→rating，缺字段降级为空串/0', () => {
  const n = api.normalizeBookInfo(bookInfo);
  assert.strictEqual(typeof n.rating, 'number');
  assert.strictEqual(typeof n.title, 'string');
  assert.strictEqual(api.normalizeBookInfo(null).title, '');
});

test('normalizeProgress: book.progress→percent（0-100 整数）', () => {
  const n = api.normalizeProgress(bookProgress);
  assert.ok(n.percent >= 0 && n.percent <= 100);
  assert.strictEqual(api.normalizeProgress(null).percent, 0);
});

test('normalizeReviews: 双层嵌套 reviews[].review.review 拍平', () => {
  const n = api.normalizeReviews(reviewList);
  assert.ok(Array.isArray(n.reviews));
  if (n.reviews.length) {
    assert.strictEqual(typeof n.reviews[0].content, 'string');
    assert.strictEqual(typeof n.reviews[0].star, 'number');
  }
});

test('assembleBookBundle: 三部分合成，myReviews 恒空数组', () => {
  const b = api.assembleBookBundle(
    api.normalizeBookInfo(bookInfo),
    api.normalizeProgress(bookProgress),
    api.normalizeReviews(reviewList)
  );
  assert.strictEqual(b.ok, true);
  assert.deepStrictEqual(b.myReviews, []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/weread-api.test.js`
Expected: FAIL —— `Cannot find module '../weread-api.js'`。

- [ ] **Step 3: 写实现**

创建 `weread-api.js`：
```js
// weread-api.js — 主进程：微信读书官方 Agent Gateway 客户端 + 回包归一化
// CommonJS（仅主进程 require）。纯函数可单测；gatewayFetch 懒加载 electron net，不在顶层 require。
'use strict';

const GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';
const SKILL_VERSION = '1.0.4';

// 参数平铺在顶层（禁止包进 params）
function buildGatewayBody(apiName, params, version) {
  return Object.assign({ api_name: apiName, skill_version: version || SKILL_VERSION }, params || {});
}

// null=正常；{upgrade:message}=需升级 skill_version；{errcode,message}=业务错误
function pickError(json) {
  if (!json || typeof json !== 'object') return { errcode: -1, message: '空回包' };
  if (json.upgrade_info && json.upgrade_info.message) return { upgrade: json.upgrade_info.message };
  const code = typeof json.errcode === 'number' ? json.errcode : 0;
  if (code !== 0) return { errcode: code, message: json.errmsg || json.message || ('errcode ' + code) };
  return null;
}

// 官方时间戳可能秒或毫秒；统一成键 'YYYY-MM-DD'（本地日）→ 秒数（同键累加）
function toDailyMap(dailyReadTimes) {
  const out = {};
  const src = dailyReadTimes || {};
  for (const k of Object.keys(src)) {
    const n = Number(k);
    if (!isFinite(n)) continue;
    const ms = n > 1e12 ? n : n * 1000;   // >1e12 视为毫秒
    const d = new Date(ms);
    const key = d.getFullYear() + '-' +
      String(d.getMonth() + 1).padStart(2, '0') + '-' +
      String(d.getDate()).padStart(2, '0');
    out[key] = (out[key] || 0) + (Number(src[k]) || 0);
  }
  return out;
}

// 单次 /readdata/detail → 该周期归一化片段
function normalizeReaddataOne(json) {
  const j = json || {};
  const num = (x) => (typeof x === 'number' ? x : 0);
  const topBooks = (Array.isArray(j.readLongest) ? j.readLongest : []).map(it => {
    const b = (it && it.book) || {};
    return { bookId: String(b.bookId || ''), title: b.title || '', cover: b.cover || '', seconds: num(it && it.readTime) };
  }).filter(x => x.bookId);
  const preference = (Array.isArray(j.preferCategory) ? j.preferCategory : []).map(c => ({
    category: (c && c.categoryTitle) || '', seconds: num(c && c.readingTime),
    count: num(c && c.readingCount), val: num(c && c.val)
  })).filter(x => x.category);
  return {
    seconds: num(j.totalReadTime),
    dayAvgSeconds: num(j.dayAverageReadTime),
    compare: typeof j.compare === 'number' ? j.compare : null,
    readDays: num(j.readDays),
    daily: toDailyMap(j.dailyReadTimes),
    topBooks, preference,
    medals: Array.isArray(j.medals) ? j.medals : []
  };
}

// 4 周期片段 → StatsBundle（daily/topBooks/preference/medals 从最先有值的周期取：年>总>月>周）
function assembleStatsBundle(parts) {
  const p = parts || {};
  const modes = ['year', 'overall', 'month', 'week'];
  const mkTotals = (x) => ({
    seconds: (x && x.seconds) || 0,
    dayAvgSeconds: (x && x.dayAvgSeconds) || 0,
    compare: x && typeof x.compare === 'number' ? x.compare : null
  });
  const pickArr = (f) => { for (const m of modes) { const v = p[m] && p[m][f]; if (Array.isArray(v) && v.length) return v; } return []; };
  const pickObj = (f) => { for (const m of modes) { const v = p[m] && p[m][f]; if (v && Object.keys(v).length) return v; } return {}; };
  const pickNum = (f) => { for (const m of modes) { const v = p[m] && p[m][f]; if (typeof v === 'number' && v > 0) return v; } return 0; };
  return {
    ok: true, source: 'agent', fetchedAt: Date.now(),
    totals: { week: mkTotals(p.week), month: mkTotals(p.month), year: mkTotals(p.year), overall: mkTotals(p.overall) },
    daily: pickObj('daily'), readDays: pickNum('readDays'),
    topBooks: pickArr('topBooks'), preference: pickArr('preference'), medals: pickArr('medals')
  };
}

function normalizeBookInfo(json) {
  const j = json || {};
  return {
    bookId: String(j.bookId || ''), title: j.title || '', author: j.author || '',
    translator: j.translator || '', cover: j.cover || '', intro: j.intro || '',
    category: j.category || '', publisher: j.publisher || '', publishTime: j.publishTime || '',
    isbn: j.isbn || '', wordCount: typeof j.wordCount === 'number' ? j.wordCount : 0,
    rating: typeof j.newRating === 'number' ? j.newRating : 0,          // 百分制
    ratingCount: typeof j.newRatingCount === 'number' ? j.newRatingCount : 0,
    deepLink: j.deepLink || ''
  };
}

function normalizeProgress(json) {
  const b = (json && json.book) || {};
  return {
    percent: typeof b.progress === 'number' ? b.progress : 0,           // 0-100 整数，1=1%
    seconds: typeof b.recordReadingTime === 'number' ? b.recordReadingTime : 0,
    lastReadAt: typeof b.updateTime === 'number' ? b.updateTime : 0,
    finishTime: typeof b.finishTime === 'number' ? b.finishTime : 0,
    started: !!b.isStartReading
  };
}

function normalizeReviews(json) {
  const j = json || {};
  const list = Array.isArray(j.reviews) ? j.reviews : [];
  const reviews = list.map(w => {
    const r = (w && w.review && w.review.review) || {};   // 双层嵌套
    const a = r.author || {};
    return {
      reviewId: String(r.reviewId || ''), content: r.content || '',
      star: typeof r.star === 'number' ? r.star : 0,      // 20/40/60/80/100
      authorName: a.name || '', authorAvatar: a.avatar || '',
      createTime: typeof r.createTime === 'number' ? r.createTime : 0
    };
  }).filter(x => x.content || x.reviewId);
  return {
    count: typeof j.reviewsCnt === 'number' ? j.reviewsCnt : reviews.length,
    recommendValue: typeof j.deepVRecommendValue === 'number' ? j.deepVRecommendValue : 0, // 862=86.2%
    reviews
  };
}

function assembleBookBundle(info, progress, reviews) {
  return {
    ok: true, source: 'agent', fetchedAt: Date.now(),
    info: info || {}, progress: progress || {},
    communityReviews: (reviews && reviews.reviews) || [],
    reviewsMeta: { count: (reviews && reviews.count) || 0, recommendValue: (reviews && reviews.recommendValue) || 0 },
    myReviews: []
  };
}

// ---- 网络（不写单测）----
async function gatewayFetch(key, apiName, params) {
  const { net } = require('electron');   // 懒加载：主进程运行时才有
  const res = await net.fetch(GATEWAY, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGatewayBody(apiName, params))
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  const err = pickError(json);
  if (err) { const e = new Error(err.upgrade ? ('需升级: ' + err.upgrade) : (err.message || 'gateway error')); e.detail = err; throw e; }
  return json;
}

async function fetchStatsBundle(key) {
  const modes = { week: 'weekly', month: 'monthly', year: 'annually', overall: 'overall' };
  const parts = {};
  for (const k of Object.keys(modes)) {
    try { parts[k] = normalizeReaddataOne(await gatewayFetch(key, '/readdata/detail', { mode: modes[k] })); }
    catch (_) { parts[k] = null; }   // 单周期失败不拖垮整体
  }
  if (!parts.week && !parts.month && !parts.year && !parts.overall) throw new Error('readdata 全部失败');
  return assembleStatsBundle(parts);
}

async function fetchBookBundle(key, bookId) {
  const [info, progress, reviews] = await Promise.all([
    gatewayFetch(key, '/book/info', { bookId }).then(normalizeBookInfo).catch(() => null),
    gatewayFetch(key, '/book/getprogress', { bookId }).then(normalizeProgress).catch(() => null),
    gatewayFetch(key, '/review/list', { bookId, reviewListType: 1, count: 10 }).then(normalizeReviews).catch(() => null)
  ]);
  if (!info && !progress && !reviews) throw new Error('book 全部失败');
  return assembleBookBundle(info, progress, reviews);
}

module.exports = {
  GATEWAY, SKILL_VERSION,
  buildGatewayBody, pickError, toDailyMap,
  normalizeReaddataOne, assembleStatsBundle,
  normalizeBookInfo, normalizeProgress, normalizeReviews, assembleBookBundle,
  gatewayFetch, fetchStatsBundle, fetchBookBundle
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/weread-api.test.js`
Expected: PASS（11 测全绿）。若某断言因 Task 1 实测字段名与附录不符而失败 → 以 fixture（实测）为准，同步修正 `weread-api.js` 的字段读取与测试断言。

- [ ] **Step 5: 全量回归**

Run: `node --test test/`
Expected: PASS（20 + 11 = 31 测全绿）。

- [ ] **Step 6: 提交**

```bash
git add weread-api.js test/weread-api.test.js
git commit -m "feat: weread-api Agent Gateway 客户端 + 回包归一化 + 单测"
```

---

### Task 4: stats-data.js —— 看板视图模型纯函数

**消费：** `StatsBundle`（Task 3 产出）+ 可选 `shelfVM`（退化用）→ 看板视图模型。本 Task 先小幅扩展 `shelf-data.toBookVM`（携带 `readingTime`/`category`），以支持 ④TOP5（与③ best-effort）在 Agent 不可用时退化到书架数据。

**Files:**
- Modify: `shelf-data.js`（`toBookVM` 新增两字段）
- Modify: `test/shelf-data.test.js`（新增 1 断言）
- Create: `stats-data.js`
- Test: `test/stats-data.test.js`

- [ ] **Step 1: 扩展 shelf-data.toBookVM（退化数据源）**

在 `shelf-data.js` 的 `toBookVM` 返回对象里，`progress` 行后新增两行（其余不动）：
```js
  function toBookVM(b, p) {
    const deepLink = b.deepLink || '';
    return {
      bookId: String(b.bookId),
      title: b.title || '',
      author: b.author || '',
      cover: b.cover || '',
      category: b.category || '',                                                  // 新增：③偏好退化用（可能为空）
      progress: p && typeof p.progress === 'number' ? p.progress : 0,
      readingTime: p && typeof p.readingTime === 'number' ? p.readingTime : 0,        // 新增：④TOP5退化用
      deepLink: deepLink,
      readerUrl: readerUrlFromDeepLink(deepLink)
    };
  }
```

- [ ] **Step 2: 给 shelf-data 测试补一条断言**

在 `test/shelf-data.test.js` 末尾追加（不改动现有用例，旧断言均仍成立）：
```js
test('toBookVM: 携带 readingTime（④退化）与 category（③退化）', () => {
  const vm = buildViewModel(raw);
  const b1 = vm.allBooks.find(b => b.bookId === 'b1');
  assert.strictEqual(b1.readingTime, 3600); // bookProgress b1.readingTime
  assert.strictEqual(b1.category, '');      // fixture 无 category → 空串不报错
});
```

- [ ] **Step 3: 跑 shelf-data 测试确认扩展不破坏旧行为**

Run: `node --test test/shelf-data.test.js`
Expected: PASS（原 5 + 新 1 = 6 测全绿）。

- [ ] **Step 4: 写 stats-data 失败测试**

创建 `test/stats-data.test.js`：
```js
const test = require('node:test');
const assert = require('node:assert');
const S = require('../stats-data.js');
const ShelfData = require('../shelf-data.js');
const shelfRaw = require('./fixtures/shelf-sample.json');

const bundle = {
  ok: true, source: 'agent', fetchedAt: 1,
  totals: {
    week:    { seconds: 3600 * 5,    dayAvgSeconds: 1800, compare: 0.2 },
    month:   { seconds: 3600 * 40,   dayAvgSeconds: 3600, compare: -0.1 },
    year:    { seconds: 3600 * 300,  dayAvgSeconds: 3000, compare: null },
    overall: { seconds: 3600 * 1000, dayAvgSeconds: 2500, compare: null }
  },
  daily: { '2026-01-01': 600, '2026-01-02': 1200, '2026-01-03': 3600, '2026-01-05': 300 },
  readDays: 116,
  topBooks: [
    { bookId: 'x1', title: '书A', cover: 'c1', seconds: 3600 * 10 },
    { bookId: 'x2', title: '书B', cover: 'c2', seconds: 3600 * 6 }
  ],
  preference: [
    { category: '文学', seconds: 3600 * 20, count: 5, val: 1 },
    { category: '历史', seconds: 3600 * 10, count: 3, val: 0.5 }
  ],
  medals: [{ title: '坚持阅读' }]
};

test('levelOf: 分档 0/1/2/3/4', () => {
  assert.strictEqual(S.levelOf(0), 0);
  assert.strictEqual(S.levelOf(600), 1);   // <15min
  assert.strictEqual(S.levelOf(1200), 2);  // <30min
  assert.strictEqual(S.levelOf(2400), 3);  // <60min
  assert.strictEqual(S.levelOf(3600), 4);  // ≥60min
});

test('buildHeatmap: 补齐整年（2026=365），已知日填 seconds+level，未知日=0', () => {
  const cells = S.buildHeatmap(bundle.daily, 2026);
  assert.strictEqual(cells.length, 365);
  const d1 = cells.find(c => c.day === '2026-01-01');
  assert.strictEqual(d1.seconds, 600);
  assert.strictEqual(d1.level, 1);
  const d9 = cells.find(c => c.day === '2026-09-09');
  assert.strictEqual(d9.seconds, 0);
  assert.strictEqual(d9.level, 0);
});

test('buildDurations: 秒→小时（年/月/周/总）', () => {
  const d = S.buildDurations(bundle.totals);
  assert.strictEqual(d.week.hours, 5);
  assert.strictEqual(d.overall.hours, 1000);
  assert.strictEqual(d.month.dayAvgHours, 1);
  assert.strictEqual(d.week.compare, 0.2);
});

test('buildPreference: 占比降序，四舍五入', () => {
  const p = S.buildPreference(bundle.preference);
  assert.strictEqual(p[0].category, '文学');
  assert.strictEqual(p[0].percent, 67);   // 20/(20+10)=66.7→67
});

test('buildTopBooks: Agent 优先，前5，秒→小时', () => {
  const t = S.buildTopBooks(bundle.topBooks);
  assert.strictEqual(t[0].title, '书A');
  assert.strictEqual(t[0].hours, 10);
});

test('buildTopBooks: Agent 空 → 退化 shelf readingTime 降序', () => {
  const vm = ShelfData.buildViewModel(shelfRaw);
  const t = S.buildTopBooks([], vm);
  assert.strictEqual(t[0].bookId, 'b2');  // readingTime 7200 > b1 3600
  assert.strictEqual(t[0].hours, 2);
});

test('buildStreak: today 已打卡 → 当前连续回数', () => {
  const daily = { '2026-01-01': 600, '2026-01-02': 600, '2026-01-03': 600 };
  const s = S.buildStreak(daily, 3, '2026-01-03');
  assert.strictEqual(s.current, 3);
  assert.strictEqual(s.longest, 3);
});

test('buildStreak: today 未打卡 → 从昨天回数', () => {
  const daily = { '2026-01-01': 600, '2026-01-02': 600 };
  const s = S.buildStreak(daily, 2, '2026-01-03');
  assert.strictEqual(s.current, 2);
});

test('buildStreak: 中断 → longest 取历史最长', () => {
  const daily = { '2026-01-01': 600, '2026-01-02': 600, '2026-01-04': 600, '2026-01-05': 600, '2026-01-06': 600 };
  const s = S.buildStreak(daily, 5, '2026-01-06');
  assert.strictEqual(s.longest, 3);   // 1/4-1/6
  assert.strictEqual(s.current, 3);
});

test('buildStatsViewModel: 未连接 → connected=false，③④ 仍退化 shelf', () => {
  const vm = ShelfData.buildViewModel(shelfRaw);
  const s = S.buildStatsViewModel({ ok: false, source: 'none' }, vm, 2026);
  assert.strictEqual(s.connected, false);
  assert.strictEqual(s.heatmap.length, 0);
  assert.ok(s.topBooks.length > 0);   // 退化 shelf
});

test('buildStatsViewModel: 已连接 → 全模块有值', () => {
  const s = S.buildStatsViewModel(bundle, null, 2026);
  assert.strictEqual(s.connected, true);
  assert.strictEqual(s.heatmap.length, 365);
  assert.ok(s.durations.year.hours > 0);
  assert.strictEqual(s.streak.readDays, 116);
});
```

- [ ] **Step 5: 跑测试确认失败**

Run: `node --test test/stats-data.test.js`
Expected: FAIL —— `Cannot find module '../stats-data.js'`。

- [ ] **Step 6: 写实现**

创建 `stats-data.js`：
```js
// stats-data.js — 纯函数：StatsBundle（weread-api 归一化）→ 看板视图模型
(function (root) {
  'use strict';

  const LEVEL_BOUNDS = [900, 1800, 3600]; // 0=0 / <15min=1 / <30min=2 / <60min=3 / ≥60min=4
  function levelOf(seconds) {
    const s = Number(seconds) || 0;
    if (s <= 0) return 0;
    if (s < LEVEL_BOUNDS[0]) return 1;
    if (s < LEVEL_BOUNDS[1]) return 2;
    if (s < LEVEL_BOUNDS[2]) return 3;
    return 4;
  }
  function secToHours(seconds) { return Math.round((Number(seconds) || 0) / 3600); }
  function secToHours1(seconds) { return Math.round((Number(seconds) || 0) / 3600 * 10) / 10; }
  function localDay(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayBefore(key) { const p = String(key).split('-').map(Number); return localDay(new Date(p[0], p[1] - 1, p[2] - 1)); }
  function isNextDay(a, b) { return dayBefore(b) === a; }

  // ① 热力图：daily map → 当年每日单元（补齐整年，缺失日 seconds=0）
  function buildHeatmap(daily, year) {
    const map = daily || {};
    const y = Number(year) || new Date().getFullYear();
    const cells = [];
    const d = new Date(y, 0, 1);
    const end = new Date(y, 11, 31);
    while (d <= end) {
      const key = localDay(d);
      const seconds = Number(map[key]) || 0;
      cells.push({ day: key, seconds: seconds, level: levelOf(seconds) });
      d.setDate(d.getDate() + 1);
    }
    return cells;
  }

  // ② 时长汇总
  function buildDurations(totals) {
    const t = totals || {};
    const card = (x) => ({
      hours: secToHours(x && x.seconds),
      dayAvgHours: secToHours1(x && x.dayAvgSeconds),
      compare: x && typeof x.compare === 'number' ? x.compare : null
    });
    return { week: card(t.week), month: card(t.month), year: card(t.year), overall: card(t.overall) };
  }

  // ③ 阅读偏好：Agent preferCategory 主；空则退化 shelf allBooks.category×readingTime（best-effort）
  function preferenceFromShelf(shelfVM) {
    const books = (shelfVM && shelfVM.allBooks) || [];
    const agg = {};
    for (const b of books) {
      if (!b.category) continue;
      agg[b.category] = (agg[b.category] || 0) + (Number(b.readingTime) || 0);
    }
    return Object.keys(agg).map(c => ({ category: c, seconds: agg[c] }));
  }
  function buildPreference(preference, shelfVM) {
    let rows = (preference || []).map(p => ({ category: p.category, seconds: Number(p.seconds) || 0 }));
    if (!rows.length && shelfVM) rows = preferenceFromShelf(shelfVM);
    const total = rows.reduce((a, r) => a + r.seconds, 0);
    return rows.filter(r => r.category && r.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds).slice(0, 8)
      .map(r => ({ category: r.category, seconds: r.seconds, percent: total > 0 ? Math.round(r.seconds / total * 100) : 0 }));
  }

  // ④ 读最久 TOP5：Agent readLongest 主；空则退化 shelf allBooks.readingTime 降序
  function buildTopBooks(topBooks, shelfVM) {
    let rows = (topBooks || []).map(t => ({ bookId: t.bookId, title: t.title, cover: t.cover, seconds: Number(t.seconds) || 0 }));
    if (!rows.length && shelfVM) {
      rows = ((shelfVM && shelfVM.allBooks) || [])
        .filter(b => (Number(b.readingTime) || 0) > 0)
        .map(b => ({ bookId: b.bookId, title: b.title, cover: b.cover, seconds: Number(b.readingTime) || 0 }));
    }
    return rows.sort((a, b) => b.seconds - a.seconds).slice(0, 5)
      .map(r => ({ bookId: r.bookId, title: r.title, cover: r.cover, hours: secToHours1(r.seconds) }));
  }

  // ⑥ 连续打卡：seconds>0=打卡；当前连续从 today（未打卡则昨天）往回数
  function buildStreak(daily, readDays, todayStr) {
    const map = daily || {};
    const days = Object.keys(map).filter(k => (Number(map[k]) || 0) > 0).sort();
    let longest = 0, run = 0, prev = null;
    for (const k of days) {
      run = (prev && isNextDay(prev, k)) ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = k;
    }
    const today = todayStr || localDay(new Date());
    let cursor = (Number(map[today]) || 0) > 0 ? today : dayBefore(today);
    let current = 0;
    while ((Number(map[cursor]) || 0) > 0) { current += 1; cursor = dayBefore(cursor); }
    return { current: current, longest: longest, readDays: Number(readDays) || 0 };
  }

  // 总装：StatsBundle + 可选 shelfVM → 看板视图模型
  function buildStatsViewModel(bundle, shelfVM, year) {
    const b = bundle || {};
    const y = Number(year) || new Date().getFullYear();
    const connected = !!(b.ok && b.source === 'agent');
    return {
      connected: connected,
      fetchedAt: b.fetchedAt || null,
      year: y,
      heatmap: connected ? buildHeatmap(b.daily, y) : [],
      durations: connected ? buildDurations(b.totals) : null,
      preference: buildPreference(b.preference, shelfVM),   // 退化仍可用
      topBooks: buildTopBooks(b.topBooks, shelfVM),          // 退化仍可用
      streak: connected ? buildStreak(b.daily, b.readDays) : { current: 0, longest: 0, readDays: 0 },
      medals: b.medals || []
    };
  }

  const api = {
    levelOf, secToHours, secToHours1, localDay, dayBefore,
    buildHeatmap, buildDurations, buildPreference, buildTopBooks, buildStreak, buildStatsViewModel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatsData = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 7: 跑测试确认通过**

Run: `node --test test/stats-data.test.js`
Expected: PASS（11 测全绿）。

- [ ] **Step 8: 全量回归**

Run: `node --test test/`
Expected: PASS（31 + 6→已含 + 11 = 42 测全绿；以实际计数为准，关键是 0 fail）。

- [ ] **Step 9: 提交**

```bash
git add shelf-data.js test/shelf-data.test.js stats-data.js test/stats-data.test.js
git commit -m "feat: stats-data 看板视图模型（热力图/时长/偏好/TOP5/打卡）+ shelf-data 补退化字段 + 单测"
```

---

### Task 5: book-detail-data.js —— 详情视图模型纯函数

**消费：** `BookBundle`（Task 3 产出）→ 详情侧栏视图模型（头部/元信息/简介/书评/本书统计）。

**Files:**
- Create: `book-detail-data.js`
- Test: `test/book-detail-data.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/book-detail-data.test.js`：
```js
const test = require('node:test');
const assert = require('node:assert');
const D = require('../book-detail-data.js');
const api = require('../weread-api.js');
const bookInfo = require('./fixtures/book-info.json');
const bookProgress = require('./fixtures/book-progress.json');
const reviewList = require('./fixtures/review-list.json');

const bundle = {
  ok: true, source: 'agent', fetchedAt: 1,
  info: { bookId:'b1', title:'书一', author:'甲', translator:'', cover:'c', intro:'简介',
          category:'文学', publisher:'某社', publishTime:'2020', isbn:'123', wordCount:250000, rating:85, ratingCount:1200 },
  progress: { percent:45, seconds:3600*8, lastReadAt:1735660800, finishTime:0, started:true },
  communityReviews: [ { reviewId:'r1', content:'很好看', star:100, authorName:'读者A', authorAvatar:'a', createTime:1735660800 } ],
  reviewsMeta: { count: 2337, recommendValue: 862 },
  myReviews: []
};

test('starOf: 20..100 → 1..5', () => {
  assert.strictEqual(D.starOf(100), 5);
  assert.strictEqual(D.starOf(60), 3);
  assert.strictEqual(D.starOf(0), 0);
});

test('formatDate: 秒/毫秒时间戳 → YYYY-MM-DD（一致）', () => {
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(D.formatDate(1735660800)));
  assert.strictEqual(D.formatDate(1735660800), D.formatDate(1735660800000));
  assert.strictEqual(D.formatDate(0), '');
});

test('formatWordCount: ≥1万→万字，否则→字', () => {
  assert.strictEqual(D.formatWordCount(250000), '25万字');
  assert.strictEqual(D.formatWordCount(8000), '8000字');
});

test('buildMetaRows: 有值才列，空字段跳过', () => {
  const rows = D.buildMetaRows(bundle.info);
  assert.strictEqual(rows.find(r => r.k === 'ISBN').v, '123');
  assert.strictEqual(rows.find(r => r.k === '字数').v, '25万字');
  assert.strictEqual(rows.find(r => r.k === '译者'), undefined);
});

test('buildDetailViewModel: 形状完整，star/recommend 换算', () => {
  const vm = D.buildDetailViewModel(bundle);
  assert.strictEqual(vm.title, '书一');
  assert.strictEqual(vm.rating, 85);
  assert.strictEqual(vm.bookStats.hours, 8);
  assert.strictEqual(vm.bookStats.progress, 45);
  assert.strictEqual(vm.communityReviews[0].star, 5);
  assert.strictEqual(vm.recommendPercent, 86);   // 862→86
});

test('buildDetailViewModel: 未连接 → connected=false，不报错', () => {
  const vm = D.buildDetailViewModel({ ok:false, source:'none' });
  assert.strictEqual(vm.connected, false);
  assert.deepStrictEqual(vm.communityReviews, []);
  assert.deepStrictEqual(vm.metaRows, []);
});

test('buildDetailViewModel: 真实 fixture 归一化后仍可构建', () => {
  const b = api.assembleBookBundle(api.normalizeBookInfo(bookInfo), api.normalizeProgress(bookProgress), api.normalizeReviews(reviewList));
  const vm = D.buildDetailViewModel(b);
  assert.strictEqual(typeof vm.title, 'string');
  assert.ok(Array.isArray(vm.metaRows));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test test/book-detail-data.test.js`
Expected: FAIL —— `Cannot find module '../book-detail-data.js'`。

- [ ] **Step 3: 写实现**

创建 `book-detail-data.js`：
```js
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test test/book-detail-data.test.js`
Expected: PASS（7 测全绿）。

- [ ] **Step 5: 全量回归 + 提交**

Run: `node --test test/`
Expected: PASS（0 fail）。
```bash
git add book-detail-data.js test/book-detail-data.test.js
git commit -m "feat: book-detail-data 详情视图模型（元信息/书评/本书统计）+ 单测"
```

---

### Task 6: 缓存与 Agent 取数 IPC（main.js + preload.js）

**职责：** 主进程持久化 auth/stats/book 缓存，并提供 Agent 取数通道（主进程读 auth → `resolveAuth` → key 模式则调 `weread-api`）。IPC 不写单测，用 `node --check` 做语法验证 + Phase B 集成手测。

**Files:**
- Modify: `main.js`（顶部 require、缓存目录常量、新增 8 个 IPC handler）
- Modify: `preload.js`（暴露 8 个方法）

- [ ] **Step 1: main.js 顶部引入依赖**

在 `main.js` 第 3 行 `const fs = require('fs');` 之后新增：
```js
const WereadAuth = require('./weread-auth.js');
const WereadApi = require('./weread-api.js');
```

- [ ] **Step 2: main.js 新增缓存目录常量**

在现有 `SHELF_CACHE_DIR` / `ensureShelfCacheDir()` 定义之后新增：
```js
const AUTH_PATH = path.join(app.getPath('userData'), 'auth.json');
const STATS_CACHE_DIR = path.join(app.getPath('userData'), 'stats-cache');
const BOOK_CACHE_DIR = path.join(app.getPath('userData'), 'book-cache');
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true }); } catch (_) {} }
function readJson(p) { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; } catch (_) { return null; } }
function writeJson(p, v) { try { fs.writeFileSync(p, JSON.stringify(v), 'utf8'); return true; } catch (_) { return false; } }
```

- [ ] **Step 3: main.js 新增 IPC handler**

在现有 `ipcMain.handle('shelf-cache-write', ...)` 之后、`app.whenReady()` 之前新增：
```js
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
```

- [ ] **Step 4: preload.js 暴露方法**

把 `preload.js` 的 `exposeInMainWorld('wereadPC', {...})` 内、`writeShelfCache` 行后（注意给它补上逗号）新增：
```js
  readAuth: () => ipcRenderer.invoke('auth-read'),
  writeAuth: (a) => ipcRenderer.invoke('auth-write', a),
  readStatsCache: () => ipcRenderer.invoke('stats-cache-read'),
  writeStatsCache: (vm) => ipcRenderer.invoke('stats-cache-write', vm),
  readBookCache: (id) => ipcRenderer.invoke('book-cache-read', id),
  writeBookCache: (id, vm) => ipcRenderer.invoke('book-cache-write', id, vm),
  fetchStats: () => ipcRenderer.invoke('weread-fetch-stats'),
  fetchBook: (id) => ipcRenderer.invoke('weread-fetch-book', id)
```
最终 `preload.js` 形如：
```js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wereadPC', {
  setPowerSave: (on) => ipcRenderer.invoke('power-save', on),
  forceRerender: () => ipcRenderer.invoke('force-rerender'),
  setWindowWidth: (width) => ipcRenderer.invoke('set-window-width', width),
  readShelfCache: () => ipcRenderer.invoke('shelf-cache-read'),
  writeShelfCache: (vm) => ipcRenderer.invoke('shelf-cache-write', vm),
  readAuth: () => ipcRenderer.invoke('auth-read'),
  writeAuth: (a) => ipcRenderer.invoke('auth-write', a),
  readStatsCache: () => ipcRenderer.invoke('stats-cache-read'),
  writeStatsCache: (vm) => ipcRenderer.invoke('stats-cache-write', vm),
  readBookCache: (id) => ipcRenderer.invoke('book-cache-read', id),
  writeBookCache: (id, vm) => ipcRenderer.invoke('book-cache-write', id, vm),
  fetchStats: () => ipcRenderer.invoke('weread-fetch-stats'),
  fetchBook: (id) => ipcRenderer.invoke('weread-fetch-book', id)
});
```

- [ ] **Step 5: 语法验证（不启动 electron）**

Run: `node --check main.js && node --check preload.js && node --check weread-api.js && echo OK`
Expected: 输出 `OK`（无语法错）。注：`node --check` 只解析不执行，不会触发 `require('electron')`。

- [ ] **Step 6: 全量回归（确保未误伤纯函数层）**

Run: `node --test test/`
Expected: PASS（0 fail）。

- [ ] **Step 7: 提交**

```bash
git add main.js preload.js
git commit -m "feat: 主进程 auth/stats/book 缓存 IPC + Agent 取数通道"
```

---

## 阶段 B：界面（Task 7–12，产出可见功能）

### Task 7: index.html 骨架 —— 顶栏双 Tab + 新容器 + CSS

**布局决策（最小化对现有可用代码的改动）：**
- 新增固定顶栏 `#libtabs`（`z-index:12`，高 52px），仅"书库模式"（书架或统计可见）显示：左 `[书架][统计]` Tab、右 `⚙`。
- `#shelf` 由 `inset:0` 改为 `top:52px`（让位给 `#libtabs`），其内部 `.shelf-head`（我的书架 + pills + 刷新）**原样不动**。
- `#stats`（`z-index:10`，`top:52px`）与 `#shelf` 平级，互斥显示。
- `#detail`（右侧滑出，`z-index:15`）、`#settings`（居中模态，`z-index:30`）、`#loading`（`z-index:20` 不变）。
- `weread-api.js` 是**主进程专用**，不在 index.html 引入；renderer 侧引入 `weread-auth/stats-data/book-detail-data/stats-view/detail-view/settings-view`。

**Files:**
- Modify: `index.html`

- [ ] **Step 1: 调整 #shelf 顶部让位**

把 `#shelf { position: fixed; inset: 0; z-index: 10; ... }` 中的 `inset: 0;` 改为 `top: 52px; left: 0; right: 0; bottom: 0;`（其余属性不变）。

- [ ] **Step 2: 新增 CSS**

在 `<style>` 末尾（`.shelf-empty {...}` 之后、`</style>` 之前）追加：
```css
    /* ===== 书库顶栏双 Tab ===== */
    #libtabs {
      position: fixed; top: 0; left: 0; right: 0; height: 52px; z-index: 12;
      display: none; align-items: center; gap: 6px; padding: 0 16px;
      background: var(--bar-bg); border-bottom: 1px solid var(--bar-border);
      -webkit-user-select: none; user-select: none;
    }
    body.library-mode #libtabs { display: flex; }
    #libtabs .tab {
      height: 52px; padding: 0 14px; border: none; border-radius: 0; background: transparent;
      box-shadow: none; font-size: 14px; color: var(--text-dim); position: relative;
    }
    #libtabs .tab:hover { background: transparent; color: var(--text); }
    #libtabs .tab.active { color: var(--accent); font-weight: 600; }
    #libtabs .tab.active::after {
      content: ''; position: absolute; left: 14px; right: 14px; bottom: 0; height: 2px;
      background: var(--accent); border-radius: 2px 2px 0 0;
    }
    .icon-btn { width: 32px; padding: 0; font-size: 16px; }

    /* ===== 统计看板 ===== */
    #stats {
      position: fixed; top: 52px; left: 0; right: 0; bottom: 0; z-index: 10;
      display: none; overflow-y: auto; background: #fafbfc; padding: 18px 22px 40px;
    }
    #stats.show { display: block; }
    .stat-card { background: #fff; border: 1px solid #eef0f3; border-radius: 12px; padding: 16px 18px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(16,18,24,.06); }
    .stat-h { font-size: 13px; color: var(--text-dim); margin-bottom: 12px; }
    .heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 12px); gap: 3px; overflow-x: auto; }
    .heat i { width: 12px; height: 12px; border-radius: 2px; background: #ebedf0; }
    .heat i.lv1 { background: #c6e48b; } .heat i.lv2 { background: #7bc96f; }
    .heat i.lv3 { background: #239a3b; } .heat i.lv4 { background: #196127; }
    .dur-row { display: flex; gap: 14px; flex-wrap: wrap; }
    .dur { flex: 1; min-width: 120px; }
    .dur b { font-size: 26px; font-variant-numeric: tabular-nums; }
    .dur span { font-size: 12px; color: var(--text-dim); margin-left: 2px; }
    .dur small { display: block; font-size: 12px; color: var(--text-dim); margin-top: 2px; }
    .cmp-up { color: #1f9254; } .cmp-down { color: #d1495b; }
    .pref-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; }
    .pref-row .name { width: 72px; flex: none; color: var(--text); }
    .pref-row .track { flex: 1; height: 8px; background: #eef0f3; border-radius: 4px; overflow: hidden; }
    .pref-row .track > i { display: block; height: 100%; background: var(--accent); }
    .pref-row .pct { width: 40px; flex: none; text-align: right; color: var(--text-dim); }
    .top-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .top-row img { width: 34px; height: 46px; border-radius: 4px; object-fit: cover; background: #eef1f5; }
    .top-row .t { flex: 1; font-size: 13px; }
    .top-row .h { font-size: 12px; color: var(--text-dim); font-variant-numeric: tabular-nums; }
    .streak { display: flex; gap: 22px; align-items: center; }
    .streak .n { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .stat-empty { color: var(--text-dim); font-size: 13px; text-align: center; padding: 40px 0; }
    .stat-empty button { margin-top: 12px; }

    /* ===== 详情侧栏 ===== */
    #detail {
      position: fixed; top: 0; right: 0; bottom: 0; width: 380px; z-index: 15;
      background: #fff; border-left: 1px solid var(--bar-border); box-shadow: -6px 0 24px rgba(16,18,24,.10);
      transform: translateX(100%); transition: transform .22s ease; display: flex; flex-direction: column;
    }
    #detail.show { transform: translateX(0); }
    .dt-head { flex: none; display: flex; gap: 12px; padding: 16px; border-bottom: 1px solid #eef0f3; }
    .dt-head img { width: 72px; height: 96px; border-radius: 6px; object-fit: cover; background: #eef1f5; }
    .dt-head .m { flex: 1; min-width: 0; }
    .dt-head .ti { font-size: 16px; font-weight: 600; line-height: 1.3; }
    .dt-head .au { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
    .dt-head .ra { font-size: 12px; color: #f0a020; margin-top: 6px; }
    .dt-close { position: absolute; top: 10px; right: 12px; border: none; background: transparent; font-size: 18px; color: var(--text-dim); width: 28px; padding: 0; }
    .dt-tabs { flex: none; display: flex; gap: 4px; padding: 0 12px; border-bottom: 1px solid #eef0f3; }
    .dt-tabs button { height: 38px; border: none; border-radius: 0; background: transparent; box-shadow: none; font-size: 13px; color: var(--text-dim); position: relative; }
    .dt-tabs button.active { color: var(--accent); font-weight: 600; }
    .dt-tabs button.active::after { content: ''; position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; background: var(--accent); }
    .dt-body { flex: 1; overflow-y: auto; padding: 14px 16px; }
    .dt-read { margin: 0 16px 12px; }
    .meta-row { display: flex; gap: 8px; font-size: 13px; padding: 5px 0; }
    .meta-row .k { width: 56px; flex: none; color: var(--text-dim); }
    .intro { font-size: 13px; line-height: 1.7; color: #4a4f5a; margin-top: 10px; }
    .review { border-left: 3px solid var(--accent-soft); padding: 8px 12px; margin-bottom: 12px; background: #fafbfc; border-radius: 0 6px 6px 0; }
    .review .who { font-size: 12px; color: var(--text-dim); margin-bottom: 4px; }
    .review .txt { font-size: 13px; line-height: 1.6; }
    .dt-empty { color: var(--text-dim); font-size: 13px; text-align: center; padding: 30px 0; }

    /* ===== 设置模态 ===== */
    #settings { position: fixed; inset: 0; z-index: 30; display: none; align-items: center; justify-content: center; background: rgba(16,18,24,.32); }
    #settings.show { display: flex; }
    .stg { width: 420px; max-height: 82vh; overflow-y: auto; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(16,18,24,.24); }
    .stg-hd { display: flex; align-items: center; padding: 14px 18px; border-bottom: 1px solid #eef0f3; font-size: 15px; font-weight: 600; }
    .stg-hd .x { margin-left: auto; border: none; background: transparent; font-size: 18px; color: var(--text-dim); width: 28px; padding: 0; }
    .stg-sec { padding: 14px 18px; border-bottom: 1px solid #f2f4f7; }
    .stg-lbl { font-size: 12px; color: var(--text-dim); margin-bottom: 8px; }
    .conn-pill { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; }
    .conn-ok { background: #eafaf1; color: #1f9254; } .conn-no { background: #fdecec; color: #d1495b; } .conn-warn { background: #fff5e6; color: #c77700; }
    .keybox { font-family: ui-monospace, Menlo, monospace; background: #f5f7fa; border: 1px solid #e6e9ee; border-radius: 6px; padding: 4px 8px; font-size: 12px; color: #5b6472; }
    .stg input[type=text], .stg textarea { width: 100%; border: 1px solid var(--bar-border); border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: inherit; margin-bottom: 8px; }
    .stg details summary { cursor: pointer; font-size: 13px; color: var(--accent); }
    .stg-ft { padding: 12px 18px; font-size: 11px; color: var(--text-dim); line-height: 1.6; }

    /* ===== 首次气泡引导 ===== */
    .bubble { position: fixed; z-index: 25; background: #2c2f36; color: #fff; font-size: 12px; padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.2); max-width: 240px; }
```

- [ ] **Step 3: 新增 DOM 容器**

在 `<body>` 内、`<div id="shelf"></div>` **之前**插入顶栏：
```html
  <div id="libtabs">
    <button class="tab active" id="tabShelf">书架</button>
    <button class="tab" id="tabStats">统计</button>
    <span class="spacer"></span>
    <button class="icon-btn" id="settingsBtn" title="设置">⚙</button>
  </div>
```
在 `<div id="loading">...</div>` **之后**、`<script src="shelf-data.js">` 之前插入三个容器：
```html
  <div id="stats"></div>
  <div id="detail"></div>
  <div id="settings"></div>
```

- [ ] **Step 4: 新增 script 引入**

把现有脚本区改为（顺序：数据 → 视图 → 编排；weread-api.js 不引入）：
```html
  <script src="shelf-data.js"></script>
  <script src="shelf-fetch.js"></script>
  <script src="shelf-view.js"></script>
  <script src="weread-auth.js"></script>
  <script src="stats-data.js"></script>
  <script src="book-detail-data.js"></script>
  <script src="stats-view.js"></script>
  <script src="detail-view.js"></script>
  <script src="settings-view.js"></script>
  <script src="renderer.js"></script>
```
> 注：`stats-view.js`/`detail-view.js`/`settings-view.js` 在 Task 8/10/11 创建。本 Task 先占位引入会导致加载 404——**因此 Step 4 与 Task 8/10/11 需在同一分支连续完成后再启动验收**；若需中途启动 app 调试，可临时先只引入已存在的脚本，待对应 view 文件建好再补齐。

- [ ] **Step 5: 结构验证**

Run: `grep -c 'id="libtabs"\|id="stats"\|id="detail"\|id="settings"' index.html`
Expected: `4`（四个新容器就位）。

- [ ] **Step 6: 提交**

```bash
git add index.html
git commit -m "feat: index.html 顶栏双 Tab + 统计/详情/设置容器 + CSS"
```

---

### Task 8: stats-view.js —— 统计看板 DOM 渲染

**消费：** `StatsData.buildStatsViewModel` 产出的看板视图模型 → 画进 `#stats`。DOM 渲染不写单测（与 `shelf-view` 一致，仅 `node --check` + Task 12 目测）。未连接时显示引导态，但③④若有退化数据仍展示。

**Files:**
- Create: `stats-view.js`

- [ ] **Step 1: 写实现**

创建 `stats-view.js`：
```js
// stats-view.js — 统计看板 DOM 渲染（只看视图模型，不发请求）
(function (root) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function card(title) {
    const c = el('div', 'stat-card');
    if (title) c.appendChild(el('div', 'stat-h', title));
    return c;
  }

  // ① 热力图
  function renderHeatmap(vm) {
    const c = card(vm.year + ' 年阅读热力图');
    const grid = el('div', 'heat');
    for (const cell of vm.heatmap) {
      const i = el('i', cell.level ? ('lv' + cell.level) : '');
      i.title = cell.day + ' · ' + Math.round((cell.seconds || 0) / 60) + ' 分钟';
      grid.appendChild(i);
    }
    c.appendChild(grid);
    return c;
  }

  // ② 时长汇总
  function renderDurations(vm) {
    const d = vm.durations || {};
    const c = card('阅读时长');
    const row = el('div', 'dur-row');
    const defs = [['year', '今年'], ['month', '本月'], ['week', '本周'], ['overall', '累计']];
    for (const def of defs) {
      const x = d[def[0]] || {};
      const box = el('div', 'dur');
      const big = el('div');
      big.appendChild(el('b', null, String(x.hours || 0)));
      big.appendChild(el('span', null, '小时'));
      box.appendChild(big);
      box.appendChild(el('small', null, '日均 ' + (x.dayAvgHours || 0) + 'h'));
      if (typeof x.compare === 'number') {
        const up = x.compare >= 0;
        box.appendChild(el('small', up ? 'cmp-up' : 'cmp-down',
          (up ? '↑ ' : '↓ ') + Math.round(Math.abs(x.compare) * 100) + '% 环比'));
      }
      row.appendChild(box);
    }
    c.appendChild(row);
    return c;
  }

  // ③ 阅读偏好
  function renderPreference(vm) {
    const c = card('阅读偏好');
    if (!vm.preference.length) { c.appendChild(el('div', 'stat-empty', '暂无偏好数据')); return c; }
    const max = vm.preference[0].seconds || 1;
    for (const p of vm.preference) {
      const row = el('div', 'pref-row');
      row.appendChild(el('span', 'name', p.category));
      const track = el('div', 'track'); const fill = el('i');
      fill.style.width = Math.max(4, Math.round(p.seconds / max * 100)) + '%';
      track.appendChild(fill); row.appendChild(track);
      row.appendChild(el('span', 'pct', p.percent + '%'));
      c.appendChild(row);
    }
    return c;
  }

  // ④ 读最久 TOP5（点击→详情）
  function renderTopBooks(vm, onOpenBook) {
    const c = card('读得最久 TOP5');
    if (!vm.topBooks.length) { c.appendChild(el('div', 'stat-empty', '暂无数据')); return c; }
    for (const b of vm.topBooks) {
      const row = el('div', 'top-row');
      if (b.cover) { const img = el('img'); img.src = b.cover; img.alt = b.title; row.appendChild(img); }
      row.appendChild(el('div', 't', b.title));
      row.appendChild(el('div', 'h', b.hours + 'h'));
      if (onOpenBook && b.bookId) { row.style.cursor = 'pointer'; row.addEventListener('click', () => onOpenBook(b.bookId)); }
      c.appendChild(row);
    }
    return c;
  }

  // ⑥ 连续打卡/成就
  function renderStreak(vm) {
    const s = vm.streak || {};
    const c = card('连续打卡');
    const row = el('div', 'streak');
    const mk = (n, label) => { const b = el('div'); b.appendChild(el('div', 'n', String(n || 0))); b.appendChild(el('small', null, label)); return b; };
    row.appendChild(mk(s.current, '当前连续(天)'));
    row.appendChild(mk(s.longest, '历史最长(天)'));
    row.appendChild(mk(s.readDays, '有效阅读(天)'));
    c.appendChild(row);
    if (vm.medals && vm.medals.length) {
      c.appendChild(el('div', 'stat-h', '成就：' + vm.medals.map(x => x.title || '').filter(Boolean).join('、')));
    }
    return c;
  }

  // 主入口
  function render(container, vm, handlers) {
    container.textContent = '';
    const h = handlers || {};
    if (!vm || !vm.connected) {
      const box = el('div', 'stat-empty');
      box.appendChild(el('div', null, '未连接微信读书，无法获取完整统计'));
      const b = el('button', 'primary', '去设置连接');
      b.addEventListener('click', () => h.onSettings && h.onSettings());
      box.appendChild(b);
      container.appendChild(box);
      if (vm && vm.preference.length) container.appendChild(renderPreference(vm));   // 退化仍可用
      if (vm && vm.topBooks.length) container.appendChild(renderTopBooks(vm, h.onOpenBook));
      return;
    }
    container.appendChild(renderDurations(vm));
    container.appendChild(renderHeatmap(vm));
    container.appendChild(renderPreference(vm));
    container.appendChild(renderTopBooks(vm, h.onOpenBook));
    container.appendChild(renderStreak(vm));
  }

  const api = { el, render, renderHeatmap, renderDurations, renderPreference, renderTopBooks, renderStreak };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatsView = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 2: 语法验证**

Run: `node --check stats-view.js && echo OK`
Expected: `OK`。

- [ ] **Step 3: 提交**

```bash
git add stats-view.js
git commit -m "feat: stats-view 统计看板渲染（热力图/时长/偏好/TOP5/打卡）"
```

---

### Task 9: renderer.js —— 双 Tab 切换 + 统计取数编排 + 自动取 Key

**职责：** 把「书架｜统计」双 Tab 接进现有 `renderer.js` 的模式机（`mode='shelf'|'reader'` 之上加库内子 Tab `libTab='shelf'|'stats'`），编排统计取数（缓存秒开→后台刷新→派生视图模型→渲染→写缓存），并提供自动取 Key 的尽力尝试（依 Task 1 spike 结论）。

> **跨 Task 前向引用（均为本文件内 `function` 声明，运行前 Task 10/11 已落地）：** `openDetailById(bookId)` 见 Task 10、`openSettings()` 见 Task 11。本 Task 的 `loadStats` 会把它们作为 handler 传给 `StatsView.render`；JS 函数声明提升保证同文件内先引用后声明可用。

**Files:**
- Modify: `renderer.js`（DOM 引用区、`showShelf/hideShelf` 段、事件绑定区、启动 IIFE 前）

- [ ] **Step 1: 新增 DOM 引用**

在 `renderer.js` 现有 `const loadingEl = document.getElementById('loading');`（第 15 行）之后新增：
```js
const libtabsEl = document.getElementById('libtabs');
const tabShelf = document.getElementById('tabShelf');
const tabStats = document.getElementById('tabStats');
const settingsBtn = document.getElementById('settingsBtn');
const statsEl = document.getElementById('stats');
const detailEl = document.getElementById('detail');
const settingsEl = document.getElementById('settings');
```

- [ ] **Step 2: 新增库内子 Tab 状态 + 自动取 Key 端点常量**

在现有 `let pendingOpen = false;` 之后新增：
```js
let libTab = 'shelf';       // 'shelf' | 'stats'，仅 mode==='shelf' 时有意义

// Task 1 spike 若发现免交互取 Key 端点，填此常量（同源、带登录态）；留空 = 不支持自动取 Key，走手动粘贴。
const AUTO_KEY_ENDPOINT = '';
```

- [ ] **Step 3: 改写书库层显隐函数**

把现有这段（第 103–111 行）：
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
```
整体替换为：
```js
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
```

- [ ] **Step 4: 新增自动取 Key + 统计取数编排**

在现有 `refreshShelf()` 函数（`async function refreshShelf() {...}`）之后新增：
```js
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
```

- [ ] **Step 5: 绑定 Tab / 设置按钮事件**

在现有 `homeBtn.addEventListener('click', () => {...});`（第 226–229 行）之后新增：
```js
tabShelf.addEventListener('click', () => { if (mode === 'shelf') showShelf(); });
tabStats.addEventListener('click', () => { if (mode === 'shelf') showStats(); });
settingsBtn.addEventListener('click', () => openSettings());
```

- [ ] **Step 6: homeBtn 回书架时按当前子 Tab 复位**

把现有 `homeBtn` 回调：
```js
homeBtn.addEventListener('click', () => {
  showShelf();
  refreshShelf(); // 返回书架时后台刷新进度
});
```
替换为（从阅读返回时回到「书架」子 Tab，并撤下详情侧栏）：
```js
homeBtn.addEventListener('click', () => {
  closeDetail();   // Task 10 定义
  showShelf();
  refreshShelf();  // 返回书架时后台刷新进度
});
```

- [ ] **Step 7: 语法验证**

Run: `node --check renderer.js && echo OK`
Expected: `OK`。
> 注：`node --check` 只解析语法，`openDetailById`/`openSettings`/`closeDetail` 尚未定义不影响解析；它们在 Task 10/11 补齐。

- [ ] **Step 8: 提交**

```bash
git add renderer.js
git commit -m "feat: renderer 双 Tab 切换 + 统计取数编排 + 自动取 Key"
```

---

### Task 10: detail-view.js + 书卡单击/双击改造 + 详情编排 + 首次气泡

**职责：** （1）新建 `detail-view.js` 画详情侧栏（概览/书评/统计 三 Tab）；（2）改 `shelf-view.js` 书卡交互：单击→详情、双击→阅读；（3）`renderer.js` 详情取数编排（缓存 TTL 7 天秒开→后台刷新→派生→渲染→写缓存）+ 首次气泡引导。

**Files:**
- Create: `detail-view.js`
- Modify: `shelf-view.js`（`bookCard` 签名 + `VirtualGrid` + `render`）
- Modify: `renderer.js`（`paintShelf` handlers、`openBook`、新增 `openDetail/loadDetail/closeDetail/openDetailById/showBubbleOnce/closeBubble`）

- [ ] **Step 1: 创建 detail-view.js**

创建 `detail-view.js`（消费 `BookDetailData.buildDetailViewModel` 产出的视图模型；复用已加载的 `window.BookDetailData.formatDate`，不重复造轮）：
```js
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
    who.textContent = (r.authorName || '匠名') + (r.star ? ' · ' + stars(r.star) : '') + (r.date ? ' · ' + r.date : '');
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
```

- [ ] **Step 2: 语法验证 detail-view.js**

Run: `node --check detail-view.js && echo OK`
Expected: `OK`。

- [ ] **Step 3: 改 shelf-view.js 书卡交互（单击→详情、双击→阅读）**

把 `shelf-view.js` 的 `bookCard`（第 27–47 行）整体替换为（签名从 `(vm, onOpen, lazy)` 改为 `(vm, handlers, lazy)`）：
```js
  // 单张书卡；handlers = { onOpen, onDetail }；lazy=true 封面走 data-src 懒加载
  // 单击→详情（延迟 220ms 避开双击）；双击→阅读
  function bookCard(vm, handlers, lazy) {
    const h = handlers || {};
    const card = el('div', 'book-card');
    const cover = el('div', 'cover');
    if (vm.cover) {
      const img = el('img');
      if (lazy) img.dataset.src = vm.cover;  // 懒加载：进入视口才赋 src
      else img.src = vm.cover;               // 立即可见，直接加载
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
    let clickTimer = null;
    card.addEventListener('click', () => {
      if (clickTimer) return;
      clickTimer = setTimeout(() => { clickTimer = null; if (h.onDetail) h.onDetail(vm); }, 220);
    });
    card.addEventListener('dblclick', () => {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      if (h.onOpen) h.onOpen(vm);
    });
    return card;
  }
```

- [ ] **Step 4: 同步改 shelf-view.js 的 bookCard 调用方**

（4a）`VirtualGrid` 构造函数里，`this.onOpen = opts.onOpen;` 后新增一行：
```js
    this.onDetail = opts.onDetail;
```
（4b）`VirtualGrid.prototype.paint` 里，把：
```js
        cell.appendChild(bookCard(this.items[idx], this.onOpen, true));
```
改为：
```js
        cell.appendChild(bookCard(this.items[idx], { onOpen: this.onOpen, onDetail: this.onDetail }, true));
```
（4c）`render` 里「继续阅读」行，把：
```js
      vm.continueReading.forEach(b => row.appendChild(bookCard(b, handlers.onOpen)));
```
改为：
```js
      vm.continueReading.forEach(b => row.appendChild(bookCard(b, { onOpen: handlers.onOpen, onDetail: handlers.onDetail })));
```
（4d）`render` 末尾创建 `VirtualGrid`，把：
```js
    container._grid = new VirtualGrid(viewport, vm.allBooks, { onOpen: handlers.onOpen });
```
改为：
```js
    container._grid = new VirtualGrid(viewport, vm.allBooks, { onOpen: handlers.onOpen, onDetail: handlers.onDetail });
```

- [ ] **Step 5: 回归 shelf-view 单测（computeRange 不受影响）**

Run: `node --test test/shelf-view.test.js`
Expected: PASS（`computeRange` 未改，仍全绿）。

- [ ] **Step 6: renderer.js —— paintShelf 传 onDetail + openBook 关侧栏**

（6a）把 `paintShelf` 里的 `window.ShelfView.render(shelfEl, vm, {...})`：
```js
  window.ShelfView.render(shelfEl, vm, {
    onOpen: openBook,
    onRefresh: () => refreshShelf()
  });
```
改为：
```js
  window.ShelfView.render(shelfEl, vm, {
    onOpen: openBook,
    onDetail: openDetail,
    onRefresh: () => refreshShelf()
  });
  showBubbleOnce();   // 首次提示单击/双击
```
（6b）把 `openBook` 函数体首行加上关闭侧栏/气泡：
```js
function openBook(vm) {
  closeDetail();
  closeBubble();
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
```

- [ ] **Step 7: renderer.js —— 新增详情编排 + 气泡（接在 loadStats 之后）**

在 Task 9 新增的 `loadStats()` 之后新增：
```js
// ---- 详情侧栏 ----
const DETAIL_TTL = 7 * 24 * 3600 * 1000;   // 7 天
function detailHandlers(vm) {
  return { onClose: closeDetail, onRead: () => openBook(vm) };
}
// vm = 书架 book VM（含 bookId/title/cover/deepLink/readerUrl）
function openDetail(vm) {
  if (!vm || !vm.bookId) return;
  closeBubble();
  detailEl.classList.add('show');
  const h = detailHandlers(vm);
  // 先用书架 VM 画占位（封面/书名立即可见），再后台补详情
  window.DetailView.render(detailEl, window.BookDetailData.buildDetailViewModel({
    ok: false, info: { bookId: vm.bookId, title: vm.title, author: vm.author, cover: vm.cover }
  }), h);
  loadDetail(vm.bookId, h);
}
// 从统计 TOP5 点开：先在书架 VM 里找，找不到用最小信息
function openDetailById(bookId) {
  let vm = null;
  if (currentVM && currentVM.allBooks) {
    vm = currentVM.allBooks.filter(b => String(b.bookId) === String(bookId))[0] || null;
  }
  openDetail(vm || { bookId: String(bookId) });
}
async function loadDetail(bookId, handlers) {
  const h = handlers || { onClose: closeDetail };
  let cached = null;
  try { cached = await window.wereadPC.readBookCache(bookId); } catch (_) { cached = null; }
  if (cached && cached.vm && cached.fetchedAt && (Date.now() - cached.fetchedAt) < DETAIL_TTL) {
    window.DetailView.render(detailEl, cached.vm, h);
    return;   // 命中未过期缓存，不再打网络
  }
  let bundle = null;
  try { bundle = await window.wereadPC.fetchBook(bookId); } catch (_) { bundle = null; }
  const vm = window.BookDetailData.buildDetailViewModel(bundle || { ok: false, info: { bookId: bookId } });
  window.DetailView.render(detailEl, vm, h);
  if (bundle && bundle.ok) {
    try { await window.wereadPC.writeBookCache(bookId, { fetchedAt: Date.now(), vm: vm }); } catch (_) {}
  }
}
function closeDetail() { detailEl.classList.remove('show'); }

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
```

- [ ] **Step 8: renderer.js —— 新增 bubbleEl 状态位**

在 Task 9 新增的 `let libTab = 'shelf';` 之后新增：
```js
let bubbleEl = null;      // 首次引导气泡节点
```

- [ ] **Step 9: 语法验证 + 全量回归**

Run: `node --check renderer.js && node --check shelf-view.js && node --check detail-view.js && node --test test/ && echo OK`
Expected: `OK`，且 `node --test test/` 0 fail（≥12 测）。

- [ ] **Step 10: 提交**

```bash
git add detail-view.js shelf-view.js renderer.js
git commit -m "feat: 详情侧栏 + 书卡单击看详情/双击阅读 + 首次气泡引导"
```

---

### Task 11: settings-view.js —— 设置模态 + renderer 接线

**职责：** 居中模态展示连接状态（pill + 掩码 Key + 来源）、折叠高级区（手动 Key/Cookie）、数据与缓存控制、隐私页脚；`renderer.js` 接线 `openSettings/closeSettings/renderSettings`（读 `auth.json` → `WereadAuth.resolveAuth` → 渲染；保存/清除手动配置 → `writeAuth`）。

> **不新增 IPC：** 缓存控制用「刷新统计」（重跑 `loadStats`）实现；统计/详情缓存每次成功取数自然覆盖，无需专门清除通道。

**Files:**
- Create: `settings-view.js`
- Modify: `renderer.js`（新增 `openSettings/closeSettings/renderSettings`）

- [ ] **Step 1: 创建 settings-view.js**

创建 `settings-view.js`（消费渲染进程已加载的 `window.WereadAuth.maskKey` 结果；model 由 renderer 组装好传入）：
```js
// settings-view.js — 设置模态渲染（连接状态 / 高级手动 / 缓存 / 隐私）
// 浏览器：挂 window.SettingsView；node：module.exports。不发请求，只渲染 + 回调 handler。
(function (root) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function pillClass(mode) {
    if (mode === 'key') return 'conn-ok';
    if (mode === 'cookie' || mode === 'webview') return 'conn-warn';
    return 'conn-no';
  }
  function pillText(mode) {
    if (mode === 'key') return '已连接（统计可用）';
    if (mode === 'cookie' || mode === 'webview') return '仅书架（统计需 API Key）';
    return '未连接';
  }
  function sourceText(src) {
    if (src === 'manual') return '手动';
    if (src === 'auto') return '自动';
    return '无';
  }

  // model = { mode, source, maskedKey, manualKey, manualCookie }
  // handlers = { onClose, onSaveManual({key,cookie}), onClearManual, onRetryAuto, onRefreshStats }
  function render(container, model, handlers) {
    const m = model || {};
    const h = handlers || {};
    // 重建面板（不清 container 本身的事件，只清内容）
    container.textContent = '';
    const panel = el('div', 'stg');

    // 头部
    const hd = el('div', 'stg-hd');
    hd.appendChild(el('span', null, '设置'));
    const x = el('button', 'x', '✕');
    x.addEventListener('click', function () { h.onClose && h.onClose(); });
    hd.appendChild(x);
    panel.appendChild(hd);

    // 连接状态
    const sec1 = el('div', 'stg-sec');
    sec1.appendChild(el('div', 'stg-lbl', '微信读书连接'));
    const pill = el('span', 'conn-pill ' + pillClass(m.mode), pillText(m.mode));
    sec1.appendChild(pill);
    if (m.maskedKey) {
      const kb = el('div');
      kb.style.marginTop = '10px';
      kb.appendChild(el('span', 'stg-lbl', 'API Key：'));
      kb.appendChild(el('span', 'keybox', m.maskedKey));
      kb.appendChild(el('span', 'stg-lbl', ' · 来源 ' + sourceText(m.source)));
      sec1.appendChild(kb);
    }
    const retry = el('button', null, '重新获取 Key');
    retry.style.marginTop = '10px';
    retry.addEventListener('click', function () { h.onRetryAuto && h.onRetryAuto(); });
    sec1.appendChild(retry);
    panel.appendChild(sec1);

    // 高级：手动 Key / Cookie
    const sec2 = el('div', 'stg-sec');
    const det = el('details');
    det.appendChild(el('summary', null, '高级：手动配置 Key / Cookie'));
    const wrap = el('div');
    wrap.style.marginTop = '10px';
    wrap.appendChild(el('div', 'stg-lbl', 'API Key（wrk- 开头，从 weread.qq.com/r/weread-skills 获取）'));
    const keyIn = el('input'); keyIn.type = 'text'; keyIn.placeholder = 'wrk-…'; keyIn.value = m.manualKey || '';
    wrap.appendChild(keyIn);
    wrap.appendChild(el('div', 'stg-lbl', 'Cookie（兜底，仅书架/同源；统计不可用）'));
    const ckIn = el('input'); ckIn.type = 'text'; ckIn.placeholder = 'wr_vid=…; wr_skey=…'; ckIn.value = m.manualCookie || '';
    wrap.appendChild(ckIn);
    const saveRow = el('div');
    const save = el('button', 'primary', '保存');
    save.addEventListener('click', function () { h.onSaveManual && h.onSaveManual({ key: keyIn.value, cookie: ckIn.value }); });
    const clear = el('button', null, '清除手动配置');
    clear.style.marginLeft = '8px';
    clear.addEventListener('click', function () { h.onClearManual && h.onClearManual(); });
    saveRow.appendChild(save); saveRow.appendChild(clear);
    wrap.appendChild(saveRow);
    det.appendChild(wrap);
    sec2.appendChild(det);
    panel.appendChild(sec2);

    // 数据与缓存
    const sec3 = el('div', 'stg-sec');
    sec3.appendChild(el('div', 'stg-lbl', '数据与缓存'));
    const rs = el('button', null, '刷新统计数据');
    rs.addEventListener('click', function () { h.onRefreshStats && h.onRefreshStats(); });
    sec3.appendChild(rs);
    const note = el('div', 'stg-lbl', '统计与书籍详情会自动缓存，每次成功取数覆盖旧值。');
    note.style.marginTop = '8px';
    sec3.appendChild(note);
    panel.appendChild(sec3);

    // 隐私页脚
    const ft = el('div', 'stg-ft');
    ft.textContent = '所有数据仅存于本机 .userdata/ 目录（已 gitignore）；API Key 与 Cookie 不会上传、不会打印到日志。';
    panel.appendChild(ft);

    container.appendChild(panel);

    // 点遮罩空白处关闭（只绑一次，避免反复 render 累积监听）
    if (!container._overlayBound) {
      container._overlayBound = true;
      container.addEventListener('click', function (e) { if (e.target === container && h.onClose) h.onClose(); });
    }
  }

  const api = { el, pillClass, pillText, sourceText, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SettingsView = api;
})(typeof window !== 'undefined' ? window : globalThis);
```

- [ ] **Step 2: 语法验证 settings-view.js**

Run: `node --check settings-view.js && echo OK`
Expected: `OK`。

- [ ] **Step 3: renderer.js —— 新增设置编排**

在 Task 10 新增的 `closeBubble()` 之后新增：
```js
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
```

- [ ] **Step 4: 语法验证 + 全量回归**

Run: `node --check renderer.js && node --check settings-view.js && node --test test/ && echo OK`
Expected: `OK`，`node --test test/` 0 fail。

- [ ] **Step 5: 提交**

```bash
git add settings-view.js renderer.js
git commit -m "feat: 设置模态（连接状态/手动 Key与Cookie/缓存/隐私）+ renderer 接线"
```

---

### Task 12: 端到端验收 + README 更新

**职责：** 全量回归、启动 app 手动走一遍新功能、把新界面与认证写进 `README.md`。本 Task 无单测（集成验收），以实际运行表现为准。

**Files:**
- Modify: `README.md`（功能表 / 目录结构 / 登录态与隐私）

- [ ] **Step 1: 全量单测回归**

Run: `node --test test/`
Expected: PASS，0 fail，总测数 ≥ 12（新增 weread-auth/stats-data/book-detail-data/weread-api 归一化 helper 等单测）。

- [ ] **Step 2: 所有新/改 JS 语法验证**

Run: `for f in weread-auth weread-api stats-data book-detail-data stats-view detail-view settings-view shelf-view renderer main preload; do node --check $f.js || echo "FAIL $f"; done; echo DONE`
Expected: 无 `FAIL`，末行 `DONE`。

- [ ] **Step 3: 启动 app（后台）**

Run: `npm start`（需开发者已扫码登录；统计需先在设置里粘 `wrk-` Key，除非 Task 1 spike 发现了自动取 Key 端点并填了 `AUTO_KEY_ENDPOINT`）。

- [ ] **Step 4: 手动验收清单（逐项目测，全部 ✓ 才算通过）**

1. 启动后书架秒开，**顶栏出现「书架｜统计」双 Tab + 右侧 ⚙**；首次底部弹一次气泡“单击书卡看详情，双击直接阅读”（5s 自消，重开不再弹）。
2. **单击**一本书 → 右侧滑出详情侧栏，封面/书名立即可见，随后概览（简介/元信息）、书评（社区点评/推荐率）、统计（已读%/本书时长）三 Tab 可切换；✕ 或点侧栏外关闭。
3. **双击**同一本书 → 进阅读（翻书 loading 后正文就绪，不露官方网页书架）；顶栏「书架」按钮能返回。
4. 点「统计」Tab → 看板依次展现：时长汇总卡、全年热力图、阅读偏好条、读最久 TOP5、连续打卡；未连接（无 Key）时顶部显示“去设置连接”引导，但③④若有书架退化数据仍展示。
5. 点看板 TOP5 某书 → 右侧详情侧栏弹出该书。
6. 点 ⚙ → 居中模态：连接状态 pill（已连接/仅书架/未连接）、掩码 Key（如 `wrk-••••d8e7`）、来源；展开“高级”可粘 Key/Cookie 并保存；保存后回统计 Tab 自动重取。
7. 阅读控件（字号/翻页/自动翻页/单页/重绘）与改造前一致，无回归。
8. 隐私：控制台/日志无完整 `wrk-` Key 或 cookie 输出（只有掩码）。

> 任一项不过 → 回到对应 Task 修复；不要跳过。若 spike 未发现自动取 Key 端点，第 4/6 项的“已连接”需先手动粘 Key 才能达成，属预期行为。

- [ ] **Step 5: 更新 README —— 功能表**

把这两行：
```markdown
| 原生书架首页 | 启动即用本地缓存秒开原生书架（清爽网格 + 继续阅读 + 阅读统计），不进网页版；点书直接进阅读 |
| 日常阅读 | 完整网页版，登录态持久化（`partition="persist:weread"`），登录一次即可 |
```
替换为：
```markdown
| 原生书架首页 | 启动即用本地缓存秒开原生书架（清爽网格 + 继续阅读 + 阅读统计），不进网页版；**单击书卡看详情，双击直接进阅读** |
| 统计看板 | 顶栏「统计」Tab：全年阅读热力图、周/月/年/总时长汇总、阅读偏好、读最久 TOP5、连续打卡（数据来自微信读书官方 Agent API，需 API Key） |
| 书籍详情侧栏 | 单击书卡右侧滑出：概览（简介/元信息）、书评（社区点评/推荐率）、统计（进度/本书时长）三 Tab |
| 日常阅读 | 完整网页版，登录态持久化（`partition="persist:weread"`），登录一次即可 |
```

- [ ] **Step 6: 更新 README —— 目录结构**

把：
```markdown
├── shelf-view.js    # 书架渲染：清爽网格 + 虚拟滚动（computeRange）
├── test/            # node:test 单测（shelf-data / fetch / view，共 12 例）
└── .userdata/       # 登录态与书架缓存（生成物，已 gitignore，见「登录态存储与隐私」）
```
替换为：
```markdown
├── shelf-view.js    # 书架渲染：清爽网格 + 虚拟滚动（computeRange）
├── weread-auth.js   # 认证路由（纯函数）：resolveAuth 四级回退 + maskKey 掩码
├── weread-api.js    # 主进程 Agent Gateway 客户端：net.fetch + 官方回包归一化
├── stats-data.js    # 统计数据层（纯函数）：热力图 / 时长 / 偏好 / TOP5 / 打卡
├── book-detail-data.js # 书籍详情数据层（纯函数）：元信息 / 书评 / 本书统计
├── stats-view.js    # 统计看板渲染
├── detail-view.js   # 详情侧栏渲染（三 Tab）
├── settings-view.js # 设置模态渲染（连接 / 手动 Key / 缓存 / 隐私）
├── test/            # node:test 单测（数据层 + 认证 + 视图 helper）
└── .userdata/       # 登录态、书架/统计/详情缓存、auth.json（生成物，已 gitignore）
```

- [ ] **Step 7: 更新 README —— 登录态与隐私**

（7a）把开头一句：
```markdown
这个项目**不申请、不硬编码任何 API Key**，认证完全复用网页版的登录会话 cookie。
```
替换为：
```markdown
这个项目的**书架与阅读**完全复用网页版登录会话 cookie；**统计看板与书籍详情**额外走微信读书官方 Agent API，需一把 `wrk-` 开头的 API Key（在 `weread.qq.com/r/weread-skills` 扫码获取，粘进「设置 → 高级」）。项目不硬编码任何 Key，Key 只存本机 `.userdata/auth.json`。
```
（7b）把“存在哪”那条 bullet：
```markdown
- **存在哪**：`main.js` 里 `app.setPath('userData', .userdata)` 把用户数据目录指到项目内的 `.userdata/`。登录 cookie 落在 `.userdata/Partitions/weread/Cookies`（SQLite，权限 `600` 仅本用户可读），书架缓存落在 `.userdata/shelf-cache/shelf.json`。
```
替换为：
```markdown
- **存在哪**：`main.js` 里 `app.setPath('userData', .userdata)` 把用户数据目录指到项目内的 `.userdata/`。登录 cookie 落在 `.userdata/Partitions/weread/Cookies`（SQLite，权限 `600` 仅本用户可读），书架缓存在 `.userdata/shelf-cache/`，统计缓存在 `.userdata/stats-cache/`，书籍详情缓存在 `.userdata/book-cache/`，手动 API Key/Cookie 在 `.userdata/auth.json`。
```
（7c）把末尾⚠ 引用块：
```markdown
> ⚠️ cookie 文件明文躺在你本机磁盘上（值按 Chromium 默认经 macOS Keychain 密钥加密），别把 `.userdata/` 整包发人或提交。**登出 / 换账号**：删掉 `.userdata/Partitions/weread/` 即可；**迁移登录态**到新机器：把该目录复制过去。
```
替换为：
```markdown
> ⚠️ cookie 文件明文躺在你本机磁盘上（值按 Chromium 默认经 macOS Keychain 密钥加密），别把 `.userdata/` 整包发人或提交。**登出 / 换账号**：删掉 `.userdata/Partitions/weread/` 即可；**清除 API Key**：删 `.userdata/auth.json` 或在设置里「清除手动配置」；**迁移登录态**到新机器：把该目录复制过去。
```

- [ ] **Step 8: 提交**

```bash
git add README.md
git commit -m "docs: README 补充统计看板/详情侧栏/设置与 API Key 认证说明"
```

---

## 阶段收尾

全部 Task 完成后：
- `node --test test/` 全绿（≥ 12 例）；`npm start` 手动验收清单（Task 12 Step 4）逐项 ✓。
- 本 feature 分支 `feat/stats-dashboard-book-detail` 上共 12 个（或更多）中文 Conventional Commits。
- 确认 `.userdata/`、`spike/` 未进版库（`git status` 干净，无敏感文件）。
- 后续合入方式见 superpowers:finishing-a-development-branch（merge / PR 由用户定）。
