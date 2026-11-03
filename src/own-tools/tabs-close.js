// tabs_close — close one of the calling connection's tabs, by tabId.
// Another session's tabs can't be named here.
//
// W2D (2026-11-03): closing goes through ctx.registry, which forgets the tab
// (its tabId becomes unknown). Closing "main" is fine: the next call without
// tabId gets a new main tab. In legacy mode the registry refuses to close
// the browser's last page (that would quit Brave). needsBrave:false — never
// creates a tab or launches the browser.

const { errorResult } = require("./_tool-args.js");
const { pickTab, safeUrl } = require("./_tabs.js");

module.exports = {
  name: "tabs_close",
  description: "Close one of your tabs, by tabId.",
  inputSchema: {
    type: "object",
    properties: { tabId: { type: "string", description: "A tabId from tabs_new / tabs_list." } },
    required: ["tabId"],
  },
  needsBrave: false,
  handler: async (args, ctx) => {
    const { tab, error } = await pickTab("tabs_close", args, ctx);
    if (error) return errorResult(error);
    const url = safeUrl(tab.page);
    try {
      await ctx.registry.closeTab(ctx.connId, tab.tabKey);
    } catch (e) {
      return errorResult(`tabs_close: failed to close tab ${tab.tabKey} (${url}): ${e.message}`);
    }
    const remaining = (await ctx.registry.listTabs(ctx.connId)).length;
    return { content: [{ type: "text", text: JSON.stringify({ closed: tab.tabKey, url, remaining }, null, 2) }] };
  },
};
