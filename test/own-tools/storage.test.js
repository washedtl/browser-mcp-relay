// Tests for the 3 storage_* own-tools added 2026-05-09.
// Auth tokens for Discord/Notion/Slack/Linear/Mercury live in localStorage,
// so this is the storage-side complement to cookies_export.

const test = require("node:test");
const assert = require("node:assert");

const getTool = require("../../src/own-tools/storage-get-local.js");
const setTool = require("../../src/own-tools/storage-set-local.js");
const clearTool = require("../../src/own-tools/storage-clear-local.js");

// Fake page with an in-memory storage implementation so we don't need a real
// browser. Mirrors the localStorage / sessionStorage surface the tools use.
function makeFakePage(initialLocal = {}, initialSession = {}, opts = {}) {
  function makeStorage(seed) {
    const map = new Map(Object.entries(seed));
    return {
      get length() { return map.size; },
      key(i) { return Array.from(map.keys())[i] ?? null; },
      getItem(k) { const v = map.get(k); return v === undefined ? null : v; },
      setItem(k, v) { map.set(k, String(v)); },
      removeItem(k) { map.delete(k); },
      clear() { map.clear(); },
      _map: map,
    };
  }
  const localStorage = makeStorage(initialLocal);
  const sessionStorage = makeStorage(initialSession);
  return {
    url: () => opts.url || "https://example.com/path",
    isClosed: () => false,
    evaluate: async (fn, arg) => {
      // Run the tool's evaluate body in this fake realm with our storage globals.
      // Use a Proxy whose `has` returns true ONLY for the names the tool's
      // evaluate body actually looks up as globals. Returning true for every
      // identifier (including local `arg`) makes `with (__g)` intercept locals,
      // which would resolve `arg` to undefined and break destructuring.
      const globalNames = new Set(["localStorage", "sessionStorage", "URL"]);
      const globalRef = { localStorage, sessionStorage, URL };
      const proxy = new Proxy(globalRef, {
        has: (_target, prop) => globalNames.has(prop),
        get: (target, prop) => target[prop],
      });
      // eslint-disable-next-line no-new-func
      const wrapped = new Function("__g", "fn", "arg",
        "with (__g) { return (" + fn.toString() + ")(arg); }");
      return wrapped(proxy, fn, arg);
    },
    _localStorage: localStorage,
    _sessionStorage: sessionStorage,
  };
}

function withFakePage(page) {
  globalThis.__relayBridge = { context: { pages: () => [page] } };
}
function clearBridge() {
  globalThis.__relayBridge = undefined;
}

// ──────────────────────────────────────────────────────────────────
// storage_get-local
// ──────────────────────────────────────────────────────────────────

test("storage_get-local has required tool shape", () => {
  assert.strictEqual(getTool.name, "storage_get-local");
  assert.strictEqual(typeof getTool.handler, "function");
  assert.deepStrictEqual(getTool.inputSchema.properties.store.enum, ["local", "session"]);
});

test("storage_get-local: dump all keys when key omitted", async () => {
  const prev = globalThis.__relayBridge;
  withFakePage(makeFakePage({ token: "abc", uid: "42" }));
  try {
    const r = await getTool.handler({});
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.count, 2);
    assert.strictEqual(payload.entries.token, "abc");
    assert.strictEqual(payload.entries.uid, "42");
    assert.strictEqual(payload.origin, "https://example.com");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_get-local: single-key fetch", async () => {
  const prev = globalThis.__relayBridge;
  withFakePage(makeFakePage({ token: "abc", uid: "42" }));
  try {
    const r = await getTool.handler({ key: "token" });
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.count, 1);
    assert.deepStrictEqual(payload.entries, { token: "abc" });
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_get-local: missing single key returns count=0", async () => {
  const prev = globalThis.__relayBridge;
  withFakePage(makeFakePage({ token: "abc" }));
  try {
    const r = await getTool.handler({ key: "no-such-key" });
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.count, 0);
    assert.deepStrictEqual(payload.entries, {});
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_get-local: store='session' targets sessionStorage", async () => {
  const prev = globalThis.__relayBridge;
  withFakePage(makeFakePage({ x: "local-only" }, { y: "session-only" }));
  try {
    const r = await getTool.handler({ store: "session" });
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.store, "session");
    assert.strictEqual(payload.entries.y, "session-only");
    assert.strictEqual(payload.entries.x, undefined, "must NOT see localStorage keys");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_get-local: invalid store returns isError", async () => {
  const prev = globalThis.__relayBridge;
  withFakePage(makeFakePage());
  try {
    const r = await getTool.handler({ store: "weird" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /must be 'local' or 'session'/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_get-local: returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  clearBridge();
  try {
    const r = await getTool.handler({});
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// storage_set-local
// ──────────────────────────────────────────────────────────────────

test("storage_set-local has required tool shape", () => {
  assert.strictEqual(setTool.name, "storage_set-local");
  assert.deepStrictEqual(setTool.inputSchema.required, ["entries"]);
});

test("storage_set-local: writes entries into localStorage", async () => {
  const prev = globalThis.__relayBridge;
  const page = makeFakePage();
  withFakePage(page);
  try {
    const r = await setTool.handler({ entries: { token: "xyz", uid: "99" } });
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.written, 2);
    assert.strictEqual(payload.totalAfter, 2);
    assert.strictEqual(page._localStorage.getItem("token"), "xyz");
    assert.strictEqual(page._localStorage.getItem("uid"), "99");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_set-local: clearFirst=true wipes existing keys before write", async () => {
  const prev = globalThis.__relayBridge;
  const page = makeFakePage({ stale: "old" });
  withFakePage(page);
  try {
    const r = await setTool.handler({
      entries: { fresh: "new" },
      clearFirst: true,
    });
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.totalAfter, 1, "stale key must be wiped before fresh key written");
    assert.strictEqual(page._localStorage.getItem("stale"), null);
    assert.strictEqual(page._localStorage.getItem("fresh"), "new");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_set-local: rejects non-string values upfront (browser would coerce)", async () => {
  const prev = globalThis.__relayBridge;
  withFakePage(makeFakePage());
  try {
    const r = await setTool.handler({ entries: { count: 42 } });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /must be a string/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_set-local: rejects entries=null", async () => {
  const prev = globalThis.__relayBridge;
  withFakePage(makeFakePage());
  try {
    const r = await setTool.handler({ entries: null });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /entries must be an object/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// storage_clear-local
// ──────────────────────────────────────────────────────────────────

test("storage_clear-local has required tool shape", () => {
  assert.strictEqual(clearTool.name, "storage_clear-local");
});

test("storage_clear-local: clears entire store when keys omitted", async () => {
  const prev = globalThis.__relayBridge;
  const page = makeFakePage({ a: "1", b: "2", c: "3" });
  withFakePage(page);
  try {
    const r = await clearTool.handler({});
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.mode, "all");
    assert.strictEqual(payload.removed, 3);
    assert.strictEqual(payload.totalAfter, 0);
    assert.strictEqual(page._localStorage.length, 0);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_clear-local: removes only specified keys when keys provided", async () => {
  const prev = globalThis.__relayBridge;
  const page = makeFakePage({ keep: "1", drop1: "2", drop2: "3" });
  withFakePage(page);
  try {
    const r = await clearTool.handler({ keys: ["drop1", "drop2", "no-such-key"] });
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.mode, "selective");
    assert.strictEqual(payload.removed, 2, "missing keys are not counted");
    assert.strictEqual(payload.totalAfter, 1);
    assert.strictEqual(page._localStorage.getItem("keep"), "1");
    assert.strictEqual(page._localStorage.getItem("drop1"), null);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("storage_clear-local: rejects keys=non-array", async () => {
  const prev = globalThis.__relayBridge;
  withFakePage(makeFakePage());
  try {
    const r = await clearTool.handler({ keys: "not-an-array" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /keys must be an array/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// W1C1 (2026-11-03): keyFilter + maxBytes on get, null-as-missing,
// shared store/origin helper, compact JSON.
// ──────────────────────────────────────────────────────────────────

async function onPage(page, fn) {
  const prev = globalThis.__relayBridge;
  withFakePage(page);
  try { return await fn(); } finally { globalThis.__relayBridge = prev; }
}
const parse = (r) => JSON.parse(r.content[0].text);

test("W1C1: storage_get-local keyFilter narrows a dump by regex on key names", async () => {
  await onPage(makeFakePage({ auth_token: "t", refresh_token: "r", theme: "dark" }), async () => {
    const p = parse(await getTool.handler({ keyFilter: "token$" }));
    assert.deepStrictEqual(Object.keys(p.entries).sort(), ["auth_token", "refresh_token"]);
    assert.strictEqual(p.count, 2);
  });
});

test("W1C1: storage_get-local rejects an invalid keyFilter regex", async () => {
  await onPage(makeFakePage({ a: "1" }), async () => {
    const r = await getTool.handler({ keyFilter: "(" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /keyFilter/);
    const notString = await getTool.handler({ keyFilter: 5 });
    assert.strictEqual(notString.isError, true, "a non-string keyFilter must not silently dump everything");
    assert.match(notString.content[0].text, /keyFilter/);
  });
});

test("W1C1: storage_get-local maxBytes omits values that don't fit and lists their keys", async () => {
  const seed = { uid: "42", cache: "c".repeat(200_000), token: "abc" };
  await onPage(makeFakePage(seed), async () => {
    const r = await getTool.handler({});
    assert.ok(r.content[0].text.length < 60_000, `default cap ~50KB (got ${r.content[0].text.length})`);
    const p = parse(r);
    assert.deepStrictEqual(p.entries, { uid: "42", token: "abc" }, "small values after a huge one are still returned");
    assert.deepStrictEqual(p.omittedKeys, ["cache"]);
    assert.strictEqual(p.omittedCount, 1);
    const big = parse(await getTool.handler({ key: "cache", maxBytes: 300_000 }));
    assert.strictEqual(big.entries.cache.length, 200_000, "raising maxBytes returns the value");
  });
});

test("W1C1: storage_get-local omittedKeys is capped at 100 names (omittedCount has the total)", async () => {
  const seed = {};
  for (let i = 0; i < 300; i++) seed[`k${i}`] = "v".repeat(1000);
  await onPage(makeFakePage(seed), async () => {
    const p = parse(await getTool.handler({ maxBytes: 2048 }));
    assert.strictEqual(p.count + p.omittedCount, 300);
    assert.strictEqual(p.omittedKeys.length, 100);
  });
});

test("W1C1: storage_get-local validates maxBytes", async () => {
  await onPage(makeFakePage(), async () => {
    for (const bad of [10, "big", 1.5]) {
      const r = await getTool.handler({ maxBytes: bad });
      assert.strictEqual(r.isError, true, JSON.stringify(bad));
      assert.match(r.content[0].text, /maxBytes/);
    }
  });
});

test("W1C1: storage_* treat store: null as the default 'local' (null-as-missing)", async () => {
  const page = makeFakePage({ a: "1" });
  await onPage(page, async () => {
    const g = await getTool.handler({ store: null, key: null, keyFilter: null, maxBytes: null });
    assert.ok(!g.isError, g.content[0].text);
    assert.strictEqual(parse(g).store, "local");
    assert.strictEqual(parse(g).entries.a, "1");
    const s = await setTool.handler({ store: null, entries: { b: "2" }, clearFirst: null });
    assert.ok(!s.isError, s.content[0].text);
    assert.strictEqual(parse(s).store, "local");
    assert.strictEqual(parse(s).clearedFirst, false);
    assert.strictEqual(page._localStorage.getItem("a"), "1", "clearFirst: null must not clear");
  });
});

test("W1C1: storage_clear-local keys: null is an ERROR — a destructive tool never reads null as 'everything'", async () => {
  const page = makeFakePage({ a: "1", b: "2" });
  await onPage(page, async () => {
    const r = await clearTool.handler({ store: null, keys: null });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /keys must be an array/);
    assert.strictEqual(page._localStorage.length, 2, "nothing may be cleared");
    const omitted = await clearTool.handler({ store: null });
    assert.ok(!omitted.isError, omitted.content[0].text);
    assert.strictEqual(parse(omitted).mode, "all", "omitting keys still clears the whole store");
    assert.strictEqual(page._localStorage.length, 0);
  });
});

test("W1C1: storage_get-local rejects a non-string key instead of dumping the store", async () => {
  await onPage(makeFakePage({ a: "1", b: "2" }), async () => {
    const r = await getTool.handler({ key: 123 });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /key/);
  });
});

test("W1C1: storage_get-local maxBytes counts JSON-escaped size", async () => {
  await onPage(makeFakePage({ quotes: '"'.repeat(30_000), small: "s" }), async () => {
    const r = await getTool.handler({});
    assert.ok(r.content[0].text.length <= 50_000 + 200, `escaped dump must respect maxBytes (got ${r.content[0].text.length})`);
    assert.deepStrictEqual(parse(r).omittedKeys, ["quotes"]);
  });
});

test("W1C1: storage_* report an empty origin for opaque-origin pages (file:, data:, chrome:)", async () => {
  for (const url of ["file:///C:/tmp/page.html", "chrome://settings", "data:text/html,hi"]) {
    await onPage(makeFakePage({ a: "1" }, {}, { url }), async () => {
      assert.strictEqual(parse(await getTool.handler({})).origin, "", url);
    });
  }
});

test("W1C1: storage_* return compact JSON and an empty origin on about: pages", async () => {
  await onPage(makeFakePage({ a: "1" }, {}, { url: "about:blank" }), async () => {
    for (const r of [
      await getTool.handler({}),
      await setTool.handler({ entries: { b: "2" } }),
      await clearTool.handler({ keys: ["b"] }),
    ]) {
      assert.ok(!r.isError, r.content[0].text);
      assert.ok(!r.content[0].text.includes("\n"), "inline JSON must be compact");
      assert.strictEqual(parse(r).origin, "");
    }
  });
});

test("W1C1: storage_* invalid store error comes from the shared helper (same text in all three)", async () => {
  await onPage(makeFakePage(), async () => {
    const texts = [
      (await getTool.handler({ store: "weird" })).content[0].text,
      (await setTool.handler({ store: "weird", entries: {} })).content[0].text,
      (await clearTool.handler({ store: "weird" })).content[0].text,
    ];
    for (const t of texts) assert.match(t, /store must be 'local' or 'session' \(got "weird"\)/);
  });
});
