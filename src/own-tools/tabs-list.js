// tabs_list — list all open pages (tabs) in the relay's browser context.

module.exports = {
  name: "tabs_list",
  description: "List all open pages (tabs) in the relay's browser context with index and URL.",
  inputSchema: { type: "object", properties: {} },
  handler: async () => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const pages = bridge.context.pages();
    const list = await Promise.all(pages.map(async (p, i) => ({
      index: i,
      url: p.url(),
      title: await p.title().catch(() => ""),
    })));
    return { content: [{ type: "text", text: JSON.stringify({ count: list.length, pages: list }, null, 2) }] };
  },
};
