// _tabs.js — helpers for tabs_list / tabs_select / tabs_close. Tabs come
// from ctx.registry.listTabs(connId) ([{ tabKey, page }], the calling
// connection's tabs only), which never creates a tab or launches a browser.
// No registry (no browser running in legacy mode) means no tabs.

async function connectionTabs({ registry, connId }) {
  return registry ? registry.listTabs(connId) : [];
}

/** The tab args.tabId names → { tab } or { error } (prefixed with the tool name). */
async function pickTab(tool, args, ctx) {
  if (typeof args.tabId !== "string" || args.tabId === "") {
    return { error: `${tool}: tabId is required (from tabs_new / tabs_list)` };
  }
  const tab = (await connectionTabs(ctx)).find((t) => t.tabKey === args.tabId);
  return tab ? { tab } : { error: `${tool}: unknown tabId ${JSON.stringify(args.tabId)}; call tabs_new or tabs_list` };
}

// Legacy mode (registry.scope "context"): upstream runs in its own process,
// so its tools can't take tabId. tabs_new / tabs_select results say so; in
// broker mode this is undefined and JSON.stringify drops the field.
function legacyNote(registry) {
  return registry && registry.scope === "context"
    ? "legacy mode: only relay tools take tabId; upstream navigation_/content_/a11y_/interaction_ tools act on main."
    : undefined;
}

/** page.url() can throw on a crashed / closed page; a tab may have no page. */
function safeUrl(page) {
  try { return page.url(); } catch { return ""; }
}

module.exports = { connectionTabs, pickTab, legacyNote, safeUrl };
