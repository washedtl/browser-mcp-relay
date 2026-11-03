// window-pages.js — one browser window per broker page (v0.4 shared broker).
//
// Playwright's newPage() on a CDP-attached browser opens a foreground TAB in
// the shared window, so every other session's tab goes to the background,
// where screenshots stall (spike: p90 2.6 s, max 3.5 s vs 515/574 ms in
// separate windows). installWindowPerPage() hooks BrowserContext.prototype
// .newPage of the playwright-core that upstream loads, so every page created
// for the browser's default context (upstream session creation AND
// ensureSessionPageOpen's re-creation after a close) comes from
// Target.createTarget {newWindow:true}, matched back to its Page by targetId.
//
// Placement: `cascade` (default; visible, stepped so windows don't stack)
// or `offscreen` (left of every display; still renders at full rate).
// Minimized windows DO stall (rAF 2/s, screenshots 3-5 s), so callers run
// ensureNotMinimized(page) before screenshot / interaction tools. Nothing
// here ever minimizes a window.
//
// The first new window still takes the OS foreground (Chromium ignores
// `background` for new windows); that's once per session window.
//
// Requiring this module is cheap: playwright-core loads on install.

"use strict";

const path = require("node:path");
const { createRequire } = require("node:module");
const { resolveUpstreamPackage } = require("./upstream-inproc.js");

const PLACEMENTS = Object.freeze(["cascade", "offscreen"]);
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 900;
// Far enough left that a window clears any monitor arranged left of the
// primary; Chromium keeps CDP-given bounds as-is (measured, not clamped).
const OFFSCREEN_LEFT = -10000;
const PAGE_APPEAR_TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function windowBounds(placement, index) {
  if (placement === "offscreen") return { left: OFFSCREEN_LEFT, top: 40, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  const i = index % 8;
  return { left: 40 + i * 48, top: 40 + i * 36, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
}

// One browser-level CDP session per Browser; a failed attempt isn't cached.
const browserSessions = new WeakMap();
function browserSession(browser) {
  let p = browserSessions.get(browser);
  if (!p) {
    p = browser.newBrowserCDPSession();
    browserSessions.set(browser, p);
    p.catch(() => { if (browserSessions.get(browser) === p) browserSessions.delete(browser); });
  }
  return p;
}
async function sendBrowser(browser, method, params) {
  return (await browserSession(browser)).send(method, params);
}

// page -> Promise<targetId>; the in-flight promise is shared so concurrent
// newPage waits don't each open a CDP session to the same page. Failures
// (page closing) aren't cached.
const targetIds = new WeakMap();
function targetIdOf(page) {
  let p = targetIds.get(page);
  if (!p) {
    p = (async () => {
      const s = await page.context().newCDPSession(page);
      try {
        return (await s.send("Target.getTargetInfo")).targetInfo.targetId;
      } finally {
        await s.detach().catch(() => {});
      }
    })();
    targetIds.set(page, p);
    p.catch(() => { if (targetIds.get(page) === p) targetIds.delete(page); });
  }
  return p;
}

async function waitForTargetPage(context, browser, targetId) {
  const deadline = Date.now() + PAGE_APPEAR_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      if ((await targetIdOf(p).catch(() => null)) === targetId) return p;
    }
    await sleep(25);
  }
  await sendBrowser(browser, "Target.closeTarget", { targetId }).catch(() => {});
  throw new Error(`[broker] new window ${targetId} never showed up as a page of its context (${PAGE_APPEAR_TIMEOUT_MS}ms)`);
}

let cascadeIndex = 0;

/** The replacement for BrowserContext.prototype.newPage. Exported for tests. */
function makeNewPage(origNewPage, getPlacement) {
  return async function newPageInOwnWindow(...args) {
    const browser = typeof this.browser === "function" ? this.browser() : null;
    // Persistent launches have no browser(); newContext() contexts are not the
    // default one, and a raw createTarget would land outside them.
    if (!browser || browser.contexts()[0] !== this) return origNewPage.apply(this, args);
    const bounds = windowBounds(getPlacement(), cascadeIndex++);
    const { targetId } = await sendBrowser(browser, "Target.createTarget", {
      url: "about:blank", newWindow: true, background: true, ...bounds,
    });
    return waitForTargetPage(this, browser, targetId);
  };
}

/** BrowserContext class of the playwright-core instance upstream imports. */
function upstreamBrowserContextClass() {
  const upReq = resolveUpstreamPackage().require;
  const coreDir = path.dirname(createRequire(upReq.resolve("playwright")).resolve("playwright-core/package.json"));
  const { BrowserContext } = require(path.join(coreDir, "lib", "client", "browserContext.js"));
  if (!BrowserContext || typeof BrowserContext.prototype.newPage !== "function") {
    throw new Error(`[broker] playwright-core at ${coreDir} has no client BrowserContext.prototype.newPage to hook`);
  }
  return BrowserContext;
}

let installed = null; // { proto, orig, placement }

function uninstallWindowPerPage() {
  if (!installed) return;
  installed.proto.newPage = installed.orig;
  installed = null;
}

/**
 * Route every default-context newPage() into its own window. Install before
 * the first upstream session context. Calling again only switches placement.
 * @param {{placement?: 'cascade'|'offscreen'}} [opts]
 * @returns {() => void} uninstall
 */
function installWindowPerPage({ placement = "cascade" } = {}) {
  if (!PLACEMENTS.includes(placement)) {
    throw new Error(`[broker] window placement must be one of ${PLACEMENTS.join(", ")}, got ${JSON.stringify(placement)}`);
  }
  if (installed) {
    installed.placement = placement;
    return uninstallWindowPerPage;
  }
  const proto = upstreamBrowserContextClass().prototype;
  const state = { proto, orig: proto.newPage, placement };
  proto.newPage = makeNewPage(state.orig, () => state.placement);
  installed = state;
  return uninstallWindowPerPage;
}

function currentPlacement() {
  return installed ? installed.placement : null;
}

/**
 * Restore the page's window if it is minimized (minimized windows throttle
 * rAF to ~2/s and screenshots to 3-5 s). Off-screen and occluded windows
 * render normally and are left alone.
 * @returns {Promise<boolean>} true when a minimized window was restored
 */
async function ensureNotMinimized(page) {
  if (!page || page.isClosed()) return false;
  const browser = page.context().browser();
  if (!browser) return false;
  const { windowId, bounds } = await sendBrowser(browser, "Browser.getWindowForTarget", { targetId: await targetIdOf(page) });
  if (bounds.windowState !== "minimized") return false;
  await sendBrowser(browser, "Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  return true;
}

module.exports = {
  installWindowPerPage,
  ensureNotMinimized,
  // exported for tests and sibling broker modules
  OFFSCREEN_LEFT,
  PLACEMENTS,
  windowBounds,
  makeNewPage,
  currentPlacement,
};
