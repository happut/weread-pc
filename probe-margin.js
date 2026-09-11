// 实验3: 单页 vs 双页模式的留白对比 + 截图（调试完可删）
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.setPath('userData', path.join(__dirname, '.userdata'));
// 同 probe.js：填入目标书的 BOOK_ID
const BOOK_ID = '<BOOK_ID>';
const BOOK = process.argv.slice(2).find((a) => !a.startsWith('-')) ||
  `https://weread.qq.com/web/reader/${BOOK_ID}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MEASURE = `
(function () {
  const w = (sel) => { const el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().width) : 0; };
  const canvases = [...document.querySelectorAll('.wr_canvasContainer canvas')].map(c => Math.round(c.getBoundingClientRect().width));
  const card = w('.readerChapterContent');
  const text = canvases.reduce((a, b) => a + b, 0);
  return JSON.stringify({ win: window.innerWidth, card, canvases, textTotal: text, blankRatio: card ? Math.round((1 - text / card) * 100) + '%' : '?' });
})();
`;

async function shot(win, file) {
  const img = await win.webContents.capturePage();
  fs.writeFileSync(file, img.toPNG());
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, width: 1200, height: 840,
    webPreferences: { partition: 'persist:weread' }
  });
  setTimeout(() => app.quit(), 240000);
  win.loadURL(BOOK);
  win.webContents.on('dom-ready', async () => {
    try {
      await sleep(14000);
      console.log('双页 win=1200:', await win.webContents.executeJavaScript(MEASURE));
      await shot(win, '/tmp/margin_double.png');

      // 窗口缩到 900，自动变单页
      win.setContentSize(900, 840);
      await sleep(15000);
      console.log('单页 win=900:', await win.webContents.executeJavaScript(MEASURE));
      await shot(win, '/tmp/margin_single.png');
    } catch (e) {
      console.error('probe error:', e.message);
    }
    app.quit();
  });
});
