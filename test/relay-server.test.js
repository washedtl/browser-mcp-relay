const test = require("node:test");
const assert = require("node:assert");
const { RelayServer, TrafficEmitter, truncateForEmit, MAX_TRAFFIC_BODY_CHARS, TRAFFIC_RING_CAPACITY } = require("../src/relay-server.js");

class FakeUpstream {
  async request(method, params) {
    if (method === "tools/list") {
      return { tools: [
        { name: "navigation_go-to", description: "navigate", inputSchema: { type: "object" } },
      ] };
    }
    if (method === "tools/call") {
      return { content: [{ type: "text", text: `forwarded ${params.name}` }] };
    }
    throw new Error(`unexpected method ${method}`);
  }
  close() {}
}

// Upstream catalog as the relay serves it from the disk cache (tool-catalog.js).
// tools/list must come from here, never from the live upstream child.
const CATALOG = [
  { name: "navigation_go-to", description: "navigate", inputSchema: { type: "object" } },
];
const fakeCatalog = async () => CATALOG;

// Default makeRelay: relay with upstream getter only (no Brave). Used by tests
// that don't care about the Brave-launch path.
function makeRelay(upstream = new FakeUpstream()) {
  return new RelayServer({ getUpstream: async () => upstream, loadUpstreamCatalog: fakeCatalog, env: {} });
}

// makeRelayWithBrave: tracks how many times each lifecycle function fires.
function makeRelayWithBrave(upstream = new FakeUpstream()) {
  const counters = { getUpstream: 0, ensureBrave: 0 };
  const relay = new RelayServer({
    getUpstream: async () => { counters.getUpstream++; return upstream; },
    ensureBrave: async () => { counters.ensureBrave++; },
    loadUpstreamCatalog: fakeCatalog,
    env: {},
  });
  return { relay, counters };
}

test("RelayServer.handleToolsList returns upstream tools when no own-tools registered", async () => {
  const relay = makeRelay();
  const result = await relay.handleToolsList();
  assert.strictEqual(result.tools.length, 1);
  assert.strictEqual(result.tools[0].name, "navigation_go-to");
});

test("RelayServer.handleToolsList merges own tools after upstream tools", async () => {
  const relay = makeRelay();
  relay.registerOwnTool({
    name: "lighthouse_audit",
    description: "run lighthouse",
    inputSchema: { type: "object" },
    handler: async () => ({ content: [{ type: "text", text: "fake audit" }] }),
  });
  const result = await relay.handleToolsList();
  assert.strictEqual(result.tools.length, 2);
  assert.deepStrictEqual(result.tools.map((t) => t.name), ["navigation_go-to", "lighthouse_audit"]);
});

test("RelayServer.handleToolsCall forwards unknown tool to upstream", async () => {
  const relay = makeRelay();
  const result = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "about:blank" } });
  assert.strictEqual(result.content[0].text, "forwarded navigation_go-to");
});

test("RelayServer.handleToolsCall routes own-tool to its handler", async () => {
  const relay = makeRelay();
  let calledWith = null;
  relay.registerOwnTool({
    name: "lighthouse_audit",
    description: "run lighthouse",
    inputSchema: { type: "object" },
    handler: async (args) => { calledWith = args; return { content: [{ type: "text", text: "ok" }] }; },
  });
  await relay.handleToolsCall({ name: "lighthouse_audit", arguments: { url: "https://example.com" } });
  assert.deepStrictEqual(calledWith, { url: "https://example.com" });
});

test("RelayServer.handleToolsCall returns isError=true when own-tool handler throws", async () => {
  const relay = makeRelay();
  relay.registerOwnTool({
    name: "broken_tool",
    description: "throws",
    inputSchema: { type: "object" },
    handler: async () => { throw new Error("intentional failure"); },
  });
  const result = await relay.handleToolsCall({ name: "broken_tool", arguments: {} });
  assert.strictEqual(result.isError, true);
  assert.ok(result.content[0].text.includes("intentional failure"));
});

test("RelayServer.registerOwnTool throws on duplicate name", () => {
  const relay = makeRelay();
  relay.registerOwnTool({ name: "x", description: "", inputSchema: {}, handler: async () => ({}) });
  assert.throws(
    () => relay.registerOwnTool({ name: "x", description: "", inputSchema: {}, handler: async () => ({}) }),
    /already registered/i,
  );
});

test("RelayServer.registerOwnTool throws when handler is not a function", () => {
  const relay = makeRelay();
  assert.throws(
    () => relay.registerOwnTool({ name: "x", description: "", inputSchema: {}, handler: "not a function" }),
    /must be a function/i,
  );
});

test("RelayServer.handleToolsList throws on collision between upstream and own tool", async () => {
  const relay = makeRelay();
  relay.registerOwnTool({
    name: "navigation_go-to",
    description: "shadow",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "ours" }] }),
  });
  await assert.rejects(
    relay.handleToolsList(),
    /collision/i,
  );
});

test("RelayServer constructor throws if getUpstream is not a function", () => {
  assert.throws(
    () => new RelayServer(),
    /getUpstream/,
  );
  assert.throws(
    () => new RelayServer({}),
    /getUpstream/,
  );
  assert.throws(
    () => new RelayServer({ getUpstream: "not a function" }),
    /getUpstream/,
  );
});

test("RelayServer constructor throws if ensureBrave is provided but not a function", () => {
  assert.throws(
    () => new RelayServer({ getUpstream: async () => {}, ensureBrave: "not a function" }),
    /ensureBrave/,
  );
});

test("RelayServer.handleToolsList does NOT call ensureBrave or getUpstream (cached catalog)", async () => {
  const { relay, counters } = makeRelayWithBrave();
  await relay.handleToolsList();
  assert.strictEqual(counters.getUpstream, 0, "W1B: tools/list is served from the cached catalog — it must NOT spawn the upstream child");
  assert.strictEqual(counters.ensureBrave, 0, "ensureBrave must NOT fire on tools/list — that's the whole point of splitting");
});

test("RelayServer.handleToolsList serves upstream tools without outputSchema/execution", async () => {
  const relay = new RelayServer({
    getUpstream: async () => { throw new Error("must not be called"); },
    loadUpstreamCatalog: async () => [{
      name: "content_get-as-text", description: "text", inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      outputSchema: { type: "object" }, execution: { taskSupport: "forbidden" },
    }],
    env: {},
  });
  const { tools } = await relay.handleToolsList();
  assert.deepStrictEqual(tools, [{
    name: "content_get-as-text", description: "text", inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  }]);
});

test("RelayServer passes its env to the catalog loader (one resolved env per relay)", async () => {
  const env = { BROWSER_RELAY_UPSTREAM_PATH: "/x/index.js" };
  let seen;
  const relay = new RelayServer({
    getUpstream: async () => new FakeUpstream(),
    loadUpstreamCatalog: async (opts) => { seen = opts; return CATALOG; },
    env,
  });
  await relay.handleToolsList();
  assert.strictEqual(seen.env, env);
});

test("RelayServer.handleToolsList loads the catalog once, and retries after a failed load", async () => {
  let calls = 0;
  const relay = new RelayServer({
    getUpstream: async () => new FakeUpstream(),
    loadUpstreamCatalog: async () => {
      calls++;
      if (calls === 1) throw new Error("spawn failed");
      return CATALOG;
    },
    env: {},
  });
  await assert.rejects(relay.handleToolsList(), /spawn failed/);
  await relay.handleToolsList();
  await relay.handleToolsList();
  assert.strictEqual(calls, 2, "one failed load + one successful load; later lists reuse it");
});

test("RelayServer.handleToolsCall calls ensureBrave for own-tools", async () => {
  const { relay, counters } = makeRelayWithBrave();
  relay.registerOwnTool({
    name: "ours",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  await relay.handleToolsCall({ name: "ours", arguments: {} });
  assert.strictEqual(counters.ensureBrave, 1, "ensureBrave should fire before own-tool handler");
});

test("RelayServer.handleToolsCall calls ensureBrave for forwarded tools", async () => {
  const { relay, counters } = makeRelayWithBrave();
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "about:blank" } });
  assert.strictEqual(counters.ensureBrave, 1, "ensureBrave should fire before forwarding to upstream");
  assert.strictEqual(counters.getUpstream, 1);
});

test("RelayServer works without ensureBrave (Brave-less mode for testing)", async () => {
  // Backwards-compat: if entrypoint passes only getUpstream, relay still works.
  // ensureBrave is just skipped on tools/call.
  const relay = new RelayServer({ getUpstream: async () => new FakeUpstream(), env: {} });
  const result = await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.strictEqual(result.content[0].text, "forwarded navigation_go-to");
});

test("RelayServer.handleToolsCall calls ensureBrave on EVERY invocation (no internal dedup — that's the entrypoint's job)", async () => {
  // Contract: RelayServer doesn't cache or dedup ensureBrave calls. The
  // entrypoint's promise-cached wrapper handles dedup. If a future refactor
  // ever moves dedup INTO RelayServer, this test breaks loudly so we don't
  // accidentally double-up dedup logic (or worse, lose it on the entrypoint
  // side).
  const { relay, counters } = makeRelayWithBrave();
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.strictEqual(counters.ensureBrave, 3, "ensureBrave fires once per handleToolsCall — caller dedups, not RelayServer");
});

test("RelayServer.handleToolsCall calls ensureBrave BEFORE own-tool handler (ordering matters)", async () => {
  // The own-tool ctx (page, context) is built from the bridge ensureBrave
  // resolves. If a future refactor moves ensureBrave to fire after the
  // handler, own-tools would get no page. Pin the ordering.
  const order = [];
  const relay = new RelayServer({
    getUpstream: async () => new FakeUpstream(),
    ensureBrave: async () => { order.push("ensureBrave"); },
    env: {},
  });
  relay.registerOwnTool({
    name: "ours",
    description: "",
    inputSchema: {},
    handler: async () => { order.push("handler"); return { content: [{ type: "text", text: "ok" }] }; },
  });
  await relay.handleToolsCall({ name: "ours", arguments: {} });
  assert.deepStrictEqual(order, ["ensureBrave", "handler"], "ensureBrave must complete before own-tool handler runs");
});

test("RelayServer.handleToolsCall calls ensureBrave BEFORE forwarding to upstream", async () => {
  // Upstream's tool handlers will lazily try chromium.connectOverCDP when their
  // first browser tool runs. Brave must be up first. ensureBrave must complete
  // before the forwarded tool/call is sent.
  const order = [];
  const upstream = {
    async request(method, params) {
      order.push(`upstream.${method}`);
      if (method === "tools/list") return { tools: [{ name: "navigation_go-to", description: "", inputSchema: {} }] };
      return { content: [{ type: "text", text: "ok" }] };
    },
    close() {},
  };
  const relay = new RelayServer({
    getUpstream: async () => upstream,
    ensureBrave: async () => { order.push("ensureBrave"); },
    env: {},
  });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.deepStrictEqual(order, ["ensureBrave", "upstream.tools/call"], "ensureBrave must complete before forwarding");
});

// ─── W2D: own-tool handlers get a ctx (legacy mode) ─────────────────────

const { fakePage, fakeContext } = require("./fixtures/fake-registry.js");

function fakeBridge() {
  return { context: fakeContext([fakePage("https://up/")]), cdpConnectUrl: "http://127.0.0.1:9339" };
}

// bridge = the running Brave (ensureBrave resolves it, peekBrave returns it).
function relayWithCtxSpy(bridge, tool = {}) {
  const counts = { ensureBrave: 0, upstream: 0 };
  const relay = new RelayServer({
    getUpstream: async () => { counts.upstream++; return new FakeUpstream(); },
    ensureBrave: async () => { counts.ensureBrave++; return bridge; },
    peekBrave: () => bridge,
    env: {},
  });
  const seen = [];
  relay.registerOwnTool({
    name: "ours", description: "", inputSchema: {},
    handler: async (args, ctx) => { seen.push({ args, ctx }); return { content: [{ type: "text", text: "ok" }] }; },
    ...tool,
  });
  return { relay, seen, counts };
}

test("W2D: an own-tool handler gets (args, ctx): the legacy bridge's main page, its context, registry, cdpUrl and the relay", async () => {
  const bridge = fakeBridge();
  const { relay, seen } = relayWithCtxSpy(bridge);
  await relay.handleToolsCall({ name: "ours", arguments: { a: 1 } });
  const { args, ctx } = seen[0];
  assert.deepStrictEqual(args, { a: 1 });
  assert.strictEqual(ctx.page, bridge.context.pages()[0]);
  assert.strictEqual(ctx.context, bridge.context);
  assert.strictEqual(ctx.connId, "legacy");
  assert.strictEqual(ctx.sessionKey, "legacy:main");
  assert.strictEqual(ctx.cdpUrl, "http://127.0.0.1:9339");
  assert.strictEqual(typeof ctx.registry.listTabs, "function");
  assert.strictEqual(ctx.relay, relay);
});

test("W2D: tabId routes an own-tool call to an existing tab; main stays put", async () => {
  const bridge = fakeBridge();
  const { relay, seen } = relayWithCtxSpy(bridge);
  await relay.handleToolsCall({ name: "ours", arguments: {} });
  const t1 = await seen[0].ctx.registry.getCtx("legacy", "t1"); // what tabs_new does
  await relay.handleToolsCall({ name: "ours", arguments: { tabId: "t1" } });
  assert.strictEqual(seen[1].ctx.page, t1.page);
  assert.strictEqual(seen[1].ctx.sessionKey, "legacy:t1");
  assert.strictEqual(seen[0].ctx.page, bridge.context.pages()[0]);
});

test("W2D: an unknown or malformed tabId is an isError result; no tab is opened, the handler isn't called", async () => {
  const bridge = fakeBridge();
  const { relay, seen } = relayWithCtxSpy(bridge);
  for (const [tabId, re] of [["t9", /unknown tabId "t9"; call tabs_new or tabs_list/], [7, /tabId must be a non-empty string/]]) {
    const r = await relay.handleToolsCall({ name: "ours", arguments: { tabId } });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, re);
  }
  assert.strictEqual(seen.length, 0);
  assert.strictEqual(bridge.context.created, 0);
});

test("W2D: needsPage:false tools get no page and open no tab", async () => {
  const bridge = fakeBridge();
  const { relay, seen } = relayWithCtxSpy(bridge, { needsPage: false });
  await relay.handleToolsCall({ name: "ours", arguments: { tabId: "t1" } });
  assert.strictEqual(seen[0].ctx.page, undefined);
  assert.strictEqual(seen[0].ctx.context, bridge.context);
  assert.strictEqual(bridge.context.created, 0);
});

test("W2D: needsBrave:false tools never launch Brave: just the relay while it's down, the tab registry while it's up", async () => {
  let running = null;
  const relay = new RelayServer({
    getUpstream: async () => new FakeUpstream(),
    ensureBrave: async () => { throw new Error("must not launch"); },
    peekBrave: () => running,
    env: {},
  });
  const ctxs = [];
  relay.registerOwnTool({ name: "local", description: "", inputSchema: {}, needsBrave: false, handler: async (_a, c) => { ctxs.push(c); return { content: [] }; } });
  await relay.handleToolsCall({ name: "local", arguments: {} });
  running = fakeBridge();
  await relay.handleToolsCall({ name: "local", arguments: {} });
  assert.deepStrictEqual(Object.keys(ctxs[0]), ["relay"]);
  assert.strictEqual(ctxs[0].relay, relay);
  assert.strictEqual(typeof ctxs[1].registry.listTabs, "function");
  assert.strictEqual(ctxs[1].page, undefined, "never routed to a tab");
  assert.strictEqual(running.context.created, 0);
});

// Legacy mode: upstream runs in its own process and its schemas drop tabId,
// so a forwarded call with tabId would silently act on main.
test("W2D: legacy forwarded calls with a tabId are rejected before Brave or upstream are touched", async () => {
  const { relay, counts } = relayWithCtxSpy(fakeBridge());
  const r = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://x/", tabId: "t1" } });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /^navigation_go-to: tabId is only supported for relay tools in this mode/);
  assert.deepStrictEqual(counts, { ensureBrave: 0, upstream: 0 });
  const ok = await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://x/" } });
  assert.notStrictEqual(ok.isError, true);
});

// ─── W10: trafficEmitter tests ─────────────────────────────────────────

test("RelayServer exposes a trafficEmitter by default", () => {
  const relay = makeRelay();
  assert.ok(relay.trafficEmitter, "trafficEmitter must always exist");
  assert.strictEqual(typeof relay.trafficEmitter.on, "function");
  assert.strictEqual(typeof relay.trafficEmitter.getRecent, "function");
});

test("RelayServer.handleToolsCall emits request + response events for forwarded tool", async () => {
  const relay = makeRelay();
  const events = [];
  relay.trafficEmitter.on("request", (e) => events.push({ kind: "request", ...e }));
  relay.trafficEmitter.on("response", (e) => events.push({ kind: "response", ...e }));
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "about:blank" } });
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].kind, "request");
  assert.strictEqual(events[0].name, "navigation_go-to");
  assert.strictEqual(events[0].source, "upstream");
  assert.strictEqual(events[1].kind, "response");
  assert.strictEqual(events[1].id, events[0].id, "request and response share id");
  assert.strictEqual(events[1].status, "ok");
  assert.strictEqual(typeof events[1].durationMs, "number");
});

test("RelayServer.handleToolsCall emits source=own for own-tool", async () => {
  const relay = makeRelay();
  const events = [];
  relay.trafficEmitter.on("request", (e) => events.push(e));
  relay.registerOwnTool({
    name: "ours",
    description: "",
    inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
  });
  await relay.handleToolsCall({ name: "ours", arguments: { x: 1 } });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].source, "own");
});

test("RelayServer.handleToolsCall emits status=error when own-tool returns isError", async () => {
  const relay = makeRelay();
  const events = [];
  relay.trafficEmitter.on("response", (e) => events.push(e));
  relay.registerOwnTool({
    name: "broken",
    description: "",
    inputSchema: {},
    handler: async () => { throw new Error("kaboom"); },
  });
  await relay.handleToolsCall({ name: "broken", arguments: {} });
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].status, "error");
});

test("RelayServer.handleToolsCall pushes events into the ring buffer", async () => {
  const relay = makeRelay();
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  const recent = relay.trafficEmitter.getRecent();
  assert.strictEqual(recent.length, 2);
  assert.strictEqual(recent[0].name, "navigation_go-to");
  assert.strictEqual(recent[1].status, "ok");
  assert.strictEqual(recent[1].id, recent[0].id);
});

test("RelayServer trafficEmitter ring buffer caps at TRAFFIC_RING_CAPACITY", async () => {
  const ee = new TrafficEmitter();
  // Push 250 fake events directly. Ring should hold only the last 200.
  for (let i = 0; i < 250; i++) ee.push({ id: i, foo: "bar" });
  const recent = ee.getRecent();
  assert.strictEqual(recent.length, TRAFFIC_RING_CAPACITY);
  assert.strictEqual(recent[0].id, 50, "oldest event should be id=50 after 250 pushes with cap 200");
  assert.strictEqual(recent[recent.length - 1].id, 249);
});

test("truncateForEmit: returns value unchanged when under cap", () => {
  const small = { name: "x", payload: "hello" };
  assert.deepStrictEqual(truncateForEmit(small), small);
});

test("truncateForEmit: returns truncated string with marker for oversize values", () => {
  const big = { huge: "x".repeat(MAX_TRAFFIC_BODY_CHARS + 1000) };
  const out = truncateForEmit(big);
  assert.strictEqual(typeof out, "string");
  assert.ok(out.endsWith("[truncated]"));
  assert.ok(out.length <= MAX_TRAFFIC_BODY_CHARS, "truncated output must be ≤ MAX_TRAFFIC_BODY_CHARS");
});

test("RelayServer.handleToolsCall truncates oversized response in emit", async () => {
  // Upstream returns a huge response; relay should still return it intact to
  // the caller, but the emitted event payload must be truncated.
  const huge = "z".repeat(MAX_TRAFFIC_BODY_CHARS + 5000);
  const upstream = {
    async request(method) {
      if (method === "tools/list") return { tools: [{ name: "big_tool", description: "", inputSchema: {} }] };
      return { content: [{ type: "text", text: huge }] };
    },
    close() {},
  };
  const relay = new RelayServer({ getUpstream: async () => upstream, env: {} });
  const events = [];
  relay.trafficEmitter.on("response", (e) => events.push(e));
  const callerSawResponse = await relay.handleToolsCall({ name: "big_tool", arguments: {} });
  // Caller still gets the full response.
  assert.strictEqual(callerSawResponse.content[0].text.length, huge.length);
  // Inspector sees the truncated marker.
  assert.strictEqual(events.length, 1);
  assert.strictEqual(typeof events[0].response, "string");
  assert.ok(events[0].response.endsWith("[truncated]"));
});

test("RelayServer accepts an injected trafficEmitter", async () => {
  const ee = new TrafficEmitter();
  const relay = new RelayServer({
    getUpstream: async () => ({
      async request(method) {
        if (method === "tools/list") return { tools: [{ name: "t", description: "", inputSchema: {} }] };
        return { content: [{ type: "text", text: "ok" }] };
      },
      close() {},
    }),
    trafficEmitter: ee,
    env: {},
  });
  assert.strictEqual(relay.trafficEmitter, ee);
  await relay.handleToolsCall({ name: "t", arguments: {} });
  assert.strictEqual(ee.getRecent().length, 2);
});

test("RelayServer.handleToolsCall ids increment across calls", async () => {
  const relay = makeRelay();
  const ids = [];
  relay.trafficEmitter.on("request", (e) => ids.push(e.id));
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.strictEqual(ids.length, 3);
  assert.ok(ids[1] > ids[0]);
  assert.ok(ids[2] > ids[1]);
});

// ─── W11: subscriber-throws-mid-emit safety ──────────────────────────

test("RelayServer.handleToolsCall: a throwing subscriber must not bubble out", async () => {
  // A buggy/disconnected Inspector subscriber should NOT take out a tool
  // call. The relay catches emit() throws on both the request and response
  // emit paths.
  const relay = makeRelay();
  relay.trafficEmitter.on("request", () => { throw new Error("subscriber boom (request)"); });
  relay.trafficEmitter.on("response", () => { throw new Error("subscriber boom (response)"); });

  const result = await relay.handleToolsCall({
    name: "navigation_go-to",
    arguments: { url: "about:blank" },
  });
  // Caller should see the upstream's normal response, NOT the subscriber error.
  assert.strictEqual(result.content[0].text, "forwarded navigation_go-to");
});

test("RelayServer.handleToolsCall: throwing subscriber on error path also doesn't bubble", async () => {
  // Forwarded tool path that throws — the catch block emits a response
  // event with the error, then rethrows. A throwing subscriber on THAT
  // emit must not mask the original error.
  const upstream = {
    async request(method) {
      if (method === "tools/list") return { tools: [{ name: "x", description: "", inputSchema: {} }] };
      throw new Error("upstream-down");
    },
    close() {},
  };
  const relay = new RelayServer({ getUpstream: async () => upstream, env: {} });
  relay.trafficEmitter.on("response", () => { throw new Error("subscriber boom"); });
  await assert.rejects(
    () => relay.handleToolsCall({ name: "x", arguments: {} }),
    /upstream-down/,
  );
});

// ─── W1B: recordTraffic + redaction ──────────────────────────────────

test("recordTraffic:false — no ring buffer, no events, no JSON.stringify of args/responses", async () => {
  let stringified = 0;
  const response = { content: [{ type: "text", text: "ok" }], toJSON() { stringified++; return { content: this.content }; } };
  const relay = new RelayServer({
    getUpstream: async () => ({ request: async () => response }),
    loadUpstreamCatalog: fakeCatalog,
    recordTraffic: false,
    env: {},
  });
  const events = [];
  relay.trafficEmitter.on("request", (e) => events.push(e));
  relay.trafficEmitter.on("response", (e) => events.push(e));
  const args = { url: "about:blank", toJSON() { stringified++; return { url: this.url }; } };
  const out = await relay.handleToolsCall({ name: "navigation_go-to", arguments: args });
  assert.strictEqual(out, response, "caller still gets the response");
  assert.strictEqual(relay.trafficEmitter.getRecent().length, 0, "no ring buffer entries");
  assert.strictEqual(events.length, 0, "no request/response events");
  assert.strictEqual(stringified, 0, "no per-call serialization when traffic recording is off");
});

test("recordTraffic:false — forwarded errors still propagate without being recorded", async () => {
  const relay = new RelayServer({
    getUpstream: async () => ({ request: async () => { throw new Error("upstream-down"); } }),
    loadUpstreamCatalog: fakeCatalog,
    recordTraffic: false,
    env: {},
  });
  await assert.rejects(relay.handleToolsCall({ name: "navigation_go-to", arguments: {} }), /upstream-down/);
  assert.strictEqual(relay.trafficEmitter.getRecent().length, 0);
});

test("recordTraffic defaults to true (events recorded)", async () => {
  const relay = makeRelay();
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.strictEqual(relay.trafficEmitter.getRecent().length, 2);
});

// Secrets each sensitive tool carries in args or results.
const SECRET = "s3cr3t-value-123";
const SENSITIVE_CASES = [
  { name: "cookies_import", args: { cookies: [{ name: "sid", value: SECRET, domain: ".example.com", path: "/" }] } },
  { name: "cookies_export", args: { urls: ["https://example.com"] }, result: `[{"name":"sid","value":"${SECRET}"}]` },
  { name: "storage_get-local", args: { store: "local", key: "token" }, result: `{"token":"${SECRET}"}` },
  { name: "storage_set-local", args: { store: "local", entries: { token: SECRET, type: SECRET } } },
  { name: "storage_clear-local", args: { keys: [SECRET] } },
  { name: "form_fill", args: { fields: [{ selector: "#pw", value: SECRET }], timeoutMs: 5000 } },
  { name: "interaction_fill", args: { selector: "#pw", value: SECRET }, upstream: true },
];

for (const c of SENSITIVE_CASES) {
  test(`redaction: ${c.name} secrets never reach traffic events; the caller still gets them`, async () => {
    const result = { content: [{ type: "text", text: c.result || `echo ${SECRET}` }] };
    const relay = new RelayServer({
      getUpstream: async () => ({ request: async () => result }),
      loadUpstreamCatalog: fakeCatalog,
      env: {},
    });
    if (!c.upstream) relay.registerOwnTool({ name: c.name, description: "", inputSchema: {}, handler: async () => result });
    const out = await relay.handleToolsCall({ name: c.name, arguments: c.args });
    assert.ok(JSON.stringify(out).includes(SECRET), "caller must get the real result");
    const events = JSON.stringify(relay.trafficEmitter.getRecent());
    assert.ok(!events.includes(SECRET), `secret leaked into traffic events: ${events}`);
    assert.match(events, /\[redacted\]/);
    const [req, res] = relay.trafficEmitter.getRecent();
    assert.strictEqual(req.name, c.name);
    assert.strictEqual(res.response.content.length, 1, "content structure stays readable");
  });
}

test("redaction: numbers/booleans and structure survive (timeoutMs, isError, field count)", async () => {
  const relay = makeRelay();
  relay.registerOwnTool({
    name: "form_fill", description: "", inputSchema: {},
    handler: async () => { throw new Error(`could not fill ${SECRET}`); },
  });
  await relay.handleToolsCall({ name: "form_fill", arguments: { fields: [{ selector: "#a", value: SECRET }, { selector: "#b", value: SECRET }], timeoutMs: 5000 } });
  const [req, res] = relay.trafficEmitter.getRecent();
  assert.strictEqual(req.args.fields.length, 2);
  assert.strictEqual(req.args.timeoutMs, 5000);
  assert.strictEqual(res.response.isError, true);
  assert.ok(!JSON.stringify(res).includes(SECRET), "own-tool error text is redacted too");
});

test("redaction: non-sensitive tools are recorded verbatim", async () => {
  const relay = makeRelay();
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: { url: "https://example.com/?q=1" } });
  assert.deepStrictEqual(relay.trafficEmitter.getRecent()[0].args, { url: "https://example.com/?q=1" });
});

// ─── V2-1: credential headers redacted in every recorded event ───────

test("header redaction: authorization/cookie/set-cookie/x-api-key/proxy-authorization values never reach events, at any depth, any case", async () => {
  const data = {
    requests: [{
      request: { url: "https://api.example.com/v1", headers: { Authorization: `Bearer ${SECRET}`, Accept: "*/*", "X-API-Key": SECRET } },
      response: { status: 200, headers: { "set-cookie": `sid=${SECRET}; HttpOnly`, "content-type": "application/json" } },
    }],
  };
  // Upstream returns the same data twice: pretty JSON text + structuredContent.
  const result = { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
  const relay = new RelayServer({ getUpstream: async () => ({ request: async () => result }), loadUpstreamCatalog: fakeCatalog, env: {} });
  const args = { headers: { COOKIE: `a=${SECRET}`, "Proxy-Authorization": `Basic ${SECRET}` }, author: "keep-me" };
  const out = await relay.handleToolsCall({ name: "o11y_get-http-requests", arguments: args });
  assert.strictEqual(out, result, "caller gets the untouched result");
  assert.ok(JSON.stringify(out).includes(SECRET));
  const events = JSON.stringify(relay.trafficEmitter.getRecent());
  assert.ok(!events.includes(SECRET), `credential header leaked into traffic events: ${events}`);
  const [req, res] = relay.trafficEmitter.getRecent();
  assert.strictEqual(req.args.author, "keep-me", "non-header keys are untouched");
  assert.strictEqual(req.args.headers.COOKIE, "[redacted]");
  assert.strictEqual(res.response.structuredContent.requests[0].request.headers.Accept, "*/*");
  assert.strictEqual(res.response.structuredContent.requests[0].request.url, "https://api.example.com/v1");
  assert.ok(res.response.content[0].text.includes('"content-type": "application/json"'), "other headers in JSON text survive");
  assert.ok(res.response.content[0].text.includes('"Authorization": "[redacted]"'));
});

test("header redaction: compact JSON text from own tools (capture_xhr) is covered too", async () => {
  const relay = makeRelay();
  relay.registerOwnTool({
    name: "capture_xhr", description: "", inputSchema: {},
    handler: async () => ({ content: [{ type: "text", text: JSON.stringify([{ headers: { cookie: SECRET, "x-api-key": SECRET, accept: "x" } }]) }] }),
  });
  await relay.handleToolsCall({ name: "capture_xhr", arguments: {} });
  const events = JSON.stringify(relay.trafficEmitter.getRecent());
  assert.ok(!events.includes(SECRET), events);
  assert.ok(events.includes('\\"accept\\":\\"x\\"'), "non-credential header kept");
});
