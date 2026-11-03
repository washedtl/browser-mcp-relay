// _legacy-context.js — the tab registry in legacy mode (one pool relay per
// Claude session, each with its own Brave). Retired with the pool (W3).
//
// LegacyTabs is the SessionRegistry subset own-tools use (getCtx / listTabs /
// closeTab, see index.js), over the relay's own BrowserContext:
//   • "main" is the newest page that no named tab owns and that has no
//     opener. Upstream runs in a child process with its own page in this
//     browser, so once upstream has made that page, main is it: Brave's
//     startup about:blank is older, and popups (OAuth windows, window.open)
//     have an opener. A tab opened over CDP with no opener (Lighthouse's
//     audit tab) is still a main candidate while it stays open.
//   • a named tab (tabs_new) gets a page of its own.
//   • scope "context": the whole BrowserContext belongs to the one session.
// Upstream's tools never see tabId in this mode: they act on upstream's page.

const LEGACY_CONN = "legacy";
// How long a lookup waits for named tabs still being created (one hung
// newPage must not block every main-routed call and tabs_list).
const SETTLE_TIMEOUT_MS = 5000;

class LegacyTabs {
  /**
   * @param {import('playwright-core').BrowserContext} context
   * @param {{ settleTimeoutMs?: number }} [opts]
   */
  constructor(context, { settleTimeoutMs = SETTLE_TIMEOUT_MS } = {}) {
    this.context = context;
    this.scope = "context"; // see index.js: the caller's session owns this.context
    this.settleTimeoutMs = settleTimeoutMs;
    // tab key → { page: Page | null until created, created: Promise<Page> }.
    // The promise is stored before it settles, so concurrent first uses of a
    // key share one page (same pattern as _page-cdp-session.js).
    this.named = new Map();
    this.mainPending = null;
  }

  /** Wait (bounded) for named tabs being created; drop closed ones. */
  async _settled() {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, this.settleTimeoutMs); });
    try {
      await Promise.race([Promise.allSettled([...this.named.values()].map((t) => t.created)), timeout]);
    } finally {
      clearTimeout(timer);
    }
    for (const [key, t] of this.named) if (t.page && t.page.isClosed()) this.named.delete(key);
  }

  async _mainPage() {
    const owned = new Set([...this.named.values()].map((t) => t.page));
    const unowned = this.context.pages().filter((p) => !owned.has(p));
    const openers = await Promise.all(unowned.map((p) => p.opener().catch(() => null)));
    return unowned.filter((_, i) => !openers[i]).at(-1) ?? null;
  }

  async _main() {
    await this._settled();
    const page = await this._mainPage();
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
    const main = await this._mainPage();
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
