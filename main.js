const { app, BrowserWindow, ipcMain, powerSaveBlocker, screen } = require('electron');
const path = require('path');

let win = null;
let powerSaveId = null;
let guest = null;        // webview 的 webContents
let lastDisplayId = null;

// 跨屏拖动会改变 devicePixelRatio，而正文是 canvas 位图，不随 DPR 变化重绘 -> 字形错位
// 做法：换屏时派发 resize 事件 + 抖动 1px 触发真实重排，让阅读器重新排版
function forceRerender() {
  if (!win) return;
  const [w, h] = win.getSize();
  if (guest) guest.executeJavaScript('window.dispatchEvent(new Event("resize"))').catch(() => {});
  win.setSize(w, h + 1);
  setTimeout(() => win.setSize(w, h), 150);
}

// 应用数据（登录态、缓存）存到项目内，保持自包含
app.setPath('userData', path.join(__dirname, '.userdata'));

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'WeRead PC',
    webPreferences: {
      webviewTag: true,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  win.setMenuBarVisibility(false);
  win.loadFile('index.html');

  // 网页内新开链接 -> 在 webview 内打开，不弹新窗口
  win.webContents.on('did-attach-webview', (_, wc) => {
    guest = wc;
    // 重置可能被持久化的页面级缩放（会破坏 canvas 渲染，产生字形错位）
    wc.setZoomFactor(1);
    wc.setWindowOpenHandler(({ url }) => {
      if (url && url.startsWith('http')) wc.loadURL(url);
      return { action: 'deny' };
    });
  });

  // 跨屏拖动后强制重绘，修复 canvas 字形错位
  lastDisplayId = screen.getDisplayMatching(win.getBounds()).id;
  win.on('moved', () => {
    const d = screen.getDisplayMatching(win.getBounds());
    if (d.id !== lastDisplayId) {
      lastDisplayId = d.id;
      setTimeout(forceRerender, 250); // 等系统完成 DPR 切换
    }
  });
}

ipcMain.handle('power-save', (_, on) => {
  if (on) {
    if (powerSaveId === null) {
      powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    }
    return true;
  }
  if (powerSaveId !== null) {
    powerSaveBlocker.stop(powerSaveId);
    powerSaveId = null;
  }
  return false;
});

ipcMain.handle('force-rerender', () => {
  forceRerender();
  return true;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
