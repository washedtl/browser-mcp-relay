// legacy-context.test.js — LegacyTabs: the SessionRegistry used in legacy
// mode (one pool relay + Brave per session): tabs are pages of the relay's
// own BrowserContext. Routing itself is toolContext (tool-context.test.js).

const test = require("node:test");
const assert = require("node:assert");
const { LegacyTabs, legacyRegistry, LEGACY_CONN } = require("../../src/own-tools/_legacy-context.js");
const { fakePage, fakeContext } = require("../fixtures/fake-registry.js");

const C = LEGACY_CONN;
const keys = async (tabs) => (await tabs.listTabs(C)).map((t) => t.tabKey);

test("legacy: main is the newest page no named tab owns (upstream's page), not Brave's startup about:blank", async () => {
  const context = fakeContext([fakePage(), fakePage("https://up/")]);
  const tabs = new LegacyTabs(context);
  const ctx = await tabs.getCtx(C, "main");
  assert.strictEqual(ctx.page, context.pages()[1]);
  assert.strictEqual(ctx.browserContext, context);
});

// V2-1: an OAuth / window.open popup must not hijack main.
test("legacy: a popup (a page with an opener) never becomes main", async () => {
  const upstreamPage = fakePage("https://up/");
  const popup = fakePage("https://login.example/", { opener: async () => upstreamPage });
  const tabs = new LegacyTabs(fakeContext([fakePage(), upstreamPage, popup]));
  assert.strictEqual((await tabs.getCtx(C)).page, upstreamPage);
  assert.deepStrictEqual(await keys(tabs), ["main"]);
});

// V2-2: one hung newPage must not block main-routed calls and tabs_list.
test("legacy: a hung named-tab creation is waited for only briefly", async () => {
  const context = fakeContext([fakePage("https://up/")]);
  const tabs = new LegacyTabs(context, { settleTimeoutMs: 20 });
  context.newPage = () => new Promise(() => {}); // never settles
  tabs.getCtx(C, "t1"); // left hanging on purpose
  const started = Date.now();
  assert.deepStrictEqual(await keys(tabs), ["main"]);
  assert.strictEqual((await tabs.getCtx(C)).page, context.pages()[0]);
  assert.ok(Date.now() - started < 1000, "not blocked by the hung creation");
});

test("legacy: a named tab gets its own page once; main does not move to it", async () => {
  const context = fakeContext([fakePage("https://up/")]);
  const tabs = new LegacyTabs(context);
  const t1 = await tabs.getCtx(C, "t1");
  assert.notStrictEqual(t1.page, context.pages()[0]);
  assert.strictEqual((await tabs.getCtx(C, "t1")).page, t1.page);
  assert.strictEqual(context.created, 1);
  assert.strictEqual((await tabs.getCtx(C)).page, context.pages()[0], "default tab key is main");
});

test("legacy: concurrent first uses of one tab key share one page (no orphan)", async () => {
  const context = fakeContext([fakePage("https://up/")]);
  const tabs = new LegacyTabs(context);
  const [a, b] = await Promise.all([tabs.getCtx(C, "t1"), tabs.getCtx(C, "t1")]);
  assert.strictEqual(a.page, b.page);
  assert.strictEqual(context.created, 1);
});

test("legacy: concurrent calls on an empty browser open ONE main page", async () => {
  const context = fakeContext([]);
  const tabs = new LegacyTabs(context);
  const [a, b] = await Promise.all([tabs.getCtx(C), tabs.getCtx(C)]);
  assert.strictEqual(a.page, b.page);
  assert.strictEqual(context.created, 1);
});

test("legacy: a failed page creation is not cached", async () => {
  const context = fakeContext([fakePage()]);
  const realNewPage = context.newPage;
  context.newPage = async () => { throw new Error("Target closed"); };
  const tabs = new LegacyTabs(context);
  await assert.rejects(tabs.getCtx(C, "t1"), /Target closed/);
  assert.deepStrictEqual(await keys(tabs), ["main"]);
  context.newPage = realNewPage;
  assert.ok((await tabs.getCtx(C, "t1")).page);
});

test("legacy: listTabs gives [{ tabKey, page }] (main first), drops closed tabs, and never creates a page", async () => {
  const context = fakeContext([fakePage("https://up/")]);
  const tabs = new LegacyTabs(context);
  const t1 = await tabs.getCtx(C, "t1");
  const t2 = await tabs.getCtx(C, "t2");
  assert.deepStrictEqual(await tabs.listTabs(C), [
    { tabKey: "main", page: context.pages()[0] },
    { tabKey: "t1", page: t1.page },
    { tabKey: "t2", page: t2.page },
  ]);
  await t2.page.close();
  assert.deepStrictEqual(await keys(tabs), ["main", "t1"]);
  const empty = fakeContext([]);
  assert.deepStrictEqual(await new LegacyTabs(empty).listTabs(C), []);
  assert.strictEqual(empty.created, 0);
});

test("legacy: closeTab closes a named tab's page and forgets it", async () => {
  const tabs = new LegacyTabs(fakeContext([fakePage("https://up/")]));
  const t1 = await tabs.getCtx(C, "t1");
  await tabs.closeTab(C, "t1");
  assert.strictEqual(t1.page.isClosed(), true);
  assert.deepStrictEqual(await keys(tabs), ["main"]);
});

test("legacy: closeTab refuses to close the browser's last page (that would close Brave)", async () => {
  const only = fakePage("https://up/");
  const tabs = new LegacyTabs(fakeContext([only]));
  await assert.rejects(tabs.closeTab(C, "main"), /last remaining page/);
  assert.strictEqual(only.isClosed(), false);
});

test("legacy: closeTab of an unknown tab rejects without touching any page", async () => {
  const context = fakeContext([fakePage(), fakePage()]);
  await assert.rejects(new LegacyTabs(context).closeTab(C, "nope"), /no tab "nope"/);
  assert.strictEqual(context.pages().length, 2);
});

test("legacy: registry.scope is \"context\": the caller's session owns registry.context", () => {
  const context = fakeContext([]);
  const tabs = new LegacyTabs(context);
  assert.strictEqual(tabs.scope, "context");
  assert.strictEqual(tabs.context, context);
});

test("legacyRegistry: one per BrowserContext (a relaunched Brave starts fresh)", () => {
  const a = fakeContext([]);
  assert.strictEqual(legacyRegistry(a), legacyRegistry(a));
  assert.notStrictEqual(legacyRegistry(a), legacyRegistry(fakeContext([])));
});
