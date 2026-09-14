# weread-pc

> 微信读书的桌面壳。核心诉求只有两条：**字号能比网页版最小号更小**，以及**能自己翻页**。

![status](https://img.shields.io/badge/status-%E8%83%BD%E7%94%A8-brightgreen) ![electron](https://img.shields.io/badge/electron-33-blue) ![platform](https://img.shields.io/badge/platform-macOS-lightgrey)

---

## 为什么要做这个

网页版微信读书能应付日常阅读，但有两个地方一直难受：

1. **最小字号还是太大**。字号滑块有 7 档，最小一级已经是 18px，再往小没有档位了。
2. **没有 PC 客户端**，只能挂在浏览器标签页里，摸鱼时容易被 Alt+Tab 暴露（划掉）。

Electron + webview 套一层网页版，这两件事都能就地解决。

## 功能

| 功能 | 说明 |
| --- | --- |
| 原生书架首页 | 启动即用本地缓存秒开原生书架（清爽网格 + 继续阅读 + 阅读统计），不进网页版；点书直接进阅读 |
| 日常阅读 | 完整网页版，登录态持久化（`partition="persist:weread"`），登录一次即可 |
| 字号缩放 | 50%–200% 连续可调，默认 100%（≈18px，与网页版最小档持平；仍可手动下调到更小） |
| 上一页 / 下一页 | 顶栏按钮 + `⌘+←` / `⌘+→` 快捷键 |
| 自动翻页 | 间隔 3–600 秒可调，翻页期间阻止系统休眠 |
| 跨屏自愈 | 窗口拖到另一块屏幕后自动重绘，修复正文错位 |
| 手动重绘 | 工具栏「重绘」按钮，兜底各种渲染异常 |

## 快速开始

```bash
npm install
npm start
```

首次启动扫码登录即可。

## 有意思的部分：正文是"画"出来的

这个项目最反直觉的发现，是**改字号这件事在原理上就不可能用 CSS 实现**。

第一版我按常规思路注入样式覆盖正文字号，结果：章节标题变了，正文纹丝不动。于是写了个探针脚本复用已登录会话去抓真实 DOM，拿到的是这样的结果：

```
pCount: 0                          // 正文里一个 <p> 都没有
canvasCount: 2                     // 两个 canvas，1228×3366，CSS 宽度 614px
bodyInnerText.length: 69           // 整页文本只有 69 个字，全是"首页/我的书架/上一章"
```

也就是说：**正文被渲染到 canvas 上了，DOM 里一个正文字符都没有**。canvas 是位图，不吃 CSS 排版，`font-size` 覆盖对它永久无效。

于是只能缩放。但缩放也有坑——

- **方案 A：`webContents.setZoomFactor(0.9)`**。能用，但 devicePixelRatio 从 2 变成 1.8 这种非整数，微信读书按像素坐标画字，小数缩放下字形错位，正文直接变乱码。
- **方案 B（最终采用）**：向页面注入 CSS，只给 canvas 页容器加 `zoom`。

```css
.wr_canvasContainer { zoom: 0.9 !important; }
```

这样位图整体等比缩小（2 倍 DPR 下采样，反而更清晰），DPR 不变，绘制坐标不动，不会乱码；附带好处是阅读器自己的工具栏、侧栏保持原大小，只有正文页缩小。

顺带还发现：**Chromium 会把页面缩放按域名持久化到 partition 里**，所以调试时上一轮设的 0.9 会阴魂不散地跟着你。

### 关于跨屏拖动导致乱码

这个 bug 一度被我误判成 zoom 的问题，实际触发路径是：窗口拖到另一块 DPR 不同的屏幕 → devicePixelRatio 变化 → 已画好的 canvas 位图不重绘 → 字形错位。

修法是监听窗口 `moved`，比对 `screen.getDisplayMatching()` 的显示器 ID，换屏后延迟 250ms 派发 `resize` 事件并把窗口高度抖动 1px，逼阅读器重新排版。

## 目录结构

```
weread-pc/
├── main.js          # 主进程：窗口、webview、缓存 IPC、换屏重绘、防休眠
├── preload.js       # contextBridge 暴露的 IPC 接口
├── index.html       # 顶栏 UI + 书架覆盖层 + 翻书 loading
├── renderer.js      # 控制逻辑：缩放注入、翻页、自动翻页、书架视图切换
├── shelf-data.js    # 书架数据层（纯函数）：视图模型 / 统计 / 继续阅读 / readerUrl
├── shelf-fetch.js   # 书架取数桥：webview 同源 fetch + 缓存秒开编排
├── shelf-view.js    # 书架渲染：清爽网格 + 虚拟滚动（computeRange）
├── test/            # node:test 单测（shelf-data / fetch / view，共 12 例）
└── .userdata/       # 登录态与书架缓存（生成物，已 gitignore，见「登录态存储与隐私」）
```

## 登录态存储与隐私

这个项目**不申请、不硬编码任何 API Key**，认证完全复用网页版的登录会话 cookie。

- **登录态怎么来**：webview 用独立持久分区 `partition="persist:weread"`，扫码登录一次后，`weread.qq.com` 的 cookie（含 httpOnly 的 `wr_vid`/`wr_skey`）由 Chromium 自动写入该分区——代码全程不手动读写 cookie。
- **存在哪**：`main.js` 里 `app.setPath('userData', .userdata)` 把用户数据目录指到项目内的 `.userdata/`。登录 cookie 落在 `.userdata/Partitions/weread/Cookies`（SQLite，权限 `600` 仅本用户可读），书架缓存落在 `.userdata/shelf-cache/shelf.json`。
- **取数如何带上 cookie**：抓书架是在 webview 页面上下文里做同源 `fetch('/web/shelf/sync', { credentials: 'include' })`，cookie 由浏览器自动附带；httpOnly 的那几个 JS 既读不到、也不需要读。
- **不会进版本库**：`.gitignore` 已忽略整个 `.userdata/`，从建库起从未提交过，`git push` 不会泄露登录态。
- **渲染层拿不到原始 cookie**：`preload.js` 只通过 contextBridge 暴露窗口/缓存相关的几个方法，没有任何读 cookie/session/token 的接口。

> ⚠️ cookie 文件明文躺在你本机磁盘上（值按 Chromium 默认经 macOS Keychain 密钥加密），别把 `.userdata/` 整包发人或提交。**登出 / 换账号**：删掉 `.userdata/Partitions/weread/` 即可；**迁移登录态**到新机器：把该目录复制过去。

## 已知限制

- 正文为 canvas 渲染，**无法选中复制**、无法使用划词划线（这是渲染方式的代价）。
- 依赖网页版的内部类名（`.wr_canvasContainer`、`.renderTarget_pager_button`），官方改版可能失效，届时改 `renderer.js` 里对应的选择器即可。
- 缩放会让正文页四周出现留白（CSS zoom 不改变整体布局尺寸）。

## 待办

- [ ] 记住上一次的缩放比例
- [ ] 双击全屏 / 沉浸式阅读模式
- [ ] 按字数而非时间触发自动翻页
