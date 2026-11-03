// W1C2: consistent error shape across the interaction/page own-tools.
// Plain-text error results from these tools start with "<tool name>: ", and
// invalid optional values are rejected (null still means "use the default").
// Not covered: the shared "bridge missing" / "no pages open" texts, and
// errors that return a JSON payload (form_fill, file_upload, tabs_new navError,
// dialog pageClosed).

const test = require("node:test");
const assert = require("node:assert");

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

async function withBridge(bridge, fn) {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = bridge;
  try { return await fn(); } finally { globalThis.__relayBridge = prev; }
}

function assertToolError(tool, result) {
  assert.strictEqual(result.isError, true, `${tool.name}: expected isError`);
  assert.strictEqual(result.content[0].type, "text");
  assert.ok(result.content[0].text.startsWith(`${tool.name}: `),
    `${tool.name}: error text must start with the tool name, got: ${result.content[0].text}`);
}

test("W1C2: tabs_select / tabs_close errors carry the tool-name prefix", async () => {
  const pages = [fakePage()];
  const bridge = { context: { pages: () => pages } };
  const tabsSelect = load("tabs-select.js");
  const tabsClose = load("tabs-close.js");
  await withBridge(bridge, async () => {
    assertToolError(tabsSelect, await tabsSelect.handler({ index: 5 }));
    assertToolError(tabsClose, await tabsClose.handler({ index: 5 }));
    assertToolError(tabsClose, await tabsClose.handler({ index: 0 })); // last remaining page
  });
});

test("W1C2: dialog_handle timeout carries the tool-name prefix", async () => {
  const tool = load("dialog-handle.js");
  const page = fakePage();
  await withBridge({ context: { pages: () => [page] } }, async () => {
    assertToolError(tool, await tool.handler({ timeoutMs: 0 }));
  });
});

test("W1C2: tabs_new rejects invalid waitUntil / timeoutMs instead of silently defaulting (no tab opened)", async () => {
  const tool = load("tabs-new.js");
  let created = 0;
  const bridge = { context: { pages: () => [], newPage: async () => { created++; return fakePage(); } } };
  await withBridge(bridge, async () => {
    for (const args of [
      { waitUntil: "networkIdle" },
      { waitUntil: 5 },
      { timeoutMs: 50 },
      { timeoutMs: "abc" },
      { timeoutMs: 300001 },
    ]) {
      const r = await tool.handler(args);
      assertToolError(tool, r);
    }
  });
  assert.strictEqual(created, 0, "no tab may be opened for rejected input");
});

test("W1C2: tabs_new still treats null waitUntil / timeoutMs as missing", async () => {
  const tool = load("tabs-new.js");
  const pages = [];
  let gotoOpts = null;
  const bridge = {
    context: {
      pages: () => pages,
      newPage: async () => {
        const p = { ...fakePage(), goto: async (_u, o) => { gotoOpts = o; } };
        pages.push(p);
        return p;
      },
    },
  };
  const prevUp = globalThis.__relayUpstream;
  globalThis.__relayUpstream = async () => ({ request: async () => ({}) });
  try {
    await withBridge(bridge, async () => {
      const r = await tool.handler({ url: "https://example.com/", waitUntil: null, timeoutMs: null });
      assert.notStrictEqual(r.isError, true, r.content[0].text);
    });
  } finally {
    globalThis.__relayUpstream = prevUp;
  }
  assert.deepStrictEqual(gotoOpts, { waitUntil: "load", timeout: 30000 });
});
