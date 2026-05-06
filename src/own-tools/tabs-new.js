// tabs_new — open a new tab/page, optionally navigating to a URL.

module.exports = {
  name: "tabs_new",
  description: "Open a new tab/page in the relay's browser context, optionally navigating to a URL.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Optional URL to navigate the new tab to" } },
  },
  handler: async ({ url }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    const page = await bridge.context.newPage();
    if (url) await page.goto(url);
    return {
      content: [{ type: "text", text: JSON.stringify({ index: bridge.context.pages().length - 1, url: page.url() }, null, 2) }],
    };
  },
};
