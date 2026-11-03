// legacy-context.test.js — the legacy (per-session pool relay) tool context.
// Own-tools get { page, context, registry, connId, ... } in both modes; in
// legacy mode the registry is a small tab map over the relay's own Brave.

const test = require("node:test");
const assert = require("node:assert");
const { legacyToolContext, LegacyTabs, LEGACY_CONN } = require("../../src/own-tools/_legacy-context.js");

function fakePage(url = "about:blank") {
  let closed = false;
  const page = {
    url: () => url,
    isClosed: () => closed,
    close: async () => { closed = true; },
    goto: async (u) => { url = u; },
  };
  return page;
}

function fakeContext(initial = []) {
  const all = [...initial];
  let created = 0;
  return {
    get created() { return created; },
    pages: () => all.filter((p) => !p.isClosed()),
    newPage: async () => { created++; const p = fakePage(); all.push(p); return p; },
  };
}

const bridgeFor = (context) => ({ context, cdpConnectUrl: "http://127.0.0.1:9334" });

test("legacy: main is the newest page no named tab owns (upstream's page), not Brave's startup about:blank", async () => {
  const blank = fakePage();
  const upstreamPage = fakePage("https://up/");
  const tabs = new LegacyTabs(bridgeFor(fakeContext([blank, upstreamPage])));
  const ctx = await tabs.getCtx(LEGACY_CONN, "main");
  assert.strictEqual(ctx.page, upstreamPage);
  assert.strictEqual(ctx.connId, LEGACY_CONN);
  assert.strictEqual(ctx.sessionKey, `${LEGACY_CONN}:main`);
  assert.strictEqual(ctx.registry, tabs);
  assert.strictEqual(ctx.cdpUrl, "http://127.0.0.1:9334");
});

test("legacy: a named tab gets its own page once; main does not move to it", async () => {
  const upstreamPage = fakePage("https://up/");
  const context = fakeContext([upstreamPage]);
  const tabs = new LegacyTabs(bridgeFor(context));
  const t1 = await tabs.getCtx(LEGACY_CONN, "t1");
  assert.notStrictEqual(t1.page, upstreamPage);
  assert.strictEqual((await tabs.getCtx(LEGACY_CONN, "t1")).page, t1.page, "same tab, same page");
  assert.strictEqual(context.created, 1);
  assert.strictEqual((await tabs.getCtx(LEGACY_CONN, "main")).page, upstreamPage);
});

test("legacy: main opens a page when the context has none; a closed named tab is reopened", async () => {
  const context = fakeContext([]);
  const tabs = new LegacyTabs(bridgeFor(context));
  const main = await tabs.getCtx(LEGACY_CONN);
  assert.ok(main.page, "default tab key is main");
  assert.strictEqual(context.created, 1);
  const t1 = await tabs.getCtx(LEGACY_CONN, "t1");
  await t1.page.close();
  const again = await tabs.getCtx(LEGACY_CONN, "t1");
  assert.notStrictEqual(again.page, t1.page);
  assert.strictEqual(again.page.isClosed(), false);
});

test("legacy: listTabs lists main (when a page exists) then named tabs, dropping closed ones", async () => {
  const context = fakeContext([fakePage("https://up/")]);
  const tabs = new LegacyTabs(bridgeFor(context));
  await tabs.getCtx(LEGACY_CONN, "t1");
  const t2 = await tabs.getCtx(LEGACY_CONN, "t2");
  assert.deepStrictEqual(await tabs.listTabs(LEGACY_CONN), ["main", "t1", "t2"]);
  await t2.page.close();
  assert.deepStrictEqual(await tabs.listTabs(LEGACY_CONN), ["main", "t1"]);
  assert.deepStrictEqual(await new LegacyTabs(bridgeFor(fakeContext([]))).listTabs(LEGACY_CONN), []);
});

test("legacy: closeTab closes a named tab's page and forgets it", async () => {
  const context = fakeContext([fakePage("https://up/")]);
  const tabs = new LegacyTabs(bridgeFor(context));
  const t1 = await tabs.getCtx(LEGACY_CONN, "t1");
  await tabs.closeTab(LEGACY_CONN, "t1");
  assert.strictEqual(t1.page.isClosed(), true);
  assert.deepStrictEqual(await tabs.listTabs(LEGACY_CONN), ["main"]);
});

test("legacy: closeTab refuses to close the browser's last page (that would close Brave)", async () => {
  const only = fakePage("https://up/");
  const tabs = new LegacyTabs(bridgeFor(fakeContext([only])));
  await assert.rejects(tabs.closeTab(LEGACY_CONN, "main"), /last remaining page/);
  assert.strictEqual(only.isClosed(), false);
});

test("legacy: closeTab of an unknown tab rejects without touching any page", async () => {
  const context = fakeContext([fakePage(), fakePage()]);
  const tabs = new LegacyTabs(bridgeFor(context));
  await assert.rejects(tabs.closeTab(LEGACY_CONN, "nope"), /no tab "nope"/);
  assert.strictEqual(context.pages().length, 2);
});

test("legacyToolContext: routes args.tabId (default main) and adds no relay", async () => {
  const upstreamPage = fakePage("https://up/");
  const bridge = bridgeFor(fakeContext([upstreamPage]));
  const main = await legacyToolContext(bridge, {}, {});
  assert.strictEqual(main.page, upstreamPage);
  assert.strictEqual(main.context, bridge.context);
  const t1 = await legacyToolContext(bridge, {}, { tabId: "t1" });
  assert.notStrictEqual(t1.page, upstreamPage);
  assert.strictEqual(t1.sessionKey, `${LEGACY_CONN}:t1`);
  assert.strictEqual((await legacyToolContext(bridge, {}, { tabId: null })).page, upstreamPage, "null tabId = main");
});

test("legacyToolContext: needsPage:false opens no tab and carries no page", async () => {
  const context = fakeContext([]);
  const ctx = await legacyToolContext(bridgeFor(context), { needsPage: false }, { tabId: "t9" });
  assert.strictEqual(ctx.page, undefined);
  assert.strictEqual(context.created, 0);
  assert.strictEqual(ctx.context, context);
  assert.strictEqual(ctx.connId, LEGACY_CONN);
  assert.strictEqual(ctx.cdpUrl, "http://127.0.0.1:9334");
  assert.ok(ctx.registry instanceof LegacyTabs);
});

test("legacyToolContext: a non-string tabId is rejected", async () => {
  const bridge = bridgeFor(fakeContext([fakePage()]));
  for (const tabId of [5, "", { id: "t1" }]) {
    await assert.rejects(legacyToolContext(bridge, {}, { tabId }), /tabId must be a non-empty string/);
  }
});

test("legacyToolContext: one tab registry per BrowserContext (a relaunched Brave starts fresh)", async () => {
  const contextA = fakeContext([fakePage()]);
  const a1 = await legacyToolContext(bridgeFor(contextA), {}, {});
  const a2 = await legacyToolContext(bridgeFor(contextA), {}, {});
  const b = await legacyToolContext(bridgeFor(fakeContext([fakePage()])), {}, {});
  assert.strictEqual(a1.registry, a2.registry);
  assert.notStrictEqual(a1.registry, b.registry);
});
