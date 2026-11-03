// window-pages.js — one browser window per broker page (v0.4 shared broker).
//
// Playwright's newPage() on a CDP-attached browser opens a foreground TAB in
// the shared window, so every other session's tab goes to the background,
// where screenshots stall (spike: p90 2.6 s, max 3.5 s vs 515/574 ms in
// separate windows). installWindowPerPage() hooks BrowserContext.prototype
// .newPage of the playwright-core that upstream loads, so every page created
// for a CDP-attached browser's default context (upstream session creation AND
// ensureSessionPageOpen's re-creation after a close) comes from
// Target.createTarget {newWindow:true}, matched back to its Page by targetId.
//
// Only CDP-attached browsers are redirected. The relay and upstream share
// one playwright-core, and a Playwright launch (launchPersistentContext, the
// legacy cdp-bridge path; or launch() + newContext()) also has a browser()
// whose contexts()[0] is the context in use, so "default context" alone
// can't tell them apart. BrowserType.prototype.connectOverCDP is wrapped to
// record the browsers it returns; everything else keeps Playwright's newPage.
// Install before upstream's first connection: browsers attached earlier
// aren't recorded and keep opening tabs.
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
// Well left of the primary display's origin, past most left-hand monitor
// setups. Chromium keeps CDP-given bounds as-is (measured headful and
// headless: created at -3000 / -10000 / -32000, reported unchanged).
const OFFSCREEN_LEFT = -10000;
const PAGE_APPEAR_TIMEOUT_MS = 10000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function windowBounds(placement, index) {
  if (placement === "offscreen") return { left: OFFSCREEN_LEFT, top: 40, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  const i = index % 8;
  return { left: 40 + i * 48, top: 40 + i * 36, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
}

// Browsers returned by BrowserType.connectOverCDP while the hook is installed.
const cdpBrowsers = new WeakSet();

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

/**
 * The replacement for BrowserContext.prototype.newPage. Exported for tests.
 * @param {Function} origNewPage Playwright's newPage
 * @param {() => string} getPlacement current placement
 * @param {(browser: object) => boolean} [isCdpAttached] defaults to "returned by connectOverCDP"
 */
function makeNewPage(origNewPage, getPlacement, isCdpAttached = (b) => cdpBrowsers.has(b)) {
  return async function newPageInOwnWindow(...args) {
    const browser = typeof this.browser === "function" ? this.browser() : null;
    // Launched browsers (persistent or not) keep Playwright's behaviour; so do
    // newContext() contexts of a CDP browser, where a raw createTarget would
    // land in the default context instead.
    if (!browser || !isCdpAttached(browser) || browser.contexts()[0] !== this) return origNewPage.apply(this, args);
    const bounds = windowBounds(getPlacement(), cascadeIndex++);
    const { targetId } = await sendBrowser(browser, "Target.createTarget", {
      url: "about:blank", newWindow: true, background: true, ...bounds,
    });
    return waitForTargetPage(this, browser, targetId);
  };
}

function makeConnectOverCDP(origConnect) {
  return async function connectOverCDPRecorded(...args) {
    const browser = await origConnect.apply(this, args);
    cdpBrowsers.add(browser);
    return browser;
  };
}

/** Client classes of the playwright-core instance upstream imports. */
function upstreamPlaywrightClient() {
  const upReq = resolveUpstreamPackage().require;
  const coreDir = path.dirname(createRequire(upReq.resolve("playwright")).resolve("playwright-core/package.json"));
  const { BrowserContext } = require(path.join(coreDir, "lib", "client", "browserContext.js"));
  const { BrowserType } = require(path.join(coreDir, "lib", "client", "browserType.js"));
  if (!BrowserContext || typeof BrowserContext.prototype.newPage !== "function"
    || !BrowserType || typeof BrowserType.prototype.connectOverCDP !== "function") {
    throw new Error(`[broker] playwright-core at ${coreDir} has no client BrowserContext.newPage / BrowserType.connectOverCDP to hook`);
  }
  return { BrowserContext, BrowserType };
}

let installed = null; // { contextProto, origNewPage, typeProto, origConnect, placement }

function uninstallWindowPerPage() {
  if (!installed) return;
  installed.contextProto.newPage = installed.origNewPage;
  installed.typeProto.connectOverCDP = installed.origConnect;
  installed = null;
}

/**
 * Route every newPage() of a CDP-attached browser's default context into its
 * own window. Install before upstream's first session context. Calling again
 * only switches placement.
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
  const { BrowserContext, BrowserType } = upstreamPlaywrightClient();
  const state = {
    contextProto: BrowserContext.prototype,
    origNewPage: BrowserContext.prototype.newPage,
    typeProto: BrowserType.prototype,
    origConnect: BrowserType.prototype.connectOverCDP,
    placement,
  };
  state.contextProto.newPage = makeNewPage(state.origNewPage, () => state.placement);
  state.typeProto.connectOverCDP = makeConnectOverCDP(state.origConnect);
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

/**
 * Bring the page's window into view for the user (browser_show): restore it
 * if minimized, and move one placed off-screen (right edge past
 * OFFSCREEN_LEFT / 2, beyond any left-hand monitor) to the next cascade slot.
 * Raising it is page.bringToFront()'s job. Runs no page JS, so an open
 * alert() can't block it.
 * @returns {Promise<{restored: boolean, movedOnScreen: boolean}>}
 */
async function showWindow(page) {
  const restored = await ensureNotMinimized(page);
  const browser = page.isClosed() ? null : page.context().browser();
  if (!browser) return { restored, movedOnScreen: false };
  const { windowId, bounds } = await sendBrowser(browser, "Browser.getWindowForTarget", { targetId: await targetIdOf(page) });
  if (bounds.windowState !== "normal" || bounds.left + bounds.width > OFFSCREEN_LEFT / 2) return { restored, movedOnScreen: false };
  const { left, top } = windowBounds("cascade", cascadeIndex++);
  await sendBrowser(browser, "Browser.setWindowBounds", { windowId, bounds: { left, top } });
  return { restored, movedOnScreen: true };
}

module.exports = {
  installWindowPerPage,
  ensureNotMinimized,
  showWindow,
  // exported for tests and sibling broker modules
  OFFSCREEN_LEFT,
  PLACEMENTS,
  windowBounds,
  makeNewPage,
  currentPlacement,
};
