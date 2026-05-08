// tabs_close — close a tab/page by its index. Refuses to close the last remaining page.

module.exports = {
  name: "tabs_close",
  description: "Close a tab/page by its index. Refusing to close the last remaining page.",
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
    const url = pages[index].url();
    await pages[index].close();
    return { content: [{ type: "text", text: JSON.stringify({ closed: index, url, remaining: bridge.context.pages().length }, null, 2) }] };
  },
};
