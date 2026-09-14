const test = require('node:test');
const assert = require('node:assert');
// shelf-fetch 依赖 ShelfData（浏览器里是 window.ShelfData）；node 下手动注入
const ShelfData = require('../shelf-data.js');
globalThis.ShelfData = ShelfData;
const { loadShelf } = require('../shelf-fetch.js');
const raw = require('./fixtures/shelf-sample.json');

function stubWebview(payloadText, { reject = false } = {}) {
  return {
    executeJavaScript: async () => {
      if (reject) throw new Error('net down');
      return payloadText;
    }
  };
}

function stubApi(cache) {
  const store = { written: null };
  return {
    store,
    readShelfCache: async () => cache,
    writeShelfCache: async (vm) => { store.written = vm; return true; }
  };
}

test('loadShelf: 取到新数据 → fresh 有值并写缓存', async () => {
  const wv = stubWebview(JSON.stringify(raw));
  const api = stubApi(null);
  const r = await loadShelf(wv, api);
  assert.ok(r.fresh);
  assert.strictEqual(r.fresh.stats.reading, 1);
  assert.strictEqual(r.err, null);
  assert.ok(api.store.written); // 已写缓存
});

test('loadShelf: 取数失败但有缓存 → 返回 cached + err', async () => {
  const cachedVm = ShelfData.buildViewModel(raw);
  const wv = stubWebview(null, { reject: true });
  const api = stubApi(cachedVm);
  const r = await loadShelf(wv, api);
  assert.strictEqual(r.fresh, null);
  assert.ok(r.cached);
  assert.ok(r.err);
});

test('loadShelf: 载荷非法（无 books）→ 抛错视为失败', async () => {
  const wv = stubWebview(JSON.stringify({ foo: 1 }));
  const api = stubApi(null);
  const r = await loadShelf(wv, api);
  assert.strictEqual(r.fresh, null);
  assert.ok(r.err);
});
