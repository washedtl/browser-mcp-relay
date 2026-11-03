const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-close.js");
const { fakeRegistry } = require("../fixtures/fake-registry.js");

const run = (args, registry, connId = "c1") => tool.handler(args, { registry, connId });

async function twoTabs() {
  const registry = fakeRegistry();
  await registry.getCtx("c1", "main");
  await registry.getCtx("c1", "t1");
  return registry;
}

test("tabs_close has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_close");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.needsPage, false, "closing must not open a tab first");
  assert.ok(tool.inputSchema.properties.tabId && tool.inputSchema.properties.index);
});

test("W2D: tabs_close closes the tab named by tabId through the registry", async () => {
  const registry = await twoTabs();
  const page = registry.pageOf("c1", "t1");
  await page.goto("https://x.example/");
  const r = await run({ tabId: "t1" }, registry);
  assert.notStrictEqual(r.isError, true, r.content[0].text);
  assert.deepStrictEqual(JSON.parse(r.content[0].text), { closed: "t1", url: "https://x.example/", remaining: 1 });
  assert.strictEqual(page.isClosed(), true);
  assert.deepStrictEqual(registry.listTabs("c1"), ["main"]);
});

test("W2D: tabs_close by index uses tabs_list order", async () => {
  const registry = await twoTabs();
  await run({ index: 0 }, registry);
  assert.deepStrictEqual(registry.listTabs("c1"), ["t1"]);
});

test("W2D: tabs_close cannot close another connection's tab (or a tab that doesn't exist)", async () => {
  const registry = await twoTabs();
  await registry.getCtx("other", "t9");
  for (const tabId of ["t9", "nope"]) {
    const r = await run({ tabId }, registry);
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, new RegExp(`^tabs_close: no tab "${tabId}"`));
  }
  assert.strictEqual(registry.pageOf("other", "t9").isClosed(), false);
  assert.ok(!registry.calls.some(([m]) => m === "closeTab"), "registry.closeTab never called");
  assert.ok(!registry.calls.some(([m, conn, key]) => m === "getCtx" && conn === "c1" && (key === "t9" || key === "nope")),
    "no tab created to look it up");
});

test("V1-5: tabs_close rejects out-of-range / negative / non-integer index", async () => {
  const registry = await twoTabs();
  for (const index of [2, -1, 1.5, "abc"]) {
    const r = await run({ index }, registry);
    assert.strictEqual(r.isError, true, `index ${index}`);
    assert.match(r.content[0].text, /^tabs_close: index out of range: .* \(have 2 tabs\)/);
  }
  assert.deepStrictEqual(registry.listTabs("c1"), ["main", "t1"]);
});

test("W1C2: tabs_close returns isError when the registry fails to close, and the tab stays listed", async () => {
  const registry = await twoTabs();
  registry.closeTab = async () => { throw new Error("connection lost"); };
  const r = await run({ tabId: "t1" }, registry);
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /^tabs_close: failed to close tab t1 \(about:blank\): connection lost/);
  assert.deepStrictEqual(registry.listTabs("c1"), ["main", "t1"]);
});
