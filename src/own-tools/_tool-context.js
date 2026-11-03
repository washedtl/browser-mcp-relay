// _tool-context.js — builds the ctx for one own-tool call; the ctx contract
// is documented in index.js. The one place a call is routed to a tab, shared
// by legacy mode (RelayServer + LegacyTabs) and the broker (W2E).

/** Does the tool act on a tab (routed by args.tabId)? */
function isRouted(tool) {
  return tool.needsBrave !== false && tool.needsPage !== false;
}

/**
 * @param {object} registry  SessionRegistry-shaped: getCtx(connId, tabKey) →
 *   { page, browserContext }, listTabs(connId) → [{ tabKey, page }]
 * @param {string} connId
 * @param {{ needsBrave?: boolean, needsPage?: boolean }} tool
 * @param {object} args      the call's arguments (args.tabId picks the tab)
 * @param {{ context, cdpUrl, relay, bridgeManagedMatcher? }} extras  context is what page-less tools get;
 *   bridgeManagedMatcher (broker + cookie bridge only) is passed through as is
 * Rejects on a malformed or unknown tabId: only tabs_new opens tabs.
 */
async function toolContext(registry, connId, tool, args, { context, cdpUrl, relay, bridgeManagedMatcher = null }) {
  const ctx = { context, registry, connId, cdpUrl, relay, bridgeManagedMatcher };
  if (!isRouted(tool)) return ctx;
  const tabKey = args.tabId ?? "main";
  if (typeof tabKey !== "string" || tabKey === "") {
    throw new Error(`tabId must be a non-empty string (got ${JSON.stringify(args.tabId)})`);
  }
  if (tabKey !== "main" && !(await registry.listTabs(connId)).some((t) => t.tabKey === tabKey)) {
    throw new Error(`unknown tabId ${JSON.stringify(tabKey)}; call tabs_new or tabs_list`);
  }
  // Read fields, don't spread: upstream's session context exposes page as a getter.
  const session = await registry.getCtx(connId, tabKey);
  return { ...ctx, page: session.page, context: session.browserContext, sessionKey: `${connId}:${tabKey}` };
}

module.exports = { toolContext, isRouted };
