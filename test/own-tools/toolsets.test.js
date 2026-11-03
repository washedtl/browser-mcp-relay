// toolsets.test.js — W1B: hidden-by-default tool groups + the `toolsets`
// own-tool. Owner rule: the agent must ASK THE USER before enabling a group.

const test = require("node:test");
const assert = require("node:assert");
const { RelayServer } = require("../../src/relay-server.js");
const { tools: ownTools } = require("../../src/own-tools/index.js");
const {
  tool,
  TOOLSET_NAMES,
  toolsetOf,
  parseToolsets,
} = require("../../src/own-tools/toolsets.js");

const CATALOG = [
  { name: "navigation_go-to", description: "", inputSchema: { type: "object" } },
  { name: "o11y_get-console-messages", description: "", inputSchema: { type: "object" } },
  { name: "o11y_get-trace-context", description: "", inputSchema: { type: "object" } },
  { name: "o11y_new-trace-id", description: "", inputSchema: { type: "object" } },
  { name: "o11y_set-trace-context", description: "", inputSchema: { type: "object" } },
  { name: "debug_status", description: "", inputSchema: { type: "object" } },
  { name: "debug_put-logpoint", description: "", inputSchema: { type: "object" } },
  { name: "react_get-component-for-element", description: "", inputSchema: { type: "object" } },
  { name: "scenario-run", description: "", inputSchema: { type: "object" } },
  { name: "execute", description: "", inputSchema: { type: "object" } },
];

// env: {} keeps these tests independent of the developer's real
// BROWSER_RELAY_TOOLSETS / local-config.json.
function makeRelay(extra = {}) {
  const counters = { ensureBrave: 0, getUpstream: 0, notify: 0, forwarded: [] };
  const relay = new RelayServer({
    getUpstream: async () => {
      counters.getUpstream++;
      return { request: async (m, p) => { counters.forwarded.push(p.name); return { content: [{ type: "text", text: `fwd ${p.name}` }] }; } };
    },
    ensureBrave: async () => { counters.ensureBrave++; },
    loadUpstreamCatalog: async () => CATALOG,
    notifyToolsChanged: () => { counters.notify++; },
    env: {},
    ...extra,
  });
  relay.registerOwnTool(tool);
  return { relay, counters };
}

const listNames = async (relay) => (await relay.handleToolsList()).tools.map((t) => t.name);
const call = (relay, args) => relay.handleToolsCall({ name: "toolsets", arguments: args });
const json = (res) => JSON.parse(res.content[0].text);

// ─── membership ──────────────────────────────────────────────────────────

test("toolsetOf: maps hidden-by-default tools to their group, everything else to null", () => {
  assert.strictEqual(toolsetOf("debug_status"), "debug");
  assert.strictEqual(toolsetOf("react_get-element-for-component"), "react");
  assert.strictEqual(toolsetOf("scenario-run"), "scenario");
  assert.strictEqual(toolsetOf("o11y_get-trace-context"), "trace");
  assert.strictEqual(toolsetOf("o11y_new-trace-id"), "trace");
  assert.strictEqual(toolsetOf("o11y_set-trace-context"), "trace");
  for (const visible of ["o11y_get-console-messages", "o11y_get-web-vitals", "execute", "navigation_go-to", "toolsets", "cookies_export"]) {
    assert.strictEqual(toolsetOf(visible), null, visible);
  }
});

test("parseToolsets: comma string or array, trims, expands all, reports unknown", () => {
  assert.deepStrictEqual(parseToolsets(" debug, react "), { sets: ["debug", "react"], unknown: [] });
  assert.deepStrictEqual(parseToolsets(["scenario", "nope"]), { sets: ["scenario"], unknown: ["nope"] });
  assert.deepStrictEqual(parseToolsets("all"), { sets: TOOLSET_NAMES, unknown: [] });
  assert.deepStrictEqual(parseToolsets(""), { sets: [], unknown: [] });
  assert.deepStrictEqual(parseToolsets(undefined), { sets: [], unknown: [] });
});

// ─── hidden by default ───────────────────────────────────────────────────

test("tools/list hides debug/react/scenario/trace by default and shows the rest + toolsets", async () => {
  const { relay } = makeRelay();
  assert.deepStrictEqual(await listNames(relay), [
    "navigation_go-to", "o11y_get-console-messages", "execute", "toolsets",
  ]);
});

test("calling a hidden tool returns isError telling the agent to ASK THE USER, without launching anything", async () => {
  const { relay, counters } = makeRelay();
  const res = await relay.handleToolsCall({ name: "debug_status", arguments: {} });
  assert.strictEqual(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /hidden/i);
  assert.match(text, /ask the user/i);
  assert.match(text, /"debug"/);
  assert.match(text, /toolsets/);
  assert.strictEqual(counters.ensureBrave, 0, "no Brave launch for a refused call");
  assert.strictEqual(counters.getUpstream, 0, "no upstream spawn for a refused call");
});

test("BROWSER_RELAY_TOOLSETS pre-enables groups (env seam; also read from local-config.json)", async () => {
  const { relay } = makeRelay({ env: { BROWSER_RELAY_TOOLSETS: "debug,trace" } });
  const names = await listNames(relay);
  assert.ok(names.includes("debug_status") && names.includes("o11y_get-trace-context"));
  assert.ok(!names.includes("react_get-component-for-element") && !names.includes("scenario-run"));
});

test("BROWSER_RELAY_TOOLSETS=all shows the full catalog", async () => {
  const { relay } = makeRelay({ env: { BROWSER_RELAY_TOOLSETS: "all" } });
  assert.strictEqual((await listNames(relay)).length, CATALOG.length + 1);
});

test("RelayServer reads BROWSER_RELAY_TOOLSETS from process.env when no env seam is passed", async () => {
  const prev = process.env.BROWSER_RELAY_TOOLSETS;
  process.env.BROWSER_RELAY_TOOLSETS = "react";
  try {
    const relay = new RelayServer({ getUpstream: async () => ({}), loadUpstreamCatalog: async () => CATALOG });
    assert.ok((await listNames(relay)).includes("react_get-component-for-element"));
  } finally {
    if (prev === undefined) delete process.env.BROWSER_RELAY_TOOLSETS;
    else process.env.BROWSER_RELAY_TOOLSETS = prev;
  }
});

// ─── the toolsets tool ───────────────────────────────────────────────────

test("toolsets is registered in the own-tools registry", () => {
  assert.ok(ownTools.includes(tool));
  assert.strictEqual(tool.name, "toolsets");
  assert.strictEqual(tool.inputSchema.type, "object");
});

test("toolsets description tells the agent the groups are hidden and to ASK THE USER before enabling", () => {
  assert.match(tool.description, /hidden/i);
  assert.match(tool.description, /ASK THE USER/);
  assert.match(tool.description, /never/i);
  for (const name of TOOLSET_NAMES) assert.ok(tool.description.includes(name), `description names ${name}`);
});

test("toolsets list: every group with enabled flag and its tools from the catalog; no Brave launch", async () => {
  const { relay, counters } = makeRelay();
  const out = json(await call(relay, {}));
  assert.deepStrictEqual(out.toolsets.map((s) => [s.name, s.enabled, s.tools]), [
    ["debug", false, ["debug_status", "debug_put-logpoint"]],
    ["react", false, ["react_get-component-for-element"]],
    ["scenario", false, ["scenario-run"]],
    ["trace", false, ["o11y_get-trace-context", "o11y_new-trace-id", "o11y_set-trace-context"]],
  ]);
  assert.strictEqual(counters.ensureBrave, 0, "toolsets is relay-local — must not launch Brave");
});

test("toolsets enable: shows the group, notifies tools/list_changed once, then the tools forward", async () => {
  const { relay, counters } = makeRelay();
  const res = await call(relay, { action: "enable", sets: ["debug"] });
  assert.ok(!res.isError, res.content[0].text);
  const out = json(res);
  assert.deepStrictEqual(out.changed, ["debug"]);
  assert.deepStrictEqual(out.tools, ["debug_status", "debug_put-logpoint"]);
  assert.match(out.note, /BROWSER_RELAY_TOOLSETS/, "fallback for clients that ignore list_changed");
  assert.strictEqual(counters.notify, 1);
  assert.ok((await listNames(relay)).includes("debug_put-logpoint"));
  const fwd = await relay.handleToolsCall({ name: "debug_status", arguments: {} });
  assert.strictEqual(fwd.content[0].text, "fwd debug_status");
  // Re-enabling is a no-op: no second notification.
  await call(relay, { action: "enable", sets: ["debug"] });
  assert.strictEqual(counters.notify, 1);
  assert.strictEqual(counters.ensureBrave, 1, "only the forwarded debug_status call launched Brave");
});

test("toolsets disable: hides the group again and notifies", async () => {
  const { relay, counters } = makeRelay({ env: { BROWSER_RELAY_TOOLSETS: "react" } });
  const out = json(await call(relay, { action: "disable", sets: ["react"] }));
  assert.deepStrictEqual(out.changed, ["react"]);
  assert.strictEqual(counters.notify, 1);
  assert.ok(!(await listNames(relay)).includes("react_get-component-for-element"));
  const res = await relay.handleToolsCall({ name: "react_get-component-for-element", arguments: {} });
  assert.strictEqual(res.isError, true);
});

test("toolsets enable rejects unknown or missing sets and names the valid ones", async () => {
  const { relay, counters } = makeRelay();
  for (const args of [{ action: "enable", sets: ["bogus"] }, { action: "enable" }, { action: "explode", sets: ["debug"] }]) {
    const res = await call(relay, args);
    assert.strictEqual(res.isError, true, JSON.stringify(args));
  }
  const res = await call(relay, { action: "enable", sets: ["bogus"] });
  assert.match(res.content[0].text, /debug, react, scenario, trace/);
  assert.strictEqual(counters.notify, 0);
});

test("a throwing or rejecting notifyToolsChanged never breaks the toolsets call", async () => {
  for (const notify of [() => { throw new Error("not connected"); }, async () => { throw new Error("rejected"); }]) {
    const { relay } = makeRelay({ notifyToolsChanged: notify });
    const res = await call(relay, { action: "enable", sets: ["scenario"] });
    assert.ok(!res.isError, res.content[0].text);
    assert.ok((await listNames(relay)).includes("scenario-run"));
  }
});

test("notifyToolsChanged is optional (defaults to a no-op)", async () => {
  const relay = new RelayServer({ getUpstream: async () => ({}), loadUpstreamCatalog: async () => CATALOG, env: {} });
  relay.registerOwnTool(tool);
  const res = await call(relay, { action: "enable", sets: ["trace"] });
  assert.ok(!res.isError, res.content[0].text);
});

test("MCP wiring: enabling a toolset reaches a real SDK client as notifications/tools/list_changed", { timeout: 10_000 }, async () => {
  // Mirrors the entrypoint contract (W1A): capabilities.tools.listChanged +
  // notifyToolsChanged: () => server.sendToolListChanged().
  const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const {
    CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema,
  } = require("@modelcontextprotocol/sdk/types.js");

  const server = new Server({ name: "t", version: "0" }, { capabilities: { tools: { listChanged: true } } });
  const relay = new RelayServer({
    getUpstream: async () => ({}),
    loadUpstreamCatalog: async () => CATALOG,
    notifyToolsChanged: () => server.sendToolListChanged(),
    env: {},
  });
  relay.registerOwnTool(tool);
  server.setRequestHandler(ListToolsRequestSchema, async () => relay.handleToolsList());
  server.setRequestHandler(CallToolRequestSchema, async (req) => relay.handleToolsCall(req.params));

  const client = new Client({ name: "c", version: "0" });
  let changed;
  const gotNotification = new Promise((resolve) => { changed = resolve; });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => changed());
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    assert.ok(!(await client.listTools()).tools.some((t) => t.name === "debug_status"));
    await client.callTool({ name: "toolsets", arguments: { action: "enable", sets: ["debug"] } });
    await gotNotification;
    assert.ok((await client.listTools()).tools.some((t) => t.name === "debug_status"));
  } finally {
    await client.close();
    await server.close();
  }
});

// ─── honest notify (V1-1) ─────────────────────────────────────────────────

test("with notifyToolsChanged wired, enable says the list_changed notification was sent", async () => {
  const { relay } = makeRelay();
  const out = json(await call(relay, { action: "enable", sets: ["debug"] }));
  assert.match(out.note, /Sent notifications\/tools\/list_changed/);
});

test("without notifyToolsChanged, enable does NOT claim a notification and says a restart with BROWSER_RELAY_TOOLSETS is needed", async () => {
  const relay = new RelayServer({ getUpstream: async () => ({}), loadUpstreamCatalog: async () => CATALOG, env: {} });
  relay.registerOwnTool(tool);
  assert.strictEqual(relay.canNotify, false);
  const out = json(await call(relay, { action: "enable", sets: ["debug", "react"] }));
  assert.deepStrictEqual(out.changed, ["debug", "react"]);
  assert.doesNotMatch(out.note, /Sent notifications/);
  assert.match(out.note, /restart/i);
  assert.match(out.note, /BROWSER_RELAY_TOOLSETS=debug,react/);
});

// ─── MCP elicitation: a real approve/decline prompt for the user ─────────

function elicitRelay(elicit, extra = {}) {
  const calls = [];
  const made = makeRelay({
    elicit: async (params, opts) => { calls.push({ params, opts }); return elicit(params, opts); },
    ...extra,
  });
  return { ...made, calls };
}

test("elicit accept: the user sees the set, its purpose and tool count; then it is enabled", async () => {
  const { relay, counters, calls } = elicitRelay(async () => ({ action: "accept", content: {} }));
  const out = json(await call(relay, { action: "enable", sets: ["debug"] }));
  assert.strictEqual(calls.length, 1);
  const { message, requestedSchema } = calls[0].params;
  assert.deepStrictEqual(requestedSchema, { type: "object", properties: {} });
  assert.match(message, /"?debug"?/);
  assert.match(message, /2 tools/, "tool count from the catalog (fixture has 2 debug tools)");
  assert.match(message, /debugger/i, "says what the set is for");
  assert.deepStrictEqual(out.changed, ["debug"]);
  assert.strictEqual(out.userApproved, true);
  assert.strictEqual(counters.notify, 1);
  assert.ok((await listNames(relay)).includes("debug_status"));
});

for (const action of ["decline", "cancel"]) {
  test(`elicit ${action}: nothing is enabled and the agent is told the user declined`, async () => {
    const { relay, counters } = elicitRelay(async () => ({ action }));
    const res = await call(relay, { action: "enable", sets: ["react"] });
    const out = json(res);
    assert.deepStrictEqual(out.changed, []);
    assert.strictEqual(out.declined, true);
    assert.match(out.note, /user declined/i);
    assert.strictEqual(counters.notify, 0);
    assert.ok(!(await listNames(relay)).includes("react_get-component-for-element"));
  });
}

test("elicit returns null (client has no elicitation): falls back to the ask-first flow and enables", async () => {
  const { relay, calls } = elicitRelay(async () => null);
  const out = json(await call(relay, { action: "enable", sets: ["scenario"] }));
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(out.changed, ["scenario"]);
  assert.strictEqual(out.userApproved, undefined, "no prompt was shown, so no approval is claimed");
});

test("elicit throws: treated as unavailable (logged), falls back and enables", async () => {
  const { relay, calls } = elicitRelay(async () => { throw new Error("client does not support elicitation"); });
  const out = json(await call(relay, { action: "enable", sets: ["trace"] }));
  assert.strictEqual(calls.length, 1, "the prompt was attempted");
  assert.deepStrictEqual(out.changed, ["trace"]);
});

test("elicit times out: nothing is enabled, the agent is told no answer arrived, and the request is aborted", async () => {
  let signal;
  const { relay } = elicitRelay((params, opts) => { signal = opts && opts.signal; return new Promise(() => {}); }, { elicitTimeoutMs: 50 });
  const out = json(await call(relay, { action: "enable", sets: ["debug"] }));
  assert.deepStrictEqual(out.changed, []);
  assert.strictEqual(out.declined, true);
  assert.match(out.note, /no answer/i);
  assert.ok(signal && signal.aborted, "the pending elicitation is aborted on timeout");
});

test("elicit is not called for disable, or when every requested set is already on", async () => {
  const { relay, calls } = elicitRelay(async () => ({ action: "accept" }), { env: { BROWSER_RELAY_TOOLSETS: "debug" } });
  await call(relay, { action: "enable", sets: ["debug"] });
  await call(relay, { action: "disable", sets: ["debug"] });
  assert.strictEqual(calls.length, 0);
});

async function sdkPair({ clientElicits, answer }) {
  // Mirrors the planned entrypoint wiring (W1A): elicit returns null when the
  // client lacks the capability, else server.elicitInput(params, { signal }).
  const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const { CallToolRequestSchema, ListToolsRequestSchema, ElicitRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
  const server = new Server({ name: "t", version: "0" }, { capabilities: { tools: { listChanged: true } } });
  const relay = new RelayServer({
    getUpstream: async () => ({}),
    loadUpstreamCatalog: async () => CATALOG,
    notifyToolsChanged: () => server.sendToolListChanged(),
    elicit: (params, { signal }) =>
      (server.getClientCapabilities() || {}).elicitation ? server.elicitInput(params, { signal }) : null,
    env: {},
  });
  relay.registerOwnTool(tool);
  server.setRequestHandler(ListToolsRequestSchema, async () => relay.handleToolsList());
  server.setRequestHandler(CallToolRequestSchema, async (req) => relay.handleToolsCall(req.params));
  const client = new Client({ name: "c", version: "0" }, { capabilities: clientElicits ? { elicitation: {} } : {} });
  const prompts = [];
  if (clientElicits) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => { prompts.push(req.params); return answer; });
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server, prompts, close: async () => { await client.close(); await server.close(); } };
}

test("MCP wiring: a client with elicitation gets the approve prompt; accept enables, decline doesn't", { timeout: 10_000 }, async () => {
  for (const [answer, enabled] of [[{ action: "accept", content: {} }, true], [{ action: "decline" }, false]]) {
    const pair = await sdkPair({ clientElicits: true, answer });
    try {
      const res = await pair.client.callTool({ name: "toolsets", arguments: { action: "enable", sets: ["react"] } });
      assert.strictEqual(pair.prompts.length, 1);
      assert.match(pair.prompts[0].message, /react/);
      const names = (await pair.client.listTools()).tools.map((t) => t.name);
      assert.strictEqual(names.includes("react_get-component-for-element"), enabled, JSON.stringify(answer));
      assert.strictEqual(JSON.parse(res.content[0].text).declined === true, !enabled);
    } finally { await pair.close(); }
  }
});

test("MCP wiring: a client without elicitation gets no prompt and the ask-first fallback applies", { timeout: 10_000 }, async () => {
  const pair = await sdkPair({ clientElicits: false });
  try {
    const res = await pair.client.callTool({ name: "toolsets", arguments: { action: "enable", sets: ["react"] } });
    assert.strictEqual(JSON.parse(res.content[0].text).changed[0], "react");
  } finally { await pair.close(); }
});
