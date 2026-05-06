// tabs_select — bring a specific tab to the front by index.

module.exports = {
  name: "tabs_select",
  description: "Bring a specific tab to the front (active page) by its index.",
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
    await pages[index].bringToFront();
    return {
      content: [{ type: "text", text: JSON.stringify({ selected: index, url: pages[index].url() }, null, 2) }],
    };
  },
};
