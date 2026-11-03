// relay-legacy-tabs.test.js — W2D: legacy mode (today's per-session pool
// relay) end to end through RelayServer with the real own-tools registered.
// Own-tools get their ctx from ensureBrave's bridge; tabs are pages of the
// relay's own BrowserContext.

const test = require("node:test");
const assert = require("node:assert");
const { RelayServer } = require("../src/relay-server.js");
const { tools: ownTools } = require("../src/own-tools/index.js");

function fakePage(url = "about:blank", local = {}) {
  let closed = false;
  const page = {
    gotos: [],
    url: () => url,
    title: async () => "",
    isClosed: () => closed,
    close: async () => { closed = true; },
    goto: async (u) => { page.gotos.push(u); url = u; },
    // storage_get-local reads the page's storage through evaluate.
    evaluate: async (_fn, arg) => {
      const entries = Object.entries(local);
      return arg && arg.key != null ? { found: arg.key in local, value: local[arg.key] ?? null } : { entries, count: entries.length };
    },
  };
  return page;
}

function legacyRelay() {
  const startup = fakePage();
  const upstreamPage = fakePage("https://upstream.example/");
  const all = [startup, upstreamPage];
  const context = {
    pages: () => all.filter((p) => !p.isClosed()),
    newPage: async () => { const p = fakePage(); all.push(p); return p; },
  };
  const upstreamCalls = [];
  const relay = new RelayServer({
    getUpstream: async () => ({ request: async (m, p) => { upstreamCalls.push([m, p]); return { content: [] }; } }),
    ensureBrave: async () => ({ context, cdpConnectUrl: "http://127.0.0.1:9334" }),
    env: {},
  });
  for (const t of ownTools) relay.registerOwnTool(t);
  const call = async (name, args = {}) => {
    const r = await relay.handleToolsCall({ name, arguments: args });
    assert.notStrictEqual(r.isError, true, `${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  return { relay, context, upstreamPage, upstreamCalls, call, all };
}

test("W2D legacy: tabs_new → tabId → own-tool on that tab → tabs_list → tabs_close; one load per URL, upstream never called", async () => {
  const { context, upstreamPage, upstreamCalls, call } = legacyRelay();

  const opened = await call("tabs_new", { url: "https://a.example/" });
  assert.match(opened.tabId, /^t\d+$/);
  const tab = context.pages().at(-1);
  assert.deepStrictEqual(tab.gotos, ["https://a.example/"], "loaded once, in the new tab");
  assert.deepStrictEqual(upstreamPage.gotos, [], "upstream's page is not navigated");
  assert.deepStrictEqual(upstreamCalls, [], "no upstream navigation_go-to (the old double load)");

  // A page tool with that tabId acts on the new tab; without one, on main.
  const listedOnTab = await call("storage_get-local", { tabId: opened.tabId });
  assert.strictEqual(listedOnTab.origin, "https://a.example");
  const listedOnMain = await call("storage_get-local", {});
  assert.strictEqual(listedOnMain.origin, "https://upstream.example", "main = upstream's page");

  const tabs = await call("tabs_list");
  assert.deepStrictEqual(tabs.tabs.map((t) => [t.tabId, t.url]), [["main", "https://upstream.example/"], [opened.tabId, "https://a.example/"]]);

  const closed = await call("tabs_close", { tabId: opened.tabId });
  assert.strictEqual(closed.closed, opened.tabId);
  assert.strictEqual(tab.isClosed(), true);
  assert.deepStrictEqual((await call("tabs_list")).tabs.map((t) => t.tabId), ["main"]);
});

test("W2D legacy: page-less tools (tabs_list, cookies_export) open no tab", async () => {
  const { relay, context, call } = legacyRelay();
  context.cookies = async () => [];
  const before = context.pages().length;
  await call("tabs_list");
  const r = await relay.handleToolsCall({ name: "cookies_export", arguments: { tabId: "t42" } });
  assert.notStrictEqual(r.isError, true, r.content[0].text);
  assert.strictEqual(context.pages().length, before);
});
