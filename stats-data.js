// stats-data.js — 纯函数：StatsBundle（weread-api 归一化）→ 看板视图模型
(function (root) {
  'use strict';

  const LEVEL_BOUNDS = [900, 1800, 3600]; // 0=0 / <15min=1 / <30min=2 / <60min=3 / ≥60min=4
  const MONTH_BOUNDS = [3600 * 5, 3600 * 15, 3600 * 30]; // 月格：<5h=1 / <15h=2 / <30h=3 / ≥30h=4
  function levelOf(seconds) {
    const s = Number(seconds) || 0;
    if (s <= 0) return 0;
    if (s < LEVEL_BOUNDS[0]) return 1;
    if (s < LEVEL_BOUNDS[1]) return 2;
    if (s < LEVEL_BOUNDS[2]) return 3;
    return 4;
  }
  function levelOfMonth(seconds) {
    const s = Number(seconds) || 0;
    if (s <= 0) return 0;
    if (s < MONTH_BOUNDS[0]) return 1;
    if (s < MONTH_BOUNDS[1]) return 2;
    if (s < MONTH_BOUNDS[2]) return 3;
    return 4;
  }
  function secToHours(seconds) { return Math.round((Number(seconds) || 0) / 3600); }
  function secToHours1(seconds) { return Math.round((Number(seconds) || 0) / 3600 * 10) / 10; }
  // 含分钟的可读时长：90m→'1h30m'、45m→'45m'、0→'0m'
  function fmtDur(seconds) {
    const m = Math.round((Number(seconds) || 0) / 60);
    if (m <= 0) return '0m';
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h <= 0) return mm + 'm';
    return mm > 0 ? h + 'h' + mm + 'm' : h + 'h';
  }
  function localDay(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayBefore(key) { const p = String(key).split('-').map(Number); return localDay(new Date(p[0], p[1] - 1, p[2] - 1)); }
  function isNextDay(a, b) { return dayBefore(b) === a; }

  // ①a 年热力（按月）：最近一年 = 截止 (year,month) 的回溯 12 格，缺失月=0
  // 网关 annually 只给自然年按月粒度，故去年月份无数据为 0；全年逐日数据不存在
  // 三种 builder 统一输出 cell：{key,label,seconds,hours,text,level,isCurrent}，热力图与柱状图共用
  function buildMonthHeat(monthBuckets, year, month) {
    const map = monthBuckets || {};
    const now = new Date();
    const ey = Number(year) || now.getFullYear();
    const em = Number(month) || (now.getMonth() + 1);
    const curKey = localDay(now).slice(0, 7);
    const cells = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(ey, em - 1 - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      const seconds = Number(map[key]) || 0;
      cells.push({ key: key, label: String(d.getMonth() + 1), seconds: seconds, hours: secToHours(seconds), text: fmtDur(seconds), level: levelOfMonth(seconds), isCurrent: key === curKey });
    }
    return cells;
  }

  // ①b 月热力（按天）：daily {'YYYY-MM-DD':sec} → 该月每日单元，缺失日=0
  function buildDayHeat(daily, year, month, todayStr) {
    const map = daily || {};
    const y = Number(year) || new Date().getFullYear();
    const mo = Number(month) || (new Date().getMonth() + 1);
    const today = todayStr || localDay(new Date());
    const cells = [];
    const d = new Date(y, mo - 1, 1);
    const end = new Date(y, mo, 0);
    while (d <= end) {
      const key = localDay(d);
      const seconds = Number(map[key]) || 0;
      cells.push({ key: key, label: String(d.getDate()), seconds: seconds, hours: secToHours1(seconds), text: fmtDur(seconds), level: levelOf(seconds), isCurrent: key === today });
      d.setDate(d.getDate() + 1);
    }
    return cells;
  }

  // ①c 本周按天（周一~周日 7 格）；daily 只覆盖本月，跨月周的历史天为 0
  function buildWeekDays(daily, todayStr) {
    const map = daily || {};
    const today = todayStr || localDay(new Date());
    const p = String(today).split('-').map(Number);
    const dow = (new Date(p[0], p[1] - 1, p[2]).getDay() + 6) % 7;   // 周一=0
    const labels = ['一', '二', '三', '四', '五', '六', '日'];
    const cells = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(p[0], p[1] - 1, p[2] - dow + i);
      const key = localDay(d);
      const seconds = Number(map[key]) || 0;
      cells.push({ key: key, label: labels[i], seconds: seconds, hours: secToHours1(seconds), text: fmtDur(seconds), level: levelOf(seconds), isCurrent: key === today });
    }
    return cells;
  }

  // ② 指标卡四槽：随维度取该周期 totals
  const DIM_LABEL = { week: '本周', month: '本月', year: '今年' };
  const DIM_COMPARE = { week: '环比上周', month: '环比上月', year: '环比去年' };
  function normDim(dim) { return (dim === 'week' || dim === 'year') ? dim : 'month'; }
  function buildMetric(totals, dim) {
    const d = normDim(dim);
    const t = (totals || {})[d] || {};
    return {
      dim: d, label: DIM_LABEL[d],
      totalText: fmtDur(t.seconds), dayAvgText: fmtDur(t.dayAvgSeconds),
      compare: typeof t.compare === 'number' ? t.compare : null, compareLabel: DIM_COMPARE[d],
      readDays: t.readDays || 0
    };
  }
  function hasKeys(obj) { return !!obj && Object.keys(obj).length > 0; }

  // ③ 阅读偏好：Agent preferCategory 主；空则退化 shelf allBooks.category×readingTime（best-effort）
  function preferenceFromShelf(shelfVM) {
    const books = (shelfVM && shelfVM.allBooks) || [];
    const agg = {};
    for (const b of books) {
      if (!b.category) continue;
      agg[b.category] = (agg[b.category] || 0) + (Number(b.readingTime) || 0);
    }
    return Object.keys(agg).map(c => ({ category: c, seconds: agg[c] }));
  }
  function buildPreference(preference, shelfVM) {
    let rows = (preference || []).map(p => ({ category: p.category, seconds: Number(p.seconds) || 0 }));
    if (!rows.length && shelfVM) rows = preferenceFromShelf(shelfVM);
    const total = rows.reduce((a, r) => a + r.seconds, 0);
    return rows.filter(r => r.category && r.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds).slice(0, 8)
      .map(r => ({ category: r.category, seconds: r.seconds, percent: total > 0 ? Math.round(r.seconds / total * 100) : 0 }));
  }

  // ④ 读最久 TOP5：Agent readLongest 主；空则退化 shelf allBooks.readingTime 降序
  function buildTopBooks(topBooks, shelfVM) {
    let rows = (topBooks || []).map(t => ({ bookId: t.bookId, title: t.title, cover: t.cover, seconds: Number(t.seconds) || 0 }));
    if (!rows.length && shelfVM) {
      rows = ((shelfVM && shelfVM.allBooks) || [])
        .filter(b => (Number(b.readingTime) || 0) > 0)
        .map(b => ({ bookId: b.bookId, title: b.title, cover: b.cover, seconds: Number(b.readingTime) || 0 }));
    }
    return rows.sort((a, b) => b.seconds - a.seconds).slice(0, 5)
      .map(r => ({ bookId: r.bookId, title: r.title, cover: r.cover, hours: secToHours1(r.seconds) }));
  }

  // ⑥ 连续打卡：seconds>0=打卡；当前连续从 today（未打卡则昨天）往回数
  function buildStreak(daily, readDays, todayStr) {
    const map = daily || {};
    const days = Object.keys(map).filter(k => (Number(map[k]) || 0) > 0).sort();
    let longest = 0, run = 0, prev = null;
    for (const k of days) {
      run = (prev && isNextDay(prev, k)) ? run + 1 : 1;
      if (run > longest) longest = run;
      prev = k;
    }
    const today = todayStr || localDay(new Date());
    let cursor = (Number(map[today]) || 0) > 0 ? today : dayBefore(today);
    let current = 0;
    while ((Number(map[cursor]) || 0) > 0) { current += 1; cursor = dayBefore(cursor); }
    return { current: current, longest: longest, readDays: Number(readDays) || 0 };
  }

  // 勋章去重：网关按年重复下发同名勋章，压成 {title,count}
  function dedupeMedals(medals) {
    const order = [];
    const counts = {};
    for (const m of (medals || [])) {
      const t = ((m && m.title) || '').trim();
      if (!t) continue;
      if (!counts[t]) { counts[t] = 0; order.push(t); }
      counts[t] += 1;
    }
    return order.map(t => ({ title: t, count: counts[t] }));
  }

  // 总装：StatsBundle + 可选 shelfVM + 维度 → 看板视图模型
  // metricByDim/cellsByDim 全量带出，切维度时 withDim 本地派生，不重新请求
  function buildStatsViewModel(bundle, shelfVM, year, dim) {
    const b = bundle || {};
    const y = Number(year) || new Date().getFullYear();
    const now = new Date();
    const curMonth = (y === now.getFullYear()) ? (now.getMonth() + 1) : 1;
    const connected = !!(b.ok && b.source === 'agent');
    const d0 = normDim(dim);
    const cellsByDim = connected ? {
      week: buildWeekDays(hasKeys(b.weekDaily) ? b.weekDaily : b.daily),
      month: buildDayHeat(b.daily, y, curMonth),
      year: buildMonthHeat(b.monthBuckets)
    } : { week: [], month: [], year: [] };
    const metricByDim = {
      week: buildMetric(b.totals, 'week'),
      month: buildMetric(b.totals, 'month'),
      year: buildMetric(b.totals, 'year')
    };
    return {
      connected: connected,
      fetchedAt: b.fetchedAt || null,
      year: y,
      dim: d0,
      metricByDim: metricByDim, metric: metricByDim[d0],
      cellsByDim: cellsByDim, cells: cellsByDim[d0],
      heatMonth: curMonth,
      preference: buildPreference(b.preference, shelfVM),   // 退化仍可用
      topBooks: buildTopBooks(b.topBooks, shelfVM),          // 退化仍可用
      streak: connected ? buildStreak(b.daily, b.readDays) : { current: 0, longest: 0, readDays: 0 },
      medals: dedupeMedals(b.medals)
    };
  }

  // 切维度：浅拷贝换 dim/metric/cells（缓存 vm 也适用）
  function withDim(vm, dim) {
    const d = normDim(dim);
    const v = Object.assign({}, vm || {}, { dim: d });
    if (v.metricByDim) v.metric = v.metricByDim[d];
    if (v.cellsByDim) v.cells = v.cellsByDim[d];
    return v;
  }

  const api = {
    levelOf, levelOfMonth, secToHours, secToHours1, fmtDur, localDay, dayBefore,
    buildMonthHeat, buildDayHeat, buildWeekDays, buildMetric,
    buildPreference, buildTopBooks, buildStreak, dedupeMedals, buildStatsViewModel, withDim
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatsData = api;
})(typeof window !== 'undefined' ? window : globalThis);
