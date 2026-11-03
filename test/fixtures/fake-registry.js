// fake-registry.js — test doubles for own-tool ctx plumbing.
//   fakePage / fakeContext: a Playwright Page / BrowserContext, enough for
//     the tab tools and the legacy registry.
//   fakeRegistry: the broker's SessionRegistry (W2 frozen contract), only
//     the methods own-tools use: getCtx(connId, tabKey="main") →
//     { page, browserContext }, listTabs(connId) → [{ tabKey, page }],
//     closeTab(connId, tabKey).

function fakePage(url = "about:blank", props = {}) {
  const page = {
    gotos: [],
    fronted: 0,
    closed: false,
    titleText: "",
    failGoto: null, // set to an error message to make goto reject
    url: () => url,
    opener: async () => null, // a popup's opener page (Playwright: async)
    title: async () => page.titleText,
    isClosed: () => page.closed,
    goto: async (u, opts) => {
      page.gotos.push({ url: u, opts });
      if (page.failGoto) throw new Error(page.failGoto);
      url = u;
    },
    bringToFront: async () => { page.fronted++; },
    close: async () => { page.closed = true; },
  };
  return Object.assign(page, props);
}

/** pages() lists open pages in creation order; newPage() appends one a tick later (like Playwright). */
function fakeContext(initialPages = []) {
  const all = [...initialPages];
  const context = {
    created: 0,
    pages: () => all.filter((p) => !p.isClosed()),
    newPage: async () => {
      context.created++;
      await new Promise((r) => setImmediate(r));
      const p = fakePage();
      all.push(p);
      return p;
    },
  };
  return context;
}

function fakeRegistry() {
  const conns = new Map(); // connId → Map<tabKey, page>
  const tabsOf = (connId) => {
    if (!conns.has(connId)) conns.set(connId, new Map());
    return conns.get(connId);
  };
  return {
    pageOf: (connId, tabKey) => tabsOf(connId).get(tabKey),
    async getCtx(connId, tabKey = "main") {
      const tabs = tabsOf(connId);
      if (!tabs.has(tabKey)) tabs.set(tabKey, fakePage());
      return { page: tabs.get(tabKey), browserContext: null };
    },
    async listTabs(connId) {
      return [...tabsOf(connId)].map(([tabKey, page]) => ({ tabKey, page }));
    },
    async closeTab(connId, tabKey) {
      const page = tabsOf(connId).get(tabKey);
      if (!page) return;
      await page.close();
      tabsOf(connId).delete(tabKey);
    },
  };
}

module.exports = { fakePage, fakeContext, fakeRegistry };
