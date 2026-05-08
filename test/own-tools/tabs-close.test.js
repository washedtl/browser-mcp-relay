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
