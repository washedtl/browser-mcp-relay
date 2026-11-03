// W1C2: consistent error shape across the interaction/page own-tools.
// Plain-text error results from these tools start with "<tool name>: ", and
// invalid optional values are rejected (null still means "use the default").
// Not covered: errors that return a JSON payload (form_fill, file_upload,
// tabs_new navError, dialog pageClosed).

const test = require("node:test");
const assert = require("node:assert");
const { fakeRegistry } = require("../fixtures/fake-registry.js");
const { LegacyTabs } = require("../../src/own-tools/_legacy-context.js");

const load = (f) => require(`../../src/own-tools/${f}`);

function fakePage() {
  return {
    url: () => "https://x/",
    isClosed: () => false,
    once: () => {},
    off: () => {},
    close: async () => {},
  };
}

function assertToolError(tool, result) {
  assert.strictEqual(result.isError, true, `${tool.name}: expected isError`);
  assert.strictEqual(result.content[0].type, "text");
  assert.ok(result.content[0].text.startsWith(`${tool.name}: `),
    `${tool.name}: error text must start with the tool name, got: ${result.content[0].text}`);
}

test("W1C2: tabs_select / tabs_close errors carry the tool-name prefix", async () => {
  const registry = fakeRegistry();
  await registry.getCtx("c1", "main");
  const ctx = { registry, connId: "c1" };
  const tabsSelect = load("tabs-select.js");
  const tabsClose = load("tabs-close.js");
  assertToolError(tabsSelect, await tabsSelect.handler({ index: 5 }, ctx));
  assertToolError(tabsClose, await tabsClose.handler({ index: 5 }, ctx));
  assertToolError(tabsClose, await tabsClose.handler({ tabId: "nope" }, ctx));
  // Legacy mode: closing the browser's last page is refused (it would quit Brave).
  const legacy = new LegacyTabs({ context: { pages: () => [fakePage()] } });
  assertToolError(tabsClose, await tabsClose.handler({ index: 0 }, { registry: legacy, connId: "legacy" }));
});

test("W1C2: dialog_handle timeout carries the tool-name prefix", async () => {
  const tool = load("dialog-handle.js");
  assertToolError(tool, await tool.handler({ timeoutMs: 0 }, { page: fakePage() }));
});

test("W1C2: tabs_new rejects invalid waitUntil / timeoutMs instead of silently defaulting (no tab opened)", async () => {
  const tool = load("tabs-new.js");
  const registry = fakeRegistry();
  for (const args of [
    { waitUntil: "networkIdle" },
    { waitUntil: 5 },
    { timeoutMs: 50 },
    { timeoutMs: "abc" },
    { timeoutMs: 300001 },
  ]) {
    assertToolError(tool, await tool.handler(args, { registry, connId: "c1" }));
  }
  assert.deepStrictEqual(registry.listTabs("c1"), [], "no tab may be opened for rejected input");
});

test("W1C2: tabs_new still treats null waitUntil / timeoutMs as missing", async () => {
  const tool = load("tabs-new.js");
  const registry = fakeRegistry();
  const r = await tool.handler({ url: "https://example.com/", waitUntil: null, timeoutMs: null }, { registry, connId: "c1" });
  assert.notStrictEqual(r.isError, true, r.content[0].text);
  const { tabId } = JSON.parse(r.content[0].text);
  assert.deepStrictEqual(registry.pageOf("c1", tabId).gotos[0].opts, { waitUntil: "load", timeout: 30000 });
});
