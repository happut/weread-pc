// 临时探针：用已登录的会话加载阅读页，dump 真实 DOM 结构（调试完可删）
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.setPath('userData', path.join(__dirname, '.userdata'));
// 把 <BOOK_ID> 替换成目标书的 bookId（URL https://weread.qq.com/web/reader/<BOOK_ID> 中那串）
const BOOK_ID = '<BOOK_ID>';
const BOOK = process.argv.slice(2).find((a) => !a.startsWith('-')) ||
  `https://weread.qq.com/web/reader/${BOOK_ID}`;

function dumpAll(text) {
  fs.writeFileSync('/tmp/weread_probe.json', text);
  console.log(text);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: true, // 隐藏窗口下阅读器不渲染正文，必须显示才会排版
    width: 1200, height: 900,
    webPreferences: { partition: 'persist:weread' }
  });
  setTimeout(() => { try { app.quit(); } catch (e) {} }, 90000); // 硬超时
  win.webContents.on('did-fail-load', (e, code, desc) => console.error('LOAD FAIL', code, desc));
  win.loadURL(BOOK);
  win.webContents.on('dom-ready', async () => {
    await new Promise((r) => setTimeout(r, 12000)); // 等正文渲染
    try {
      const dump = await win.webContents.executeJavaScript(`
        (function () {
          const out = {};
          out.url = location.href;
          out.loggedIn = !!document.querySelector('.readerTopBar') ;
          const chapter = document.querySelector('.readerChapterContent');
          out.hasChapter = !!chapter;
          if (!chapter) {
            out.bodyClasses = document.body.className;
            out.topDivs = [...document.querySelectorAll('div')].slice(0, 15).map(d => d.className).filter(Boolean).slice(0, 15);
            return JSON.stringify(out, null, 2);
          }
          out.chapterClass = chapter.className;
          // 找正文段落：取文本最长的一个 p
          const ps = [...chapter.querySelectorAll('p')];
          out.pCount = ps.length;
          if (ps.length) {
            const target = ps.slice(0, 60).sort((a, b) => b.textContent.length - a.textContent.length)[0] || ps[0];
            out.pComputedFontSize = getComputedStyle(target).fontSize;
            out.pInlineStyle = target.getAttribute('style');
            out.pClass = target.className;
            out.pHtml = target.outerHTML.slice(0, 200);
            // 祖先链
            const chain = [];
            let e = target;
            while (e && e !== document.documentElement) {
              chain.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : ''));
              e = e.parentElement;
            }
            out.ancestors = chain;
            // 祖先的字体/尺寸信息
            out.ancestorInfo = (() => {
              const arr = [];
              let n = target;
              while (n && n !== document.documentElement) {
                const cs = getComputedStyle(n);
                arr.push({
                  cls: (typeof n.className === 'string' ? n.className : '').slice(0, 60),
                  fontSize: cs.fontSize, lineHeight: cs.lineHeight,
                  transform: cs.transform, zoom: cs.zoom, width: cs.width, height: cs.height, overflow: cs.overflow
                });
                n = n.parentElement;
              }
              return arr;
            })();
          }
          // 取文本最长的 passage（第一个常是空的分页占位）
          const passages = [...chapter.querySelectorAll('.passage-content')];
          const passage = passages.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length)[0];
          out.passageLens = passages.map((p) => (p.textContent || '').length);
          out.hasPassage = !!passage;
          if (passage) {
            out.passageHtml = passage.outerHTML.slice(0, 900);
            const cs = getComputedStyle(passage);
            out.passageStyle = { fontSize: cs.fontSize, lineHeight: cs.lineHeight, transform: cs.transform, zoom: cs.zoom, width: cs.width, height: cs.height };
            out.passageChildren = [...passage.children].slice(0, 6).map((c) => ({
              tag: c.tagName.toLowerCase(), cls: c.className, text: (c.textContent || '').slice(0, 40),
              fontSize: getComputedStyle(c).fontSize
            }));
            out.passageTextLen = (passage.textContent || '').length;
            out.passageCount = chapter.querySelectorAll('.passage-content').length;
            // 祖先链
            const chain = [];
            let e = passage;
            while (e && e !== document.documentElement) {
              chain.push((typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\s+/).join('.') : e.tagName.toLowerCase()) + ' [' + getComputedStyle(e).fontSize + ']');
              e = e.parentElement;
            }
            out.ancestors = chain;
          }
          // 全局扫描：正文文字实际落在哪个元素里（取最内层、文本较长的元素）
          const all = [...chapter.querySelectorAll('*')].filter((e) => (e.textContent || '').trim().length > 80);
          out.textElementsCount = all.length;
          if (all.length) {
            const leaf = all.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
            out.leafHtml = leaf.outerHTML.slice(0, 500);
            out.leafStyle = (() => { const cs = getComputedStyle(leaf); return { fontSize: cs.fontSize, lineHeight: cs.lineHeight, width: cs.width }; })();
            const lchain = [];
            let n2 = leaf;
            while (n2 && n2 !== document.documentElement) {
              lchain.push((typeof n2.className === 'string' && n2.className ? '.' + n2.className.trim().split(/\s+/).join('.') : n2.tagName.toLowerCase()) + ' [' + getComputedStyle(n2).fontSize + ']');
              n2 = n2.parentElement;
            }
            out.leafAncestors = lchain;
            out.leafTagCount = (() => {
              const m = {};
              all.forEach((e) => { const k = e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className : ''); m[k] = (m[k] || 0) + 1; });
              return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 12);
            })();
          }
          // canvas 详情
          out.canvasInfo = [...document.querySelectorAll('canvas')].map((c) => ({
            w: c.width, h: c.height, cssW: c.style.width, cls: c.className, parentCls: (c.parentElement && c.parentElement.className) || ''
          }));
          out.bodyInnerTextLen = (document.body.innerText || '').trim().length;
          out.bodyTextSample = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 150);
          // 字号面板
          const panel = document.querySelector('.font-panel-content-size-wrapper') || document.querySelector('.font-panel-content');
          out.fontPanelHtml = panel ? panel.outerHTML.slice(0, 500) : 'none';
          out.canvasCount = document.querySelectorAll('canvas').length;
          out.svgCount = document.querySelectorAll('svg').length;
          // 容器类名统计
          out.containerClasses = [...chapter.querySelectorAll('div')]
            .map(d => typeof d.className === 'string' ? d.className : '')
            .filter(c => /render|Render|page|Page|content|Content/.test(c))
            .slice(0, 30);
          return JSON.stringify(out, null, 2);
        })();
      `);
      dumpAll(dump);
    } catch (e) {
      dumpAll('probe error: ' + e.message);
    }
    app.quit();
  });
});
