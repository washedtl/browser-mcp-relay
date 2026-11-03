// tabs_select — bring one of the calling connection's tabs to the front.
//
// W2D (2026-11-03): selection is cosmetic. Tool calls act on the tab their
// tabId names (or "main"), so nothing is "made active" and no page is
// navigated (the old propagate-to-upstream step is gone: in broker mode a
// tab's page IS upstream's page).

const { errorResult } = require("./_tool-args.js");
const { connectionTabs, pickTab, safeUrl } = require("./_tabs.js");

module.exports = {
  name: "tabs_select",
  description:
    "Bring one of your tabs to the front, by tabId (or index from tabs_list). This does not change " +
    "which tab later calls act on: pass tabId on those calls.",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "string", description: "A tabId from tabs_new / tabs_list." },
      index: { type: "integer", minimum: 0, description: "Position in tabs_list, if you have no tabId." },
    },
  },
  needsPage: false,
  handler: async (args, ctx) => {
    const { tab, error } = pickTab("tabs_select", args, await connectionTabs(ctx));
    if (error) return errorResult(error);
    try {
      await tab.page.bringToFront();
    } catch (e) {
      // bringToFront is cosmetic (just visual focus); failure shouldn't fail the call.
      process.stderr.write(`[tabs_select] bringToFront failed (continuing): ${e.message}\n`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({
        selected: tab.tabId,
        url: safeUrl(tab.page),
        note: `Brought to the front. To act on it, pass tabId "${tab.tabId}" on each call.`,
      }, null, 2) }],
    };
  },
};
