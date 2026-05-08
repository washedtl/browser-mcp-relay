// cookies_export — return all cookies in the active context as JSON.
// Useful for saving authenticated session state, debugging cookie issues.

module.exports = {
  name: "cookies_export",
  description:
    "Export all cookies from the active browser context as a JSON array. " +
    "Each cookie has { name, value, domain, path, expires, httpOnly, secure, sameSite }. " +
    "Optionally filter to specific URLs (returns cookies that would apply to those URLs).",
  inputSchema: {
    type: "object",
    properties: {
      urls: {
        type: "array",
        items: { type: "string" },
        description: "Optional URL filter — return only cookies that would be sent to these URLs.",
      },
    },
  },
  handler: async ({ urls }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    // V1-4: Playwright's `context.cookies([])` returns ALL cookies (empty
    // array = no filter). A caller passing `urls: []` likely expects "no
    // cookies for empty filter" — instead they'd get the full vault. Treat
    // empty array as "no matching URLs → empty result".
    if (Array.isArray(urls) && urls.length === 0) {
      return {
        content: [{ type: "text", text: JSON.stringify({ count: 0, cookies: [] }, null, 2) }],
      };
    }
    const cookies = await bridge.context.cookies(urls);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: cookies.length, cookies }, null, 2),
      }],
    };
  },
};
