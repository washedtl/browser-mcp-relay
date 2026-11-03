// tabs_close — close one of the calling connection's tabs (by tabId or
// index). Another session's tabs can't be named here.
//
// W2D (2026-11-03): closing goes through ctx.registry, which forgets the tab
// (a later call with that tabId opens a fresh one). Closing "main" is fine:
// the next call without tabId gets a new main tab. In legacy mode the
// registry refuses to close the browser's last page (that would quit Brave).

const { errorResult } = require("./_tool-args.js");
const { connectionTabs, pickTab, safeUrl } = require("./_tabs.js");

module.exports = {
  name: "tabs_close",
  description: "Close one of your tabs, by tabId (or index from tabs_list).",
  inputSchema: {
    type: "object",
    properties: {
      tabId: { type: "string", description: "A tabId from tabs_new / tabs_list." },
      index: { type: "integer", minimum: 0, description: "Position in tabs_list, if you have no tabId." },
    },
  },
  needsPage: false,
  handler: async (args, ctx) => {
    const { tab, error } = pickTab("tabs_close", args, await connectionTabs(ctx));
    if (error) return errorResult(error);
    const url = safeUrl(tab.page);
    try {
      await ctx.registry.closeTab(ctx.connId, tab.tabId);
    } catch (e) {
      return errorResult(`tabs_close: failed to close tab ${tab.tabId} (${url}): ${e.message}`);
    }
    const remaining = (await ctx.registry.listTabs(ctx.connId)).length;
    return { content: [{ type: "text", text: JSON.stringify({ closed: tab.tabId, url, remaining }, null, 2) }] };
  },
};
