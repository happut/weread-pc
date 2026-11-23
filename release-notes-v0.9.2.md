# WeRead PC v0.9.2

书架按文件夹下钻整理，应用自己能检查更新、一键升级。

### 新增

- **文件夹下钻书架**：「全部藏书」网格把归档展示为文件夹卡片，单击下钻进入该文件夹的书架，顶部返回键回到顶层；文件夹徽章显示本数，空文件夹不出卡
- **四格封面卡面**：≤4 本按最近阅读序铺四格封面、不足留空；>4 本前 3 格放最近读的 3 本，第 4 格内嵌 2×2 拼贴放其后最近 4 本、不足留空；每个小封面套书籍外框并留内边距
- **检查更新 + 一键更新**：设置新增「关于与更新」区，显示当前版本与检查更新按钮，更新源为 GitHub releases；发现新版展示版本号与可折叠更新说明；macOS 安装版点「立即更新」自动下载对应平台包、解压校验、旧版备份到临时目录后替换并自动重启，任一步失败恢复备份；其余平台与开发态给下载页链接手动更新

### 体验优化

- 文件夹卡改用 div role=button：Chrome 的 button 固有高度不计 aspect-ratio 子元素，曾致网格行轨塌陷、卡片叠盖且无法滚动
- 下钻返回顶层重置滚动位置，从第一行开始浏览
- 更新进度只局部刷新更新区 DOM，不重渲染设置面板，不打断手动 Key 输入

### 下载与安装

| 平台 | 包 | 首次打开 |
| --- | --- | --- |
| macOS · Apple Silicon | `WeRead-PC-macOS-arm64-0.9.2.zip` | 拖进「应用程序」；未公证，右键 → 打开，或 `xattr -cr /Applications/WeRead-PC.app` |
| macOS · Intel | `WeRead-PC-macOS-x64-0.9.2.zip` | 同上 |
| Windows · x64 | `WeRead-PC-win32-x64-0.9.2.zip` | 解压进 `WeRead-PC/`，双击 `WeRead-PC.exe`；SmartScreen 选「仍要运行」 |
| Linux · x64 | `WeRead-PC-linux-x64-0.9.2.zip` | 解压进 `WeRead-PC/`，`./weread-pc --no-sandbox` |

> **验证状态**：macOS arm64 包已本机运行验证（79 例单测全过；文件夹下钻与四格卡面真数据截图；设置检查更新真实请求 GitHub 返回「已是最新」；开发态更新 guard 与下载页兜底实测）；其余平台为同源交叉构建，结构一致但未在对应系统实测。Linux 便携包内 chrome-sandbox 非 root SUID，需 `--no-sandbox` 启动。问题欢迎提 Issue。

### 从源码运行

```bash
npm install
npm start
npm test    # 79 例单测
```
