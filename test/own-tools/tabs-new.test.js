const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-new.js");
const { fakeRegistry } = require("../fixtures/fake-registry.js");

const run = (args, registry, connId = "c1") => tool.handler(args, { registry, connId });
const body = (r) => JSON.parse(r.content[0].text);

test("tabs_new has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_new");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.needsPage, false, "opens its own tab; the caller's tab is not needed");
  assert.match(tool.description, /tabId/);
});

// W2D regression: tabs_new used to open a relay tab AND navigate upstream's
// page to the same URL (_propagate-active-page), so every URL loaded twice,
// in two tabs. Now the new tab is a registry tab that upstream tools use too.
test("W2D: tabs_new loads the URL exactly once, in a new registry tab, and returns its tabId", async () => {
  const registry = fakeRegistry();
  const main = (await registry.getCtx("c1", "main")).page;
  const b = body(await run({ url: "https://example.com/" }, registry));
  assert.match(b.tabId, /^t\d+$/);
  assert.notStrictEqual(b.tabId, "main");
  const page = registry.pageOf("c1", b.tabId);
  assert.deepStrictEqual(page.gotos.map((g) => g.url), ["https://example.com/"], "one navigation");
  assert.deepStrictEqual(main.gotos, [], "no other tab is navigated");
  assert.strictEqual(b.url, "https://example.com/");
  assert.strictEqual(b.navError, null);
  assert.ok(!("upstreamPropagated" in b) && !("index" in b), "no propagation / index fields");
  assert.match(b.note, /tabId/);
});

test("W2D: each tabs_new gets a fresh tabId that no existing tab uses", async () => {
  const registry = fakeRegistry();
  // An agent may have named a tab itself; tabs_new must not hand out a taken id.
  for (let i = 1; i <= 50; i++) await registry.getCtx("c1", `t${i}`);
  const a = body(await run({}, registry)).tabId;
  const b = body(await run({}, registry)).tabId;
  assert.notStrictEqual(a, b);
  for (const id of [a, b]) {
    assert.ok(!/^t([1-9]|[1-4]\d|50)$/.test(id), `${id} collides with an existing tab`);
  }
  assert.notStrictEqual(registry.pageOf("c1", a), registry.pageOf("c1", b));
});

test("W2D: tabs_new without url opens the tab and navigates nothing", async () => {
  const registry = fakeRegistry();
  const b = body(await run({}, registry));
  assert.deepStrictEqual(registry.pageOf("c1", b.tabId).gotos, []);
  assert.strictEqual(b.url, "about:blank");
});

test("W2D: tabs_new opens the tab in the calling connection only", async () => {
  const registry = fakeRegistry();
  const b = body(await run({}, registry, "c2"));
  assert.deepStrictEqual(registry.listTabs("c2"), [b.tabId]);
  assert.deepStrictEqual(registry.listTabs("c1"), []);
});

test("T0-7: tabs_new with a bad URL returns isError + navError, and the tab stays usable by its tabId", async () => {
  const registry = fakeRegistry();
  const getCtx = registry.getCtx;
  registry.getCtx = async (...a) => {
    const ctx = await getCtx(...a);
    ctx.page.failGoto = "net::ERR_NAME_NOT_RESOLVED";
    return ctx;
  };
  const r = await run({ url: "https://no-such-host.invalid/" }, registry);
  assert.strictEqual(r.isError, true);
  const b = body(r);
  assert.match(b.navError, /ERR_NAME_NOT_RESOLVED/);
  assert.deepStrictEqual(registry.listTabs("c1"), [b.tabId], "the tab exists (close it with tabs_close)");
});

test("T1-10: tabs_new passes waitUntil + timeoutMs to goto", async () => {
  const registry = fakeRegistry();
  const b = body(await run({ url: "https://example.com/", waitUntil: "networkidle", timeoutMs: 60000 }, registry));
  assert.deepStrictEqual(registry.pageOf("c1", b.tabId).gotos[0].opts, { waitUntil: "networkidle", timeout: 60000 });
});
