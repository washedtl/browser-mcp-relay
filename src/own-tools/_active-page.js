// _active-page.js — shared "which page is the user looking at" state
// for own-tools. tabs_new + tabs_select update it; other tools read it.
//
// Why this exists: Playwright's context.pages() returns pages in CREATION
// order, and Brave auto-opens about:blank as pages[0]. Without this tracker,
// every own-tool would fire against the about:blank instead of the page
// the user actually just opened or selected.
//
// Pairs with _propagate-active-page.js which solves the same problem on
// the upstream-MCP side.

let activePage = null;

function setActivePage(page) {
  activePage = page;
}

/**
 * Get the page own-tools should target. Order:
 *   1. The explicit active page if set + still open
 *   2. The last page in the context (tabs_new appends, so this is usually right)
 *   3. The first page (last resort — works for the common single-page case)
 *
 * @param {import('playwright-core').BrowserContext} context
 * @returns {import('playwright-core').Page | null}
 */
function getActivePage(context) {
  if (activePage && !activePage.isClosed()) return activePage;
  const pages = context.pages();
  if (pages.length === 0) return null;
  return pages[pages.length - 1] || pages[0];
}

/**
 * V1-9: tool-handler wrapper that resolves bridge + active page, returning
 * a structured "bridge missing" / "no pages open" error result if either
 * is unavailable. Removes ~10 lines of identical boilerplate from each of
 * 13 own-tool handlers + standardizes the error messages.
 *
 * @template T
 * @param {(ctx: { bridge: { context: import('playwright-core').BrowserContext, port: number, cdpConnectUrl: string }, page: import('playwright-core').Page }) => Promise<T>} handler
 * @returns {Promise<T | { content: Array<{type:"text", text:string}>, isError: true }>}
 */
async function withActivePage(handler) {
  const bridge = globalThis.__relayBridge;
  if (!bridge) {
    return {
      content: [{ type: "text", text: "bridge missing" }],
      isError: true,
    };
  }
  const page = getActivePage(bridge.context);
  if (!page) {
    return {
      content: [{ type: "text", text: "no pages open" }],
      isError: true,
    };
  }
  return handler({ bridge, page });
}

module.exports = { setActivePage, getActivePage, withActivePage };
