const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-new.js");

test("tabs_new has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_new");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.type, "object");
});

test("tabs_new returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// Mock helper: a fake bridge with a fake context that records page operations.
function makeFakeBridge() {
  const pages = [];
  const fakePage = {
    _url: "about:blank",
    url() { return this._url; },
    async goto(u) { this._url = u; return null; },
  };
  return {
    context: {
      pages: () => pages,
      newPage: async () => {
        const p = { ...fakePage, _url: "about:blank" };
        pages.push(p);
        return p;
      },
    },
  };
}

test("tabs_new without url: does NOT call upstream propagate", async () => {
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  let upstreamCalled = false;
  globalThis.__relayBridge = makeFakeBridge();
  globalThis.__relayUpstream = async () => ({
    request: async () => { upstreamCalled = true; return {}; },
  });
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.strictEqual(upstreamCalled, false, "upstream must NOT be called when no url");
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
  }
});

test("tabs_new with url: calls upstream navigation_go-to with that url", async () => {
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  let calledWith = null;
  globalThis.__relayBridge = makeFakeBridge();
  globalThis.__relayUpstream = async () => ({
    request: async (method, params) => {
      calledWith = { method, params };
      return {};
    },
  });
  try {
    const result = await tool.handler({ url: "https://example.com/foo" });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.upstreamPropagated, true);
    assert.strictEqual(payload.url, "https://example.com/foo");
    assert.ok(calledWith, "upstream.request must be invoked");
    assert.strictEqual(calledWith.method, "tools/call");
    assert.strictEqual(calledWith.params.name, "navigation_go-to");
    assert.strictEqual(calledWith.params.arguments.url, "https://example.com/foo");
    // Snapshot/screenshot must be disabled to keep the propagation cheap.
    assert.strictEqual(calledWith.params.arguments.includeSnapshot, false);
    assert.strictEqual(calledWith.params.arguments.includeScreenshot, false);
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
  }
});

test("tabs_new: upstream failure does NOT fail the tool call", async () => {
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  globalThis.__relayBridge = makeFakeBridge();
  globalThis.__relayUpstream = async () => ({
    request: async () => { throw new Error("upstream blew up"); },
  });
  try {
    const result = await tool.handler({ url: "https://example.com/" });
    assert.strictEqual(result.isError, undefined, "tool must succeed even if upstream fails");
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.upstreamPropagated, false);
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
  }
});

test("tabs_new: about:blank URL skips upstream propagation", async () => {
  const prevBridge = globalThis.__relayBridge;
  const prevUpstream = globalThis.__relayUpstream;
  let upstreamCalled = false;
  globalThis.__relayBridge = makeFakeBridge();
  globalThis.__relayUpstream = async () => ({
    request: async () => { upstreamCalled = true; return {}; },
  });
  try {
    const result = await tool.handler({ url: "about:blank" });
    assert.strictEqual(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.upstreamPropagated, false);
    assert.strictEqual(upstreamCalled, false);
  } finally {
    globalThis.__relayBridge = prevBridge;
    globalThis.__relayUpstream = prevUpstream;
  }
});
