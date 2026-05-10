// tabs_close — close a tab/page by its index. Refuses to close the last remaining page.
//
// T0-8 fix (2026-05-09): when closing the page that's currently tracked as the
// active page, clear the active-page reference so subsequent own-tool calls
// don't operate on a closed page (which falls through to `pages[length-1]` —
// often Brave's about:blank, not what the user wants). After clearing we let
// the next call's `getActivePage` re-derive from `context.pages()` cleanly.

const { clearActivePage, getActivePageRaw } = require("./_active-page.js");

module.exports = {
  name: "tabs_close",
  description: "Close a tab/page by its index. Refuses to close the last remaining page. If you close the active page, the next-most-recent page becomes active automatically.",
  inputSchema: {
    type: "object",
    properties: { index: { type: "integer", minimum: 0 } },
    required: ["index"],
  },
  handler: async ({ index }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const pages = bridge.context.pages();
    // V1-5: validate index explicitly — JSON-Schema `minimum: 0` is not
    // enforced by the MCP SDK at handler entry, so -1 / "abc" / 999 would
    // crash with an unhelpful undefined-property TypeError otherwise.
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) {
      return {
        content: [{ type: "text", text: `index out of range: ${index} (have ${pages.length} pages)` }],
        isError: true,
      };
    }
    if (pages.length === 1) {
      return { content: [{ type: "text", text: "refusing to close the last remaining page" }], isError: true };
    }
    const target = pages[index];
    const url = target.url();
    // T0-8: if we're closing the tracked active page, clear the reference so
    // the next own-tool call's `getActivePage` falls through cleanly to
    // pages[length-1] (excluding the now-closed one).
    const wasActive = getActivePageRaw() === target;
    if (wasActive) {
      clearActivePage();
    }
    await target.close();
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          closed: index,
          url,
          wasActive,
          remaining: bridge.context.pages().length,
        }, null, 2),
      }],
    };
  },
};
