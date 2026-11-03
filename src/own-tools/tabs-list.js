// tabs_list — list the calling connection's tabs (never another session's).
//
// W2D (2026-11-03): tabs come from ctx.registry with their tabId. There is
// no "active" tab: each call acts on the tab its tabId names, or on "main".
// needsBrave:false — listing never creates a tab or launches the browser.
//
// F1-2 (2026-05-10): per-tab error isolation around url()/title() (one
// crashed/closed page no longer breaks the whole list).

const { connectionTabs, safeUrl } = require("./_tabs.js");

module.exports = {
  name: "tabs_list",
  description:
    "List your tabs (this session only) with tabId, URL and title. Pass a tabId on a tool call " +
    "to act on that tab; calls without tabId act on \"main\".",
  inputSchema: { type: "object", properties: {} },
  needsBrave: false,
  handler: async (_args, ctx) => {
    const tabs = await connectionTabs(ctx);
    const list = await Promise.all(tabs.map(async ({ tabKey, page }) => {
      let title = "";
      try { title = await page.title(); } catch { /* closed mid-call, or no page */ }
      return { tabId: tabKey, url: safeUrl(page), title };
    }));
    return { content: [{ type: "text", text: JSON.stringify({ count: list.length, tabs: list }, null, 2) }] };
  },
};
