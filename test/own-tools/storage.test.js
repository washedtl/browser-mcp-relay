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
