# 阅读统计看板 + 书籍详情 + API 认证设计（v1）

- 日期：2026-09-15
- 状态：已获用户批准，待转 writing-plans
- 关联项目：weread-pc（Electron 33 + webview 微信读书桌面壳）
- 前置：本设计在《原生书架首页设计（v1）》（`2026-09-14-native-shelf-homepage-design.md`）之上扩展，复用其 webview 一物两用、纯函数分层、缓存秒开、loading 编排等既有约定。

## 1. 背景与目标

现有原生书架只有一个数据接口：webview 同源 `fetch('/web/shelf/sync', {credentials:'include'})`，只能拿到书架本身（books / bookProgress / archive）。阅读正文是 canvas，必须留在 webview（硬约束，不变）。

用户诉求：**像参考项目 `zhaohongxuan/obsidian-weread-plugin` 那样，开放认证、拿书架之外的数据，把原生书架升级成"数据看板 + 书籍详情"**。诉求优先级沿用 **D（好看/掌控感）＞ C（数据看板）＞ A（快而轻）＞ B（整理检索）**。

**v1 目标**：新增三块原生界面——统计看板、书籍详情侧栏、设置面板；用混合认证（自动取 API Key + 手动 cookie/token 兜底）从主进程直连 weread 官方接口，取「阅读统计 + 书评 + 书籍元信息」并本地缓存。

## 2. 非目标（明确延后）

- ⏭️ 划线 / 笔记同步（本轮不做，用户已明确排除）。
- ⏭️ 「我的书评总览」全站聚合页（模块⑤，用户未选；单本书评已在详情侧栏内）。
- ⏭️ 公众号文章、主题模板、Daily Notes、导出——参考项目有，本项目不搬。
- ❌ 不改阅读器本身（canvas 正文、字号 / 单页 / 翻页 / 自动翻页等现有控件原样）。
- ❌ 不做多账号、云同步自建数据。

## 3. 已确认的设计决策（brainstorming 产出汇总）

| 维度 | 决策 |
|---|---|
| 核心目标 | 访问书架之外的数据（不是单纯透出配置） |
| MVP 数据 | 阅读统计（热力图/时长）+ 书评 + 书籍元信息 |
| 认证方式 | **混合**：自动取 `wrk-` API Key 为主 + 手动 cookie/token 兜底（可折叠高级区） |
| 界面结构 | **B+C**：顶栏「书架 ｜ 统计」双 Tab + 点书右侧滑出详情侧栏 |
| 点书交互 | **单击封面 → 详情侧栏；双击封面 → 直接进阅读**（首次给气泡引导双击） |
| 统计看板模块 | ①全年热力图 ②时长汇总卡 ③阅读偏好 ④读最久 TOP5 ⑥连续打卡/成就（**不含**⑤书评总览） |
| 详情侧栏组织 | **三 Tab**：概览（元信息+简介）／ 书评（我的+社区精选）／ 统计（本书时长/进度/首末次读） |
| 设置面板入口 | 顶栏 ⚙ → **居中模态弹窗** |

## 4. 架构：混合认证与取数链路

不改动"阅读留在 webview"这条硬约束。新增一条**主进程直连官方接口**的取数通道，与现有 webview 同源取数并存、按优先级回退。

```
┌─ 主窗口 (index.html + renderer.js) ───────────────────────────────┐
│  顶栏:  [书架] [统计]                              ⚙设置          │
│  ┌─ 书架视图(现有) ─┐  单击书→ ┌─ 详情侧栏(新, 三Tab) ─┐          │
│  │  网格/继续阅读   │          │ 概览｜书评｜统计  ▶阅读 │          │
│  └─────────────────┘          └────────────────────────┘          │
│  ┌─ 统计视图(新) ──────────────────────────────────────┐          │
│  │ ①热力图 ②时长汇总 ③偏好 ④TOP5 ⑥连续打卡             │          │
│  └──────────────────────────────────────────────────────┘        │
│  双击书 / 详情内▶阅读 → 现有 openBook(loading 编排) → <webview>   │
└───────────────────────────────────────────────────────────────────┘
        │取数                          │取数
        ▼(同源, 现有)                   ▼(主进程, 新)
  webview.executeJavaScript        weread-api.js: net.fetch
  fetch('/web/shelf/sync')         POST i.weread.qq.com/api/agent/gateway
  fetch('/api/skills/apikeyGet')   Authorization: Bearer wrk-<key>
```

**认证来源与优先级（纯函数 `resolveAuth`，可单测）**：

1. 手动填的 API Key（`wrk-`）非空 → 用它（显式覆盖）。
2. 否则自动获取的 Key 有效 → 用它。
3. 否则手动填的 cookie（`wr_vid`/`wr_skey`）非空 → 走 V1 cookie 接口。
4. 否则 → 退回 webview 同源取数（即现状，仅书架可得）；统计/详情显示"未连接"引导。

**自动取 Key**：webview `dom-ready` 后同源 `fetch('/api/skills/apikeyGet', {credentials:'include'})`，解析出 `wrk-` key，存 `.userdata/auth.json`（掩码显示）。此手法与现有取 shelf 完全一致（同源、cookie 自动带、无 CORS）。

**主进程取数无 CORS**：`weread-api.js` 用 Electron `net.fetch` 打 Agent API，主进程请求不受浏览器同源策略限制（比参考项目省事——它在 Obsidian 里需挂代理绕 CORS）。

## 5. 数据契约与数据流

### 5.1 数据来源

- **书架**：现有 `/web/shelf/sync`（不变），继续喂书架 Tab 与"继续阅读/读完/累计"基础统计。
- **阅读统计 / 书评 / 书籍元信息**：V2 Agent API（`i.weread.qq.com/api/agent/gateway`，`Bearer wrk-`）。**具体 action、请求体、返回字段结构未经验证，由实施 Task 1 spike 打样确认**（参考项目已证明这些数据可取：年度/月度/每周时长、热力图、书评、元信息）。
- 回退：Agent API 不可用时，尝试 V1 cookie 接口；注意部分 V1 接口需 `x-wrpa-0` wasm 签名（裸调被拒），spike 一并探明哪些免签。

### 5.2 视图模型（纯函数派生，DOM 层只消费视图模型）

- `stats-data.js`：原始数据 → 看板视图模型。**关键：③④ 只依赖现有 `/web/shelf/sync`（每本书 `readingTime` + `category`），①②⑥ 才需 Agent API 的"每日时长序列"**——故即便 Agent API 不通，③④ 仍可用（见 8.1）。
  - ① 热力图：按日聚合阅读时长 → `{date, seconds, level(0..4)}` 单元数组。level 分档默认 `0=0 / 1=<15min / 2=<30min / 3=<60min / 4=≥60min`（spike 拿到真实分布后可微调）。
  - ② 时长汇总：年 / 月 / 周 / 日均，秒 → 小时（沿用 v1"四舍五入取整"口径；日均保留 1 位小数）。
  - ③ 阅读偏好：按 `category` 聚合 `Σ readingTime` 占比 → `[{category, percent}]` 降序取前 N（数据源：shelf/sync，无需新接口）。
  - ④ 读最久 TOP5：按每本书累计 `readingTime` 降序取 5 → `{cover, title, hours}`（数据源：shelf/sync，无需新接口）。
  - ⑥ 连续打卡：某日 `seconds>0` 即算打卡；由每日时长序列推导当前连续天数与历史最长（纯函数）。
- `book-detail-data.js`：原始书籍信息 + 书评 → 详情视图模型：`{cover, title, author, rating, metaRows[{k,v}], intro, myReviews[], communityReviews[], bookStats{hours, progress, firstRead, lastRead}}`。

### 5.3 缓存（沿用 `.userdata/` 套路，均已 gitignore）

- 书架：`.userdata/shelf-cache/shelf.json`（现状不动）。
- 认证：`.userdata/auth.json`（自动 Key + 手动覆盖 + 来源标记 + 更新时间；**敏感，掩码/不外泄**）。
- 统计：`.userdata/stats-cache/stats.json`（看板视图模型 + 抓取时间）。策略：切到统计 Tab 先渲染缓存（秒开）→ 每次打开都后台刷新（不设长 TTL）→ 成功更新视图与缓存。
- 书籍详情：`.userdata/book-cache/<bookId>.json`（详情视图模型 + 抓取时间），**点开详情时懒加载**；TTL 7 天（元信息/书评稳定），过期后台刷新。

## 6. 组件划分（单一职责、可独立测；对齐现有 `shelf-*` 命名）

| 层 | 文件 | 新增/扩展 | 职责 | 可单测 |
|---|---|---|---|---|
| 认证 | `weread-auth.js` | 新增 | 自动取 Key、手动覆盖存取、`resolveAuth` 路由决策 | ✅ 纯函数 |
| 取数 | `weread-api.js` | 新增 | 主进程 Agent API / V1 客户端（`net.fetch`，Bearer） | ❌ 网络（手测） |
| 数据 | `stats-data.js` | 新增 | 原始统计 → 看板视图模型（热力图分桶/汇总/偏好/TOP-N/连续） | ✅ 纯函数 |
| 数据 | `book-detail-data.js` | 新增 | 原始书籍信息+书评 → 详情视图模型 | ✅ 纯函数 |
| 渲染 | `stats-view.js` | 新增 | 统计看板 DOM（热力图网格/卡片/条形/榜单/打卡） | 计算 helper 可测 |
| 渲染 | `detail-view.js` | 新增 | 详情侧栏 DOM（三 Tab 切换） | 计算 helper 可测 |
| 渲染 | `settings-view.js` | 新增 | 设置模态 DOM（连接状态/高级手动/缓存控制） | — |
| 编排 | `renderer.js` | 扩展 | Tab 切换、单击→详情 / 双击→阅读、设置接线、缓存刷新编排 | — |
| IPC | `main.js` + `preload.js` | 扩展 | 统计/书籍缓存读写、auth 存取、Agent API 调用通道 | — |
| UI | `index.html` | 扩展 | 顶栏双 Tab、统计视图/详情侧栏/设置模态的容器 + CSS | — |

- 现有 `shelf-data.js` / `shelf-fetch.js` / `shelf-view.js` 与阅读器控件（`applyFont`/`setWindowWidth`/翻页）**不动**，仅在书架 Tab 内复用；书架卡片的事件从"单击→阅读"改为"单击→详情、双击→阅读"。
- 进阅读仍走现有 `openBook` 的 loading 编排（点书盖不透明 loading → 轮询 `.wr_canvasContainer canvas` 就绪再撤，见既有约定），双击与详情内▶阅读共用它。

## 7. 界面设计

### 7.1 顶栏与 Tab
- 顶栏左侧「书架 ｜ 统计」两个 Tab（当前项高亮下划线），右侧 ⚙ 打开设置。
- 书架 Tab = 现有原生书架（清爽网格 + 继续阅读 + pill 统计），仅改卡片点击语义。

### 7.2 统计看板（Tab）
自上而下：① 全年热力图（GitHub 风格每日格，level 分档配色，悬浮显示当日时长）→ ② 时长汇总卡（年/月/周/日均 大数字）→ ③ 阅读偏好（分类占比横条）→ ④ 读最久 TOP5（封面+时长条）→ ⑥ 连续打卡/成就（当前连续天数 + 历史最长 + 里程碑徽章）。浅色底、白卡片、圆角柔和阴影，沿用 v1 视觉语言与彩色 pill 用色。

### 7.3 详情侧栏（单击书滑出）
右侧滑出面板，头部常驻（封面 + 书名 + 作者 + ★评分 + `▶ 阅读`按钮），下方三 Tab：
- **概览**：元信息（出版社 / 分类 / ISBN / 出版年）+ 简介。
- **书评**：我的书评 + 社区精选（引用块样式）。
- **统计**：本书时长 / 进度 / 首末次阅读。
关闭：点面板外 / Esc / 关闭按钮。

### 7.4 设置模态（⚙ 打开，居中）
- **微信读书连接**：状态 pill（已连接 / 未连接 / Key 失效）+ 掩码 API Key + 来源（自动/手动）+ 上次更新时间 + `重新获取`按钮。
- **▾ 高级·手动配置**（折叠，默认收起）：Cookie 输入框 + API Key/Token 输入框 + `保存`/`清除`，注明"留空 = 用自动获取"。
- **数据与缓存**：书架缓存状态（本数/大小/更新时间）+ 统计与详情缓存 TTL + `刷新书架`/`清除全部缓存`。
- **页脚**：隐私提示（数据只存本地 `.userdata/`、删目录即登出、绝不入库）+ `关闭`。

## 8. 关键技术风险与兜底

1. **Agent API 结构未知（最高风险，但影响面已收窄）**：action / 请求体 / 返回字段未验证。**实施 Task 1 先 spike**：用自动取到的 Key 打 gateway，验证「每日时长序列（喂①②⑥）、书评（我的+社区）、书籍元信息」能否取到及其结构；据实测定 `stats-data`/`book-detail-data` 解析契约。**注意 ③阅读偏好、④TOP5 只用现有 shelf/sync 数据、不依赖本 spike**——即便 Agent API 全不通，看板仍有 ③④ 可显示。spike 若发现某数据拿不到 → 试 V1 cookie 接口（探明是否需 `x-wrpa-0` 签名）→ 仍不行则该模块降级隐藏。
2. **自动取 Key 失败**：`/api/skills/apikeyGet` 同源 fetch 若取不到（改版/未登录）→ 设置显示"未连接"，引导手动填 Key/cookie 或重登；不阻塞书架（书架仍走同源 fetch）。
3. **Key / cookie 过期**：接口返回 401/未登录类错误码 → 标记连接失效 → 提示`重新获取`；期间用缓存旧数据 + "刷新失败"提示条兜底。
4. **交互变更风险**：单击语义从"阅读"改为"详情"，可能反直觉 → 首次使用给气泡引导（"单击看详情，双击直接阅读"）；双击/▶阅读必须无延迟复用现有 openBook。
5. **热力图性能**：全年 365+ 格 DOM 一次渲染可接受；若未来扩多年，再考虑虚拟化。
6. **接口结构漂移**：解析层防御式取值，字段缺失单项降级（如无评分/无 ISBN 仍可显示其余）。

## 9. 错误处理

- 取数失败：有缓存 → 显示缓存 + "刷新失败，展示上次数据"轻提示；无缓存 → 该界面友好空态 + 重试按钮。
- 未连接（无 Key 无 cookie）：统计/详情显示引导态（"去设置连接微信读书"），书架不受影响。
- 模块级降级：单个统计模块数据缺失只隐藏该模块，不拖垮整页；详情某 Tab 无数据显示空态。
- 敏感信息：任何错误信息/日志**不得**打印完整 Key/cookie。

## 10. 测试策略

沿用现有 node:test + fixture 风格（现 12 测基础上新增）：

- **纯函数单测**：`stats-data`（热力图分桶/时长换算/偏好占比/TOP-N/连续天数）、`book-detail-data`（视图模型形状/缺失降级）、`weread-auth` 的 `resolveAuth`（四种来源优先级）。用 spike 落地的真实响应片段作 fixture（脱敏）。
- **计算 helper**：热力图 level 分档、偏好聚合等可测部分。
- **不写单测**：`weread-api.js` 网络、IPC、webview `executeJavaScript`、DOM 渲染——集成手测（与现状一致）。
- **手动验收**：自动取 Key、双 Tab 切换、单击详情/双击阅读、三 Tab 详情、设置模态（连接/手动覆盖/缓存控制）、缓存秒开、未连接与刷新失败兜底。

## 11. v1 范围边界（YAGNI）

- ✅ 做：混合认证（自动 Key + 手动兜底）、主进程 Agent API 取数、统计看板（①②③④⑥）、详情侧栏（三 Tab：元信息/书评/本书统计）、设置模态（连接/高级手动/缓存/隐私）、`.userdata` 缓存秒开、双击/单击交互改造、错误与未连接兜底。
- ⏭️ 不做（见第 2 节）：划线/笔记、书评总览页、公众号、主题、导出、多账号。

## 12. 交付顺序（供 writing-plans 展开）

1. **Spike**：自动取 `wrk-` Key（`/api/skills/apikeyGet` 同源 fetch）+ 用它打 Agent API，验证统计/书评/元信息三类数据的 action 与返回结构；落定解析契约与 fixture（脱敏）。
2. `weread-auth.js`：`resolveAuth` 路由 + 自动取 Key + 手动覆盖存取 + 单测。
3. `weread-api.js`：主进程 Agent API 客户端（Bearer，net.fetch）+ 回退。
4. `stats-data.js` 纯函数 + 单测（fixture 驱动）。
5. `book-detail-data.js` 纯函数 + 单测。
6. 缓存 IPC：扩 `main.js`/`preload.js`（stats/book 缓存读写、auth 存取）。
7. `stats-view.js` + 统计 Tab（顶栏双 Tab、index.html 容器/CSS、renderer 切换）。
8. `detail-view.js` + 详情侧栏（三 Tab）+ 书架卡片单击/双击改造 + 首次气泡引导。
9. `settings-view.js` + 设置模态（连接状态/高级手动/缓存控制/隐私）。
10. 端到端手动验收 + README 更新（新增界面与认证说明）。
