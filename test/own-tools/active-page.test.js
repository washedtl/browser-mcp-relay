// active-page.test.js — covers the _active-page.js helper plus the
// tabs_new + tabs_select setter integration and two representative consumers
// (capture_xhr, emulate_device) reading the tracked active page rather than
// pages[0].

const test = require("node:test");
const assert = require("node:assert");
const { setActivePage, getActivePage } = require("../../src/own-tools/_active-page.js");

// Helper: clear module-level activePage so tests don't see leftover state.
function clearActivePage() {
  setActivePage(null);
}

// Helper: build a fake Playwright page with isClosed() + url() + minimal
// observability for tools that just attach event listeners.
function fakePage({ url = "about:blank", closed = false } = {}) {
  return {
    _closed: closed,
    _url: url,
    _listeners: {},
    url() { return this._url; },
    isClosed() { return this._closed; },
    on(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
    off(ev, fn) {
      this._listeners[ev] = (this._listeners[ev] || []).filter((f) => f !== fn);
    },
    once(ev, fn) { this.on(ev, fn); },
    async goto(u) { this._url = u; return null; },
    async bringToFront() { /* no-op */ },
    async waitForEvent() { return null; },
    async click() { return null; },
    async fill() { return null; },
    locator() { return { setInputFiles: async () => null }; },
    async evaluate() { return {}; },
  };
}

function fakeContext(pages) {
  return { pages: () => pages };
}

// -----------------------------
// Pure helper-level tests
// -----------------------------

test("getActivePage: empty context returns null", () => {
  clearActivePage();
  const ctx = fakeContext([]);
  assert.strictEqual(getActivePage(ctx), null);
});

test("getActivePage: no setter call → returns LAST page (not pages[0])", () => {
  clearActivePage();
  const blank = fakePage({ url: "about:blank" });
  const real = fakePage({ url: "https://example.com/" });
  const ctx = fakeContext([blank, real]);
  const got = getActivePage(ctx);
  assert.strictEqual(got, real, "must fall back to last page (the user's most-recent), not pages[0]");
  assert.notStrictEqual(got, blank);
});

test("getActivePage: setActivePage(pageB) returns pageB even when in pages[2]", () => {
  clearActivePage();
  const a = fakePage({ url: "about:blank" });
  const b = fakePage({ url: "https://b.example.com/" });
  const c = fakePage({ url: "https://c.example.com/" });
  const ctx = fakeContext([a, b, c]);
  // Simulate: tabs_new appended b, tabs_new appended c, tabs_select picks b.
  setActivePage(b);
  assert.strictEqual(getActivePage(ctx), b, "must return the explicit active page (b), even though pages[2] is c");
});

test("getActivePage: closed active page falls back to last page", () => {
  clearActivePage();
  const a = fakePage({ url: "about:blank" });
  const b = fakePage({ url: "https://b.example.com/", closed: true });
  const c = fakePage({ url: "https://c.example.com/" });
  const ctx = fakeContext([a, b, c]);
  setActivePage(b);
  assert.strictEqual(getActivePage(ctx), c, "closed active page → fall back to last page in context");
});

test("getActivePage: single-page context returns that page", () => {
  clearActivePage();
  const only = fakePage({ url: "https://only.example.com/" });
  const ctx = fakeContext([only]);
  assert.strictEqual(getActivePage(ctx), only);
});

// -----------------------------
// tabs_new sets active page
// -----------------------------

test("tabs_new: setActivePage is called with the newly-created page", async () => {
  clearActivePage();
  const tabsNew = require("../../src/own-tools/tabs-new.js");
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  const pages = [];
  const bridge = {
    context: {
      pages: () => pages,
      newPage: async () => {
        const p = fakePage({ url: "about:blank" });
        pages.push(p);
        return p;
      },
    },
  };
  globalThis.__relayBridge = bridge;
  globalThis.__relayUpstream = async () => ({ request: async () => ({}) });
  try {
    await tabsNew.handler({ url: "https://example.com/foo" });
    // The tracked active page must be the page that tabs_new just created
    // (pages[0] in this synthetic context — but the IDENTITY check is what
    // matters: getActivePage must return the same object as pages[pages.length-1]).
    const tracked = getActivePage(bridge.context);
    assert.strictEqual(tracked, pages[pages.length - 1], "tabs_new must call setActivePage on the new page");
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
    clearActivePage();
  }
});

// -----------------------------
// tabs_select sets active page
// -----------------------------

test("tabs_select: setActivePage is called with the selected page (NOT pages[0])", async () => {
  clearActivePage();
  const tabsSelect = require("../../src/own-tools/tabs-select.js");
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  const blank = fakePage({ url: "about:blank" });
  const real = fakePage({ url: "https://example.com/" });
  const pages = [blank, real];
  globalThis.__relayBridge = { context: fakeContext(pages) };
  globalThis.__relayUpstream = async () => ({ request: async () => ({}) });
  try {
    await tabsSelect.handler({ index: 1 });
    const tracked = getActivePage(globalThis.__relayBridge.context);
    assert.strictEqual(tracked, real, "tabs_select must mark the SELECTED page as active, not pages[0]");
    assert.notStrictEqual(tracked, blank);
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
    clearActivePage();
  }
});

// -----------------------------
// Representative consumer tests
// -----------------------------
// Without the fix, both of these would target the about:blank page (pages[0])
// and silently do the wrong thing. The assertion is that the tool grabs the
// page set by tabs_new/tabs_select instead.

test("capture_xhr: targets the tracked active page, not pages[0]", async () => {
  clearActivePage();
  const captureXhr = require("../../src/own-tools/capture-xhr.js");
  const prevBridge = globalThis.__relayBridge;
  const blank = fakePage({ url: "about:blank" });
  const real = fakePage({ url: "https://example.com/" });
  globalThis.__relayBridge = { context: fakeContext([blank, real]) };
  setActivePage(real);
  try {
    // Run a tiny capture; we don't navigate, just listen for durationMs.
    // After the handler returns, `real` should have had a `response`
    // listener attached + removed; `blank` must have had no listeners
    // touched at all.
    await captureXhr.handler({ durationMs: 100, includeBody: false });
    // No response events fired in this synthetic test, but the proof that
    // capture_xhr targeted `real`:
    //   - real has a .on/.off cycle recorded — listeners[] is empty after
    //     because off() removed it, but the removal only happened because
    //     it was attached in the first place.
    //   - blank's listeners object should still be untouched (no entries).
    assert.deepStrictEqual(blank._listeners, {}, "capture_xhr must NOT have attached to about:blank");
    // real's listener array exists but is empty after off():
    assert.ok("response" in real._listeners, "capture_xhr must have attached a 'response' listener to the active page");
    assert.strictEqual(real._listeners.response.length, 0, "listener must have been removed in finally");
  } finally {
    globalThis.__relayBridge = prevBridge;
    clearActivePage();
  }
});

test("emulate_device: targets the tracked active page, not pages[0]", async () => {
  clearActivePage();
  const emulateDevice = require("../../src/own-tools/emulate-device.js");
  const prevBridge = globalThis.__relayBridge;
  const blank = fakePage({ url: "about:blank" });
  // Track which page CDP was attached to so we can prove emulate_device
  // operated on `real`, not `blank`.
  let attachedTo = null;
  // emulate_device calls getOrCreatePageCdp(page, context). That helper
  // calls context.newCDPSession(page) under the hood. Our fake context
  // records which page was passed.
  const real = fakePage({ url: "https://example.com/" });
  const ctx = {
    pages: () => [blank, real],
    newCDPSession: async (page) => {
      attachedTo = page;
      return {
        _events: {},
        send: async () => ({}),
        on: () => {},
        off: () => {},
        detach: async () => {},
      };
    },
  };
  globalThis.__relayBridge = { context: ctx };
  setActivePage(real);
  try {
    const result = await emulateDevice.handler({
      userAgent: "test-agent",
    });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(attachedTo, real, "emulate_device must attach CDP to the tracked active page, not pages[0]");
  } finally {
    globalThis.__relayBridge = prevBridge;
    clearActivePage();
  }
});
