# WeRead PC v0.5.0

这一版把阅读变成了「多书并行」：左侧在读侧栏可快速切换，书页后台保活，切换不重载。

### 新增

- **阅读左侧「在读」侧栏**：列出本会话打开过的书，高亮当前在读；点书快速切换，✕ 关闭（关当前则切下一本或回书架）；侧栏底部可一键回首页
- **多 book webview 后台保活**：每本在读书独立 webview，切走只隐藏不销毁，进度/画布/滚动原样保留；再点回是热切换，不闪 loading
- **侧栏顺序固定**：按首次打开顺序排列，点击切换不再乱跳

### 其他

- 应用图标定稿为银虎斑美短正脸（圆脸宽颊 + 经典涡纹 + 绿眼）
- 首页（书架/统计）保持独立视图，阅读侧栏不侵入首页

### 安装

下载 `WeRead-PC-macOS-arm64-0.5.0.zip`，解压得到 `WeRead-PC.app`，拖进「应用程序」即可。

> ⚠️ **首次打开会被 Gatekeeper 拦截**（未做 Apple 公证）。解决方式二选一：
> - 右键点击 App → 选择「打开」→ 再点一次「打开」
> - 或在终端执行：`xattr -cr /Applications/WeRead-PC.app`

**系统要求**：macOS，Apple Silicon（arm64）。Intel 机器需要自行改用 x64 运行时。

### 从源码运行

```bash
npm install
npm start
```

打包：

```bash
npm run build
# 产物 release/WeRead-PC-macOS-arm64-0.5.0.zip
```
