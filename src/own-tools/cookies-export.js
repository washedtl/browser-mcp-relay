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
  handler: async (_args = {}) => {
    // F0-9 reviewer V1 (2026-05-10): destructure-with-default so a JSON-RPC
    // client sending the call with no `arguments` field (or `null`) doesn't
    // crash on `urls`-from-undefined; still distinguish null vs omitted
    // below so the empty-array short-circuit works.
    const urls = _args.urls;
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
    // F1-1 (2026-05-10): validate `urls` before passing to Playwright. A
    // caller sending `urls: "https://x"` (string not array) or
    // `urls: [null, "https://x"]` previously propagated Playwright's raw
    // stack to the user. Surface a structured error instead.
    if (urls !== undefined && urls !== null) {
      if (!Array.isArray(urls)) {
        return {
          content: [{ type: "text", text: "cookies_export: urls must be an array of URL strings (or omit to return all cookies)" }],
          isError: true,
        };
      }
      for (let i = 0; i < urls.length; i++) {
        if (typeof urls[i] !== "string" || urls[i].length === 0) {
          return {
            content: [{ type: "text", text: `cookies_export: urls[${i}] must be a non-empty URL string` }],
            isError: true,
          };
        }
      }
    }
    let cookies;
    try {
      cookies = await bridge.context.cookies(urls);
    } catch (e) {
      return {
        content: [{ type: "text", text: `cookies_export: ${e.message || e}` }],
        isError: true,
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: cookies.length, cookies }, null, 2),
      }],
    };
  },
};
