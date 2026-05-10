// tabs_new — open a new tab/page, optionally navigating to a URL.
//
// Active-page propagation: when `url` is given, we ALSO navigate
// upstream's tracked page (via its `navigation_go-to`) so upstream's
// screenshot / snapshot tools target this URL. See
// _propagate-active-page.js for the why; upstream pins `_page` to a
// specific Playwright Page reference and never re-evaluates it from
// CDP, so creating a Playwright page on our side alone leaves
// upstream targeting its original page.
//
// T0-7 / T1-10 fixes (2026-05-09):
//   • try/catch around page.goto so a bad URL doesn't leave an orphan tab
//     visible in tabs_list with no error context. On goto failure we now
//     still call setActivePage (the page exists) and return a structured
//     `{ navError, isError: true }` response.
//   • accept `waitUntil` parameter — SPA-heavy sites need 'networkidle'.

const { propagateActivePageToUpstream } = require("./_propagate-active-page.js");
const { setActivePage } = require("./_active-page.js");

module.exports = {
  name: "tabs_new",
  description: "Open a new tab/page in the relay's browser context, optionally navigating to a URL. Tracks the new tab as the active page for subsequent own-tool calls.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Optional URL to navigate the new tab to" },
      waitUntil: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle", "commit"],
        default: "load",
        description: "Playwright navigation lifecycle to wait for. Default 'load'. Use 'networkidle' for SPA-heavy sites.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 300000,
        default: 30000,
        description: "Max wait for the navigation in ms. Default 30s.",
      },
    },
  },
  handler: async ({ url, waitUntil = "load", timeoutMs = 30000 } = {}) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const page = await bridge.context.newPage();
    // T0-7: track the page as active BEFORE goto so a goto failure still
    // leaves us in a usable state — subsequent own-tools target this new
    // tab, not the previous active page or pages[0]'s about:blank.
    setActivePage(page);

    let navError = null;
    if (url) {
      try {
        await page.goto(url, { waitUntil, timeout: timeoutMs });
      } catch (e) {
        navError = e.message || String(e);
      }
    }

    // Propagate to upstream (best-effort) only if navigation succeeded.
    const propagation = navError
      ? { propagated: false, reason: "navError" }
      : await propagateActivePageToUpstream(url);

    const result = {
      content: [{
        type: "text",
        text: JSON.stringify({
          index: bridge.context.pages().length - 1,
          url: page.url(),
          waitUntil,
          navError,
          upstreamPropagated: propagation.propagated,
        }, null, 2),
      }],
    };
    // Only set isError when truthy — keeping success-path shape `{ content }`
    // identical to the pre-T0-7 contract that existing tests assert on.
    if (navError) result.isError = true;
    return result;
  },
};
