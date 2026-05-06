// cookies_import — load cookies into the active context.
// Inverse of cookies_export. For restoring saved sessions or testing flows.

module.exports = {
  name: "cookies_import",
  description:
    "Import cookies into the active browser context. Accepts array of cookie " +
    "objects in Playwright format (same shape as cookies_export output). " +
    "Cookies override existing same-name cookies for the same domain/path.",
  inputSchema: {
    type: "object",
    properties: {
      cookies: {
        type: "array",
        description: "Array of cookie objects in Playwright format: { name, value, domain, path, expires?, httpOnly?, secure?, sameSite? }.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            domain: { type: "string" },
            path: { type: "string" },
          },
          required: ["name", "value"],
        },
      },
    },
    required: ["cookies"],
  },
  handler: async ({ cookies }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    if (!Array.isArray(cookies)) {
      return { content: [{ type: "text", text: "cookies must be an array" }], isError: true };
    }
    try {
      await bridge.context.addCookies(cookies);
    } catch (e) {
      // Playwright throws on malformed cookies (missing domain+path or url,
      // invalid sameSite, etc.). Return structured error instead of letting
      // it propagate as an uncaught exception.
      return {
        content: [{ type: "text", text: `addCookies failed: ${e.message}` }],
        isError: true,
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ imported: cookies.length }, null, 2),
      }],
    };
  },
};
