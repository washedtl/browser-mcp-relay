const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-close.js");

test("tabs_close has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_close");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.required[0], "index");
});

test("tabs_close returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ index: 0 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// Helper: minimal bridge with closeable pages.
function makeFakeBridge(pageUrls) {
  const pages = pageUrls.map((u) => ({
    _closeCalled: 0,
    url() { return u; },
    async close() { this._closeCalled++; },
  }));
  return { context: { pages: () => pages }, _pages: pages };
}

// V1-5: negative + non-integer index validation must produce isError, not
// crash with `pages[-1].url is not a function`.
test("V1-5: tabs_close with negative index returns isError (not crash)", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridge(["about:blank", "https://example.com/"]);
  try {
    const result = await tool.handler({ index: -1 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /out of range/i);
    for (const p of globalThis.__relayBridge._pages) {
      assert.strictEqual(p._closeCalled, 0);
    }
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("V1-5: tabs_close with non-integer index returns isError", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridge(["a", "b"]);
  try {
    const result = await tool.handler({ index: "xyz" });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /out of range/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("V1-5: tabs_close with index>=length returns isError (existing behavior preserved)", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridge(["a", "b"]);
  try {
    const result = await tool.handler({ index: 5 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /out of range/i);
    assert.match(result.content[0].text, /have 2 pages/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-8: closing the active page must clear the active-page reference
// so subsequent own-tool calls don't operate on a closed page.
// ──────────────────────────────────────────────────────────────────

test("T0-8: tabs_close on the ACTIVE page clears activePage reference", async () => {
  const prev = globalThis.__relayBridge;
  const { setActivePage, getActivePageRaw, clearActivePage } = require("../../src/own-tools/_active-page.js");
  // Two pages; mark page 1 as active; close page 1 — verify activePage cleared.
  const bridge = makeFakeBridge(["about:blank", "https://target.example.com/"]);
  globalThis.__relayBridge = bridge;
  const targetPage = bridge._pages[1];
  setActivePage(targetPage);
  try {
    assert.strictEqual(getActivePageRaw(), targetPage, "precondition: target is the active page");
    const result = await tool.handler({ index: 1 });
    assert.notStrictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.wasActive, true, "must report wasActive=true");
    assert.strictEqual(getActivePageRaw(), null, "activePage must be cleared after closing the active page");
  } finally {
    globalThis.__relayBridge = prev;
    clearActivePage();
  }
});

test("T0-8: tabs_close on a non-active page leaves activePage untouched", async () => {
  const prev = globalThis.__relayBridge;
  const { setActivePage, getActivePageRaw, clearActivePage } = require("../../src/own-tools/_active-page.js");
  const bridge = makeFakeBridge(["about:blank", "https://target.example.com/"]);
  globalThis.__relayBridge = bridge;
  const activePage = bridge._pages[1];
  setActivePage(activePage);
  try {
    // Close index 0 (NOT the active one).
    const result = await tool.handler({ index: 0 });
    assert.notStrictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.wasActive, false, "must report wasActive=false");
    assert.strictEqual(getActivePageRaw(), activePage, "active page reference must be preserved");
  } finally {
    globalThis.__relayBridge = prev;
    clearActivePage();
  }
});
