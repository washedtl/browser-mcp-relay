// relay-legacy-tabs.test.js — W2D: legacy mode (today's per-session pool
// relay) end to end through RelayServer with the real own-tools registered.
// Own-tools get their ctx from ensureBrave's bridge; tabs are pages of the
// relay's own BrowserContext.

const test = require("node:test");
const assert = require("node:assert");
const { RelayServer } = require("../src/relay-server.js");
const { tools: ownTools } = require("../src/own-tools/index.js");
const { fakePage, fakeContext } = require("./fixtures/fake-registry.js");

// storage_get-local reads a page's storage through evaluate.
const withStorage = (page) => Object.assign(page, {
  evaluate: async () => ({ entries: [], count: 0 }),
});

function legacyRelay({ running = true } = {}) {
  const upstreamPage = withStorage(fakePage("https://upstream.example/"));
  const context = fakeContext([fakePage(), upstreamPage]); // Brave's startup page, then upstream's
  const newPage = context.newPage;
  context.newPage = async () => withStorage(await newPage());
  context.cookies = async () => [];
  context.scripts = [];
  context.addInitScript = async (s) => { context.scripts.push(s); };
  const bridge = { context, cdpConnectUrl: "http://127.0.0.1:9334" };
  const counts = { ensureBrave: 0, upstream: 0 };
  const relay = new RelayServer({
    getUpstream: async () => ({ request: async () => { counts.upstream++; return { content: [] }; } }),
    ensureBrave: async () => { counts.ensureBrave++; return bridge; },
    peekBrave: () => (running ? bridge : null),
    env: {},
  });
  for (const t of ownTools) relay.registerOwnTool(t);
  const raw = (name, args = {}) => relay.handleToolsCall({ name, arguments: args });
  const call = async (name, args) => {
    const r = await raw(name, args);
    assert.notStrictEqual(r.isError, true, `${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  return { context, upstreamPage, counts, raw, call };
}

test("W2D legacy: tabs_new → tabId → own-tool on that tab → tabs_list → tabs_close; one load per URL, upstream never called", async () => {
  const { context, upstreamPage, counts, call } = legacyRelay();

  const opened = await call("tabs_new", { url: "https://a.example/" });
  assert.match(opened.tabId, /^t\d+$/);
  const tab = context.pages().at(-1);
  assert.deepStrictEqual(tab.gotos.map((g) => g.url), ["https://a.example/"], "loaded once, in the new tab");
  assert.deepStrictEqual(upstreamPage.gotos, [], "upstream's page is not navigated");
  assert.strictEqual(counts.upstream, 0, "no upstream navigation_go-to (the old double load)");

  // A page tool with that tabId acts on the new tab; without one, on main.
  assert.strictEqual((await call("storage_get-local", { tabId: opened.tabId })).origin, "https://a.example");
  assert.strictEqual((await call("storage_get-local", {})).origin, "https://upstream.example", "main = upstream's page");

  const tabs = await call("tabs_list");
  assert.deepStrictEqual(tabs.tabs.map((t) => [t.tabId, t.url]), [["main", "https://upstream.example/"], [opened.tabId, "https://a.example/"]]);

  const closed = await call("tabs_close", { tabId: opened.tabId });
  assert.strictEqual(closed.closed, opened.tabId);
  assert.strictEqual(tab.isClosed(), true);
  assert.deepStrictEqual((await call("tabs_list")).tabs.map((t) => t.tabId), ["main"]);
});

test("W2D legacy: an unknown tabId is an isError, never a silent new tab", async () => {
  const { context, raw } = legacyRelay();
  const before = context.pages().length;
  const r = await raw("storage_get-local", { tabId: "t999" });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /unknown tabId "t999"; call tabs_new or tabs_list/);
  assert.strictEqual(context.pages().length, before);
});

test("W2D legacy: forwarded tools reject tabId (upstream would silently act on main)", async () => {
  const { counts, raw } = legacyRelay();
  const r = await raw("content_take-screenshot", { tabId: "t1" });
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /tabId is only supported for relay tools in this mode/);
  assert.deepStrictEqual(counts, { ensureBrave: 0, upstream: 0 });
});

// Spec-review regression: "stealth, then navigate" — upstream opens its page
// after stealth_apply, so the whole session context must be patched.
test("W2D legacy: stealth_apply patches the session's context, so a page opened later is covered", async () => {
  const { context, call } = legacyRelay();
  const body = await call("stealth_apply", {});
  assert.deepStrictEqual(body.applied, ["all tabs"]);
  assert.strictEqual(context.scripts.length, 1, "context.addInitScript called once");
});

test("W2D legacy: page-less tools (tabs_list, cookies_export) open no tab", async () => {
  const { context, call } = legacyRelay();
  const before = context.pages().length;
  await call("tabs_list");
  await call("cookies_export", {});
  assert.strictEqual(context.pages().length, before);
  assert.strictEqual(context.created, 0);
});

test("W2D legacy: tabs_list / tabs_select / tabs_close never launch Brave", async () => {
  const { counts, raw, call } = legacyRelay({ running: false });
  assert.deepStrictEqual(await call("tabs_list"), { count: 0, tabs: [] });
  assert.match((await raw("tabs_select", { tabId: "main" })).content[0].text, /^tabs_select: unknown tabId "main"/);
  assert.match((await raw("tabs_close", { tabId: "main" })).content[0].text, /^tabs_close: unknown tabId "main"/);
  assert.strictEqual(counts.ensureBrave, 0);
});
