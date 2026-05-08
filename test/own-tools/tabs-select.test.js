const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-select.js");

test("tabs_select has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_select");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.required[0], "index");
});

test("tabs_select returns isError when bridge missing", async () => {
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

// Mock helper: bridge with a fixed list of pages, each with a recordable
// bringToFront() and a fixed url.
function makeFakeBridge(pageUrls) {
  const pages = pageUrls.map((u) => ({
    _bringCalled: 0,
    url() { return u; },
    async bringToFront() { this._bringCalled++; },
  }));
  return { context: { pages: () => pages }, _pages: pages };
}

test("tabs_select: out-of-range index returns isError", async () => {
  const prevBridge = globalThis.__relayBridge;
  globalThis.__relayBridge = makeFakeBridge(["about:blank"]);
  try {
    const result = await tool.handler({ index: 5 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /out of range/);
  } finally {
    globalThis.__relayBridge = prevBridge;
  }
});

test("tabs_select: about:blank target skips upstream propagation", async () => {
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  let upstreamCalled = false;
  globalThis.__relayBridge = makeFakeBridge(["about:blank", "about:blank"]);
  globalThis.__relayUpstream = async () => ({
    request: async () => { upstreamCalled = true; return {}; },
  });
  try {
    const result = await tool.handler({ index: 0 });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.selected, 0);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.strictEqual(upstreamCalled, false);
    // bringToFront still called (Playwright-side focus)
    assert.strictEqual(globalThis.__relayBridge._pages[0]._bringCalled, 1);
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
  }
});

test("tabs_select: real URL triggers upstream navigation_go-to", async () => {
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  let calledWith = null;
  globalThis.__relayBridge = makeFakeBridge([
    "about:blank",
    "file:///c/tmp/test.html",
  ]);
  globalThis.__relayUpstream = async () => ({
    request: async (method, params) => {
      calledWith = { method, params };
      return {};
    },
  });
  try {
    const result = await tool.handler({ index: 1 });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.selected, 1);
    assert.strictEqual(payload.url, "file:///c/tmp/test.html");
    assert.strictEqual(payload.upstreamPropagated, true);
    assert.ok(calledWith, "upstream.request must be invoked");
    assert.strictEqual(calledWith.params.name, "navigation_go-to");
    assert.strictEqual(calledWith.params.arguments.url, "file:///c/tmp/test.html");
    assert.strictEqual(globalThis.__relayBridge._pages[1]._bringCalled, 1);
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
  }
});

test("tabs_select: upstream failure does NOT fail the tool call", async () => {
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  globalThis.__relayBridge = makeFakeBridge(["https://example.com/"]);
  globalThis.__relayUpstream = async () => ({
    request: async () => { throw new Error("upstream blew up"); },
  });
  try {
    const result = await tool.handler({ index: 0 });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.upstreamPropagated, false);
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
  }
});
