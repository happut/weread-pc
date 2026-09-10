// renderer.js — 控制条逻辑：字号缩放 / 自动翻页 / 快捷键
const webview = document.getElementById('weread');
const fontLabel = document.getElementById('fontLabel');
const fontMinus = document.getElementById('fontMinus');
const fontPlus = document.getElementById('fontPlus');
const intervalInput = document.getElementById('interval');
const autoToggle = document.getElementById('autoToggle');
const homeBtn = document.getElementById('homeBtn');
const rerenderBtn = document.getElementById('rerenderBtn');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const statusEl = document.getElementById('status');

let fontSize = 0.9;       // 缩放系数：0.9 = 比网页版最小档（18px）再小一点，约 16px
let autoTimer = null;
let domReady = false;     // 由 webview dom-ready 事件维护，比 readyState 属性可靠

// ---- 字号（缩放）----
// 2026-09 网页版正文是 canvas 渲染（.wr_canvasContainer > canvas），CSS font-size 对它无效，
// 网页版字号滑块最小一级 = 18px，只能靠浏览器级缩放把正文进一步缩小。
// 有效字号 ≈ 网页版当前档位字号 × zoom（按最小档 18px 估算）
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2.0;
const ZOOM_STEP = 0.05;
const BASE_PX = 18; // 网页版最小一级的字号


// ---- 翻页：优先点新版底部分页按钮，否则模拟方向键 + 滚动兜底 ----
const TURN_JS = `
(function () {
  const btns = [...document.querySelectorAll('.renderTarget_pager_button')];
  const next = btns.length > 1 ? btns[btns.length - 1] : btns[0];
  if (next && next.offsetParent !== null) { next.click(); return 'click'; }
  const oldBtn = document.querySelector('.readerFooter_button');
  if (oldBtn && oldBtn.offsetParent !== null) { oldBtn.click(); return 'click-old'; }
  const ev = new KeyboardEvent('keydown', {
    key: 'ArrowRight', code: 'ArrowRight',
    keyCode: 39, which: 39, bubbles: true, cancelable: true
  });
  (document.activeElement || document.body).dispatchEvent(ev);
  document.dispatchEvent(ev);
  window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'smooth' });
  return 'key+scroll';
})();
`;

const TURN_PREV_JS = `
(function () {
  const btns = [...document.querySelectorAll('.renderTarget_pager_button')];
  const prev = btns[0];
  if (btns.length > 1 && prev && prev.offsetParent !== null) { prev.click(); return 'click'; }
  const ev = new KeyboardEvent('keydown', {
    key: 'ArrowLeft', code: 'ArrowLeft',
    keyCode: 37, which: 37, bubbles: true, cancelable: true
  });
  (document.activeElement || document.body).dispatchEvent(ev);
  document.dispatchEvent(ev);
  return 'ok';
})();
`;

function clampZoom(z) {
  return Math.round(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z)) * 100) / 100;
}

// CSS zoom 只作用于 canvas 页容器：位图整体等比缩小（2x DPR 降采样，清晰），
// 不改 devicePixelRatio，阅读器自身 UI 保持原大小。已验证无字形错位。
const zoomJs = (z) => `
(function () {
  const id = 'wb-canvas-zoom';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('style');
    el.id = id;
    document.head.appendChild(el);
  }
  el.textContent = '.wr_canvasContainer { zoom: ' + ${z} + ' !important; }';
})();
`;

function applyFont() {
  fontSize = clampZoom(fontSize);
  const approxPx = Math.round(BASE_PX * fontSize);
  fontLabel.textContent = Math.round(fontSize * 100) + '% ≈ ' + approxPx + 'px';
  if (domReady) {
    webview.executeJavaScript(zoomJs(fontSize)).catch(() => {});
  }
}

function setStatus(text, on) {
  statusEl.textContent = text || '';
  statusEl.className = on ? 'on' : '';
}

function startAuto() {
  const sec = Math.max(3, parseInt(intervalInput.value, 10) || 30);
  intervalInput.value = sec;
  autoTimer = setInterval(() => {
    webview.executeJavaScript(TURN_JS).catch(() => {});
  }, sec * 1000);
  autoToggle.textContent = '停止翻页';
  autoToggle.classList.add('primary');
  setStatus(`自动翻页中 · 每 ${sec}s`);
  if (window.wereadPC) window.wereadPC.setPowerSave(true); // 防止后台挂起
}

function stopAuto() {
  if (autoTimer) clearInterval(autoTimer);
  autoTimer = null;
  autoToggle.textContent = '自动翻页';
  autoToggle.classList.remove('primary');
  setStatus('');
  if (window.wereadPC) window.wereadPC.setPowerSave(false);
}

// ---- 事件绑定 ----
fontMinus.addEventListener('click', () => {
  if (fontSize > MIN_ZOOM + 0.001) {
    fontSize = clampZoom(fontSize - ZOOM_STEP);
    applyFont();
  }
});
fontPlus.addEventListener('click', () => {
  if (fontSize < MAX_ZOOM - 0.001) {
    fontSize = clampZoom(fontSize + ZOOM_STEP);
    applyFont();
  }
});
autoToggle.addEventListener('click', () => autoTimer ? stopAuto() : startAuto());
prevBtn.addEventListener('click', () => {
  webview.executeJavaScript(TURN_PREV_JS).catch(() => {});
});
nextBtn.addEventListener('click', () => {
  webview.executeJavaScript(TURN_JS).catch(() => {});
});
rerenderBtn.addEventListener('click', () => {
  if (window.wereadPC) window.wereadPC.forceRerender();
  setTimeout(applyFont, 400); // 重排后补回缩放样式
});
homeBtn.addEventListener('click', () => {
  webview.loadURL('https://weread.qq.com/web/shelf');
});
intervalInput.addEventListener('change', () => {
  if (autoTimer) { stopAuto(); startAuto(); } // 修改间隔后重启
});

window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key === 'ArrowRight') {
    webview.executeJavaScript(TURN_JS).catch(() => {});
  } else if (e.key === 'ArrowLeft') {
    webview.executeJavaScript(TURN_PREV_JS).catch(() => {});
  }
});

// ---- webview 生命周期 ----
webview.addEventListener('dom-ready', () => {
  domReady = true;
  applyFont(); // 整页跳转后缩放会丢失，重新应用
});
