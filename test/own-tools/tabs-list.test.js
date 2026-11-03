const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-list.js");

test("tabs_list has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_list");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.type, "object");
});

test("tabs_list returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// W1C2: `active` must mark the page own-tools will actually target
// (getActivePage), including the fallback when nothing was selected yet or
// the selected page closed — not only an explicit tabs_new/tabs_select pick.
test("W1C2: tabs_list marks the effective active page when none was explicitly set", async () => {
  const { clearActivePage, setActivePage } = require("../../src/own-tools/_active-page.js");
  const prev = globalThis.__relayBridge;
  const mk = (url, closed = false) => ({ url: () => url, title: async () => url, isClosed: () => closed });
  const blank = mk("about:blank");
  const real = mk("https://example.com/");
  globalThis.__relayBridge = { context: { pages: () => [blank, real] } };
  try {
    clearActivePage();
    let payload = JSON.parse((await tool.handler({})).content[0].text);
    assert.deepStrictEqual(payload.pages.map((p) => p.active), [false, true]);

    // Selected page closed → own-tools fall back to the last page; so must `active`.
    const gone = mk("https://gone.example.com/", true);
    setActivePage(gone);
    payload = JSON.parse((await tool.handler({})).content[0].text);
    assert.deepStrictEqual(payload.pages.map((p) => p.active), [false, true]);

    setActivePage(blank);
    payload = JSON.parse((await tool.handler({})).content[0].text);
    assert.deepStrictEqual(payload.pages.map((p) => p.active), [true, false]);
  } finally {
    globalThis.__relayBridge = prev;
    clearActivePage();
  }
});
