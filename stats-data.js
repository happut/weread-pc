// stats-data.js — 纯函数：StatsBundle（weread-api 归一化）→ 看板视图模型
(function (root) {
  'use strict';

  const LEVEL_BOUNDS = [900, 1800, 3600]; // 0=0 / <15min=1 / <30min=2 / <60min=3 / ≥60min=4
  function levelOf(seconds) {
    const s = Number(seconds) || 0;
    if (s <= 0) return 0;
    if (s < LEVEL_BOUNDS[0]) return 1;
    if (s < LEVEL_BOUNDS[1]) return 2;
    if (s < LEVEL_BOUNDS[2]) return 3;
    return 4;
  }
  function secToHours(seconds) { return Math.round((Number(seconds) || 0) / 3600); }
  function secToHours1(seconds) { return Math.round((Number(seconds) || 0) / 3600 * 10) / 10; }
  function localDay(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function dayBefore(key) { const p = String(key).split('-').map(Number); return localDay(new Date(p[0], p[1] - 1, p[2] - 1)); }
  function isNextDay(a, b) { return dayBefore(b) === a; }

  // ① 热力图：daily map → 当年每日单元（补齐整年，缺失日 seconds=0）
  function buildHeatmap(daily, year) {
    const map = daily || {};
    const y = Number(year) || new Date().getFullYear();
    const cells = [];
    const d = new Date(y, 0, 1);
    const end = new Date(y, 11, 31);
    while (d <= end) {
      const key = localDay(d);
      const seconds = Number(map[key]) || 0;
      cells.push({ day: key, seconds: seconds, level: levelOf(seconds) });
      d.setDate(d.getDate() + 1);
    }
    return cells;
  }

  // ② 时长汇总
  function buildDurations(totals) {
    const t = totals || {};
    const card = (x) => ({
      hours: secToHours(x && x.seconds),
      dayAvgHours: secToHours1(x && x.dayAvgSeconds),
      compare: x && typeof x.compare === 'number' ? x.compare : null
    });
    return { week: card(t.week), month: card(t.month), year: card(t.year), overall: card(t.overall) };
  }

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

  // 总装：StatsBundle + 可选 shelfVM → 看板视图模型
  function buildStatsViewModel(bundle, shelfVM, year) {
    const b = bundle || {};
    const y = Number(year) || new Date().getFullYear();
    const connected = !!(b.ok && b.source === 'agent');
    return {
      connected: connected,
      fetchedAt: b.fetchedAt || null,
      year: y,
      heatmap: connected ? buildHeatmap(b.daily, y) : [],
      durations: connected ? buildDurations(b.totals) : null,
      preference: buildPreference(b.preference, shelfVM),   // 退化仍可用
      topBooks: buildTopBooks(b.topBooks, shelfVM),          // 退化仍可用
      streak: connected ? buildStreak(b.daily, b.readDays) : { current: 0, longest: 0, readDays: 0 },
      medals: b.medals || []
    };
  }

  const api = {
    levelOf, secToHours, secToHours1, localDay, dayBefore,
    buildHeatmap, buildDurations, buildPreference, buildTopBooks, buildStreak, buildStatsViewModel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.StatsData = api;
})(typeof window !== 'undefined' ? window : globalThis);
