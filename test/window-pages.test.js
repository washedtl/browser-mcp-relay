// window-pages.test.js — W2B (v0.4 shared broker).
//
// Every page the broker creates gets its own browser window (background tabs
// stall screenshots; separate windows don't), placed `cascade` (visible) or
// `offscreen` (rendering, out of the way). Minimized windows do stall, so
// ensureNotMinimized() restores them before work.
//
// Unit checks need no browser. The live block launches a throwaway Brave
// (test/fixtures/temp-brave.js) and skips cleanly when Brave is absent.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { createRequire } = require("node:module");

for (const k of ["FIGMA_ACCESS_TOKEN", "AVAILABLE_TOOL_DOMAINS", "TOOL_NAME_PREFIX", "PLATFORM", "BROWSER_RELAY_UPSTREAM_PATH"]) {
  delete process.env[k];
}

const wp = require("../src/broker/window-pages.js");
const up = require("../src/broker/upstream-inproc.js");
const { BRAVE_PATH, braveAvailable, headfulRequested, launchTempBrave, makeProfileDir, removeProfile } = require("./fixtures/temp-brave.js");

/** Client classes of the playwright-core that upstream itself loads. */
function upstreamPlaywrightCoreDir() {
  const upReq = createRequire(require.resolve("browser-devtools-mcp/package.json"));
  return path.dirname(createRequire(upReq.resolve("playwright")).resolve("playwright-core/package.json"));
}
const upstreamBrowserContextClass = () => require(path.join(upstreamPlaywrightCoreDir(), "lib", "client", "browserContext.js")).BrowserContext;
const upstreamBrowserTypeClass = () => require(path.join(upstreamPlaywrightCoreDir(), "lib", "client", "browserType.js")).BrowserType;

// ─────────────────── placement (pure) ───────────────────

test("windowBounds: cascade steps each new window down-right and wraps after 8", () => {
  assert.deepStrictEqual(wp.windowBounds("cascade", 0), { left: 40, top: 40, width: 1280, height: 900 });
  assert.deepStrictEqual(wp.windowBounds("cascade", 1), { left: 88, top: 76, width: 1280, height: 900 });
  assert.deepStrictEqual(wp.windowBounds("cascade", 8), wp.windowBounds("cascade", 0));
});

test("windowBounds: offscreen puts the whole window left of every display origin", () => {
  const b = wp.windowBounds("offscreen", 3);
  assert.strictEqual(b.left, wp.OFFSCREEN_LEFT);
  assert.ok(b.left + b.width < 0, "no part of the window may sit at x >= 0");
  assert.strictEqual(b.width, 1280);
  assert.strictEqual(b.height, 900);
});

test("installWindowPerPage: rejects an unknown placement", () => {
  assert.throws(() => wp.installWindowPerPage({ placement: "minimized" }), /placement/);
});

// ─────────────────── the newPage hook (fake contexts) ───────────────────

test("makeNewPage: a browser not attached over CDP keeps Playwright's newPage, even for its first context", async () => {
  // launchPersistentContext / launch(): browser() is set and contexts()[0]
  // is the context in use, exactly like a CDP default context.
  const calls = [];
  const orig = async function (...a) { calls.push({ self: this, a }); return "orig-page"; };
  const hooked = wp.makeNewPage(orig, () => "cascade", () => false);
  const ctx = {};
  const browser = { contexts: () => [ctx] };
  ctx.browser = () => browser;
  assert.strictEqual(await hooked.call(ctx, "x"), "orig-page");
  assert.deepStrictEqual(calls, [{ self: ctx, a: ["x"] }]);
});

test("makeNewPage: on a CDP browser only the default context is redirected to new windows", async () => {
  let origCalls = 0;
  const orig = async function () { origCalls++; return "orig-page"; };
  const hooked = wp.makeNewPage(orig, () => "cascade", () => true);
  const defaultCtx = {};
  const other = {};
  const browser = { contexts: () => [defaultCtx, other] };
  other.browser = () => browser;
  assert.strictEqual(await hooked.call(other), "orig-page", "newContext() pages stay in their own context");
  assert.strictEqual(origCalls, 1);
});

test("install/uninstall: hooks upstream's newPage + connectOverCDP once and restores both", (t) => {
  const BrowserContext = upstreamBrowserContextClass();
  const BrowserType = upstreamBrowserTypeClass();
  const original = BrowserContext.prototype.newPage;
  const originalConnect = BrowserType.prototype.connectOverCDP;
  t.after(() => { BrowserContext.prototype.newPage = original; BrowserType.prototype.connectOverCDP = originalConnect; });
  const uninstall = wp.installWindowPerPage({ placement: "cascade" });
  const hooked = BrowserContext.prototype.newPage;
  assert.notStrictEqual(hooked, original);
  assert.notStrictEqual(BrowserType.prototype.connectOverCDP, originalConnect, "CDP attaches are recorded");
  assert.strictEqual(wp.installWindowPerPage({ placement: "offscreen" }), uninstall, "second install reuses the hook");
  assert.strictEqual(BrowserContext.prototype.newPage, hooked, "no double wrap");
  assert.strictEqual(wp.currentPlacement(), "offscreen", "second install switches placement");
  uninstall();
  assert.strictEqual(BrowserContext.prototype.newPage, original);
  assert.strictEqual(BrowserType.prototype.connectOverCDP, originalConnect);
  assert.strictEqual(wp.currentPlacement(), null);
  uninstall(); // idempotent
});

// ─────────────────── live: real Brave, real upstream contexts ───────────────────

test.describe("live windows", { skip: braveAvailable() ? false : "Brave not installed" }, () => {
  let brave;
  let upstream;
  let uninstall;
  const ctxs = [];
  let bcdp;

  async function windowOf(page) {
    const s = await page.context().newCDPSession(page);
    const { targetInfo } = await s.send("Target.getTargetInfo");
    await s.detach().catch(() => {});
    return bcdp.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
  }
  async function newCtx(key) {
    const ctx = await upstream.createContext(key);
    ctxs.push(ctx);
    return ctx;
  }

  test.before(async () => {
    brave = await launchTempBrave({ label: "windows" });
    upstream = await up.loadUpstream({ cdpUrl: brave.cdpUrl });
    uninstall = wp.installWindowPerPage({ placement: "cascade" });
    const first = await newCtx("w:first");
    bcdp = await first.browserContext.browser().newBrowserCDPSession();
  });
  test.after(async () => {
    for (const c of ctxs) { try { await c.close(); } catch {} }
    if (uninstall) uninstall();
    if (brave) {
      await brave.close(); // graceful Browser.close, kill fallback, profile removed
    }
  });

  test("each upstream session page opens in its own window, in the default context", async () => {
    const a = await newCtx("w:a");
    const b = await newCtx("w:b");
    const [wa, wb] = await Promise.all([windowOf(a.page), windowOf(b.page)]);
    assert.notStrictEqual(wa.windowId, wb.windowId);
    assert.notDeepStrictEqual([wa.bounds.left, wa.bounds.top], [wb.bounds.left, wb.bounds.top], "cascade offsets each window");
    const defaultCtx = a.browserContext.browser().contexts()[0];
    assert.strictEqual(a.page.context(), defaultCtx);
    assert.strictEqual(b.page.context(), defaultCtx);
  });

  test("concurrent newPage calls each get their own page and window", async () => {
    const defaultCtx = ctxs[0].browserContext.browser().contexts()[0];
    const pages = await Promise.all([1, 2, 3].map(() => defaultCtx.newPage()));
    try {
      assert.strictEqual(new Set(pages).size, 3);
      const windows = await Promise.all(pages.map(windowOf));
      assert.strictEqual(new Set(windows.map((w) => w.windowId)).size, 3);
      for (const p of pages) assert.ok(defaultCtx.pages().includes(p));
    } finally {
      for (const p of pages) await p.close();
    }
  });

  test("offscreen placement: the window sits off-screen and still renders", async () => {
    wp.installWindowPerPage({ placement: "offscreen" });
    try {
      const ctx = await newCtx("w:off");
      const w = await windowOf(ctx.page);
      assert.strictEqual(w.bounds.left, wp.OFFSCREEN_LEFT);
      assert.strictEqual(w.bounds.windowState, "normal");
      const frames = await ctx.page.evaluate(() => new Promise((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve(n); };
        requestAnimationFrame(tick);
      }));
      assert.ok(frames >= 30, `offscreen window throttled: ${frames} rAF/s`);
    } finally {
      wp.installWindowPerPage({ placement: "cascade" });
    }
  });

  test("ensureNotMinimized restores a minimized window and is a no-op otherwise", async () => {
    const ctx = await newCtx("w:min");
    const w = await windowOf(ctx.page);
    assert.strictEqual(await wp.ensureNotMinimized(ctx.page), false, "normal window: nothing to do");
    await bcdp.send("Browser.setWindowBounds", { windowId: w.windowId, bounds: { windowState: "minimized" } });
    assert.strictEqual((await windowOf(ctx.page)).bounds.windowState, "minimized");
    assert.strictEqual(await wp.ensureNotMinimized(ctx.page), true);
    assert.strictEqual((await windowOf(ctx.page)).bounds.windowState, "normal");
    assert.strictEqual(await wp.ensureNotMinimized(ctx.page), false);
  });

  test("W2E showWindow (browser_show): restores a minimized window, brings an off-screen one to a cascade slot, leaves a visible one", async () => {
    wp.installWindowPerPage({ placement: "offscreen" });
    let ctx;
    try {
      ctx = await newCtx("w:show");
    } finally {
      wp.installWindowPerPage({ placement: "cascade" });
    }
    const w = await windowOf(ctx.page);
    assert.strictEqual(w.bounds.left, wp.OFFSCREEN_LEFT);
    await bcdp.send("Browser.setWindowBounds", { windowId: w.windowId, bounds: { windowState: "minimized" } });
    assert.deepStrictEqual(await wp.showWindow(ctx.page), { restored: true, movedOnScreen: true });
    const shown = (await windowOf(ctx.page)).bounds;
    assert.strictEqual(shown.windowState, "normal");
    assert.ok(shown.left >= 0 && shown.top >= 0, `on-screen now: ${JSON.stringify(shown)}`);
    assert.deepStrictEqual(await wp.showWindow(ctx.page), { restored: false, movedOnScreen: false }, "already in view");
  });

  test("ensureNotMinimized: a closed page is a no-op (upstream re-opens it in a new window)", async () => {
    const ctx = await newCtx("w:closed");
    await ctx.page.close();
    assert.strictEqual(await wp.ensureNotMinimized(ctx.page), false);
  });

  test("a page upstream re-creates after close gets a new window of its own", async () => {
    const a = await newCtx("w:swapA");
    const b = await newCtx("w:swapB");
    const wb = await windowOf(b.page);
    const old = a.page;
    const oldWindow = await windowOf(old);
    await old.close();
    const getText = upstream.tools.find((t) => t.name === "content_get-as-text").tool;
    await upstream.execute(a, getText, {});
    assert.notStrictEqual(a.page, old);
    const wa = await windowOf(a.page);
    assert.notStrictEqual(wa.windowId, wb.windowId, "re-created page must not land in another session's window");
    assert.notStrictEqual(wa.windowId, oldWindow.windowId);
  });

  // The relay (legacy cdp-bridge) and upstream share one playwright-core, so
  // with the hook installed, Playwright's own launches must keep their newPage.
  async function windowIdOf(context, page) {
    const s = await context.newCDPSession(page);
    try {
      const { targetInfo } = await s.send("Target.getTargetInfo");
      return (await s.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId })).windowId;
    } finally {
      await s.detach().catch(() => {});
    }
  }

  test("a persistent launch (legacy cdp-bridge path) is not redirected: newPage stays a tab of its window", async () => {
    const { chromium } = require("playwright-core");
    const dir = makeProfileDir("persist");
    const ctx = await chromium.launchPersistentContext(dir, { executablePath: BRAVE_PATH, headless: !headfulRequested() });
    try {
      assert.ok(ctx.browser() && ctx.browser().contexts()[0] === ctx, "looks like a default context, so only the CDP check can tell");
      const first = ctx.pages()[0];
      const p = await ctx.newPage();
      assert.strictEqual(p.context(), ctx);
      assert.strictEqual(await windowIdOf(ctx, p), await windowIdOf(ctx, first), "redirected into a new window");
    } finally {
      await ctx.close();
      await removeProfile(dir);
    }
  });

  test("launch() + newContext().newPage() is not redirected (no 10 s hang, page in its own context)", async () => {
    const { chromium } = require("playwright-core");
    // Playwright puts launch()'s temp profile under os.tmpdir(): keep it in .tmp-profiles
    const tmp = makeProfileDir("launch");
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TEMP = process.env.TMP = tmp;
    let browser;
    try {
      browser = await chromium.launch({ executablePath: BRAVE_PATH, headless: !headfulRequested() });
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    try {
      const c = await browser.newContext();
      assert.strictEqual(browser.contexts()[0], c, "first context of a launched browser");
      const t0 = Date.now();
      const p = await c.newPage();
      assert.strictEqual(p.context(), c);
      assert.ok(Date.now() - t0 < 5000, `newPage took ${Date.now() - t0}ms`);
    } finally {
      await browser.close();
      await removeProfile(tmp);
    }
  });

  test("pages of a non-default context stay in that context", async () => {
    const browser = ctxs[0].browserContext.browser();
    const other = await browser.newContext();
    try {
      const p = await other.newPage();
      assert.strictEqual(p.context(), other);
      assert.ok(!browser.contexts()[0].pages().includes(p));
    } finally {
      await other.close();
    }
  });
});
