// _tabs.js — the calling connection's tabs, shared by tabs_list /
// tabs_select / tabs_close. Tabs come from ctx.registry (the broker's
// SessionRegistry, or LegacyTabs in legacy mode): listTabs(connId) gives the
// tab keys, and getCtx on a listed key returns that tab without creating one.
// Another connection's tabs are never visible here.

/** [{ tabId, page }] in registry order. */
async function connectionTabs({ registry, connId }) {
  const keys = await registry.listTabs(connId);
  return Promise.all(keys.map(async (tabId) => ({ tabId, page: (await registry.getCtx(connId, tabId)).page })));
}

/**
 * The tab named by args.tabId, else by args.index (tabs_list order).
 * Returns { tab } or { error } (error text prefixed with the tool name).
 */
function pickTab(tool, args, tabs) {
  if (args.tabId != null) {
    const tab = tabs.find((t) => t.tabId === args.tabId);
    if (tab) return { tab };
    const have = tabs.map((t) => t.tabId).join(", ") || "none";
    return { error: `${tool}: no tab ${JSON.stringify(args.tabId)} in this session (have ${have})` };
  }
  const { index } = args;
  if (index == null) return { error: `${tool}: pass tabId (from tabs_new / tabs_list) or index` };
  // JSON-Schema minimum/type aren't enforced by the MCP SDK at handler entry.
  if (!Number.isInteger(index) || index < 0 || index >= tabs.length) {
    return { error: `${tool}: index out of range: ${JSON.stringify(index)} (have ${tabs.length} tabs)` };
  }
  return { tab: tabs[index] };
}

/** page.url() can throw on a crashed / closed page. */
function safeUrl(page) {
  try { return page.url(); } catch { return ""; }
}

module.exports = { connectionTabs, pickTab, safeUrl };
