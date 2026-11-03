const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-select.js");
const { fakeRegistry } = require("../fixtures/fake-registry.js");

const run = (args, registry, connId = "c1") => tool.handler(args, { registry, connId });

// Selecting never creates a tab: getCtx is only used here to set tabs up.
async function twoTabs() {
  const registry = fakeRegistry();
  await registry.getCtx("c1", "main");
  await registry.getCtx("c1", "t1");
  await registry.getCtx("other", "t9");
  registry.getCtx = async () => { throw new Error("tabs_select must not call getCtx"); };
  return registry;
}

test("tabs_select has required tool shape: selects by tabId only", () => {
  assert.strictEqual(tool.name, "tabs_select");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.needsBrave, false);
  assert.deepStrictEqual(Object.keys(tool.inputSchema.properties), ["tabId"]);
  assert.deepStrictEqual(tool.inputSchema.required, ["tabId"]);
});

test("W2D: tabs_select brings the tab to the front and navigates nothing", async () => {
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

test("W2D: tabs_select rejects an unknown tabId, another connection's, or none", async () => {
  const registry = await twoTabs();
  for (const [args, re] of [
    [{ tabId: "t9" }, /^tabs_select: unknown tabId "t9"; call tabs_new or tabs_list/],
    [{ tabId: "nope" }, /^tabs_select: unknown tabId "nope"/],
    [{}, /^tabs_select: tabId is required/],
    [{ index: 0 }, /^tabs_select: tabId is required/],
  ]) {
    const r = await run(args, registry);
    assert.strictEqual(r.isError, true, JSON.stringify(args));
    assert.match(r.content[0].text, re);
  }
  assert.strictEqual(registry.pageOf("other", "t9").fronted, 0);
});

test("W2D: with no browser running (no registry) every tabId is unknown", async () => {
  const r = await tool.handler({ tabId: "t1" }, {});
  assert.match(r.content[0].text, /^tabs_select: unknown tabId "t1"/);
});

test("tabs_select: a bringToFront failure does not fail the call (it's cosmetic)", async () => {
  const registry = await twoTabs();
  registry.pageOf("c1", "t1").bringToFront = async () => { throw new Error("Target closed"); };
  const r = await run({ tabId: "t1" }, registry);
  assert.notStrictEqual(r.isError, true);
});
