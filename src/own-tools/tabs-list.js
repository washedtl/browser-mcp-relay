// tabs_list — list all open pages (tabs) in the relay's browser context.
//
// F1-2 + F1-7 (2026-05-10): per-page error isolation around `p.url()` (one
// crashed/closed page no longer breaks the whole list), plus an `active` flag
// per entry so callers can identify the tracked active page without needing
// a separate round-trip.

const { getActivePageRaw } = require("./_active-page.js");

module.exports = {
  name: "tabs_list",
  description: "List all open pages (tabs) in the relay's browser context with index, URL, and title. The `active: true` field marks the page tracked by tabs_new/tabs_select (this is what own-tools target by default).",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const pages = bridge.context.pages();
    const activePage = getActivePageRaw();
    const list = await Promise.all(pages.map(async (p, i) => {
      // F1-2: guard p.url() — sync but can throw on a closed/crashed page.
      // Previously only p.title() was guarded; one bad page crashed the
      // whole Promise.all.
      let url = "";
      try { url = p.url(); } catch { /* page closed mid-call; surface empty */ }
      let title = "";
      try { title = await p.title(); } catch { /* same */ }
      return {
        index: i,
        url,
        title,
        active: p === activePage,
      };
    }));
    return { content: [{ type: "text", text: JSON.stringify({ count: list.length, pages: list }, null, 2) }] };
  },
};
