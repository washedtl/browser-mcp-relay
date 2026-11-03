// tabs_select — bring one of the calling connection's tabs to the front.
//
// W2D (2026-11-03): selection is cosmetic. Tool calls act on the tab their
// tabId names (or "main"), so nothing is "made active" and no page is
// navigated (in broker mode a tab's page IS upstream's page). Selects by
// tabId only: indexes shift while parallel subagents open and close tabs.
// needsBrave:false — never creates a tab or launches the browser.

const { errorResult } = require("./_tool-args.js");
const { pickTab, safeUrl } = require("./_tabs.js");

module.exports = {
  name: "tabs_select",
  description:
    "Bring one of your tabs to the front. This does not change which tab later calls act on: " +
    "pass tabId on those calls.",
  inputSchema: {
    type: "object",
    properties: { tabId: { type: "string", description: "A tabId from tabs_new / tabs_list." } },
    required: ["tabId"],
  },
  needsBrave: false,
  handler: async (args, ctx) => {
    const { tab, error } = await pickTab("tabs_select", args, ctx);
    if (error) return errorResult(error);
    try {
      await tab.page.bringToFront();
    } catch (e) {
      // bringToFront is cosmetic (just visual focus); failure shouldn't fail the call.
      process.stderr.write(`[tabs_select] bringToFront failed (continuing): ${e.message}\n`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({
        selected: tab.tabKey,
        url: safeUrl(tab.page),
        note: `Brought to the front. To act on it, pass tabId "${tab.tabKey}" on each call.`,
      }, null, 2) }],
    };
  },
};
