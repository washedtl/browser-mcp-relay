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
    if (index >= pages.length) {
      return { content: [{ type: "text", text: `index ${index} out of range (${pages.length} pages)` }], isError: true };
    }
    if (pages.length === 1) {
      return { content: [{ type: "text", text: "refusing to close the last remaining page" }], isError: true };
    }
    const url = pages[index].url();
    await pages[index].close();
    return { content: [{ type: "text", text: JSON.stringify({ closed: index, url, remaining: bridge.context.pages().length }, null, 2) }] };
  },
};
