// _legacy-context.js — the own-tool context in legacy mode (one pool relay
// per Claude session, each with its own Brave). Retired with the pool (W3).
//
// Own-tool handlers take (args, { page, context, sessionKey, registry,
// connId }) in both modes. In broker mode the SessionRegistry hands out
// upstream's per-session pages. Here LegacyTabs plays that registry over the
// relay's own BrowserContext:
//   • "main" is the newest page no named tab owns. Upstream runs in a child
//     process with its own page in this browser, so once upstream has made
//     that page, main is it (Brave's startup about:blank is older).
//   • any other tab key gets a page of its own on first use (tabs_new).
// Upstream's tools never see tabId in this mode: they always act on
// upstream's page.

const LEGACY_CONN = "legacy";

class LegacyTabs {
  /** @param {{ context: import('playwright-core').BrowserContext, cdpConnectUrl: string }} bridge */
  constructor(bridge) {
    this.context = bridge.context;
    this.cdpUrl = bridge.cdpConnectUrl;
    this.named = new Map(); // tab key → Page
  }

  _openNamed() {
    for (const [key, page] of this.named) if (page.isClosed()) this.named.delete(key);
    return this.named;
  }

  _mainPage() {
    const owned = new Set(this._openNamed().values());
    return this.context.pages().filter((p) => !owned.has(p)).at(-1) ?? null;
  }

  async getCtx(connId, tabKey = "main") {
    let page;
    if (tabKey === "main") {
      page = this._mainPage() || await this.context.newPage();
    } else {
      page = this._openNamed().get(tabKey);
      if (!page) {
        page = await this.context.newPage();
        this.named.set(tabKey, page);
      }
    }
    return { page, context: this.context, sessionKey: `${LEGACY_CONN}:${tabKey}`, registry: this, connId: LEGACY_CONN, cdpUrl: this.cdpUrl };
  }

  listTabs() {
    const named = [...this._openNamed().keys()];
    return this._mainPage() ? ["main", ...named] : named;
  }

  async closeTab(connId, tabKey) {
    const page = tabKey === "main" ? this._mainPage() : this._openNamed().get(tabKey);
    if (!page) throw new Error(`no tab "${tabKey}"`);
    // Closing a persistent context's last page closes Brave.
    if (this.context.pages().length <= 1) throw new Error("refusing to close the last remaining page");
    await page.close();
    this.named.delete(tabKey);
  }
}

const TABS = new WeakMap(); // BrowserContext → LegacyTabs (a relaunched Brave starts fresh)

/**
 * The ctx for one own-tool call: routed to args.tabId (default "main"), or
 * page-less for tools marked needsPage:false (they never open a tab).
 */
async function legacyToolContext(bridge, tool, args) {
  let tabs = TABS.get(bridge.context);
  if (!tabs) {
    tabs = new LegacyTabs(bridge);
    TABS.set(bridge.context, tabs);
  }
  if (tool.needsPage === false) {
    return { context: tabs.context, registry: tabs, connId: LEGACY_CONN, cdpUrl: tabs.cdpUrl };
  }
  const tabId = args.tabId ?? "main";
  if (typeof tabId !== "string" || tabId === "") {
    throw new Error(`tabId must be a non-empty string (got ${JSON.stringify(args.tabId)})`);
  }
  return tabs.getCtx(LEGACY_CONN, tabId);
}

module.exports = { legacyToolContext, LegacyTabs, LEGACY_CONN };
