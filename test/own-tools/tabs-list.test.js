const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-list.js");
const { fakeRegistry } = require("../fixtures/fake-registry.js");

const run = (registry, connId = "c1") => tool.handler({}, { registry, connId });
const body = (r) => JSON.parse(r.content[0].text);

test("tabs_list has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_list");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.needsPage, false, "listing must not open a tab");
});

test("W2D: tabs_list lists the calling connection's tabs with index, tabId, url and title", async () => {
  const registry = fakeRegistry();
  const main = (await registry.getCtx("c1", "main")).page;
  await main.goto("https://a.example/");
  main.titleText = "A";
  await registry.getCtx("c1", "t1");
  const b = body(await run(registry));
  assert.strictEqual(b.count, 2);
  assert.deepStrictEqual(b.tabs, [
    { index: 0, tabId: "main", url: "https://a.example/", title: "A" },
    { index: 1, tabId: "t1", url: "about:blank", title: "" },
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

test("F1-2: one broken tab (url/title throw) doesn't break the list", async () => {
  const registry = fakeRegistry();
  const bad = (await registry.getCtx("c1", "main")).page;
  bad.url = () => { throw new Error("Target closed"); };
  bad.title = async () => { throw new Error("Target closed"); };
  await registry.getCtx("c1", "t1");
  const b = body(await run(registry));
  assert.deepStrictEqual(b.tabs.map((t) => [t.tabId, t.url, t.title]), [["main", "", ""], ["t1", "about:blank", ""]]);
});
