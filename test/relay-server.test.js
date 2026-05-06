const test = require("node:test");
const assert = require("node:assert");
const { RelayServer } = require("../src/relay-server.js");

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

// Default makeRelay: relay with upstream getter only (no Brave). Used by tests
// that don't care about the Brave-launch path.
function makeRelay(upstream = new FakeUpstream()) {
  return new RelayServer({ getUpstream: async () => upstream });
}

// makeRelayWithBrave: tracks how many times each lifecycle function fires.
function makeRelayWithBrave(upstream = new FakeUpstream()) {
  const counters = { getUpstream: 0, ensureBrave: 0 };
  const relay = new RelayServer({
    getUpstream: async () => { counters.getUpstream++; return upstream; },
    ensureBrave: async () => { counters.ensureBrave++; },
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

test("RelayServer.handleToolsList does NOT call ensureBrave (cheap path)", async () => {
  const { relay, counters } = makeRelayWithBrave();
  await relay.handleToolsList();
  assert.strictEqual(counters.getUpstream, 1, "getUpstream should be called for tools/list");
  assert.strictEqual(counters.ensureBrave, 0, "ensureBrave must NOT fire on tools/list — that's the whole point of splitting");
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
  const relay = new RelayServer({ getUpstream: async () => new FakeUpstream() });
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
  // Own-tool handlers read globalThis.__relayBridge, which is populated INSIDE
  // ensureBrave. If a future refactor moves ensureBrave to fire after the
  // handler, own-tools would see an empty bridge. Pin the ordering.
  const order = [];
  const relay = new RelayServer({
    getUpstream: async () => new FakeUpstream(),
    ensureBrave: async () => { order.push("ensureBrave"); },
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
  });
  await relay.handleToolsCall({ name: "navigation_go-to", arguments: {} });
  assert.deepStrictEqual(order, ["ensureBrave", "upstream.tools/call"], "ensureBrave must complete before forwarding");
});
