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

// ──────────────────────────────────────────────────────────────────
// T1-2: emulate-device dispatches CDP commands in parallel via Promise.all.
// T1-8: setTouchEmulationEnabled sent unconditionally when viewport given.
// T1-9: viewport.{width,height} validated at handler entry.
// ──────────────────────────────────────────────────────────────────

test("T1-2: emulate_device dispatches CDP commands in parallel", async () => {
  const prev = globalThis.__relayBridge;
  // Each cdp.send takes 50ms. Sequential = ≥150ms for 3 commands; parallel ≈ 50ms.
  const fakePage = { once() {} };
  const fakeCdp = {
    send: async () => new Promise((r) => setTimeout(r, 50)),
    detach: async () => {},
  };
  const fakeContext = {
    pages: () => [fakePage],
    newCDPSession: async () => fakeCdp,
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const t0 = Date.now();
    await tool.handler({
      userAgent: "Mozilla/5.0 Test",
      viewport: { width: 1280, height: 720 },
      network: { downloadKbps: 1000 },
    });
    const elapsed = Date.now() - t0;
    // 4 commands (UA + setDeviceMetricsOverride + setTouchEmulationEnabled +
    // emulateNetworkConditions) at 50ms each. Parallel: ~50ms; sequential ≥200ms.
    assert.ok(elapsed < 150,
      `expected parallel dispatch (≤150ms), got ${elapsed}ms — likely reverted to sequential await`);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
    globalThis.__relayBridge = prev;
  }
});

test("T1-8: emulate_device always sends setTouchEmulationEnabled when viewport given", async () => {
  const prev = globalThis.__relayBridge;
  const fakePage = { once() {} };
  const sentCommands = [];
  const fakeCdp = {
    send: async (method, params) => { sentCommands.push({ method, params }); },
    detach: async () => {},
  };
  const fakeContext = {
    pages: () => [fakePage],
    newCDPSession: async () => fakeCdp,
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    // First call: hasTouch=true. Second call: hasTouch=false. Both must send
    // setTouchEmulationEnabled with the corresponding flag.
    await tool.handler({ viewport: { width: 1280, height: 720, hasTouch: true } });
    const firstTouch = sentCommands.filter((c) => c.method === "Emulation.setTouchEmulationEnabled");
    assert.strictEqual(firstTouch.length, 1, "first call must send setTouchEmulationEnabled");
    assert.strictEqual(firstTouch[0].params.enabled, true);

    sentCommands.length = 0;
    await tool.handler({ viewport: { width: 1280, height: 720, hasTouch: false } });
    const secondTouch = sentCommands.filter((c) => c.method === "Emulation.setTouchEmulationEnabled");
    assert.strictEqual(secondTouch.length, 1,
      "second call must send setTouchEmulationEnabled (was: skipped because hasTouch falsy — touch never disabled)");
    assert.strictEqual(secondTouch[0].params.enabled, false);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
    globalThis.__relayBridge = prev;
  }
});

test("T1-9: emulate_device rejects viewport without width/height at entry", async () => {
  const prev = globalThis.__relayBridge;
  const fakePage = { once() {} };
  const fakeCdp = { send: async () => {}, detach: async () => {} };
  const fakeContext = {
    pages: () => [fakePage],
    newCDPSession: async () => fakeCdp,
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const r = await tool.handler({ viewport: { mobile: true } }); // no width/height
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /viewport requires both width and height/);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
    globalThis.__relayBridge = prev;
  }
});
