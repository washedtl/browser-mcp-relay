const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/browser-show.js");
const wp = require("../../src/broker/window-pages.js");
const { OFFSCREEN_LEFT } = wp;

/** Run fn with the broker's window placement set to "offscreen" (hooks installed meanwhile). */
async function underOffscreenPlacement(fn) {
  const uninstall = wp.installWindowPerPage({ placement: "offscreen" });
  try {
    return await fn();
  } finally {
    uninstall();
  }
}

const VISIBLE = { left: 40, top: 40, width: 1280, height: 900, windowState: "normal" };

// A page whose window starts with `bounds` (minimized → normal on restore),
// reached the way W2B's window-pages reaches it: a browser-level CDP session
// addressed by the page's targetId.
function makeWindow({ bounds }) {
  const sent = [];
  let current = { ...bounds };
  const browserSession = {
    send: async (method, params) => {
      sent.push({ method, params });
      if (method === "Browser.getWindowForTarget") {
        assert.strictEqual(params.targetId, "T-1", "addresses the page's own target");
        return { windowId: 7, bounds: { ...current } };
      }
      if (method === "Browser.setWindowBounds") current = { ...current, ...params.bounds };
      return {};
    },
  };
  const browser = { newBrowserCDPSession: async () => browserSession };
  const attached = [];
  const page = {
    fronted: 0,
    evaluated: 0,
    isClosed: () => false,
    url: () => "https://login.example/",
    bringToFront: async () => { page.fronted++; },
    evaluate: async () => { page.evaluated++; },
    context: () => context,
  };
  const context = {
    browser: () => browser,
    newCDPSession: async (p) => {
      attached.push(p);
      return { send: async () => ({ targetInfo: { targetId: "T-1" } }), detach: async () => {} };
    },
  };
  return { page, context, sent, attached, bounds: () => current };
}

async function show(w) {
  const r = await tool.handler({}, { page: w.page, context: w.context });
  assert.notStrictEqual(r.isError, true, r.content[0].text);
  return JSON.parse(r.content[0].text);
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

test("browser_show restores a minimized window, then brings it to the front", async () => {
  const w = makeWindow({ bounds: { ...VISIBLE, windowState: "minimized" } });
  const b = await show(w);
  assert.deepStrictEqual(setBounds(w), [{ windowId: 7, bounds: { windowState: "normal" } }]);
  assert.strictEqual(w.page.fronted, 1);
  assert.deepStrictEqual(b, { shown: true, url: "https://login.example/", restored: true, movedOnScreen: false });
});

test("browser_show, broker placement 'offscreen': moves the window to a visible cascade slot, once per page", async () => {
  const w = makeWindow({ bounds: { ...VISIBLE, left: OFFSCREEN_LEFT } });
  const b = await underOffscreenPlacement(() => show(w));
  const moves = setBounds(w);
  assert.strictEqual(moves.length, 1);
  assert.strictEqual(moves[0].windowId, 7);
  assert.deepStrictEqual(Object.keys(moves[0].bounds).sort(), ["left", "top"]);
  assert.ok(moves[0].bounds.left >= 40 && moves[0].bounds.top >= 40, JSON.stringify(moves[0]));
  assert.strictEqual(b.movedOnScreen, true);
  assert.strictEqual(w.page.fronted, 1);
  const again = await underOffscreenPlacement(() => show(w));
  assert.strictEqual(again.movedOnScreen, false, "already on-screen: not moved again");
  assert.strictEqual(setBounds(w).length, 1);
});

test("cascade placement or no broker (legacy): a window is never moved, wherever it is; only brought to the front", async () => {
  for (const left of [40, -1500, -3800, OFFSCREEN_LEFT]) {
    const w = makeWindow({ bounds: { ...VISIBLE, left } });
    const b = await show(w);
    assert.deepStrictEqual(setBounds(w), [], `left=${left}`);
    assert.deepStrictEqual([b.restored, b.movedOnScreen], [false, false]);
    assert.strictEqual(w.page.fronted, 1);
  }
});

// An open alert() blocks page JS: the window calls never run page JS.
test("browser_show runs no page JS (a blocked page still comes forward)", async () => {
  const w = makeWindow({ bounds: { ...VISIBLE, left: OFFSCREEN_LEFT, windowState: "minimized" } });
  await show(w);
  assert.strictEqual(w.page.evaluated, 0);
});

test("browser_show attaches to ctx.page, not another page", async () => {
  const w = makeWindow({ bounds: VISIBLE });
  await show(w);
  assert.ok(w.attached.length > 0 && w.attached.every((p) => p === w.page));
});
