## WeRead PC v0.1.0

微信读书的桌面壳，基于 Electron + webview。核心解决两件事：**字号能比网页版最小号更小**、**能自己翻页**。

### 功能

- **完整网页版阅读**：登录态持久化，扫码登录一次即可
- **字号缩放 50%–200%**：默认 90%（≈16px，小于网页版最小的 18px），连续可调
- **上一页 / 下一页**：顶栏按钮 + `⌘+←` / `⌘+→` 快捷键
- **自动翻页**：间隔 3–600 秒可调，翻页期间阻止系统休眠
- **跨屏自愈**：窗口拖到另一块屏幕后自动重绘，修复正文错位
- **手动重绘**：工具栏「重绘」按钮，兜底渲染异常

### 安装

下载 `WeRead-PC-macOS-arm64-0.1.0.zip`，解压得到 `WeRead-PC.app`，拖进「应用程序」即可。

> ⚠️ **首次打开会被 Gatekeeper 拦截**（未做 Apple 公证）。解决方式二选一：
> - 右键点击 App → 选择「打开」→ 再点一次「打开」
> - 或在终端执行：`xattr -cr /Applications/WeRead-PC.app`

**系统要求**：macOS，Apple Silicon（arm64）。Intel 机器需要自行改用 x64 运行时。

### 从源码运行

```bash
npm install
npm start
```

### 打包

```bash
npm run build   # 产出 release/WeRead-PC-macOS-arm64-<version>.zip
```

打包脚本不依赖 electron-builder / electron-packager：本应用运行时只用 Electron 内置模块，无第三方依赖，于是直接复用 `node_modules/electron/dist` 里的运行时，注入源码 + 改 Info.plist + ad-hoc 签名即可。

### 已知限制

- 正文为 canvas 渲染，**无法选中复制**、无法划词划线（这是渲染方式的代价，详见 README）
- 依赖网页版内部类名（`.wr_canvasContainer`、`.renderTarget_pager_button`），官方改版可能失效
- 仅提供 macOS arm64 构建，未签名未公证
