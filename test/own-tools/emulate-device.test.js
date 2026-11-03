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
    newCDPSession: async (page) => { attachedTo = page; return { send: async () => ({}), detach: async () => {}, on() {} }; },
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
    on() {},
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
    on() {},
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
    on() {},
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
    on() {},
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
  // STEALTH2-1: Chromium's GREASE brand for major 127 (was a fixed "Not?A_Brand"/24).
  assert.ok(out.brands.some((b) => b.brand === "Not)A;Brand" && b.version === "99"),
    "brands must include Chromium's GREASE slot for 127");
  assert.ok(out.brands.some((b) => b.brand === "Google Chrome" && b.version === "127"),
    "a Chrome UA carries the Google Chrome brand");
  assert.ok(Array.isArray(out.fullVersionList));
  // GREASE may take any slot (Chromium's seeded order), so find Chromium by name.
  assert.ok(out.fullVersionList.find((b) => b.brand === "Chromium").version.startsWith("127."),
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
    on() {},
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

// ─── STEALTH2 (2026-11-03) ───
// A UA override must look the same everywhere a site can read it: the
// page's navigator, the Sec-CH-UA-* headers, and the tab's cross-origin
// iframes (OOPIFs) + dedicated workers, which are separate CDP targets the
// page session's override does not reach (live check, Brave 147: the OOPIF
// reported the host's UA, Brave brands and "Win32").

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

/** Fake page CDP session: records sends; tests emit CDP events into it. */
function fakeSession({ fail = () => false } = {}) {
  const sent = [];
  const listeners = {};
  return {
    sent,
    send: async (method, params) => {
      sent.push({ method, params });
      if (fail(method, params)) throw new Error("boom: " + method);
      return {};
    },
    detach: async () => {},
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    emit(event, params) { for (const fn of listeners[event] || []) fn(params); },
  };
}

/** Calls fn with a handler ctx whose page CDP session is `session`. */
async function withSession(session, fn) {
  const page = { once() {} };
  try {
    return await fn({ page, context: { pages: () => [page], newCDPSession: async () => session } });
  } finally {
    PAGE_CDP_SESSIONS.delete(page);
  }
}

/** Unwraps (nested) Target.sendMessageToTarget → [{ path: "F1>F2", method, params }]. */
function childCommands(sent) {
  const out = [];
  const unwrap = (path, method, params) => {
    if (method === "Target.sendMessageToTarget") {
      const m = JSON.parse(params.message);
      unwrap([...path, params.sessionId], m.method, m.params);
    } else if (path.length) {
      out.push({ path: path.join(">"), method, params });
    }
  };
  for (const s of sent) unwrap([], s.method, s.params);
  return out;
}
const methodsFor = (sent, path) => childCommands(sent).filter((c) => c.path === path).map((c) => c.method);
const pageOverride = (sent) => sent.filter((c) => c.method === "Network.setUserAgentOverride").map((c) => c.params);
const attach = (sessionId, type) => ({ sessionId, targetInfo: { targetId: "T-" + sessionId, type, url: "" }, waitingForDebugger: true });
const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: false,
  filter: [{ type: "service_worker", exclude: true }, { type: "shared_worker", exclude: true }, { type: "browser", exclude: true }, { type: "tab", exclude: true }, {}],
};

test("STEALTH2-4: the UA override carries navigator.platform for the UA's OS (CDP platform)", async () => {
  for (const [ua, platform] of [[MAC_UA, "MacIntel"], [ANDROID_UA, "Linux armv81"]]) {
    const s = fakeSession();
    const r = await withSession(s, (ctx) => tool.handler({ userAgent: ua }, ctx));
    assert.strictEqual(pageOverride(s.sent)[0].platform, platform, ua);
    assert.strictEqual(JSON.parse(r.content[0].text).applied.platform, platform);
  }
});

test("STEALTH2-3: the metadata pins fullVersion + formFactors (left out, Chromium reports the host's)", async () => {
  const s = fakeSession();
  await withSession(s, (ctx) => tool.handler({ userAgent: ANDROID_UA }, ctx));
  const meta = pageOverride(s.sent)[0].userAgentMetadata;
  assert.strictEqual(meta.fullVersion, "131.0.6778.264");
  assert.deepStrictEqual(meta.formFactors, ["Mobile"]);
  assert.deepStrictEqual(meta.brands.map((b) => b.brand), ["Google Chrome", "Chromium", "Not_A Brand"]);
});

test("STEALTH2-5: a userAgent override auto-attaches (non-flat, paused) to the tab's child targets, minus service/shared workers", async () => {
  const s = fakeSession();
  await withSession(s, (ctx) => tool.handler({ userAgent: MAC_UA }, ctx));
  assert.deepStrictEqual(s.sent.filter((c) => c.method === "Target.setAutoAttach").map((c) => c.params), [AUTO_ATTACH]);
});

test("STEALTH2-5: an OOPIF and a dedicated worker get the page's exact override, their own auto-attach, then resume", async () => {
  const s = fakeSession();
  await withSession(s, async (ctx) => {
    await tool.handler({ userAgent: MAC_UA }, ctx);
    s.emit("Target.attachedToTarget", attach("F1", "iframe"));
    s.emit("Target.attachedToTarget", attach("W1", "worker"));
  });
  const page = pageOverride(s.sent)[0];
  for (const path of ["F1", "W1"]) {
    // Order matters: the target is paused until resumed, so the override
    // must be in place before Runtime.runIfWaitingForDebugger.
    assert.deepStrictEqual(methodsFor(s.sent, path), ["Network.setUserAgentOverride", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"], path);
    const cmds = childCommands(s.sent).filter((c) => c.path === path);
    assert.deepStrictEqual(cmds[0].params, page, `${path} gets the page's override`);
    assert.deepStrictEqual(cmds[1].params, AUTO_ATTACH);
  }
});

test("STEALTH2-5: nested targets (an OOPIF's own iframe / worker) are reached through their parent", async () => {
  const s = fakeSession();
  await withSession(s, async (ctx) => {
    await tool.handler({ userAgent: MAC_UA }, ctx);
    s.emit("Target.attachedToTarget", attach("F1", "iframe"));
    s.emit("Target.receivedMessageFromTarget", {
      sessionId: "F1",
      message: JSON.stringify({ method: "Target.attachedToTarget", params: attach("W2", "worker") }),
    });
  });
  assert.deepStrictEqual(methodsFor(s.sent, "F1>W2"), ["Network.setUserAgentOverride", "Target.setAutoAttach", "Runtime.runIfWaitingForDebugger"]);
  assert.strictEqual(childCommands(s.sent).find((c) => c.path === "F1>W2").params.userAgent, MAC_UA);
});

test("STEALTH2-5: other target types are only resumed, never overridden", async () => {
  const s = fakeSession();
  await withSession(s, async (ctx) => {
    await tool.handler({ userAgent: MAC_UA }, ctx);
    for (const [id, type] of [["S1", "service_worker"], ["S2", "shared_worker"], ["O1", "other"]]) s.emit("Target.attachedToTarget", attach(id, type));
  });
  for (const id of ["S1", "S2", "O1"]) assert.deepStrictEqual(methodsFor(s.sent, id), ["Runtime.runIfWaitingForDebugger"], id);
});

test("STEALTH2-5: a new userAgent reaches the live child targets (not detached ones); auto-attach is set up once", async () => {
  const s = fakeSession();
  await withSession(s, async (ctx) => {
    await tool.handler({ userAgent: MAC_UA }, ctx);
    s.emit("Target.attachedToTarget", attach("F1", "iframe"));
    s.emit("Target.attachedToTarget", attach("W1", "worker"));
    s.emit("Target.detachedFromTarget", { sessionId: "W1", targetId: "T-W1" });
    await tool.handler({ userAgent: ANDROID_UA }, ctx);
  });
  const f1 = childCommands(s.sent).filter((c) => c.path === "F1" && c.method === "Network.setUserAgentOverride");
  assert.deepStrictEqual(f1.map((c) => c.params.userAgent), [MAC_UA, ANDROID_UA]);
  assert.deepStrictEqual(f1[1].params, pageOverride(s.sent)[1]);
  assert.strictEqual(childCommands(s.sent).filter((c) => c.path === "W1").length, 3, "nothing more for a detached worker");
  assert.strictEqual(s.sent.filter((c) => c.method === "Target.setAutoAttach").length, 1);
});

test("STEALTH2-5: reset turns child auto-attach off (Chromium detaches them, their overrides go too)", async () => {
  const s = fakeSession();
  let body;
  await withSession(s, async (ctx) => {
    await tool.handler({ userAgent: MAC_UA }, ctx);
    s.emit("Target.attachedToTarget", attach("F1", "iframe"));
    body = JSON.parse((await tool.handler({ reset: true }, ctx)).content[0].text);
    s.emit("Target.attachedToTarget", attach("F2", "iframe")); // a straggler after reset
  });
  assert.deepStrictEqual(s.sent.filter((c) => c.method === "Target.setAutoAttach").map((c) => c.params),
    [AUTO_ATTACH, { autoAttach: false, waitForDebuggerOnStart: false, flatten: false }]);
  assert.ok(body.reset.includes("childTargets"));
  assert.deepStrictEqual(methodsFor(s.sent, "F2"), ["Runtime.runIfWaitingForDebugger"]);
});

test("STEALTH2-5 review: after reset, a late grandchild an old child reports is still resumed (never left paused)", async () => {
  const s = fakeSession();
  await withSession(s, async (ctx) => {
    await tool.handler({ userAgent: MAC_UA }, ctx);
    s.emit("Target.attachedToTarget", attach("F1", "iframe"));
    await tool.handler({ reset: true }, ctx);
    // Chromium hasn't processed autoAttach:false yet; F1's own auto-attach fires.
    s.emit("Target.receivedMessageFromTarget", {
      sessionId: "F1",
      message: JSON.stringify({ method: "Target.attachedToTarget", params: attach("W9", "worker") }),
    });
  });
  assert.deepStrictEqual(methodsFor(s.sent, "F1>W9"), ["Runtime.runIfWaitingForDebugger"]);
});

test("STEALTH2-5 review: concurrent first calls share one child auto-attach and both see its failure", async () => {
  const s = fakeSession({ fail: (method) => method === "Target.setAutoAttach" });
  await withSession(s, async (ctx) => {
    const [a, b] = await Promise.all([tool.handler({ userAgent: MAC_UA }, ctx), tool.handler({ userAgent: MAC_UA }, ctx)]);
    for (const r of [a, b]) {
      assert.strictEqual(r.isError, true);
      assert.deepStrictEqual(JSON.parse(r.content[0].text).failed.map((f) => f.name), ["childTargets"]);
    }
  });
  assert.strictEqual(s.sent.filter((c) => c.method === "Target.setAutoAttach").length, 1);
});

test("STEALTH2-5: a failing child command never blocks the resume or leaks an unhandled rejection", async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const s = fakeSession({
      fail: (method, params) => method === "Target.sendMessageToTarget" && JSON.parse(params.message).method !== "Runtime.runIfWaitingForDebugger",
    });
    await withSession(s, async (ctx) => {
      await tool.handler({ userAgent: MAC_UA }, ctx);
      s.emit("Target.attachedToTarget", attach("F1", "iframe"));
      s.emit("Target.receivedMessageFromTarget", { sessionId: "F1", message: "not json" });
      s.emit("Target.receivedMessageFromTarget", { sessionId: "nope", message: "{}" });
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(methodsFor(s.sent, "F1").at(-1), "Runtime.runIfWaitingForDebugger");
    assert.deepStrictEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("STEALTH2-5: a failed child auto-attach is reported (page override still applied) and retried next call", async () => {
  let failAutoAttach = true;
  const s = fakeSession({ fail: (method) => method === "Target.setAutoAttach" && failAutoAttach });
  await withSession(s, async (ctx) => {
    const r = await tool.handler({ userAgent: MAC_UA }, ctx);
    assert.strictEqual(r.isError, true);
    assert.deepStrictEqual(JSON.parse(r.content[0].text).failed, [{ name: "childTargets", error: "boom: Target.setAutoAttach" }]);
    assert.strictEqual(pageOverride(s.sent).length, 1);
    failAutoAttach = false;
    const r2 = await tool.handler({ userAgent: MAC_UA }, ctx);
    assert.strictEqual(r2.isError, undefined);
  });
  assert.strictEqual(s.sent.filter((c) => c.method === "Target.setAutoAttach").length, 2);
});

test("STEALTH2-5: viewport / network calls don't touch child targets", async () => {
  const s = fakeSession();
  await withSession(s, (ctx) => tool.handler({ viewport: { width: 400, height: 800 }, network: { offline: true } }, ctx));
  assert.ok(!s.sent.some((c) => c.method.startsWith("Target.")));
});

test("STEALTH2-5: the description states what the override reaches and what it can't", () => {
  assert.match(tool.description, /cross-origin iframes/);
  assert.match(tool.description, /service\/shared workers/);
});

// ── v0.4.1: a child target that can't be resumed is never left paused, and the failure is reported ──

const refuseResume = (method, params) => method === "Target.sendMessageToTarget" && JSON.parse(params.message).method === "Runtime.runIfWaitingForDebugger";

test("v0.4.1: a resume that fails for an EXISTING child (attached during this call) fails childTargets now, and the child is detached so it runs", async () => {
  const s = fakeSession({ fail: refuseResume });
  const send = s.send;
  // Chromium reports the existing children before it answers setAutoAttach
  s.send = async (method, params) => {
    if (method === "Target.setAutoAttach" && params.autoAttach) s.emit("Target.attachedToTarget", attach("F1", "iframe"));
    return send(method, params);
  };
  await withSession(s, async (ctx) => {
    const r = await tool.handler({ userAgent: MAC_UA }, ctx);
    assert.strictEqual(r.isError, true);
    const failed = JSON.parse(r.content[0].text).failed;
    assert.deepStrictEqual(failed.map((x) => x.name), ["childTargets"]);
    assert.match(failed[0].error, /a child target \(iframe\) could not be resumed \(boom: Target.sendMessageToTarget\); it was detached/);
    assert.deepStrictEqual(s.sent.filter((c) => c.method === "Target.detachFromTarget").map((c) => c.params), [{ sessionId: "F1" }], "detached on the page session: it runs");
    assert.strictEqual(pageOverride(s.sent).length, 1, "the page's own override still applied");
    // reported once
    const again = await tool.handler({ viewport: { width: 800, height: 600 } }, ctx);
    assert.strictEqual(again.isError, undefined);
  });
});

test("v0.4.1: a resume that fails for a LATER child (nested too) detaches it from its parent and is reported by the next call", async () => {
  const s = fakeSession({ fail: (method, params) => {
    if (method !== "Target.sendMessageToTarget") return false;
    const inner = JSON.parse(params.message);
    // F1's own resume works; resuming F1's child F2 (wrapped twice) is refused
    return inner.method === "Target.sendMessageToTarget" && JSON.parse(inner.params.message).method === "Runtime.runIfWaitingForDebugger";
  } });
  await withSession(s, async (ctx) => {
    assert.strictEqual((await tool.handler({ userAgent: MAC_UA }, ctx)).isError, undefined);
    s.emit("Target.attachedToTarget", attach("F1", "iframe"));
    s.emit("Target.receivedMessageFromTarget", { sessionId: "F1", message: JSON.stringify({ method: "Target.attachedToTarget", params: attach("F2", "worker") }) });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(childCommands(s.sent).filter((c) => c.method === "Target.detachFromTarget").map((c) => [c.path, c.params.sessionId]), [["F1", "F2"]], "F2 detached through its parent F1");
    const r = await tool.handler({ viewport: { width: 800, height: 600 } }, ctx);
    assert.strictEqual(r.isError, true);
    const failed = JSON.parse(r.content[0].text).failed;
    assert.deepStrictEqual(failed.map((x) => x.name), ["childTargets"]);
    assert.match(failed[0].error, /a child target \(worker\) could not be resumed/);
  });
});

test("v0.4.1: closing the page detaches its CDP session without an unhandled rejection (detach rejects once the page is gone)", async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    let onClose = null;
    const page = { once(event, fn) { if (event === "close") onClose = fn; } };
    const session = { send: async () => ({}), on() {}, detach: async () => { throw new Error("cdpSession.detach: Target page, context or browser has been closed"); } };
    await tool.handler({ viewport: { width: 800, height: 600 } }, { page, context: { pages: () => [page], newCDPSession: async () => session } });
    assert.ok(PAGE_CDP_SESSIONS.has(page));
    onClose();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(unhandled, []);
    assert.ok(!PAGE_CDP_SESSIONS.has(page), "forgotten with its page");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
