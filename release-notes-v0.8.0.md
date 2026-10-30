# WeRead PC v0.8.0

体验打磨 + 夜间模式联动，并首次提供 **四平台** 下载包（macOS arm64/x64 · Windows x64 · Linux x64）。

### 新增

- **应用外观开关**：设置 → 外观，跟随系统 / 浅色 / 深色，选择本地持久化；壳 UI 颜色收敛为 CSS 变量，默认跟随系统 `prefers-color-scheme`
- **阅读器夜间联动**：应用切深色时同步微信读书阅读器夜间模式——写站点自带的 `wr_theme` cookie（等同点站点自己的夜间按钮，不注入 CSS），可在设置里关闭同步
- **书架搜索**：顶部搜索框按书名 / 作者本地过滤，计数联动，清空即还原
- **书桌置顶**：书卡右键 → 置顶 / 取消置顶，置顶持久化并排前显示
- **设置自助维护**：新增「退出登录」（清 Cookie，保留统计 Key）与「清除本地缓存」
- **单页模式 toggle**：工具条「单页」收窄窗口消除双页中缝，再点还原进单页前的宽度

### 体验修复（P0）

- 缩放比例与自动翻页间隔写入本地，重启后恢复
- book webview 检测登录页跳转：登录态过期时更新连接状态并提示就地扫码
- 加载失败分级提示：区分断网 / 被打断 / 正文超时（可能官方改版），不再一律转圈
- 首次气泡文案对齐「单击直接阅读，右键看详情 / 统计」

### 夜间联动稳定性（多轮修复）

- `wr_theme` 是站点 **cookie** 而非 localStorage：改为比对 / 写入 cookie + 镜像 localStorage
- 写入前清 host / domain 双级旧 cookie，消除无限重载
- 阅读页判断移入 guest 脚本（宿主 `getURL` 重载后不可靠）
- 同一目标值每页只注入一次，消除并发重复 reload

### 清理

- 删除永不生效的「自动取 Key」死路径（`AUTO_KEY_ENDPOINT` / `tryAutoKey` / 重新获取 Key 按钮）；授权页 `wrk-` 自动抓取与手动粘贴仍保留

### 多平台打包

`build.sh` 重写为跨平台：复用 / 下载官方 Electron 预编译运行时注入源码，无需 electron-builder。

```bash
npm run build       # 仅 macOS arm64
npm run build:all   # 四平台全打
```

### 下载与安装

| 平台 | 包 | 首次打开 |
| --- | --- | --- |
| macOS · Apple Silicon | `WeRead-PC-macOS-arm64-0.8.0.zip` | 拖进「应用程序」；未公证，右键 → 打开，或 `xattr -cr /Applications/WeRead-PC.app` |
| macOS · Intel | `WeRead-PC-macOS-x64-0.8.0.zip` | 同上 |
| Windows · x64 | `WeRead-PC-win32-x64-0.8.0.zip` | 解压进 `WeRead-PC/`，双击 `WeRead-PC.exe`；SmartScreen 选「仍要运行」 |
| Linux · x64 | `WeRead-PC-linux-x64-0.8.0.zip` | 解压进 `WeRead-PC/`，`./weread-pc --no-sandbox` |

> **验证状态**：macOS arm64 包已本机运行验证（启动 → 壳 UI → webview 到达书架）；macOS x64 已校验架构与签名；Windows / Linux 为同源交叉构建，结构一致但未在对应系统实测。Linux 便携包内 chrome-sandbox 非 root SUID，需 `--no-sandbox` 启动。问题欢迎提 Issue。

### 从源码运行

```bash
npm install
npm start
npm test    # 62 例单测
```