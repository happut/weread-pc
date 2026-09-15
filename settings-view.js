// settings-view.js — 设置模态渲染（连接状态 / 高级手动 / 缓存 / 隐私）
// 浏览器：挂 window.SettingsView；node：module.exports。不发请求，只渲染 + 回调 handler。
(function (root) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function pillClass(mode) {
    if (mode === 'key') return 'conn-ok';
    if (mode === 'cookie' || mode === 'webview') return 'conn-warn';
    return 'conn-no';
  }
  function pillText(mode) {
    if (mode === 'key') return '已连接（统计可用）';
    if (mode === 'cookie' || mode === 'webview') return '仅书架（统计需 API Key）';
    return '未连接';
  }
  function sourceText(src) {
    if (src === 'manual') return '手动';
    if (src === 'auto') return '自动';
    return '无';
  }

  // model = { mode, source, maskedKey, manualKey, manualCookie }
  // handlers = { onClose, onSaveManual({key,cookie}), onClearManual, onRetryAuto, onRefreshStats }
  function render(container, model, handlers) {
    const m = model || {};
    const h = handlers || {};
    // 重建面板（不清 container 本身的事件，只清内容）
    container.textContent = '';
    const panel = el('div', 'stg');

    // 头部
    const hd = el('div', 'stg-hd');
    hd.appendChild(el('span', null, '设置'));
    const x = el('button', 'x', '✕');
    x.addEventListener('click', function () { h.onClose && h.onClose(); });
    hd.appendChild(x);
    panel.appendChild(hd);

    // 连接状态
    const sec1 = el('div', 'stg-sec');
    sec1.appendChild(el('div', 'stg-lbl', '微信读书连接'));
    const pill = el('span', 'conn-pill ' + pillClass(m.mode), pillText(m.mode));
    sec1.appendChild(pill);
    if (m.maskedKey) {
      const kb = el('div');
      kb.style.marginTop = '10px';
      kb.appendChild(el('span', 'stg-lbl', 'API Key：'));
      kb.appendChild(el('span', 'keybox', m.maskedKey));
      kb.appendChild(el('span', 'stg-lbl', ' · 来源 ' + sourceText(m.source)));
      sec1.appendChild(kb);
    }
    const retry = el('button', null, '重新获取 Key');
    retry.style.marginTop = '10px';
    retry.addEventListener('click', function () { h.onRetryAuto && h.onRetryAuto(); });
    sec1.appendChild(retry);
    panel.appendChild(sec1);

    // 高级：手动 Key / Cookie
    const sec2 = el('div', 'stg-sec');
    const det = el('details');
    det.appendChild(el('summary', null, '高级：手动配置 Key / Cookie'));
    const wrap = el('div');
    wrap.style.marginTop = '10px';
    wrap.appendChild(el('div', 'stg-lbl', 'API Key（wrk- 开头，从 weread.qq.com/r/weread-skills 获取）'));
    const keyIn = el('input'); keyIn.type = 'text'; keyIn.placeholder = 'wrk-…'; keyIn.value = m.manualKey || '';
    wrap.appendChild(keyIn);
    wrap.appendChild(el('div', 'stg-lbl', 'Cookie（兜底，仅书架/同源；统计不可用）'));
    const ckIn = el('input'); ckIn.type = 'text'; ckIn.placeholder = 'wr_vid=…; wr_skey=…'; ckIn.value = m.manualCookie || '';
    wrap.appendChild(ckIn);
    const saveRow = el('div');
    const save = el('button', 'primary', '保存');
    save.addEventListener('click', function () { h.onSaveManual && h.onSaveManual({ key: keyIn.value, cookie: ckIn.value }); });
    const clear = el('button', null, '清除手动配置');
    clear.style.marginLeft = '8px';
    clear.addEventListener('click', function () { h.onClearManual && h.onClearManual(); });
    saveRow.appendChild(save); saveRow.appendChild(clear);
    wrap.appendChild(saveRow);
    det.appendChild(wrap);
    sec2.appendChild(det);
    panel.appendChild(sec2);

    // 数据与缓存
    const sec3 = el('div', 'stg-sec');
    sec3.appendChild(el('div', 'stg-lbl', '数据与缓存'));
    const rs = el('button', null, '刷新统计数据');
    rs.addEventListener('click', function () { h.onRefreshStats && h.onRefreshStats(); });
    sec3.appendChild(rs);
    const note = el('div', 'stg-lbl', '统计与书籍详情会自动缓存，每次成功取数覆盖旧值。');
    note.style.marginTop = '8px';
    sec3.appendChild(note);
    panel.appendChild(sec3);

    // 隐私页脚
    const ft = el('div', 'stg-ft');
    ft.textContent = '所有数据仅存于本机 .userdata/ 目录（已 gitignore）；API Key 与 Cookie 不会上传、不会打印到日志。';
    panel.appendChild(ft);

    container.appendChild(panel);

    // 点遮罩空白处关闭（只绑一次监听；handler 存 container 上动态读取，避免闭包固化首次 h）
    container._stgHandlers = h;
    if (!container._overlayBound) {
      container._overlayBound = true;
      container.addEventListener('click', function (e) {
        if (e.target === container && container._stgHandlers && container._stgHandlers.onClose) container._stgHandlers.onClose();
      });
    }
  }

  const api = { el, pillClass, pillText, sourceText, render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SettingsView = api;
})(typeof window !== 'undefined' ? window : globalThis);
