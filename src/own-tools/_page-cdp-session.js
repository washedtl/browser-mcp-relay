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
//
// G0-2 (2026-05-10): the WeakMap now stores the IN-FLIGHT Promise of the
// session, not the resolved session. Without this, two concurrent callers
// (e.g. emulate_device + memory_take-heap-snapshot fired on the same page
// from parallel agents) BOTH see a cache miss, BOTH call newCDPSession,
// the second `set()` overwrites the first → first session leaks (no
// detach listener fires for it because page.once is for the close event,
// not session cleanup). Caching the Promise serializes concurrent callers
// onto the same in-flight session creation.

const PAGE_CDP_SESSIONS = new WeakMap(); // page → Promise<CDPSession>

/**
 * Return a CDP session for `page`, creating one if needed and registering
 * a `close` listener to auto-detach. Subsequent calls with the same page
 * return the same session. Concurrent callers share the in-flight Promise.
 *
 * @param {import('playwright-core').Page} page
 * @param {import('playwright-core').BrowserContext} context
 * @returns {Promise<import('playwright-core').CDPSession>}
 */
function getOrCreatePageCdp(page, context) {
  const cached = PAGE_CDP_SESSIONS.get(page);
  if (cached) return cached;
  // G0-2: store the in-flight promise immediately so concurrent callers
  // share the same newCDPSession invocation. The .catch resets the cache
  // entry on creation failure so a future caller can retry.
  const promise = (async () => {
    const cdp = await context.newCDPSession(page);
    page.once("close", () => {
      try { cdp.detach(); } catch { /* best-effort */ }
      PAGE_CDP_SESSIONS.delete(page);
    });
    return cdp;
  })().catch((e) => {
    // Reset cache on creation failure so the next caller retries cleanly.
    if (PAGE_CDP_SESSIONS.get(page) === promise) PAGE_CDP_SESSIONS.delete(page);
    throw e;
  });
  PAGE_CDP_SESSIONS.set(page, promise);
  return promise;
}

// V2-4: clearPageCdp had zero callers (page closure is the only intended
// removal path, registered above as a `close` listener). Removed.
// PAGE_CDP_SESSIONS stays exported as a test-only seam — emulate-device
// and memory-take-heap-snapshot tests need to reset between runs since
// the WeakMap survives across handler invocations on the same fake page.
module.exports = { getOrCreatePageCdp, PAGE_CDP_SESSIONS };
