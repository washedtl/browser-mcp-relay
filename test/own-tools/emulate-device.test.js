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

// W2D: replaces "bridge missing" / "targets the active page": CDP attaches
// to ctx.page, never to another page of the shared context.
test("W2D: emulate_device attaches CDP to ctx.page, not to the context's other pages", async () => {
  const mine = { once() {} };
  const other = { once() {} };
  let attachedTo = null;
  const context = {
    pages: () => [other, mine],
    newCDPSession: async (page) => { attachedTo = page; return { send: async () => ({}), detach: async () => {} }; },
  };
  try {
    const result = await tool.handler({ userAgent: "test-agent" }, { page: mine, context });
    assert.strictEqual(result.isError, undefined);
    assert.strictEqual(attachedTo, mine);
  } finally {
    PAGE_CDP_SESSIONS.delete(mine);
  }
});

// V0-3: CDP session must NOT be detached after applying overrides — detach
// reverts every Emulation.* override the tool just set.
test("V0-3: emulate_device does NOT detach CDP session after applying overrides", async () => {
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
  const ctx = { page: fakePage, context: fakeContext };
  try {
    const result = await tool.handler({ userAgent: "Mozilla/5.0 Test" }, ctx);
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
  }
});

test("V0-3: emulate_device reuses cached CDP session on second call (no double-attach)", async () => {
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
  const ctx = { page: fakePage, context: fakeContext };
  try {
    await tool.handler({ userAgent: "UA1" }, ctx);
    await tool.handler({ userAgent: "UA2" }, ctx);
    // Single CDP session created across two tool calls — same page, cache hit.
    assert.strictEqual(newSessionCalls, 1, "expected cached session reuse on second call");
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
  }
});

// ──────────────────────────────────────────────────────────────────
// T1-2: emulate-device dispatches CDP commands in parallel via Promise.all.
// T1-8: setTouchEmulationEnabled sent unconditionally when viewport given.
// T1-9: viewport.{width,height} validated at handler entry.
// ──────────────────────────────────────────────────────────────────

test("T1-2: emulate_device dispatches CDP commands in parallel", async () => {
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
  const ctx = { page: fakePage, context: fakeContext };
  try {
    const t0 = Date.now();
    await tool.handler({
      userAgent: "Mozilla/5.0 Test",
      viewport: { width: 1280, height: 720 },
      network: { downloadKbps: 1000 },
    }, ctx);
    const elapsed = Date.now() - t0;
    // 4 commands (UA + setDeviceMetricsOverride + setTouchEmulationEnabled +
    // emulateNetworkConditions) at 50ms each. Parallel: ~50ms; sequential ≥200ms.
    assert.ok(elapsed < 150,
      `expected parallel dispatch (≤150ms), got ${elapsed}ms — likely reverted to sequential await`);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
  }
});

test("T1-8: emulate_device always sends setTouchEmulationEnabled when viewport given", async () => {
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
  const ctx = { page: fakePage, context: fakeContext };
  try {
    // First call: hasTouch=true. Second call: hasTouch=false. Both must send
    // setTouchEmulationEnabled with the corresponding flag.
    await tool.handler({ viewport: { width: 1280, height: 720, hasTouch: true } }, ctx);
    const firstTouch = sentCommands.filter((c) => c.method === "Emulation.setTouchEmulationEnabled");
    assert.strictEqual(firstTouch.length, 1, "first call must send setTouchEmulationEnabled");
    assert.strictEqual(firstTouch[0].params.enabled, true);

    sentCommands.length = 0;
    await tool.handler({ viewport: { width: 1280, height: 720, hasTouch: false } }, ctx);
    const secondTouch = sentCommands.filter((c) => c.method === "Emulation.setTouchEmulationEnabled");
    assert.strictEqual(secondTouch.length, 1,
      "second call must send setTouchEmulationEnabled (was: skipped because hasTouch falsy — touch never disabled)");
    assert.strictEqual(secondTouch[0].params.enabled, false);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
  }
});

test("T1-9: emulate_device rejects viewport without width/height at entry", async () => {
  const fakePage = { once() {} };
  const fakeCdp = { send: async () => {}, detach: async () => {} };
  const fakeContext = {
    pages: () => [fakePage],
    newCDPSession: async () => fakeCdp,
  };
  const ctx = { page: fakePage, context: fakeContext };
  try {
    const r = await tool.handler({ viewport: { mobile: true } }, ctx); // no width/height
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /viewport requires both width and height/);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
  }
});

// ─── Tier 2 (v0.3.5) ───
//
// T2-A: emulate_device passes userAgentMetadata to CDP's
// Network.setUserAgentOverride so HTTP-side Sec-CH-UA-* aligns with the
// JS-side navigator.userAgentData that stealth_apply T1-A synthesizes.

test("T2-A: synthesizeUserAgentMetadata produces correct shape from a Windows Chrome UA", () => {
  const out = tool.synthesizeUserAgentMetadata(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
  );
  assert.strictEqual(out.platform, "Windows");
  assert.strictEqual(out.platformVersion, "15.0.0");
  assert.strictEqual(out.architecture, "x86");
  assert.strictEqual(out.bitness, "64");
  assert.strictEqual(out.mobile, false);
  assert.strictEqual(out.wow64, false);
  assert.strictEqual(out.model, "");
  assert.ok(Array.isArray(out.brands));
  assert.ok(out.brands.some((b) => b.brand === "Chromium"),
    "brands must include Chromium");
  assert.ok(out.brands.some((b) => b.brand === "Not?A_Brand"),
    "brands must include the Not?A_Brand randomization slot");
  assert.ok(Array.isArray(out.fullVersionList));
  assert.ok(out.fullVersionList[0].version.startsWith("127."),
    "fullVersionList must reflect the Chrome major version");
});

test("T2-A: synthesizeUserAgentMetadata branches on platform from UA", () => {
  // macOS UA → platform: macOS
  const mac = tool.synthesizeUserAgentMetadata(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
  );
  assert.strictEqual(mac.platform, "macOS");
  // Linux UA → platform: Linux
  const linux = tool.synthesizeUserAgentMetadata(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
  );
  assert.strictEqual(linux.platform, "Linux");
  // Android UA → platform: Android, mobile: true
  const android = tool.synthesizeUserAgentMetadata(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  );
  assert.strictEqual(android.platform, "Android");
  assert.strictEqual(android.mobile, true);
  // iPhone UA → platform: iOS, mobile: true
  const ios = tool.synthesizeUserAgentMetadata(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile/15E148 Safari/604.1"
  );
  assert.strictEqual(ios.platform, "iOS");
  assert.strictEqual(ios.mobile, true);
});

test("T2-A: emulate_device's handler passes userAgentMetadata to setUserAgentOverride", async () => {
  const sentCommands = [];
  const fakePage = { once() {} };
  const fakeCdp = {
    send: async (method, params) => { sentCommands.push({ method, params }); },
    detach: async () => {},
  };
  const fakeContext = { pages: () => [fakePage], newCDPSession: async () => fakeCdp };
  const ctx = { page: fakePage, context: fakeContext };
  try {
    const TEST_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/127.0.0.0 Safari/537.36";
    const r = await tool.handler({ userAgent: TEST_UA }, ctx);
    assert.strictEqual(r.isError, undefined, "handler must not error");
    const setUA = sentCommands.find((c) => c.method === "Network.setUserAgentOverride");
    assert.ok(setUA, "must send Network.setUserAgentOverride");
    assert.strictEqual(setUA.params.userAgent, TEST_UA);
    // T2-A invariant: userAgentMetadata MUST be passed (without it, the
    // HTTP-side Sec-CH-UA-* headers fall back to chromium's internal UA
    // config and disagree with the override).
    assert.ok(setUA.params.userAgentMetadata,
      "T2-A: setUserAgentOverride must include userAgentMetadata");
    assert.strictEqual(setUA.params.userAgentMetadata.platform, "Windows");
    assert.ok(setUA.params.userAgentMetadata.brands.length >= 2);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
  }
});

// ─── W1D (2026-11-03) ───

test("W1D-3: emulate_device uses the shared client-hints generator (same values stealth_apply exposes to JS)", () => {
  const { clientHintsFromUA } = require("../../src/own-tools/_client-hints.js");
  assert.strictEqual(tool.synthesizeUserAgentMetadata, clientHintsFromUA);
});

test("W1D-3: Mac + Android metadata follow Chromium's rules (arch/bitness/platformVersion)", () => {
  const mac = tool.synthesizeUserAgentMetadata(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"
  );
  // Was architecture "arm" + bitness "32" (no Mac is 32-bit) and "10.15.0".
  assert.deepStrictEqual([mac.architecture, mac.bitness, mac.platformVersion], ["arm", "64", "14.0.0"]);
  const android = tool.synthesizeUserAgentMetadata(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36"
  );
  // Chromium sends no arch/bitness on Android; was "arm" / "32" / "15.0.0".
  assert.deepStrictEqual([android.architecture, android.bitness, android.platformVersion, android.model], ["", "", "14.0.0", "Pixel 8"]);
});

test("W1D-4: description no longer claims overrides end on navigation, and documents reset", () => {
  assert.doesNotMatch(tool.description, /until the page navigates/i);
  assert.match(tool.description, /navigation/i);
  assert.match(tool.description, /reset/);
  assert.strictEqual(tool.inputSchema.properties.reset.type, "boolean");
});

test("W1D-4: reset:true clears UA, device metrics, touch and network overrides on the active page", async () => {
  const sentCommands = [];
  const fakePage = { once() {} };
  const fakeCdp = { send: async (method, params) => { sentCommands.push({ method, params }); }, detach: async () => {} };
  const ctx = { page: fakePage, context: { pages: () => [fakePage], newCDPSession: async () => fakeCdp } };
  try {
    const r = await tool.handler({ reset: true }, ctx);
    assert.strictEqual(r.isError, undefined);
    const byMethod = Object.fromEntries(sentCommands.map((c) => [c.method, c.params]));
    // Empty UA string = "no override" in CDP; no metadata may accompany it.
    assert.deepStrictEqual(byMethod["Network.setUserAgentOverride"], { userAgent: "" });
    assert.ok("Emulation.clearDeviceMetricsOverride" in byMethod, "must clear device metrics");
    assert.deepStrictEqual(byMethod["Emulation.setTouchEmulationEnabled"], { enabled: false });
    assert.deepStrictEqual(byMethod["Network.emulateNetworkConditions"],
      { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    assert.strictEqual(sentCommands.length, 4);
    const body = JSON.parse(r.content[0].text);
    assert.deepStrictEqual(body.reset.sort(), ["network", "touch", "userAgent", "viewport"]);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
  }
});

test("W1D-4: reset:true combined with an override is rejected before any CDP command", async () => {
  const sentCommands = [];
  const fakePage = { once() {} };
  const fakeCdp = { send: async (method) => { sentCommands.push(method); }, detach: async () => {} };
  const ctx = { page: fakePage, context: { pages: () => [fakePage], newCDPSession: async () => fakeCdp } };
  try {
    for (const extra of [{ userAgent: "UA" }, { viewport: { width: 400, height: 800 } }, { network: { offline: true } }]) {
      const r = await tool.handler({ reset: true, ...extra }, ctx);
      assert.strictEqual(r.isError, true, JSON.stringify(extra));
      assert.match(r.content[0].text, /reset/);
    }
    assert.deepStrictEqual(sentCommands, []);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
  }
});

test("W1D-4: a failed reset command is reported, not swallowed", async () => {
  const fakePage = { once() {} };
  const fakeCdp = {
    send: async (method) => { if (method === "Emulation.clearDeviceMetricsOverride") throw new Error("boom"); },
    detach: async () => {},
  };
  const ctx = { page: fakePage, context: { pages: () => [fakePage], newCDPSession: async () => fakeCdp } };
  try {
    const r = await tool.handler({ reset: true }, ctx);
    assert.strictEqual(r.isError, true);
    assert.deepStrictEqual(JSON.parse(r.content[0].text).failed, [{ name: "viewport", error: "boom" }]);
  } finally {
    PAGE_CDP_SESSIONS.delete(fakePage);
  }
});
