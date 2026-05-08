// tabs_select — bring a specific tab to the front by index.
//
// Active-page propagation: after Playwright's `bringToFront()`, we
// navigate upstream's tracked page (via its `navigation_go-to`) to the
// selected tab's URL. Upstream pins its `_page` reference at session
// init and never re-evaluates it from CDP `Target.activateTarget`
// notifications, so `bringToFront` alone leaves upstream's screenshot/
// snapshot tools targeting whatever page upstream originally grabbed —
// usually NOT the one the caller just selected. See
// _propagate-active-page.js for the full investigation.

const { propagateActivePageToUpstream } = require("./_propagate-active-page.js");

module.exports = {
  name: "tabs_select",
  description: "Bring a specific tab to the front (active page) by its index.",
  inputSchema: {
    type: "object",
    properties: { index: { type: "integer", minimum: 0 } },
    required: ["index"],
  },
  handler: async ({ index }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const pages = bridge.context.pages();
    // V1-5: JSON-Schema `minimum: 0` is not enforced by the MCP SDK at
    // handler entry. Validate explicitly so bad inputs (-1, "abc", 999)
    // produce an actionable error instead of an undefined-property crash.
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      return {
        content: [{ type: "text", text: `index out of range: ${index} (have ${pages.length} pages)` }],
        isError: true,
      };
    }
    await pages[index].bringToFront();
    const url = pages[index].url();
    // Propagate to upstream so content_take-screenshot etc. target this
    // tab's URL. Best-effort; about:blank is skipped to avoid churn.
    const propagation = await propagateActivePageToUpstream(url);
    return {
      content: [{ type: "text", text: JSON.stringify({
        selected: index,
        url,
        upstreamPropagated: propagation.propagated,
      }, null, 2) }],
    };
  },
};
