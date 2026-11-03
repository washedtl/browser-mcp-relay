// tool-context.test.js — toolContext(): the one place an own-tool call is
// routed to a tab (legacy mode and, via W2E, the broker).

const test = require("node:test");
const assert = require("node:assert");
const { toolContext, isRouted } = require("../../src/own-tools/_tool-context.js");
const { fakeRegistry } = require("../fixtures/fake-registry.js");

const EXTRAS = { context: "the-context", cdpUrl: "http://127.0.0.1:9334", relay: "the-relay" };
const keys = async (registry, connId = "c1") => (await registry.listTabs(connId)).map((t) => t.tabKey);

test("routed tool: no tabId → the connection's main tab, with the full ctx", async () => {
  const registry = fakeRegistry();
  const ctx = await toolContext(registry, "c1", {}, {}, EXTRAS);
  assert.strictEqual(ctx.page, registry.pageOf("c1", "main"));
  assert.strictEqual(ctx.context, null, "context = the tab's browserContext");
  assert.strictEqual(ctx.sessionKey, "c1:main");
  assert.strictEqual(ctx.registry, registry);
  assert.strictEqual(ctx.connId, "c1");
  assert.strictEqual(ctx.cdpUrl, EXTRAS.cdpUrl);
  assert.strictEqual(ctx.relay, EXTRAS.relay);
});

test("routed tool: a known tabId → that tab", async () => {
  const registry = fakeRegistry();
  await registry.getCtx("c1", "t3");
  const ctx = await toolContext(registry, "c1", {}, { tabId: "t3" }, EXTRAS);
  assert.strictEqual(ctx.page, registry.pageOf("c1", "t3"));
  assert.strictEqual(ctx.sessionKey, "c1:t3");
});

test("routed tool: an unknown tabId (or another connection's) is an error and opens no tab", async () => {
  const registry = fakeRegistry();
  await registry.getCtx("other", "t3");
  for (const tabId of ["t9", "t3"]) {
    await assert.rejects(toolContext(registry, "c1", {}, { tabId }, EXTRAS),
      new RegExp(`unknown tabId "${tabId}"; call tabs_new or tabs_list`));
  }
  assert.deepStrictEqual(await keys(registry), []);
});

test("routed tool: a non-string / empty tabId is an error", async () => {
  for (const tabId of [5, "", { id: "t1" }]) {
    await assert.rejects(toolContext(fakeRegistry(), "c1", {}, { tabId }, EXTRAS), /tabId must be a non-empty string/);
  }
});

test("page-less tools (needsPage:false / needsBrave:false) get no page, open no tab, and take context from the provider", async () => {
  for (const tool of [{ needsPage: false }, { needsBrave: false }]) {
    const registry = fakeRegistry();
    const ctx = await toolContext(registry, "c1", tool, { tabId: "t9" }, EXTRAS);
    assert.deepStrictEqual(Object.keys(ctx).sort(), ["bridgeManagedMatcher", "cdpUrl", "connId", "context", "registry", "relay"]);
    assert.strictEqual(ctx.context, "the-context");
    assert.strictEqual(ctx.bridgeManagedMatcher, null, "no cookie bridge (legacy mode): null");
    assert.deepStrictEqual(await keys(registry), []);
  }
});

test("isRouted: only tools that need both a browser and a page", () => {
  assert.strictEqual(isRouted({}), true);
  assert.strictEqual(isRouted({ needsPage: false }), false);
  assert.strictEqual(isRouted({ needsBrave: false }), false);
});

test("W2F: the broker's bridgeManagedMatcher reaches page-less and routed tools as it is (cookies_export hides those values)", async () => {
  const bridgeManagedMatcher = () => () => true;
  const pageless = await toolContext(fakeRegistry(), "c1", { needsPage: false }, {}, { ...EXTRAS, bridgeManagedMatcher });
  assert.strictEqual(pageless.bridgeManagedMatcher, bridgeManagedMatcher);
  const routed = await toolContext(fakeRegistry(), "c1", {}, {}, { ...EXTRAS, bridgeManagedMatcher });
  assert.strictEqual(routed.bridgeManagedMatcher, bridgeManagedMatcher);
});
