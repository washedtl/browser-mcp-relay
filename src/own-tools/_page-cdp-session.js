// _page-cdp-session.js — per-page CDP session cache.
//
// Why: tools that apply session-scoped CDP overrides (Emulation.*,
// Network.setUserAgentOverride, etc.) must NOT detach the session after
// applying — overrides revert on detach. We therefore keep one CDP session
// alive per page, keyed in a WeakMap, and auto-detach when the page closes.
//
// V0-3 + V1-1: shared between emulate_device (overrides revert if detached)
// and memory_take-heap-snapshot (detach was being skipped on takeHeapSnapshot
// throw → CDP session leak). Centralizing the lifecycle here means callers
// can't get the cleanup wrong.

const PAGE_CDP_SESSIONS = new WeakMap();

/**
 * Return a CDP session for `page`, creating one if needed and registering
 * a `close` listener to auto-detach. Subsequent calls with the same page
 * return the same session.
 *
 * @param {import('playwright-core').Page} page
 * @param {import('playwright-core').BrowserContext} context
 * @returns {Promise<import('playwright-core').CDPSession>}
 */
async function getOrCreatePageCdp(page, context) {
  const cached = PAGE_CDP_SESSIONS.get(page);
  if (cached) return cached;
  const cdp = await context.newCDPSession(page);
  PAGE_CDP_SESSIONS.set(page, cdp);
  page.once("close", () => {
    try { cdp.detach(); } catch { /* best-effort */ }
    PAGE_CDP_SESSIONS.delete(page);
  });
  return cdp;
}

// V2-4: clearPageCdp had zero callers (page closure is the only intended
// removal path, registered above as a `close` listener). Removed.
// PAGE_CDP_SESSIONS stays exported as a test-only seam — emulate-device
// and memory-take-heap-snapshot tests need to reset between runs since
// the WeakMap survives across handler invocations on the same fake page.
module.exports = { getOrCreatePageCdp, PAGE_CDP_SESSIONS };
