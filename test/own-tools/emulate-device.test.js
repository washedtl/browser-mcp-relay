const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/emulate-device.js");
const { PAGE_CDP_SESSIONS } = require("../../src/own-tools/_page-cdp-session.js");

test("emulate_device has required tool shape", () => {
  assert.strictEqual(tool.name, "emulate_device");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.type, "object");
  assert.ok(tool.inputSchema.properties.viewport);
  assert.ok(tool.inputSchema.properties.network);
});

test("emulate_device returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ userAgent: "test" });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// V0-3: CDP session must NOT be detached after applying overrides — detach
// reverts every Emulation.* override the tool just set.
test("V0-3: emulate_device does NOT detach CDP session after applying overrides", async () => {
  const prev = globalThis.__relayBridge;
  let detachCalls = 0;
  let sentCommands = [];
  const fakePage = {
    _closeListeners: [],
    once(event, fn) { if (event === "close") this._closeListeners.push(fn); },
  };
  const fakeCdp = {
    send: async (method, params) => { sentCommands.push({ method, params }); },
    detach: async () => { detachCalls++; },
  };
  const fakeContext = {
    pages: () => [fakePage],
    newCDPSession: async () => fakeCdp,
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const result = await tool.handler({ userAgent: "Mozilla/5.0 Test" });
    assert.strictEqual(result.isError, undefined);
    // Override was sent to CDP.
    assert.ok(sentCommands.some((c) => c.method === "Network.setUserAgentOverride"),
      "expected setUserAgentOverride to be sent");
    // Critical assertion: CDP session was NOT detached. If detached, the
    // override reverts and the tool silently does nothing.
    assert.strictEqual(detachCalls, 0, "CDP session must NOT be detached inline");
  } finally {
    // Cleanup the WeakMap entry so it doesn't leak between tests.
    PAGE_CDP_SESSIONS.delete(fakePage);
    globalThis.__relayBridge = prev;
  }
});

test("V0-3: emulate_device reuses cached CDP session on second call (no double-attach)", async () => {
  const prev = globalThis.__relayBridge;
  let newSessionCalls = 0;
  const fakePage = {
    once(/* event, fn */) {},
  };
  const fakeCdp = {
    send: async () => {},
    detach: async () => {},
  };
  const fakeContext = {
    pages: () => [fakePage],
    newCDPSession: async () => { newSessionCalls++; return fakeCdp; },
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    await tool.handler({ userAgent: "UA1" });
    await tool.handler({ userAgent: "UA2" });
    // Single CDP session created across two tool calls — same page, cache hit.
    assert.strictEqual(newSessionCalls, 1, "expected cached session reuse on second call");
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
    globalThis.__relayBridge = prev;
  }
});
