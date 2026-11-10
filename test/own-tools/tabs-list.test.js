const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-list.js");
const { fakeRegistry } = require("../fixtures/fake-registry.js");

// Listing must never create a tab (or relaunch Brave): getCtx is off-limits.
function listOnly(registry) {
  registry.getCtx = async () => { throw new Error("tabs_list must not call getCtx"); };
  return registry;
}
const run = (registry, connId = "c1") => tool.handler({}, { registry: registry && listOnly(registry), connId });
const body = (r) => JSON.parse(r.content[0].text);

test("tabs_list has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_list");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.needsBrave, false, "listing never launches the browser");
});

test("tabs_list: a tab that can't answer (page stuck in a loop) doesn't hold up the list", async () => {
  const registry = fakeRegistry();
  (await registry.getCtx("c1", "main")).page.title = () => new Promise(() => {});
  await registry.getCtx("c1", "t1");
  const t0 = Date.now();
  const b = body(await run(registry));
  assert.ok(Date.now() - t0 < 5000);
  assert.strictEqual(b.count, 2);
  assert.strictEqual(b.tabs.find((x) => x.tabId === "main").title, "");
});

test("W2D: tabs_list lists the calling connection's tabs with tabId, url and title", async () => {
  const registry = fakeRegistry();
  const main = (await registry.getCtx("c1", "main")).page;
  await main.goto("https://a.example/");
  main.titleText = "A";
  await registry.getCtx("c1", "t1");
  const b = body(await run(registry));
  assert.strictEqual(b.count, 2);
  assert.deepStrictEqual(b.tabs, [
    { tabId: "main", url: "https://a.example/", title: "A" },
    { tabId: "t1", url: "about:blank", title: "" },
  ]);
});

test("W2D: tabs_list never shows another connection's tabs", async () => {
  const registry = fakeRegistry();
  await registry.getCtx("other", "main");
  await registry.getCtx("other", "t7");
  await registry.getCtx("c1", "main");
  assert.deepStrictEqual(body(await run(registry)).tabs.map((t) => t.tabId), ["main"]);
  assert.strictEqual(body(await run(registry, "nobody")).count, 0);
});

test("W2D: with no browser running (no registry) the list is empty", async () => {
  assert.deepStrictEqual(body(await tool.handler({}, {})), { count: 0, tabs: [] });
});

test("F1-2: a broken tab (url/title throw) or one without a page doesn't break the list", async () => {
  const registry = fakeRegistry();
  const bad = (await registry.getCtx("c1", "main")).page;
  bad.url = () => { throw new Error("Target closed"); };
  bad.title = async () => { throw new Error("Target closed"); };
  const listTabs = registry.listTabs;
  registry.listTabs = async (c) => [...(await listTabs(c)), { tabKey: "t2", page: null }];
  const b = body(await run(registry));
  assert.deepStrictEqual(b.tabs, [{ tabId: "main", url: "", title: "" }, { tabId: "t2", url: "", title: "" }]);
});
