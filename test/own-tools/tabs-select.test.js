const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-select.js");
const { fakeRegistry } = require("../fixtures/fake-registry.js");

const run = (args, registry, connId = "c1") => tool.handler(args, { registry, connId });

async function twoTabs() {
  const registry = fakeRegistry();
  await registry.getCtx("c1", "main");
  await registry.getCtx("c1", "t1");
  return registry;
}

test("tabs_select has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_select");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.needsPage, false);
  assert.ok(tool.inputSchema.properties.tabId && tool.inputSchema.properties.index);
});

test("W2D: tabs_select brings the tab named by tabId to the front and navigates nothing", async () => {
  const registry = await twoTabs();
  const r = await run({ tabId: "t1" }, registry);
  assert.notStrictEqual(r.isError, true, r.content[0].text);
  const b = JSON.parse(r.content[0].text);
  assert.strictEqual(b.selected, "t1");
  assert.match(b.note, /tabId/, "says routing is by tabId, not by selection");
  assert.strictEqual(registry.pageOf("c1", "t1").fronted, 1);
  assert.strictEqual(registry.pageOf("c1", "main").fronted, 0);
  assert.deepStrictEqual(registry.pageOf("c1", "t1").gotos, []);
});

test("W2D: tabs_select by index uses tabs_list order", async () => {
  const registry = await twoTabs();
  assert.strictEqual(JSON.parse((await run({ index: 0 }, registry)).content[0].text).selected, "main");
  assert.strictEqual(registry.pageOf("c1", "main").fronted, 1);
});

test("W2D: tabs_select cannot reach another connection's tab", async () => {
  const registry = await twoTabs();
  await registry.getCtx("other", "t9");
  const r = await run({ tabId: "t9" }, registry);
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /^tabs_select: no tab "t9"/);
  assert.strictEqual(registry.pageOf("other", "t9").fronted, 0);
});

test("V1-5: tabs_select rejects out-of-range / negative / non-integer index with the tab count", async () => {
  const registry = await twoTabs();
  for (const index of [2, -1, 1.5, "abc"]) {
    const r = await run({ index }, registry);
    assert.strictEqual(r.isError, true, `index ${index}`);
    assert.match(r.content[0].text, /^tabs_select: index out of range: .* \(have 2 tabs\)/);
  }
});

test("W2D: tabs_select needs tabId or index", async () => {
  const r = await run({}, await twoTabs());
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /^tabs_select: pass tabId/);
});

test("tabs_select: a bringToFront failure does not fail the call (it's cosmetic)", async () => {
  const registry = await twoTabs();
  registry.pageOf("c1", "t1").bringToFront = async () => { throw new Error("Target closed"); };
  const r = await run({ tabId: "t1" }, registry);
  assert.notStrictEqual(r.isError, true);
});
