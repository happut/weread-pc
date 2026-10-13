# WeRead PC v0.4.0

这一版换了新应用图标，修掉了安装版统计页「未连接」和 Dock 旧图标两个硬伤，并给网关 Skill 升级加了兼容层。

### 新增

- **阅读页模式切换**：顶栏「模式」按钮，一键切换微信读书的「上下滚动 / 翻页」；由主进程注入真实鼠标事件点按阅读页内官方控件（合成 click 无效），并能唤出自动隐藏的工具栏
- **新应用图标**：美短银虎斑猫窝在书里；打包时自动注入 ICNS，可执行文件同步改名为 `WeRead-PC`

### 修复

- **安装版统计页报「未连接」**：`userData` 落在 `~/Library/Application Support/WeRead-PC`，不再写进 `.app` 包内；首次运行自动从旧目录迁移登录态 / API Key / 缓存
- **Dock 显示 Electron 旧图标**：可执行文件改名为产品名，双写 `WeRead-PC.icns` + `electron.icns`
- **统计页闪一下又未连接**：网关 `skill_version` 升级提示不再丢弃已取到的业务数据；`skill_version` 升到 1.0.5
- **状态栏按钮换行**：长文案不再把工具按钮挤成两行

### 兼容

- **Skill 版本自动跟随**：解析网关 `upgrade_info.latest_version` 并记忆；旧版本号请求失败时用新号自动重取一次。后续微信读书再升 Skill 版本，一般无需改代码

### 安装

下载 `WeRead-PC-macOS-arm64-0.4.0.zip`，解压得到 `WeRead-PC.app`，拖进「应用程序」即可。

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
# 产物 release/WeRead-PC-macOS-arm64-0.4.0.zip
```
