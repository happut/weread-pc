// 对比截图：zoom=1 原始 / setZoomFactor(0.9) / CSS zoom 0.9，定位乱码来源（调试完可删）
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.setPath('userData', path.join(__dirname, '.userdata'));
const BOOK = process.argv.slice(2).find((a) => !a.startsWith('-')) ||
  'https://weread.qq.com/web/reader/<BOOK_ID>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(win, file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
  console.log('saved', file);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1200, height: 840,
    webPreferences: { partition: 'persist:weread' }
  });
  setTimeout(() => app.quit(), 120000);
  win.loadURL(BOOK);
  win.webContents.on('dom-ready', async () => {
    try {
      await sleep(12000); // 等正文渲染
      const dpr = await win.webContents.executeJavaScript('window.devicePixelRatio');
      console.log('dpr at zoom1 =', dpr);
      await shot(win, '/tmp/shot_A_zoom1.png');

      // B: setZoomFactor 0.9（当前 app 的做法）
      win.webContents.setZoomFactor(0.9);
      await sleep(4000);
      const dpr2 = await win.webContents.executeJavaScript('window.devicePixelRatio');
      console.log('dpr at setZoomFactor(0.9) =', dpr2);
      await shot(win, '/tmp/shot_B_setZoom09.png');

      // C: 恢复 zoom=1，改用 CSS zoom 缩放 canvas 容器
      win.webContents.setZoomFactor(1);
      await sleep(2000);
      await win.webContents.executeJavaScript(`
        const id = 'wb-canvas-zoom';
        let el = document.getElementById(id);
        if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el); }
        el.textContent = '.wr_canvasContainer { zoom: 0.9 !important; }';
      `);
      await sleep(3000);
      const dpr3 = await win.webContents.executeJavaScript('window.devicePixelRatio');
      console.log('dpr at CSS zoom 0.9 =', dpr3);
      await shot(win, '/tmp/shot_C_cssZoom09.png');
    } catch (e) {
      console.error('probe error:', e.message);
    }
    app.quit();
  });
});
