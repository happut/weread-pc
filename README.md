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
| 日常阅读 | 完整网页版，登录态持久化（`partition="persist:weread"`），登录一次即可 |
| 字号缩放 | 50%–200% 连续可调，默认 90%（≈16px，小于网页版最小的 18px） |
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

第一版我按常规思路注入样式覆盖正文字号，结果：章节标题变了，正文纹丝不动。于是写了个探针脚本（`probe.js`）复用已登录会话去抓真实 DOM，拿到的是这样的结果：

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
├── main.js          # 主进程：窗口、webview、换屏重绘、防休眠
├── preload.js       # contextBridge 暴露的 IPC 接口
├── index.html       # 顶栏 UI
├── renderer.js      # 控制逻辑：缩放注入、翻页、自动翻页
├── probe.js         # DOM 探针：复用登录会话抓取真实页面结构
└── probe-shot.js    # 截图对比：验证不同缩放方案的渲染效果
```

`probe.js` / `probe-shot.js` 是排查这类问题的利器——面对改版后结构不明的页面，与其猜类名，不如直接问页面要答案。

## 已知限制

- 正文为 canvas 渲染，**无法选中复制**、无法使用划词划线（这是渲染方式的代价）。
- 依赖网页版的内部类名（`.wr_canvasContainer`、`.renderTarget_pager_button`），官方改版可能失效，届时改 `renderer.js` 里对应的选择器即可。
- 缩放会让正文页四周出现留白（CSS zoom 不改变整体布局尺寸）。

## 待办

- [ ] 记住上一次的缩放比例
- [ ] 双击全屏 / 沉浸式阅读模式
- [ ] 按字数而非时间触发自动翻页
