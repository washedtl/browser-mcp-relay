// tabs_new — open a new tab/page, optionally navigating to a URL.
//
// Active-page propagation: when `url` is given, we ALSO navigate
// upstream's tracked page (via its `navigation_go-to`) so upstream's
// screenshot / snapshot tools target this URL. See
// _propagate-active-page.js for the why; upstream pins `_page` to a
// specific Playwright Page reference and never re-evaluates it from
// CDP, so creating a Playwright page on our side alone leaves
// upstream targeting its original page.

const { propagateActivePageToUpstream } = require("./_propagate-active-page.js");

module.exports = {
  name: "tabs_new",
  description: "Open a new tab/page in the relay's browser context, optionally navigating to a URL.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Optional URL to navigate the new tab to" } },
  },
  handler: async ({ url }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const page = await bridge.context.newPage();
    if (url) await page.goto(url);
    // Propagate to upstream so content_take-screenshot etc. target the
    // URL the caller asked for. No-op when url is empty/about:blank or
    // when upstream is unavailable (best-effort; never throws).
    const propagation = await propagateActivePageToUpstream(url);
    return {
      content: [{ type: "text", text: JSON.stringify({
        index: bridge.context.pages().length - 1,
        url: page.url(),
        upstreamPropagated: propagation.propagated,
      }, null, 2) }],
    };
  },
};
