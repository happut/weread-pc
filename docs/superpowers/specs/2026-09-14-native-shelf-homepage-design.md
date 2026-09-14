# 原生书架首页设计（v1）

- 日期：2026-09-14
- 状态：已获用户批准，待转 writing-plans
- 关联项目：weread-pc（Electron 33 + webview 微信读书桌面壳）

## 1. 背景与目标

当前 weread-pc 的首页就是把 `<webview>` 直接指向 `https://weread.qq.com/web/shelf`，即官方网页书架。它的问题：启动即加载整站、样式不可控、无法沉淀"我自己的书架"体验。

已验证的关键事实（见 probe-shelf2/probe-shelf3 与记忆《weread 书架数据获取方式与签名/httpOnly 坑》）：

- 在 `weread.qq.com` **同源上下文**里 `fetch('/web/shelf/sync', { credentials: 'include' })` **无需 `x-wrpa-0` 签名**即可拿到完整书架 JSON。
- 一次请求返回：`books`（5548 本）、`bookProgress`（3506 条）、`archive`（54 个用户自建分组）、`bookCount`（5556）。
- `wr_vid/wr_skey` 是 httpOnly + host-only cookie，主进程裸 `net.fetch` 读不到、也会被签名校验拒；**必须借 webview 的同源上下文取数**。
- 阅读正文是 canvas 渲染，无法 API 化，**阅读必须留在 webview**（硬约束）。

用户诉求优先级：**D（好看/掌控感）＞ C（数据看板）＞ A（快而轻）＞ B（整理检索）**。

**v1 目标**：启动即显示一个**自己掌控的、清爽好看的原生书架首页**，点书进入 webview 阅读，返回即回书架；秒开、可离线兜底。

## 2. 非目标（明确延后）

- ⏭️ **v2**：完整数据看板（C）——阅读时长趋势、分类分布图等；排序方式切换（按时间/进度/作者）。
- ⏭️ **v3**：搜索、分类/分组筛选（B）——利用 `archive` 的 54 个自建分组。
- ❌ 不做：笔记/划线同步、书评、推荐发现、多账号、云同步自建数据。
- ❌ 不改：阅读器本身（canvas 正文、字号/单页等现有控件保持原样）。

## 3. 架构：webview 一物两用 + 双视图切换（结构 A）

不新建任何网络请求通道。现有 `<webview>` 同时承担两件事：**(a) 提供同源取数上下文；(b) 承载阅读**。书架视图是盖在 webview 之上的、我们自己的原生 DOM。

```
┌─ Electron 主窗口 (index.html + renderer.js，自有代码，完全可控) ──────┐
│                                                                      │
│  ┌─ 书架视图 (原生 DOM，方向2 清爽网格) ──────────┐  ← 启动默认显示   │
│  │  顶栏: 我的书架   [在读 N][读完 M][累计 Hh]      │                 │
│  │  继续阅读: 横向一排真封面 + 进度条               │                 │
│  │  全部藏书: 封面网格 · 虚拟滚动                   │                 │
│  └────────────────────────────────────────────────┘                  │
│                    │ 点某本书                                          │
│                    ▼                                                  │
│  ┌─ 阅读视图 (<webview> 全屏) ────────────────────┐  ← 切换显示       │
│  │  顶栏: [← 书架]  字号/单页… (现有控件不动)       │                 │
│  │  weread canvas 正文                             │                 │
│  └────────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
```

生命周期：

1. **启动**：webview 后台加载 `weread.qq.com`（建立/复用 `persist:weread` 登录态）；书架视图默认覆盖其上并显示。
2. **取数**：webview `dom-ready` 后，通过 `webview.executeJavaScript()` 在页面上下文里 `fetch('/web/shelf/sync')`，把 JSON 回传宿主。
3. **渲染**：宿主用 JSON（或缓存）渲染清爽网格书架。
4. **进阅读**：点封面 → 隐藏书架视图 → `webview.loadURL(<reader url>)` → 显示阅读视图。
5. **返回**：`← 书架` → 重新显示书架视图；顺手 re-fetch 刷新进度（失败则用旧数据）。

> webview 始终存在（不再"启动即显示官方书架页"），只是被书架视图遮住；这样既保活会话，又提供取数上下文。

## 4. 数据契约与数据流

### 4.1 输入：`/web/shelf/sync` 关键字段

- `books[]`：`bookId`、`title`、`author`、`cover`（`cdn.weread.qq.com/...`）、`deepLink`（`https://weread.qq.com/book-detail?type=1&v=...`）、`category`（如"心理-心理学应用"）、`categories[]`、`finished`/`finishReading`、`format`、`updateTime`、`readUpdateTime`。
- `bookProgress[]`：`bookId`、`progress`（0–100）、`chapterUid`/`chapterIdx`/`chapterOffset`、`readingTime`（**秒**，本书累计）、`updateTime`（最近阅读时间戳）。
- `archive[]`：`archiveId`、`name`、`bookIds[]`（v3 才用）。
- `bookCount`、`pureBookCount`、`synckey`。

### 4.2 视图模型（纯函数派生，`shelf-data.js`）

- **继续阅读**：`books ⋈ bookProgress`，按 `bookProgress.updateTime` 倒序取前 N（v1 取 6）。
- **全部藏书**：`books` 全量，按 `readUpdateTime` 倒序；无 `readUpdateTime` 的书回退按 `updateTime` 倒序排在后面（v1 固定这一种排序，不做切换）。
- **统计（喂一口 C）**：
  - 在读 = 有 `bookProgress` 且 `progress ∈ (0,100)` 且书未 `finishReading` 的本数。
  - 读完 = `finishReading==1`（或 `progress==100`）的本数。
  - 累计时长 = `Σ bookProgress.readingTime`（秒）→ 换算为小时并**四舍五入取整**显示（如 `320h`）。
- 输出统一视图模型对象，DOM 层只消费视图模型、不碰原始 JSON。

### 4.3 缓存

- 缓存目录：`.userdata/shelf-cache/`（跟随现有 `app.setPath('userData', .../.userdata)`）。
- 内容：`shelf.json`（原始或视图模型）+ `covers/`（封面图片文件）+ `meta.json`（抓取时间、bookCount）。
- 策略：**启动先渲染缓存（秒开）→ 后台 re-fetch → 成功则更新视图与缓存**。无缓存且无网络时显示空态 + 重试。

## 5. 组件划分（单一职责、可独立测）

| 组件 | 文件（建议） | 职责 | 依赖 |
|---|---|---|---|
| 数据转换 | `shelf-data.js` | 原始 JSON → 视图模型 + 统计（纯函数） | 无（node 可单测） |
| 取数桥 | `shelf-fetch.js` | 经 webview `executeJavaScript` 同源取数；缓存读写 | webview / IPC / fs |
| 书架渲染 | `shelf-view.js` | 清爽网格 DOM + 虚拟滚动 + 封面懒加载 | 视图模型 |
| 视图切换 | `view-switch.js`（或并入 renderer.js） | 书架 ⇄ 阅读切换、登录态兜底、返回刷新 | 上述三者 |

- 复用现有 `preload.js` / IPC 风格；新增 IPC 通道走 `main.js` 已有模式（如 `set-window-width` 等）。
- 现有阅读器控件（字号 `applyFont`、单页 `setWindowWidth`）**不动**，仅在阅读视图顶栏保留。

## 6. 视觉设计（方向 2 · 清爽网格）

- 浅色底 `#fafbfc`，白卡片 + `1px #eef0f3` 边框 + 圆角 + 柔和阴影。
- 顶栏统计做成**彩色 pill**：在读（蓝 `#2f7de1`）/ 读完（绿 `#1f9254`）/ 累计时长（紫 `#7a5af5`）。
- "继续阅读"：横向一排卡片，封面 3:4，下方书名 + 细进度条。
- "全部藏书"：封面网格（每行 4–6，随窗口宽度自适应），**虚拟滚动**。
- 封面加载失败退化为浅灰渐变块（不破坏布局）。
- 字体沿用系统 `-apple-system, "PingFang SC"`。

## 7. 关键技术风险与兜底

1. **封面防盗链（最高风险）**：宿主 renderer（`file://`/app 源）直接 `<img src="cdn.weread.qq.com/...">` 可能被 Referer 校验挡（403）。
   - 兜底 A：主进程 `session.webRequest.onBeforeSendHeaders` 给 `cdn.weread.qq.com` 注入合法 `Referer: https://weread.qq.com/`。
   - 兜底 B：若仍不行，经 webview `executeJavaScript` 把封面 `fetch → blob → base64` 回传，落地到 `.userdata/shelf-cache/covers/`，`<img>` 用本地 `file://`/自定义协议。
   - **实施第 1 个 spike 先验证封面能否直连**，据此选 A 或 B。
2. **阅读入口 URL**：`deepLink` 指向 book-detail 页而非直接阅读器。
   - 首选尝试阅读器直达路由（如 `https://weread.qq.com/web/reader?bookId=<id>`）；若非常规路由，**兜底加载 `deepLink`**（已登录，可正常进入阅读）。
   - 同样在实施早期 spike 验证 canonical reader URL。
3. **5548 本性能**：必须虚拟滚动，只渲染视口内 DOM；封面懒加载 + 缓存。
4. **登录失效**：`/web/shelf/sync` 返回未登录/错误 → 落到 webview 的 weread 登录页（即当前行为）；登录后回到书架并 re-fetch。
5. **接口结构漂移**：解析层防御式取值，字段缺失时降级（如某书无 cover/progress 仍可显示）。

## 8. 错误处理

- 取数失败：有缓存 → 显示缓存 + "刷新失败，展示上次数据"轻提示；无缓存 → 空态 + 重试按钮。
- 未登录：显示 webview 登录页，不显示空书架。
- 封面失败：渐变占位块。
- 部分数据缺失：单项降级，不整屏崩。

## 9. 测试策略

项目现无测试框架，沿用既有 probe 脚本 + node 轻量断言风格：

- **纯函数单测**（`shelf-data.js`）：用 `/tmp/weread_shelf_full.json` 作 fixture，断言统计数值、继续阅读排序、视图模型形状。
- **集成 probe**：验证 webview `executeJavaScript` 取数、封面直连/兜底、reader URL 直达。
- **手动验收**：视觉（清爽网格）、虚拟滚动流畅度（5548 本）、切换/返回、缓存秒开、未登录兜底。

## 10. v1 范围边界（YAGNI）

- ✅ 做：清爽网格书架、继续阅读区、一条 pill 统计、点击进阅读、`← 书架` 返回、本地缓存秒开、虚拟滚动、封面兜底、登录/网络错误处理。
- ⏭️ 不做（见第 2 节）：数据看板、排序切换、搜索、分组筛选、笔记/书评/推荐。

## 11. 交付顺序（供 writing-plans 展开）

1. Spike：验证封面直连（定 A/B）+ reader URL 直达（定首选/兜底）。
2. `shelf-data.js` 纯函数 + 单测（fixture 驱动）。
3. `shelf-fetch.js` 取数桥 + 缓存。
4. `shelf-view.js` 清爽网格 + 虚拟滚动 + 懒加载。
5. `view-switch` 切换/返回/登录兜底，接入现有 index.html/renderer.js。
6. 端到端手动验收。
