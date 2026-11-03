// broker-pipe.test.js — W2A: the broker's named pipe (single instance), its
// per-connection MCP servers and its idle policy. Upstream (W2B), the Brave
// supervisor (W2C) and own-tools (W2D) are fakes; the pipe, the MCP SDK
// server/client, RelayServer and the toolsets tool are real.
//
// Pipe names here are unique per test run and never a name a real broker
// uses (those start with "browser-mcp-relay-").

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");

const {
  pipeNameFor,
  resolveEndpoint,
  brokerHome,
  claimPipe,
} = require("../src/broker/pipe-server.js");

const testPipe = (tag) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\bmr-test-${tag}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
    : path.join(os.tmpdir(), `bmr-test-${tag}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`);

const closeServer = (s) => new Promise((r) => s.close(() => r()));

// ───────────────────────────── naming ─────────────────────────────

test("pipeNameFor: per user and per profile; a real broker's prefix", () => {
  const a = pipeNameFor({ profileDir: "C:\\p\\one", user: "fakeuser", platform: "win32" });
  assert.match(a, /^\\\\\.\\pipe\\browser-mcp-relay-fakeuser-[0-9a-f]{12}$/);
  assert.strictEqual(a, pipeNameFor({ profileDir: "C:\\p\\one", user: "fakeuser", platform: "win32" }), "deterministic");
  assert.notStrictEqual(a, pipeNameFor({ profileDir: "C:\\p\\two", user: "fakeuser", platform: "win32" }));
  assert.notStrictEqual(a, pipeNameFor({ profileDir: "C:\\p\\one", user: "otheruser", platform: "win32" }));
});

test("pipeNameFor: Windows paths that name the same dir give the same pipe", () => {
  const n = (p) => pipeNameFor({ profileDir: p, user: "fakeuser", platform: "win32" });
  assert.strictEqual(n("C:\\Users\\Fake\\Prof"), n("c:/users/fake/prof/"));
});

test("pipeNameFor: user names with odd characters stay pipe-safe and distinct", () => {
  const a = pipeNameFor({ profileDir: "C:\\p", user: "Jo Smith\\x", platform: "win32" });
  const b = pipeNameFor({ profileDir: "C:\\p", user: "Jo Smith/x", platform: "win32" });
  assert.match(a, /^\\\\\.\\pipe\\browser-mcp-relay-Jo_Smith_x-[0-9a-f]{12}$/);
  assert.notStrictEqual(a, b, "sanitizing must not merge two users");
});

test("pipeNameFor: elsewhere, a unix socket in a per-user dir (not loose in a shared /tmp)", () => {
  const s = pipeNameFor({ profileDir: "/home/fakeuser/prof", user: "fakeuser", uid: 1000, platform: "linux", tmpdir: "/tmp" });
  assert.match(s, /^\/tmp\/browser-mcp-relay-1000\/[0-9a-f]{12}\.sock$/);
  const other = pipeNameFor({ profileDir: "/home/fakeuser/prof", user: "fakeuser", uid: 1001, platform: "linux", tmpdir: "/tmp" });
  assert.notStrictEqual(path.posix.dirname(s), path.posix.dirname(other));
});

test("claimPipe: refuses a socket dir other users could write", { skip: process.platform === "win32" && "unix sockets only" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-sockdir-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(dir, 0o777);
  await assert.rejects(claimPipe(path.join(dir, "x.sock")), /not private/);
});

test("resolveEndpoint: defaults to a per-user profile; env overrides pipe and profile", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\fakeuser\\AppData\\Local" };
  const def = resolveEndpoint(env, { user: "fakeuser", platform: "win32" });
  assert.strictEqual(def.profileDir, path.join(brokerHome(env, "win32"), "profile"));
  assert.ok(def.profileDir.startsWith(path.join("C:\\Users\\fakeuser\\AppData\\Local", "browser-mcp-relay")));
  assert.strictEqual(def.pipe, pipeNameFor({ profileDir: def.profileDir, user: "fakeuser", platform: "win32" }));

  const custom = resolveEndpoint({ ...env, BROWSER_RELAY_BROKER_PROFILE_DIR: "D:\\prof" }, { user: "fakeuser", platform: "win32" });
  assert.strictEqual(custom.profileDir, path.resolve("D:\\prof"));
  assert.strictEqual(custom.pipe, pipeNameFor({ profileDir: "D:\\prof", user: "fakeuser", platform: "win32" }));

  const pinned = resolveEndpoint({ ...env, BROWSER_RELAY_BROKER_PIPE: "\\\\.\\pipe\\mine" }, { user: "fakeuser", platform: "win32" });
  assert.strictEqual(pinned.pipe, "\\\\.\\pipe\\mine");
});

// ──────────────────────────── single instance ────────────────────────────

test("claimPipe: the first claim listens; a second gets null (EADDRINUSE = another broker)", async () => {
  const name = testPipe("claim");
  const first = await claimPipe(name);
  assert.ok(first && first.listening);
  try {
    assert.strictEqual(await claimPipe(name), null);
  } finally {
    await closeServer(first);
  }
  const again = await claimPipe(name);
  assert.ok(again, "claimable again once the owner closed");
  await closeServer(again);
});

test("claimPipe: any other listen error rejects (it is not 'another broker')", { skip: process.platform !== "win32" && "Windows pipe names" }, async () => {
  // a mangled name (e.g. a shell ate a backslash) fails with EACCES
  await assert.rejects(claimPipe("\\.\\pipe\\bmr-test-mangled"), (e) => e.code === "EACCES" && /EACCES/.test(e.message));
});

test("claimPipe: a stale unix socket file is reclaimed", { skip: process.platform === "win32" && "unix sockets only" }, async () => {
  const name = testPipe("stale");
  fs.writeFileSync(name, ""); // left behind by a crashed broker
  const s = await claimPipe(name);
  assert.ok(s && s.listening);
  await closeServer(s);
});

test("claimPipe: connections reach the claimed server", async () => {
  const name = testPipe("conn");
  const server = await claimPipe(name);
  try {
    const got = new Promise((resolve) => server.once("connection", (sock) => { sock.setEncoding("utf8"); sock.once("data", resolve); }));
    const c = net.connect(name);
    c.write("hello\n");
    assert.strictEqual(await got, "hello\n");
    c.destroy();
  } finally {
    await closeServer(server);
  }
});

// ───────────────────── broker: per-connection MCP servers ─────────────────────

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { ToolListChangedNotificationSchema } = require("@modelcontextprotocol/sdk/types.js");
const { startBroker, IdlePolicy, TAB_ID_SCHEMA } = require("../src/broker/main.js");
const {
  FAKE_CATALOG,
  fakeSupervisor,
  fakeUpstreamModule,
  fakeWindowPages,
  fakeToolContextModule,
  SocketClientTransport,
  probeOwnTool,
  tabsNewTool,
  cookiesTool,
  cdpOnlyTool,
  tabsListTool,
  toolsetsTool,
} = require("./fixtures/broker-fakes.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
async function until(cond, ms = 3000, what = "condition") {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const DEFAULT_OWN_TOOLS = [probeOwnTool, tabsNewTool, cookiesTool, cdpOnlyTool, tabsListTool, toolsetsTool];

async function startTestBroker(t, { idle, ownTools = DEFAULT_OWN_TOOLS, env = {}, loadCatalog, supervisor } = {}) {
  const pipe = testPipe("broker");
  const made = [];
  const upstreamModule = fakeUpstreamModule();
  const windowPages = fakeWindowPages();
  const exits = [];
  const logs = [];
  const handle = await startBroker({
    pipe,
    profileDir: path.join(os.tmpdir(), "bmr-test-profile-unused"),
    env,
    log: (m) => logs.push(m),
    idle: idle || { exitMs: 60_000, browserMs: 60_000 },
    onExit: (why) => exits.push(why),
    deps: {
      createSupervisor: (opts) => { const s = supervisor ? supervisor(opts) : fakeSupervisor(opts); made.push(s); return s; },
      upstreamModule: () => upstreamModule,
      windowPages: () => windowPages,
      ownTools: () => ownTools,
      toolContext: fakeToolContextModule,
      loadCatalog: loadCatalog || (async () => FAKE_CATALOG),
    },
  });
  t.after(() => handle.close("test done"));
  return { pipe, handle, sup: made[0], upstreamModule, windowPages, exits, logs, up: upstreamModule.state };
}

/** Open a tab the W2D way (tabs_new); only then may calls name it. */
async function openTab(c, name) {
  const r = await c.callTool({ name: "tabs_new", arguments: { name } });
  assert.ok(!r.isError, JSON.stringify(r));
}

async function connectClient(t, pipe, { name = "test-client", capabilities = {} } = {}) {
  const client = new Client({ name, version: "0" }, { capabilities });
  await client.connect(new SocketClientTransport(pipe));
  t.after(() => client.close().catch(() => {}));
  return client;
}

test("startBroker: resolves null when another broker owns the pipe", async (t) => {
  const pipe = testPipe("owned");
  const holder = await claimPipe(pipe);
  t.after(() => closeServer(holder));
  const handle = await startBroker({
    pipe, profileDir: "unused", log: () => {},
    deps: { createSupervisor: () => { throw new Error("a losing broker must not build anything"); } },
  });
  assert.strictEqual(handle, null);
});

test("startBroker: the supervisor gets a fixed CDP port chosen up front", async (t) => {
  const b = await startTestBroker(t);
  assert.ok(Number.isInteger(b.sup.opts.port) && b.sup.opts.port > 0);
  assert.strictEqual(b.sup.opts.profileDir, path.join(os.tmpdir(), "bmr-test-profile-unused"));
});

test("tools/list: cached catalog + own tools, tabId on page tools only, hidden toolsets filtered; no Brave, no upstream", async (t) => {
  const b = await startTestBroker(t, { env: { BROWSER_RELAY_TOOLSETS: "scenario" } });
  const c = await connectClient(t, b.pipe);
  const { tools } = await c.listTools();
  const byName = new Map(tools.map((x) => [x.name, x]));
  assert.ok(!byName.has("debug_status"), "the debug toolset stays hidden");
  for (const n of ["content_take-screenshot", "navigation_go-to", "content_get-as-text", "ghost_tool"]) {
    assert.deepStrictEqual(byName.get(n).inputSchema.properties.tabId, TAB_ID_SCHEMA, n);
  }
  for (const n of ["scenario-list", "toolsets", "own_cookies", "tabs_list"]) {
    assert.strictEqual((byName.get(n).inputSchema.properties || {}).tabId, undefined, `${n} takes no tabId`);
  }
  assert.deepStrictEqual(byName.get("own_probe").inputSchema, probeOwnTool.inputSchema, "own-tool schemas are W2D's, untouched");
  assert.deepStrictEqual(byName.get("navigation_go-to").inputSchema.required, ["url"], "tabId is never required");
  assert.strictEqual(FAKE_CATALOG[1].inputSchema.properties.tabId, undefined, "the cached catalog is not mutated");
  assert.strictEqual(b.sup.ensures, 0, "no Brave");
  assert.deepStrictEqual(b.up.loads, [], "no upstream import");
  assert.match(c.getInstructions(), /tabs_new/);
  assert.match(c.getInstructions(), /toolsets/);
  assert.strictEqual(c.getServerCapabilities().tools.listChanged, true);
});

test("tools/call: args parsed by upstream's zod shape, tabId routed to its own tab, result shaped like upstream's", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  await openTab(c, "sub1");
  const r = await c.callTool({ name: "content_take-screenshot", arguments: { type: "JPEG", tabId: "sub1" } });
  const exec = b.up.executed[0];
  assert.deepStrictEqual(exec.args, { type: "jpeg" }, "transformed by upstream's enum; tabId stripped");
  assert.match(exec.sessionKey, /^[0-9a-f]{8}:sub1$/);
  const body = JSON.parse(r.content[0].text);
  assert.deepStrictEqual(body, { format: "jpeg", url: `about:blank#${exec.sessionKey}` }, "_ keys and the image leave the JSON");
  assert.strictEqual(r.content[0].text, JSON.stringify(body, null, 2));
  assert.deepStrictEqual(r.content[1], { type: "image", data: Buffer.from("PNGDATA").toString("base64"), mimeType: "image/png" });
  assert.strictEqual(r.structuredContent, undefined, "no outputSchema is served, so no structuredContent either");
  assert.strictEqual(r.isError, false);

  await c.callTool({ name: "content_take-screenshot", arguments: {} });
  assert.deepStrictEqual(b.up.executed[1].args, { type: "png" }, "upstream's default applied");
  assert.match(b.up.executed[1].sessionKey, /:main$/);
  assert.deepStrictEqual(b.up.loads, [`http://127.0.0.1:${b.sup.opts.port}`], "upstream loaded once, on the fixed port");
  assert.deepStrictEqual(b.windowPages.state.installs, ["cascade"], "window-per-page installed once");
  assert.ok(b.up.order.indexOf("loadUpstream") < b.up.order.findIndex((s) => s.startsWith("createContext")));
});

test("tools/call: invalid args are an isError result naming the tool; nothing runs, Brave stays down", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  for (const args of [{}, { url: 42 }]) {
    const r = await c.callTool({ name: "navigation_go-to", arguments: args });
    assert.strictEqual(r.isError, true);
    assert.match(textOf(r), /^MCP error -32602: Input validation error: Invalid arguments for tool navigation_go-to: /);
  }
  const bad = await c.callTool({ name: "content_take-screenshot", arguments: { type: "GIF" } });
  assert.strictEqual(bad.isError, true);
  assert.strictEqual(b.up.executed.length, 0);
  assert.strictEqual(b.sup.ensures, 0);
});

test("tools/call: an upstream throw becomes upstream's 'Error: …' isError result", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  const r = await c.callTool({ name: "navigation_go-to", arguments: { url: "boom://" } });
  assert.strictEqual(r.isError, true);
  assert.strictEqual(textOf(r), "Error: net::ERR_NAME_NOT_RESOLVED");
});

test("tools/call: a catalog tool upstream no longer has fails cleanly", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  const r = await c.callTool({ name: "ghost_tool", arguments: {} });
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /ghost_tool not found/);
});

test("tools/call: a sessionless tool runs with no context, no window and no Brave", async (t) => {
  const b = await startTestBroker(t, { env: { BROWSER_RELAY_TOOLSETS: "scenario" } });
  const c = await connectClient(t, b.pipe);
  const r = await c.callTool({ name: "scenario-list", arguments: { tabId: "sub1" } });
  assert.deepStrictEqual(JSON.parse(r.content[0].text), { scenarios: [], hadCtx: false });
  assert.deepStrictEqual(b.up.executed, [{ name: "scenario-list", sessionKey: null, args: {} }]);
  assert.strictEqual(b.sup.ensures, 0);
  assert.strictEqual(b.up.contexts.length, 0);
});

test("tools/call: minimized windows are restored before screenshot / interaction / navigation, not before others", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  await c.callTool({ name: "own_probe", arguments: {} });
  await openTab(c, "s");
  assert.deepStrictEqual(b.windowPages.state.restored, []);
  await c.callTool({ name: "content_take-screenshot", arguments: { tabId: "s" } });
  await c.callTool({ name: "navigation_go-to", arguments: { url: "about:blank" } });
  assert.strictEqual(b.windowPages.state.restored.length, 2);
  assert.match(b.windowPages.state.restored[0], /:s$/);
  assert.match(b.windowPages.state.restored[1], /:main$/);
});

test("tools/call: tabId must be a non-empty string naming an open tab; only tabs_new opens tabs", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  for (const tabId of [7, ""]) {
    const r = await c.callTool({ name: "content_get-as-text", arguments: { tabId } });
    assert.strictEqual(r.isError, true);
    assert.match(textOf(r), /tabId must be a non-empty string/);
  }
  const unknown = await c.callTool({ name: "content_get-as-text", arguments: { tabId: "sub1" } });
  assert.strictEqual(unknown.isError, true);
  assert.match(textOf(unknown), /unknown tabId "sub1"; call tabs_new or tabs_list/);
  assert.strictEqual(b.up.contexts.length, 0, "nothing was created for it");
  assert.strictEqual(b.sup.ensures, 0);
  await c.callTool({ name: "content_get-as-text", arguments: { tabId: null } });
  assert.match(b.up.executed[0].sessionKey, /:main$/, "null means main");
  await openTab(c, "sub1");
  const ok = await c.callTool({ name: "content_get-as-text", arguments: { tabId: "sub1" } });
  assert.match(textOf(ok), /:sub1/);
});

test("reset notice: after Brave goes down, the tab's next result starts with the notice, once", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  const first = await c.callTool({ name: "content_get-as-text", arguments: {} });
  assert.doesNotMatch(textOf(first), /reset/);
  b.sup.crash("cdp disconnected");
  const after = await c.callTool({ name: "content_get-as-text", arguments: {} });
  assert.match(after.content[0].text, /^\[browser-mcp-relay\] This tab was reset because the browser went down \(cdp disconnected\)/);
  assert.match(after.content[1].text, /text of/);
  assert.strictEqual(b.up.contexts.length, 2, "a fresh context");
  const third = await c.callTool({ name: "content_get-as-text", arguments: {} });
  assert.strictEqual(third.content.length, 1);
});

test("own tools (routed): W2D's ctx {page, context, sessionKey, registry, connId, cdpUrl, relay}; args as sent", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  await openTab(c, "sub2");
  const got = JSON.parse(textOf(await c.callTool({ name: "own_probe", arguments: { v: "x", tabId: "sub2" } })));
  assert.deepStrictEqual(got.args, { v: "x", tabId: "sub2" }, "W2D's tools read tabId from args themselves");
  assert.strictEqual(got.sessionKey, `${got.connId}:sub2`);
  assert.strictEqual(got.url, `about:blank#${got.connId}:sub2`, "the same page upstream tools use");
  assert.strictEqual(got.contextSession, got.sessionKey, "context = that session's browserContext");
  assert.strictEqual(got.cdpUrl, `http://127.0.0.1:${b.sup.opts.port}`);
  assert.strictEqual(got.hasRelay, true);
  assert.strictEqual(got.hasRegistry, true);
});

test("own tools (routed): an unknown tabId is an error and opens nothing", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  const r = await c.callTool({ name: "own_probe", arguments: { tabId: "nope" } });
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /unknown tabId "nope"/);
  assert.strictEqual(b.up.contexts.length, 0);
});

test("own tools (needsPage:false): context is upstream's shared one, from an open session; no second browser client", async (t) => {
  const b = await startTestBroker(t);
  const a = await connectClient(t, b.pipe, { name: "A" });
  const other = await connectClient(t, b.pipe, { name: "B" });
  await a.callTool({ name: "content_get-as-text", arguments: {} }); // A's main tab is open
  const got = JSON.parse(textOf(await other.callTool({ name: "own_cookies", arguments: {} })));
  assert.match(got.cookies[0].via, /:main$/, "B reads the shared jar through A's open session");
  assert.strictEqual(got.hasPage, false);
  assert.strictEqual(b.up.contexts.length, 1, "B opened no tab");
});

test("own tools (needsPage:false): with no tab open anywhere, the context comes from the caller's main tab, only when used", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  const cdp = JSON.parse(textOf(await c.callTool({ name: "own_cdp", arguments: {} })));
  assert.strictEqual(cdp.cdpUrl, `http://127.0.0.1:${b.sup.opts.port}`);
  assert.strictEqual(b.sup.launches, 1, "Brave is up for a page-less tool (lighthouse needs it)");
  assert.strictEqual(b.up.contexts.length, 0, "a tool that never touches ctx.context opens no tab");
  const got = JSON.parse(textOf(await c.callTool({ name: "own_cookies", arguments: {} })));
  assert.match(got.cookies[0].via, /:main$/);
  assert.strictEqual(b.up.contexts.length, 1, "the caller's main tab, opened on use");
});

test("own tools (needsBrave:false): never launch Brave; just { relay } while it is down, the registry & co. while it runs", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  const down = JSON.parse(textOf(await c.callTool({ name: "tabs_list", arguments: {} })));
  assert.deepStrictEqual(down, { keys: ["relay"], tabs: null });
  assert.strictEqual(b.sup.ensures, 0);
  await openTab(c, "sub1");
  const ensuresBefore = b.sup.ensures;
  const up = JSON.parse(textOf(await c.callTool({ name: "tabs_list", arguments: {} })));
  assert.deepStrictEqual(up.keys, ["cdpUrl", "connId", "context", "registry", "relay"]);
  assert.deepStrictEqual(up.tabs, ["sub1"]);
  assert.strictEqual(b.sup.ensures, ensuresBefore, "tabs_list itself never calls ensure()");
  assert.strictEqual(b.sup.launches, 1, "only tabs_new launched Brave");
});

test("proxy credentials: not supported yet in broker mode, warned once", async (t) => {
  const b = await startTestBroker(t, {
    supervisor: (opts) => Object.assign(fakeSupervisor(opts), { proxyCredentials: { username: "proxy-user-x", password: "s3cr3t-pw-xyz" } }),
  });
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  await c.callTool({ name: "own_cookies", arguments: {} });
  const warnings = b.logs.filter((l) => /authenticated proxies are not yet supported in broker mode/.test(l));
  assert.strictEqual(warnings.length, 1);
  assert.ok(!b.logs.some((l) => l.includes("s3cr3t-pw-xyz") || l.includes("proxy-user-x")), "credentials are never logged");
});

test("own tools: a handler throw keeps RelayServer's error shape and still carries the reset notice", async (t) => {
  const thrower = { name: "own_throw", description: "throws", inputSchema: { type: "object" }, async handler() { throw new Error("kaput"); } };
  const b = await startTestBroker(t, { ownTools: [thrower] });
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  b.sup.crash();
  const r = await c.callTool({ name: "own_throw", arguments: {} });
  assert.strictEqual(r.isError, true);
  assert.match(textOf(r), /\[mcp-relay\] tool "own_throw" failed: \[browser-mcp-relay\] This tab was reset[\s\S]*kaput/);
});

test("toolsets are per connection: enabling in A notifies A and shows the tools to A only", async (t) => {
  const b = await startTestBroker(t);
  const a = await connectClient(t, b.pipe, { name: "A" });
  const other = await connectClient(t, b.pipe, { name: "B" });
  const changed = new Promise((resolve) => a.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve(true)));
  const r = await a.callTool({ name: "toolsets", arguments: { action: "enable", sets: ["debug"] } });
  assert.deepStrictEqual(JSON.parse(textOf(r)).changed, ["debug"]);
  assert.strictEqual(await changed, true);
  assert.ok((await a.listTools()).tools.some((x) => x.name === "debug_status"));
  assert.ok(!(await other.listTools()).tools.some((x) => x.name === "debug_status"));
  assert.strictEqual(b.sup.ensures, 0, "toggling toolsets never needs a browser");
});

test("connections: each gets its own connId; closing one closes only its tabs", async (t) => {
  const b = await startTestBroker(t);
  const a = await connectClient(t, b.pipe, { name: "A" });
  const other = await connectClient(t, b.pipe, { name: "B" });
  await a.callTool({ name: "content_get-as-text", arguments: {} });
  await openTab(a, "sub");
  await a.callTool({ name: "content_get-as-text", arguments: { tabId: "sub" } });
  await other.callTool({ name: "content_get-as-text", arguments: {} });
  const [ca, cs, cb] = b.up.contexts;
  assert.notStrictEqual(ca.sessionKey.split(":")[0], cb.sessionKey.split(":")[0]);
  assert.strictEqual(b.handle.connections(), 2);
  await a.close();
  await until(() => ca.closed === 1 && cs.closed === 1, 3000, "A's tabs to close");
  assert.strictEqual(cb.closed, 0);
  await until(() => b.handle.connections() === 1, 3000, "connection count");
});

test("catalog: loaded with W2B's forced upstream env, so its key matches the in-process tools", async (t) => {
  let seenEnv;
  const b = await startTestBroker(t, { env: { KEEP: "me", TOOL_OUTPUT_SCHEMA_DISABLE: "false" }, loadCatalog: async ({ env }) => { seenEnv = env; return FAKE_CATALOG; } });
  await connectClient(t, b.pipe);
  await until(() => seenEnv, 3000, "the catalog load");
  assert.strictEqual(seenEnv.KEEP, "me");
  assert.strictEqual(seenEnv.TOOL_OUTPUT_SCHEMA_DISABLE, "true");
  assert.strictEqual(seenEnv.TELEMETRY_ENABLE, "false");
});

test("catalog: a failed load is not cached; the next tools/list retries", async (t) => {
  let calls = 0;
  const b = await startTestBroker(t, {
    loadCatalog: async () => { calls++; if (calls === 1) throw new Error("upstream catalog fetch failed"); return FAKE_CATALOG; },
  });
  const c = await connectClient(t, b.pipe);
  await until(() => calls >= 1, 3000, "the warm-up load");
  const { tools } = await c.listTools();
  assert.ok(tools.length > 0);
  assert.strictEqual(calls, 2);
});

test("supervisor 'fatal' (e.g. its fixed CDP port is gone): the broker shuts down so shims respawn one", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  b.sup.emit("fatal", "CDP port 9999 is in use by another process");
  await until(() => b.exits.length === 1, 3000, "onExit");
  assert.match(b.exits[0], /fatal.*9999/);
  assert.ok(b.sup.closes >= 1, "Brave closed gracefully first");
  const again = await claimPipe(b.pipe);
  assert.ok(again, "the pipe is released");
  await closeServer(again);
});

// ─────────────────────── result conversion (upstream parity) ───────────────────────

const { toCallToolResult, prepareWorkDir } = require("../src/broker/main.js");

test("toCallToolResult: text-only result is upstream's pretty JSON, minus _ keys", () => {
  assert.deepStrictEqual(toCallToolResult({ a: 1, _trace: "x", nested: { _keep: true } }), {
    content: [{ type: "text", text: JSON.stringify({ a: 1, nested: { _keep: true } }, null, 2) }],
    isError: false,
  });
});

test("toCallToolResult: a Buffer image becomes image content; SVG stays text", () => {
  const png = toCallToolResult({ ok: true, image: { data: Buffer.from([1, 2, 3]), mimeType: "image/png" } });
  assert.deepStrictEqual(png.content, [
    { type: "text", text: JSON.stringify({ ok: true }, null, 2) },
    { type: "image", data: Buffer.from([1, 2, 3]).toString("base64"), mimeType: "image/png" },
  ]);
  const svg = toCallToolResult({ image: { data: Buffer.from("<svg/>"), mimeType: "image/svg+xml" } });
  assert.deepStrictEqual(svg.content[1], { type: "text", text: "<svg/>", mimeType: "image/svg+xml" });
});

test("toCallToolResult: an image that is not a Buffer stays in the JSON (as upstream)", () => {
  const r = toCallToolResult({ image: { data: "base64?", mimeType: "image/png" } });
  assert.strictEqual(r.content.length, 1);
  assert.match(r.content[0].text, /base64?/);
});

test("toCallToolResult: a non-object result is wrapped instead of crashing", () => {
  assert.deepStrictEqual(JSON.parse(toCallToolResult("done").content[0].text), { result: "done" });
  assert.deepStrictEqual(JSON.parse(toCallToolResult(undefined).content[0].text), {});
});

test("brokerEnv: local-config.json values reach process.env (in-process upstream reads only that); real env wins", () => {
  const { brokerEnv } = require("../src/broker/main.js");
  const processEnv = { KEEP: "env", TOOL_NAME_PREFIX: "fromEnv" };
  const env = brokerEnv(processEnv, (e) => ({ ...e, BROWSER_RELAY_UPSTREAM_PATH: "C:\\x\\dist\\index.js", TOOL_NAME_PREFIX: "fromEnv" }));
  assert.strictEqual(processEnv.BROWSER_RELAY_UPSTREAM_PATH, "C:\\x\\dist\\index.js");
  assert.strictEqual(processEnv.TOOL_NAME_PREFIX, "fromEnv");
  assert.strictEqual(env.KEEP, "env");
});

test("prepareWorkDir: a broker-owned dir becomes WORKING_DIR and the cwd", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-workdir-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const processEnv = {};
  let chdirTo = null;
  const env = process.platform === "win32" ? { LOCALAPPDATA: root } : { XDG_STATE_HOME: root };
  const dir = prepareWorkDir(env, { chdir: (d) => { chdirTo = d; }, processEnv });
  assert.ok(dir.startsWith(root));
  assert.ok(fs.statSync(dir).isDirectory());
  assert.strictEqual(processEnv.WORKING_DIR, dir);
  assert.strictEqual(chdirTo, dir);
});

// ───────────────────────────── idle policy ─────────────────────────────

function idleHarness(t, { exitIdleMs = 1000, browserIdleMs = 5000 } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fired = [];
  const policy = new IdlePolicy({
    exitIdleMs, browserIdleMs,
    onExitIdle: () => fired.push("exit"),
    onBrowserIdle: () => fired.push("browser"),
  });
  t.after(() => policy.stop());
  return { policy, fired, tick: (ms) => t.mock.timers.tick(ms) };
}

test("idle: with no connections the broker exits after exitIdleMs", (t) => {
  const { policy, fired, tick } = idleHarness(t);
  policy.start();
  tick(999);
  assert.deepStrictEqual(fired, []);
  tick(1);
  assert.deepStrictEqual(fired, ["exit"]);
});

test("idle: a connection cancels the exit; the last one leaving restarts the full wait", (t) => {
  const { policy, fired, tick } = idleHarness(t);
  policy.start();
  tick(500);
  policy.connectionOpened();
  policy.connectionOpened();
  tick(5000);
  policy.connectionClosed();
  tick(5000);
  assert.deepStrictEqual(fired, [], "one connection is still open");
  policy.connectionClosed();
  tick(999);
  assert.deepStrictEqual(fired, []);
  tick(1);
  assert.deepStrictEqual(fired, ["exit"]);
});

test("idle: Brave closes browserIdleMs after the last tool call ends, even with sessions connected", (t) => {
  const { policy, fired, tick } = idleHarness(t, { exitIdleMs: 1000, browserIdleMs: 5000 });
  policy.start();
  policy.connectionOpened();
  tick(10_000);
  assert.deepStrictEqual(fired, [], "no call yet: Brave was never needed");
  policy.callStarted();
  tick(60_000);
  assert.deepStrictEqual(fired, [], "never while a call is in flight");
  policy.callEnded();
  tick(4999);
  policy.callStarted();
  policy.callEnded();
  tick(4999);
  assert.deepStrictEqual(fired, [], "each call restarts the wait");
  tick(1);
  assert.deepStrictEqual(fired, ["browser"]);
});

test("idle: overlapping calls — the wait starts when the last one ends", (t) => {
  const { policy, fired, tick } = idleHarness(t, { browserIdleMs: 100 });
  policy.connectionOpened();
  policy.callStarted();
  policy.callStarted();
  policy.callEnded();
  tick(1000);
  assert.deepStrictEqual(fired, []);
  policy.callEnded();
  tick(100);
  assert.deepStrictEqual(fired, ["browser"]);
});

test("idle: stop() cancels everything, and nothing re-arms after it", (t) => {
  const { policy, fired, tick } = idleHarness(t);
  policy.start();
  policy.connectionOpened();
  policy.callStarted();
  policy.callEnded();
  policy.stop();
  policy.connectionClosed(); // sockets destroyed by the shutdown itself
  policy.callStarted();
  policy.callEnded();
  tick(100_000);
  assert.deepStrictEqual(fired, []);
});

test("close(): an explicit shutdown never fires the idle exit afterwards", async (t) => {
  const b = await startTestBroker(t, { idle: { exitMs: 40, browserMs: 60_000 } });
  await connectClient(t, b.pipe);
  assert.strictEqual(await b.handle.close("explicit"), true);
  await sleep(150);
  assert.deepStrictEqual(b.exits, [], "no onExit for a shutdown the caller asked for");
});

test("close(): joining an idle exit that gets called off still shuts down", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let closing = false;
  const b = await startTestBroker(t, {
    idle: { exitMs: 40, browserMs: 60_000 },
    supervisor: (opts) => {
      const s = fakeSupervisor(opts);
      const close = s.closeGracefully;
      s.closeGracefully = async () => { closing = true; await gate; return close(); };
      return s;
    },
  });
  await until(() => closing, 3000, "the idle exit to start");
  await connectClient(t, b.pipe); // calls the idle exit off...
  const explicit = b.handle.close("explicit"); // ...while an explicit close joins it
  release();
  assert.strictEqual(await explicit, true);
  const again = await claimPipe(b.pipe);
  assert.ok(again, "the pipe was released");
  await closeServer(again);
});

test("idle exit: Brave is closed gracefully while the pipe is still ours, then the pipe is released", async (t) => {
  const order = [];
  let pipe;
  const b = await startTestBroker(t, {
    idle: { exitMs: 80, browserMs: 60_000 },
    supervisor: (opts) => {
      const s = fakeSupervisor(opts);
      const close = s.closeGracefully;
      s.closeGracefully = async () => {
        const probe = await claimPipe(pipe);
        order.push(probe ? "pipe free during Brave close" : "pipe held during Brave close");
        if (probe) await closeServer(probe);
        return close();
      };
      return s;
    },
  });
  pipe = b.pipe;
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  assert.strictEqual(b.sup.up, true);
  await c.close();
  await until(() => b.exits.length === 1, 3000, "idle exit");
  assert.deepStrictEqual(order, ["pipe held during Brave close"]);
  assert.strictEqual(b.sup.up, false);
  assert.match(b.exits[0], /no connections/);
  const again = await claimPipe(b.pipe);
  assert.ok(again, "released after");
  await closeServer(again);
});

test("idle exit is called off when a session connects while Brave is closing", async (t) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let closing = false;
  const b = await startTestBroker(t, {
    idle: { exitMs: 50, browserMs: 60_000 },
    supervisor: (opts) => {
      const s = fakeSupervisor(opts);
      const close = s.closeGracefully;
      s.closeGracefully = async () => { closing = true; await gate; return close(); };
      return s;
    },
  });
  await until(() => closing, 3000, "the idle exit to start closing Brave");
  const c = await connectClient(t, b.pipe);
  release();
  await sleep(100);
  assert.deepStrictEqual(b.exits, [], "stayed up");
  assert.ok((await c.listTools()).tools.length > 0, "still serving");
});

test("browser idle: no tool call for browserMs closes Brave; the tab's next call relaunches it with a notice", async (t) => {
  const b = await startTestBroker(t, { idle: { exitMs: 60_000, browserMs: 80 } });
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  await until(() => b.sup.closes === 1, 3000, "Brave to close");
  assert.strictEqual(b.sup.up, false);
  const r = await c.callTool({ name: "content_get-as-text", arguments: {} });
  assert.match(r.content[0].text, /reset because the browser was closed after/);
  assert.strictEqual(b.sup.launches, 2);
  assert.deepStrictEqual(b.exits, [], "the broker itself stays up while a session is connected");
});
