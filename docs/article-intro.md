# 微信读书没有 PC 客户端？我写了个开源的，字号还能比官方更小

> 一个 Electron 桌面壳：把网页版微信读书变成「像原生客户端」的阅读体验。MIT 开源、零运行时依赖、四平台可下载。
> 仓库：https://github.com/happut/weread-pc

## 三个很小的难受，值得一个客户端

1. **字号最小还是太大。** 网页版滑块最小 18px，再往小没档位。
2. **没有 PC 客户端。** 只能挂浏览器标签页，Alt+Tab 一不小心就暴露。
3. **网页 UI 太吵。** 想安静看书，却面对一坨按钮和推荐。

这个项目把这三件事就地解决，顺手把书桌 / 书架 / 统计做成了原生界面。

![阅读页](screenshots/reader.png)

## 它能干什么

- **字号 50%–200% 连续可调**，比官方最小号还能小。
- **自动翻页**：3–600 秒间隔，翻页期间阻止系统休眠。
- **多书秒切**：每本书独立 webview 保活，切书不重载，进度原样保留。
- **原生书架 / 书桌 / 统计**：搜索、置顶、热力图、阅读时长、连续打卡，本地缓存秒开。
- **深色模式联动**：应用切深色，阅读器跟着进夜间。
- **跨屏自愈**：换显示器自动重绘，修 canvas 字形错位。

## 最反直觉的发现：正文不在 DOM 里

第一版按常规思路注入 CSS 改正文字号，结果章节标题变了、正文纹丝不动。写探针抓真实页面才看清：

```
pCount: 0                // 正文里一个 <p> 都没有
canvasCount: 2           // 两个 canvas，1228×3366，CSS 宽度 614px
bodyInnerText.length: 69 // 整页文本只有 69 个字，全是导航
```

**正文画在 canvas 上**，DOM 里没有正文字符——这也解释了为什么网页版无法选中复制、划词划线。改 `font-size` 改的是空气。

只能缩放，但缩放也有坑：`webContents.setZoomFactor(0.9)` 会让 DPR 变成非整数（2→1.8），微信读书按像素坐标画字，小数缩放下字形错位。最终方案是只给 canvas 容器加 `zoom`：

```css
.wr_canvasContainer { zoom: 0.9 !important; }
```

位图等比缩放、DPR 不变，不乱码，工具栏字号也不跟着缩。

**跨屏同理**：canvas 是画好就定格的位图，窗口拖到另一块 DPR 不同的屏不会自动重绘。修法是监听 `moved`、比对显示器 ID，换屏后派发 `resize` 并把窗口高度抖动 1px，逼阅读器重排。

## 夜间模式：一个 cookie 引发的状态同步

想让应用切深色时阅读器跟着进夜间，第一反应写 `localStorage`——没用。扒 bundle 才发现主题常量指向 **cookie `wr_theme`**，不是 localStorage。

改成写 cookie 后又掉进无限重载：cookie 有 host 级和 domain 级两份旧值，没清干净就反复读到不一致。最终叠了四层才稳定：比对/写入 cookie 并镜像 localStorage、写前清双级旧值、把「是否阅读页」的判断放进 guest 脚本、同一目标值每页只注入一次去重。

一个「换主题色」的需求，最后是个状态同步去重问题。而且我坚持不注入 CSS 覆盖，而是写站点自己的 `wr_theme`，等同点它自己的夜间按钮——官方改版时不容易碎。

![设置：外观三档 + 夜间联动](screenshots/settings.png)

## 点不动的按钮

阅读页有些控件无视 `element.click()`——它只认真实用户输入，合成事件 `isTrusted: false` 被过滤。解法是走主进程向 webview 注入真实鼠标事件（`sendInputEvent` 的 mouseMove/mouseDown/mouseUp），产生 `isTrusted: true` 的输入，和真鼠标无异。

## 下载 / 运行

[Releases](https://github.com/happut/weread-pc/releases) 提供 macOS（arm64/x64）、Windows、Linux 四平台 zip，解压即用。

```bash
npm install && npm start   # 从源码跑
npm run build:all          # 自己打四平台包
```

首次启动是两步向导：扫码登录书架（必须）、开通统计 API（可选）。

![首次连接向导](screenshots/wizard.png)

## 它还年轻，欢迎一起打磨

项目是我按自己的阅读习惯做的，有几处明显值得补，也是很好的上手切入点：

- **Windows / Linux 真机实测**：目前仅 macOS arm64 经过运行验证，其余是同源交叉构建，欢迎反馈；
- **release CI**：一个 tag 自动出四平台包的 GitHub Actions workflow，让发布不依赖我的本机；
- **沉浸式阅读模式、按字数自动翻页**：路线图里躺着的两个需求。

架构上刻意做了纯函数视图模型 + 62 个单测、零运行时第三方依赖（打包就是往官方 Electron 运行时里注入源码），改起来负担不大。

## 如实说限制

正文 canvas 渲染，**无法选中复制 / 划词划线**；依赖网页版内部类名，官方改版可能要改选择器；未做 Apple 公证，macOS 首次打开需右键→打开。另外阅读时长上报依赖把 UA 伪装成标准桌面 Chrome，属 ToS 灰色地带，自行评估。

---

仓库和下载都在 **https://github.com/happut/weread-pc** 。能帮到你就好，顺手 Star / Watch 跟进更新也欢迎。