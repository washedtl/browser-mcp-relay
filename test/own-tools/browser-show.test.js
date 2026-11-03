const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/browser-show.js");
const { PAGE_CDP_SESSIONS } = require("../../src/own-tools/_page-cdp-session.js");

const VISIBLE = { left: 40, top: 40, width: 1280, height: 900, windowState: "normal" };
const PRIMARY = { left: 0, top: 0, width: 1920, height: 1040 };

// A page whose window starts with `bounds` (states: minimized → normal on
// restore) on a display reported by window.screen.
function makeWindow({ bounds, display = PRIMARY, evaluateFails = false }) {
  const sent = [];
  let current = { ...bounds };
  const cdp = {
    send: async (method, params) => {
      sent.push({ method, params });
      if (method === "Browser.getWindowForTarget") return { windowId: 7, bounds: { ...current } };
      if (method === "Browser.setWindowBounds") {
        if (params.bounds.windowState === "normal") current = { ...current, windowState: "normal", left: 100, top: 100 };
        else current = { ...current, ...params.bounds };
      }
      return {};
    },
    detach: async () => {},
  };
  const page = {
    fronted: 0,
    url: () => "https://login.example/",
    once() {},
    bringToFront: async () => { page.fronted++; },
    evaluate: async () => { if (evaluateFails) throw new Error("no JS here"); return display; },
  };
  const attached = [];
  const context = { newCDPSession: async (p) => { attached.push(p); return cdp; } };
  return { page, context, sent, attached, bounds: () => current };
}

async function show(w) {
  try {
    const r = await tool.handler({}, { page: w.page, context: w.context });
    assert.notStrictEqual(r.isError, true, r.content[0].text);
    return JSON.parse(r.content[0].text);
  } finally {
    PAGE_CDP_SESSIONS.delete(w.page);
  }
}

const setBounds = (w) => w.sent.filter((s) => s.method === "Browser.setWindowBounds").map((s) => s.params);

test("browser_show has required tool shape and acts on the routed tab", () => {
  assert.strictEqual(tool.name, "browser_show");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.notStrictEqual(tool.needsPage, false, "routed by tabId like any page tool");
  assert.match(tool.description, /log in|2FA/i);
});

test("W2D: browser_show restores a minimized window, then brings it to the front", async () => {
  const w = makeWindow({ bounds: { ...VISIBLE, windowState: "minimized" } });
  const b = await show(w);
  assert.deepStrictEqual(setBounds(w), [{ windowId: 7, bounds: { windowState: "normal" } }]);
  assert.strictEqual(w.page.fronted, 1);
  assert.deepStrictEqual(b, { shown: true, url: "https://login.example/", restored: true, movedOnScreen: false });
});

test("W2D: browser_show moves an off-screen window onto the display", async () => {
  const w = makeWindow({ bounds: { ...VISIBLE, left: -10000 } });
  const b = await show(w);
  assert.deepStrictEqual(setBounds(w), [{ windowId: 7, bounds: { left: 40, top: 40 } }]);
  assert.strictEqual(b.movedOnScreen, true);
  assert.strictEqual(w.page.fronted, 1);
});

test("W2D: a visible window (incl. one on a monitor left of the primary) is only brought to the front", async () => {
  for (const [bounds, display] of [
    [VISIBLE, PRIMARY],
    [{ ...VISIBLE, left: -1500 }, { left: -1920, top: 0, width: 1920, height: 1040 }],
  ]) {
    const w = makeWindow({ bounds, display });
    const b = await show(w);
    assert.deepStrictEqual(setBounds(w), []);
    assert.deepStrictEqual([b.restored, b.movedOnScreen], [false, false]);
    assert.strictEqual(w.page.fronted, 1);
  }
});

test("W2D: when the display can't be read (no JS on the page), the window is not moved", async () => {
  const w = makeWindow({ bounds: { ...VISIBLE, left: -10000 }, evaluateFails: true });
  const b = await show(w);
  assert.deepStrictEqual(setBounds(w), []);
  assert.strictEqual(b.movedOnScreen, false);
  assert.strictEqual(w.page.fronted, 1);
});

test("W2D: browser_show attaches to ctx.page, not another page", async () => {
  const w = makeWindow({ bounds: VISIBLE });
  await show(w);
  assert.deepStrictEqual(w.attached, [w.page]);
});
