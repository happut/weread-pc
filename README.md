# weread-pc

> 微信读书的桌面壳。核心诉求：**字号能比网页版最小号更小**、**能自动翻页**、**像原生客户端一样管书桌和书架**。

![status](https://img.shields.io/badge/status-%E8%83%BD%E7%94%A8-brightgreen) ![electron](https://img.shields.io/badge/electron-33-blue) ![platform](https://img.shields.io/badge/platform-macOS-lightgrey)

---

## 为什么要做这个

网页版微信读书能应付日常阅读，但有两个地方一直难受：

1. **最小字号还是太大**。字号滑块最小一级 18px，再往小没有档位。
2. **没有 PC 客户端**，只能挂在浏览器标签页里，摸鱼时容易被 Alt+Tab 暴露（划掉）。

Electron + webview 套一层网页版，这两件事都能就地解决。后来顺手把**书桌 / 书架 / 统计**做成原生界面，日常阅读不再面对一坨网页 UI。

## 功能

### 布局

| | 说明 |
| --- | --- |
| 常驻左侧栏 | 上部「**书桌**」列出打开过的书（本地记录，重启仍在）；左下角 `书架` / `我的` / `设置`，可折叠 |
| 无系统标题栏 | 红绿灯嵌进侧栏，侧栏与工具条均可拖动窗口 |
| 点书即读 | 书卡**单击直接进阅读**；右键或 hover `⋯` → 阅读 / 查看详情 / 查看统计 |
| 多书保活 | 每本打开过的书独立 webview，切书不重载，进度和画布原样保留 |

### 阅读

| | 说明 |
| --- | --- |
| 字号缩放 | 50%–200% 连续可调（正文是 canvas，靠整体 zoom） |
| 上一页 / 下一页 | 工具条 + `⌘+←` / `⌘+→` |
| 自动翻页 | 间隔 3–600 秒，翻页期间阻止系统休眠 |
| 跨屏自愈 | 换显示器后自动重绘，修复 canvas 字形错位 |
| 手动重绘 | 工具条 `⟳` 兜底 |

### 书架 · 我的 · 详情

| | 说明 |
| --- | --- |
| 原生书架 | 继续阅读 + 全部藏书网格，本地缓存秒开 |
| 我的（统计） | 热力图、周/月/年/总时长、阅读偏好、读最久 TOP5、连续打卡 |
| 书籍详情 | 概览 / 书评 / 统计 三 Tab（从右键菜单进） |

### 首次连接

需要两样东西，向导会引导：

1. **登录态 Cookie**（必须）——扫码登录网页版，书架与阅读用
2. **API Key**（可选）——`wrk-` 开头，统计看板用；授权页可自动识别，也可粘贴

侧栏底部常驻「书架 / 统计」连接状态。

## 快速开始

```bash
npm install
npm start
```

首次启动会进入连接向导：扫码登录书架 →（可选）开通统计 API。

安装版：

```bash
npm run build
# 产物 release/WeRead-PC-macOS-arm64-<version>.zip
```

解压后拖进「应用程序」。未做 Apple 公证，首次打开需右键 → 打开，或 `xattr -cr /Applications/WeRead-PC.app`。

## 有意思的部分：正文是"画"出来的

这个项目最反直觉的发现，是**改字号这件事在原理上就不可能用 CSS 实现**。

第一版按常规思路注入样式覆盖正文字号，结果：章节标题变了，正文纹丝不动。探针抓真实 DOM：

```
pCount: 0                          // 正文里一个 <p> 都没有
canvasCount: 2                     // 两个 canvas，1228×3366，CSS 宽度 614px
bodyInnerText.length: 69           // 整页文本只有 69 个字，全是"首页/我的书架/上一章"
```

**正文渲染在 canvas 上**，DOM 里没有正文字符。canvas 是位图，不吃 CSS 排版。

于是只能缩放。缩放也有坑：

- **`webContents.setZoomFactor`**：DPR 变成非整数（如 2 → 1.8），微信读书按像素坐标画字，小数缩放下字形错位。
- **最终方案**：只给 canvas 页容器加 `zoom`：

```css
.wr_canvasContainer { zoom: 0.9 !important; }
```

位图等比缩放，DPR 不变，不会乱码；阅读器工具栏字号也不跟着缩。

### 跨屏乱码

窗口拖到另一块 DPR 不同的屏 → devicePixelRatio 变了 → 已画好的 canvas 位图不重绘 → 字形错位。修法：监听 `moved`，比对显示器 ID，换屏后延迟派发 `resize` 并抖动窗口高度 1px，逼阅读器重排。

## 目录结构

```
weread-pc/
├── main.js             # 主进程：无标题栏窗口、多 webview、缓存 IPC、换屏重绘、防休眠
├── preload.js          # contextBridge IPC
├── index.html          # 书桌侧栏 + 工具条 + 书架/统计/向导/详情 UI
├── renderer.js         # 书桌/热切换/连接向导/缩放/翻页/自动翻页
├── shelf-data.js       # 书架 VM（纯函数）
├── shelf-fetch.js      # webview 同源取书架 + 缓存编排
├── shelf-view.js       # 书架网格、虚拟滚动、书卡右键菜单
├── weread-auth.js      # 认证路由（纯函数）
├── weread-api.js       # Agent Gateway 客户端 + skill_version 自动跟随
├── stats-data.js       # 统计 VM（纯函数）
├── book-detail-data.js # 详情 VM（纯函数）
├── stats-view.js       # 统计看板
├── detail-view.js      # 详情三 Tab
├── settings-view.js    # 设置模态
├── assets/icons/       # 应用图标（美短猫书 SVG + ICNS）
├── test/               # node:test 单测
└── release-notes-v*.md
```

## 登录态与隐私

- **Cookie / 登录态**：webview 分区 `persist:weread`，扫码一次，Chromium 自动落盘。
- **API Key**：`auth.json`（`manualKey` / `autoKey`），本地明文 JSON，不上传、不入库。
- **书桌列表**：壳页面 `localStorage`。

**路径**

| | |
| --- | --- |
| 安装版 | `~/Library/Application Support/WeRead-PC/` |
| 开发版 | 项目下 `.userdata/`（gitignore） |

关键文件：`auth.json`（Key）、`Partitions/weread/Cookies`（微信读书登录态）。忘记登录 = 删这两个；`.gitignore` 已覆盖全部用户数据，仓库无凭据。

> ⚠️ `auth.json` 与 Cookie 文件在本机磁盘，勿整包外发。

## 已知限制

- 正文 canvas 渲染，**无法选中复制**、无法划词划线。
- 依赖网页版内部类名（`.wr_canvasContainer` 等），官方改版可能要改选择器。
- 统计 API 的 `skill_version` 已做自动跟随；若官方改接口语义仍需改代码。

## 待办

- [ ] 记住上次缩放比例
- [ ] 沉浸式阅读模式
- [ ] 按字数而非时间自动翻页
- [ ] 书桌手动排序 / 置顶
