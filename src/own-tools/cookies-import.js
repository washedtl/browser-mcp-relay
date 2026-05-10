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
  handler: async (_args = {}) => {
    // F0-9 reviewer V1 (2026-05-10): destructure-with-default.
    const cookies = _args.cookies;
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    if (!Array.isArray(cookies)) {
      return { content: [{ type: "text", text: "cookies must be an array" }], isError: true };
    }
    // F0-5 (2026-05-10): filter null/non-object entries upfront. Without
    // this, `[null, validCookie]` propagates to addCookies which throws
    // on the null with no per-index context. We surface the index of the
    // first bad entry.
    //
    // Reviewer V1 (2026-05-10): also validate the OPTIONAL fields Playwright
    // actually consumes — domain/path/expires/url/sameSite/httpOnly/secure.
    // Pre-fix this was half-applied: name/value were checked but a malformed
    // domain (number) or sameSite (random string) reached Playwright's
    // ParameterError with a cryptic stack trace. Match the rigor of F0-5's
    // top-level guards.
    const VALID_SAMESITE = new Set(["Strict", "Lax", "None"]);
    for (let i = 0; i < cookies.length; i++) {
      const c = cookies[i];
      if (!c || typeof c !== "object" || Array.isArray(c)) {
        return {
          content: [{ type: "text", text: `cookies_import: cookies[${i}] must be a non-null object (got ${c === null ? "null" : typeof c})` }],
          isError: true,
        };
      }
      if (typeof c.name !== "string" || typeof c.value !== "string") {
        return {
          content: [{ type: "text", text: `cookies_import: cookies[${i}] must have string name + value` }],
          isError: true,
        };
      }
      // Either url OR (domain + path) must be present per Playwright's
      // contract. We don't enforce the OR here (Playwright surfaces it
      // with a clear message) but we do reject *malformed* values.
      if (c.url !== undefined && (typeof c.url !== "string" || c.url.length === 0)) {
        return { content: [{ type: "text", text: `cookies_import: cookies[${i}].url must be a non-empty string when provided` }], isError: true };
      }
      if (c.domain !== undefined && typeof c.domain !== "string") {
        return { content: [{ type: "text", text: `cookies_import: cookies[${i}].domain must be a string when provided` }], isError: true };
      }
      if (c.path !== undefined && typeof c.path !== "string") {
        return { content: [{ type: "text", text: `cookies_import: cookies[${i}].path must be a string when provided` }], isError: true };
      }
      if (c.expires !== undefined && (!Number.isFinite(c.expires))) {
        return { content: [{ type: "text", text: `cookies_import: cookies[${i}].expires must be a finite number (Unix seconds) when provided` }], isError: true };
      }
      if (c.httpOnly !== undefined && typeof c.httpOnly !== "boolean") {
        return { content: [{ type: "text", text: `cookies_import: cookies[${i}].httpOnly must be boolean when provided` }], isError: true };
      }
      if (c.secure !== undefined && typeof c.secure !== "boolean") {
        return { content: [{ type: "text", text: `cookies_import: cookies[${i}].secure must be boolean when provided` }], isError: true };
      }
      if (c.sameSite !== undefined && (typeof c.sameSite !== "string" || !VALID_SAMESITE.has(c.sameSite))) {
        return {
          content: [{ type: "text", text: `cookies_import: cookies[${i}].sameSite must be 'Strict' | 'Lax' | 'None' (got ${JSON.stringify(c.sameSite)})` }],
          isError: true,
        };
      }
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
