// _legacy-context.js — the tab registry in legacy mode (one pool relay per
// Claude session, each with its own Brave). Retired with the pool (W3).
//
// LegacyTabs is the SessionRegistry subset own-tools use (getCtx / listTabs /
// closeTab, see index.js), over the relay's own BrowserContext:
//   • "main" is the newest page no named tab owns. Upstream runs in a child
//     process with its own page in this browser, so once upstream has made
//     that page, main is it (Brave's startup about:blank is older).
//   • a named tab (tabs_new) gets a page of its own.
//   • the whole BrowserContext belongs to the one session (sessionContext).
// Upstream's tools never see tabId in this mode: they act on upstream's page.

const LEGACY_CONN = "legacy";

class LegacyTabs {
  /** @param {import('playwright-core').BrowserContext} context */
  constructor(context) {
    this.context = context;
    // tab key → { page: Page | null until created, created: Promise<Page> }.
    // The promise is stored before it settles, so concurrent first uses of a
    // key share one page (same pattern as _page-cdp-session.js).
    this.named = new Map();
    this.mainPending = null;
  }

  /** This whole BrowserContext belongs to the caller's session. */
  get sessionContext() {
    return this.context;
  }

  async _settled() {
    await Promise.allSettled([...this.named.values()].map((t) => t.created));
    for (const [key, t] of this.named) if (t.page && t.page.isClosed()) this.named.delete(key);
  }

  _mainPage() {
    const owned = new Set([...this.named.values()].map((t) => t.page));
    return this.context.pages().filter((p) => !owned.has(p)).at(-1) ?? null;
  }

  async _main() {
    await this._settled();
    const page = this._mainPage();
    if (page) return page;
    // No page at all: open one (shared by concurrent callers). Nothing owns
    // it, so from then on it is the newest unowned page, i.e. main.
    this.mainPending ??= this.context.newPage().finally(() => { this.mainPending = null; });
    return this.mainPending;
  }

  _named(tabKey) {
    const tab = this.named.get(tabKey);
    if (tab && !(tab.page && tab.page.isClosed())) return tab.created;
    const entry = { page: null, created: null };
    entry.created = this.context.newPage().then(
      (page) => (entry.page = page),
      (e) => {
        if (this.named.get(tabKey) === entry) this.named.delete(tabKey);
        throw e;
      },
    );
    this.named.set(tabKey, entry);
    return entry.created;
  }

  async getCtx(connId, tabKey = "main") {
    const page = tabKey === "main" ? await this._main() : await this._named(tabKey);
    return { page, browserContext: this.context };
  }

  /** [{ tabKey, page }], main first. Never creates a page. */
  async listTabs() {
    await this._settled();
    const main = this._mainPage();
    const tabs = main ? [{ tabKey: "main", page: main }] : [];
    for (const [tabKey, { page }] of this.named) if (page) tabs.push({ tabKey, page });
    return tabs;
  }

  async closeTab(connId, tabKey) {
    const tab = (await this.listTabs()).find((t) => t.tabKey === tabKey);
    if (!tab) throw new Error(`no tab "${tabKey}"`);
    // Closing a persistent context's last page closes Brave.
    if (this.context.pages().length <= 1) throw new Error("refusing to close the last remaining page");
    await tab.page.close();
    this.named.delete(tabKey);
  }
}

const REGISTRIES = new WeakMap(); // BrowserContext → LegacyTabs (a relaunched Brave starts fresh)

function legacyRegistry(context) {
  let tabs = REGISTRIES.get(context);
  if (!tabs) {
    tabs = new LegacyTabs(context);
    REGISTRIES.set(context, tabs);
  }
  return tabs;
}

module.exports = { LegacyTabs, legacyRegistry, LEGACY_CONN };
