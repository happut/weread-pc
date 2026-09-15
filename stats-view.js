// stats-view.js — 统计看板 DOM 渲染（只看视图模型，不发请求）
(function (root) {
  'use strict';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function card(title) {
    const c = el('div', 'stat-card');
    if (title) c.appendChild(el('div', 'stat-h', title));
    return c;
  }

  // ① 热力图
  function renderHeatmap(vm) {
    const c = card(vm.year + ' 年阅读热力图');
    const grid = el('div', 'heat');
    for (const cell of vm.heatmap) {
      const i = el('i', cell.level ? ('lv' + cell.level) : '');
      i.title = cell.day + ' · ' + Math.round((cell.seconds || 0) / 60) + ' 分钟';
      grid.appendChild(i);
    }
    c.appendChild(grid);
    return c;
  }

  // ② 时长汇总
  function renderDurations(vm) {
    const d = vm.durations || {};
    const c = card('阅读时长');
    const row = el('div', 'dur-row');
    const defs = [['year', '今年'], ['month', '本月'], ['week', '本周'], ['overall', '累计']];
    for (const def of defs) {
      const x = d[def[0]] || {};
      const box = el('div', 'dur');
      const big = el('div');
      big.appendChild(el('b', null, String(x.hours || 0)));
      big.appendChild(el('span', null, '小时'));
      box.appendChild(big);
      box.appendChild(el('small', null, '日均 ' + (x.dayAvgHours || 0) + 'h'));
      if (typeof x.compare === 'number') {
        const up = x.compare >= 0;
        box.appendChild(el('small', up ? 'cmp-up' : 'cmp-down',
          (up ? '↑ ' : '↓ ') + Math.round(Math.abs(x.compare) * 100) + '% 环比'));
      }
      row.appendChild(box);
    }
    c.appendChild(row);
    return c;
  }

  // ③ 阅读偏好
  function renderPreference(vm) {
    const c = card('阅读偏好');
    if (!vm.preference.length) { c.appendChild(el('div', 'stat-empty', '暂无偏好数据')); return c; }
    const max = vm.preference[0].seconds || 1;
    for (const p of vm.preference) {
      const row = el('div', 'pref-row');
      row.appendChild(el('span', 'name', p.category));
      const track = el('div', 'track'); const fill = el('i');
      fill.style.width = Math.max(4, Math.round(p.seconds / max * 100)) + '%';
      track.appendChild(fill); row.appendChild(track);
      row.appendChild(el('span', 'pct', p.percent + '%'));
      c.appendChild(row);
    }
    return c;
  }

  // ④ 读最久 TOP5（点击→详情）
  function renderTopBooks(vm, onOpenBook) {
    const c = card('读得最久 TOP5');
    if (!vm.topBooks.length) { c.appendChild(el('div', 'stat-empty', '暂无数据')); return c; }
    for (const b of vm.topBooks) {
      const row = el('div', 'top-row');
      if (b.cover) { const img = el('img'); img.src = b.cover; img.alt = b.title; row.appendChild(img); }
      row.appendChild(el('div', 't', b.title));
      row.appendChild(el('div', 'h', b.hours + 'h'));
      if (onOpenBook && b.bookId) { row.style.cursor = 'pointer'; row.addEventListener('click', () => onOpenBook(b.bookId)); }
      c.appendChild(row);
    }
    return c;
  }

  // ⑥ 连续打卡/成就
  function renderStreak(vm) {
    const s = vm.streak || {};
    const c = card('连续打卡');
    const row = el('div', 'streak');
    const mk = (n, label) => { const b = el('div'); b.appendChild(el('div', 'n', String(n || 0))); b.appendChild(el('small', null, label)); return b; };
    row.appendChild(mk(s.current, '当前连续(天)'));
    row.appendChild(mk(s.longest, '历史最长(天)'));
    row.appendChild(mk(s.readDays, '有效阅读(天)'));
    c.appendChild(row);
    if (vm.medals && vm.medals.length) {
      c.appendChild(el('div', 'stat-h', '成就：' + vm.medals.map(x => x.title || '').filter(Boolean).join('、')));
    }
    return c;
  }

  // 主入口
  function render(container, vm, handlers) {
    container.textContent = '';
    const h = handlers || {};
    if (!vm || !vm.connected) {
      const box = el('div', 'stat-empty');
      box.appendChild(el('div', null, '未连接微信读书，无法获取完整统计'));
      const b = el('button', 'primary', '去设置连接');
      b.addEventListener('click', () => h.onSettings && h.onSettings());
      box.appendChild(b);
      container.appendChild(box);
      if (vm && vm.preference.length) container.appendChild(renderPreference(vm));   // 退化仍可用
      if (vm && vm.topBooks.length) container.appendChild(renderTopBooks(vm, h.onOpenBook));
      return;
    }
    container.appendChild(renderDurations(vm));
    container.appendChild(renderHeatmap(vm));
    container.appendChild(renderPreference(vm));
    container.appendChild(renderTopBooks(vm, h.onOpenBook));
    container.appendChild(renderStreak(vm));
  }

  const api = { el, render, renderHeatmap, renderDurations, renderPreference, renderTopBooks, renderStreak };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatsView = api;
})(typeof window !== 'undefined' ? window : globalThis);
