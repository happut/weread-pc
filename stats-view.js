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

  // ⓪ 维度分段控件（周/月/年）
  function renderTabs(vm, h) {
    const tabs = el('div', 'dim-tabs');
    for (const d of [['week', '周'], ['month', '月'], ['year', '年']]) {
      const b = el('button', 'dim-tab' + (vm.dim === d[0] ? ' on' : ''), d[1]);
      b.addEventListener('click', () => h.onDim && h.onDim(d[0]));
      tabs.appendChild(b);
    }
    return tabs;
  }

  // ① 热力图：cells 随维度（周=7 格 / 月=按天 / 年=最近一年 12 月格）
  function renderHeat(vm) {
    const cells = vm.cells || [];
    const title = vm.dim === 'week' ? '本周阅读热力'
      : vm.dim === 'year' ? '最近一年阅读热力 · 按月'
        : vm.year + ' 年 ' + vm.heatMonth + ' 月阅读热力 · 按天';
    const c = card(title);
    if (vm.dim === 'year' && cells.length) {
      c.appendChild(el('div', 'stat-sub', cells[0].key + ' ~ ' + cells[cells.length - 1].key));
    }
    const grid = el('div', vm.dim === 'week' ? 'heat-week' : (vm.dim === 'year' ? 'heat-month' : 'heat'));
    for (const cell of cells) {
      const i = el('i', cell.level ? ('lv' + cell.level) : '');
      i.title = cell.key + ' · ' + (vm.dim === 'year' ? (cell.hours + ' 小时') : cell.text);
      grid.appendChild(i);
    }
    c.appendChild(grid);
    return c;
  }

  // ①b 分布柱状图：与热力图同源 cells；月维度 31 根走 dense 细柱
  function renderBars(vm) {
    const cells = vm.cells || [];
    const label = (vm.metric && vm.metric.label) || '';
    const c = card(label + (vm.dim === 'year' ? '按月分布' : '按天分布'));
    if (!cells.length) { c.appendChild(el('div', 'stat-empty', '暂无数据')); return c; }
    const dense = cells.length > 12;
    const max = Math.max.apply(null, cells.map(x => x.seconds).concat([1]));
    const row = el('div', 'weekbars' + (dense ? ' dense' : ''));
    for (const cell of cells) {
      const col = el('div', 'wb' + (cell.isCurrent ? ' today' : ''));
      const val = vm.dim === 'year' ? (cell.hours + 'h') : cell.text;   // 周/月含分钟，年按小时
      col.title = cell.key + ' · ' + val;
      const bar = el('div', 'wb-bar');
      const fill = el('i');
      fill.style.height = Math.max(2, Math.round((cell.seconds || 0) / max * 100)) + '%';
      bar.appendChild(fill);
      col.appendChild(bar);
      if (!dense || cell.isCurrent) col.appendChild(el('small', null, cell.label));
      if (!dense) col.appendChild(el('span', 'wb-h', cell.seconds ? val : '—'));
      row.appendChild(col);
    }
    c.appendChild(row);
    return c;
  }

  // ② 指标卡四槽：随维度（总时长/日均/环比/阅读天数）
  function renderMetric(vm) {
    const m = vm.metric || {};
    const c = card('阅读时长');
    const row = el('div', 'dur-row');
    const slot = (big, unit, small, smallCls) => {
      const box = el('div', 'dur');
      const head = el('div');
      head.appendChild(el('b', null, String(big)));
      if (unit) head.appendChild(el('span', null, unit));
      box.appendChild(head);
      box.appendChild(el('small', smallCls || null, small));
      return box;
    };
    row.appendChild(slot(m.totalText || '0m', '', (m.label || '') + '总时长'));
    row.appendChild(slot(m.dayAvgText || '0m', '', '日均'));
    if (typeof m.compare === 'number') {
      const up = m.compare >= 0;
      row.appendChild(slot((up ? '↑' : '↓') + Math.round(Math.abs(m.compare) * 100), '%', m.compareLabel || '环比', up ? 'cmp-up' : 'cmp-down'));
    } else {
      row.appendChild(slot('—', '', m.compareLabel || '环比'));
    }
    row.appendChild(slot(m.readDays || 0, '天', '阅读天数'));
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
      c.appendChild(el('div', 'stat-sub', '成就'));
      const wrap = el('div', 'medals');
      const shown = vm.medals.slice(0, 12);
      for (const m of shown) {
        wrap.appendChild(el('span', 'medal', m.count > 1 ? m.title + ' ×' + m.count : m.title));
      }
      if (vm.medals.length > shown.length) {
        wrap.appendChild(el('span', 'medal more', '等 ' + vm.medals.length + ' 种'));
      }
      c.appendChild(wrap);
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
      if (vm && (vm.preference || []).length) container.appendChild(renderPreference(vm));   // 退化仍可用
      if (vm && (vm.topBooks || []).length) container.appendChild(renderTopBooks(vm, h.onOpenBook));
      return;
    }
    container.appendChild(renderTabs(vm, h));
    container.appendChild(renderMetric(vm));
    container.appendChild(renderHeat(vm));
    container.appendChild(renderBars(vm));
    container.appendChild(renderPreference(vm));
    container.appendChild(renderTopBooks(vm, h.onOpenBook));
    container.appendChild(renderStreak(vm));
  }

  const api = { el, render, renderTabs, renderMetric, renderHeat, renderBars, renderPreference, renderTopBooks, renderStreak };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatsView = api;
})(typeof window !== 'undefined' ? window : globalThis);
