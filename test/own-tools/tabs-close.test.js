const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-close.js");
const { fakeRegistry } = require("../fixtures/fake-registry.js");

const run = (args, registry, connId = "c1") => tool.handler(args, { registry, connId });
const keys = async (registry, connId = "c1") => (await registry.listTabs(connId)).map((t) => t.tabKey);

// Closing never creates a tab: getCtx is only used here to set tabs up.
async function twoTabs() {
  const registry = fakeRegistry();
  await registry.getCtx("c1", "main");
  await registry.getCtx("c1", "t1");
  await registry.getCtx("other", "t9");
  registry.getCtx = async () => { throw new Error("tabs_close must not call getCtx"); };
  return registry;
}

test("tabs_close has required tool shape: closes by tabId only", () => {
  assert.strictEqual(tool.name, "tabs_close");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.needsBrave, false, "closing never launches the browser");
  assert.deepStrictEqual(Object.keys(tool.inputSchema.properties), ["tabId"]);
  assert.deepStrictEqual(tool.inputSchema.required, ["tabId"]);
});

test("W2D: tabs_close closes the tab through the registry", async () => {
  const registry = await twoTabs();
  const page = registry.pageOf("c1", "t1");
  await page.goto("https://x.example/");
  const r = await run({ tabId: "t1" }, registry);
  assert.notStrictEqual(r.isError, true, r.content[0].text);
  assert.deepStrictEqual(JSON.parse(r.content[0].text), { closed: "t1", url: "https://x.example/", remaining: 1 });
  assert.strictEqual(page.isClosed(), true);
  assert.deepStrictEqual(await keys(registry), ["main"]);
});

test("W2D: tabs_close rejects an unknown tabId, another connection's, or none; nothing is closed", async () => {
  const registry = await twoTabs();
  for (const [args, re] of [
    [{ tabId: "t9" }, /^tabs_close: unknown tabId "t9"; call tabs_new or tabs_list/],
    [{ tabId: "nope" }, /^tabs_close: unknown tabId "nope"/],
    [{ index: 0 }, /^tabs_close: tabId is required/],
  ]) {
    const r = await run(args, registry);
    assert.strictEqual(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  }
  assert.strictEqual(registry.pageOf("other", "t9").isClosed(), false);
  assert.deepStrictEqual(await keys(registry), ["main", "t1"]);
});

test("W2D: with no browser running (no registry) every tabId is unknown", async () => {
  const r = await tool.handler({ tabId: "t1" }, {});
  assert.match(r.content[0].text, /^tabs_close: unknown tabId "t1"/);
});

test("W1C2: tabs_close returns isError when the registry fails to close, and the tab stays listed", async () => {
  const registry = await twoTabs();
  registry.closeTab = async () => { throw new Error("connection lost"); };
  const r = await run({ tabId: "t1" }, registry);
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /^tabs_close: failed to close tab t1 \(about:blank\): connection lost/);
  assert.deepStrictEqual(await keys(registry), ["main", "t1"]);
});
