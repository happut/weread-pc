// 临时脚本：启动应用并在 20 秒后截取应用窗口（调试完可删）
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

require('./main.js'); // 复用应用主逻辑创建窗口

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 20000)); // 等阅读器加载
  const wins = BrowserWindow.getAllWindows();
  if (!wins.length) {
    console.log('no window');
    return;
  }
  const img = await wins[0].webContents.capturePage();
  fs.writeFileSync('/tmp/weread_app.png', img.toPNG());
  console.log('captured ->/tmp/weread_app.png');
  // 不退出，应用继续运行
});
