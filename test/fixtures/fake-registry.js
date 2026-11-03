// fake-registry.js — stand-in for the broker's SessionRegistry (W2 frozen
// contract): tabs per connection, each tab its own page (window). Only the
// methods own-tools use: getCtx(connId, tabKey="main"), listTabs(connId),
// closeTab(connId, tabKey). listTabs returns the connection's tab keys.

function fakePage(url = "about:blank") {
  const page = {
    gotos: [],
    fronted: 0,
    closed: false,
    titleText: "",
    failGoto: null, // set to an error message to make goto reject
    url: () => url,
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
  return page;
}

function fakeRegistry() {
  const conns = new Map(); // connId → Map<tabKey, ctx>
  const calls = [];
  const tabsOf = (connId) => {
    if (!conns.has(connId)) conns.set(connId, new Map());
    return conns.get(connId);
  };
  return {
    calls,
    pageOf: (connId, tabKey) => tabsOf(connId).get(tabKey)?.page,
    async getCtx(connId, tabKey = "main") {
      calls.push(["getCtx", connId, tabKey]);
      const tabs = tabsOf(connId);
      if (!tabs.has(tabKey)) tabs.set(tabKey, { page: fakePage(), sessionKey: `${connId}:${tabKey}`, connId });
      return tabs.get(tabKey);
    },
    listTabs(connId) {
      return [...tabsOf(connId).keys()];
    },
    async closeTab(connId, tabKey) {
      calls.push(["closeTab", connId, tabKey]);
      const tab = tabsOf(connId).get(tabKey);
      if (!tab) return;
      await tab.page.close();
      tabsOf(connId).delete(tabKey);
    },
  };
}

module.exports = { fakePage, fakeRegistry };
