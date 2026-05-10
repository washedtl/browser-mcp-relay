// storage_get-local — read localStorage / sessionStorage from the active page.
//
// Why this exists: cookies_export covers HTTP cookies, but modern OAuth and
// chat apps (Discord, Notion, Slack, Linear, Mercury, etc.) keep auth tokens
// in localStorage / sessionStorage. Without this tool, those sessions can't
// be inspected or copied between profiles even though Local Storage / Session
// Storage IS already in the cookie-source snapshot's directory list.

const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "storage_get-local",
  description:
    "Read keys from localStorage or sessionStorage on the active page's origin. " +
    "Returns { origin, store, entries: Record<string, string> }. " +
    "Use `key` to fetch a single value; omit it to dump all keys. " +
    "Auth tokens for OAuth-style apps (Discord, Notion, modern SaaS) typically " +
    "live in localStorage rather than HTTP cookies — this is the storage-side " +
    "complement to cookies_export.",
  inputSchema: {
    type: "object",
    properties: {
      store: {
        type: "string",
        enum: ["local", "session"],
        default: "local",
        description: "Which storage area to read. 'local' = localStorage, 'session' = sessionStorage.",
      },
      key: {
        type: "string",
        description: "Optional. Read just this key. Omit to dump all keys.",
      },
    },
  },
  handler: async ({ store = "local", key } = {}) => withActivePage(async ({ page }) => {
    if (store !== "local" && store !== "session") {
      return {
        content: [{ type: "text", text: `storage_get-local: store must be 'local' or 'session' (got ${JSON.stringify(store)})` }],
        isError: true,
      };
    }
    let result;
    try {
      result = await page.evaluate(({ store, key }) => {
        const s = store === "session" ? sessionStorage : localStorage;
        if (typeof key === "string") {
          const v = s.getItem(key);
          return { entries: v === null ? {} : { [key]: v }, count: v === null ? 0 : 1 };
        }
        const out = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k != null) out[k] = s.getItem(k);
        }
        return { entries: out, count: Object.keys(out).length };
      }, { store, key });
    } catch (e) {
      return {
        content: [{ type: "text", text: `storage_get-local: page.evaluate failed: ${e.message}` }],
        isError: true,
      };
    }
    // Reviewer V1: URL("about:blank").origin is the literal string "null".
    // Skip about:* URLs explicitly so the response shape doesn't carry an
    // ambiguous "null" string that looks like JSON null.
    let origin = "";
    const rawUrl = page.url();
    if (rawUrl && !rawUrl.startsWith("about:") && !rawUrl.startsWith("chrome:")) {
      try { origin = new URL(rawUrl).origin; } catch { /* not a real URL */ }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ origin, store, count: result.count, entries: result.entries }, null, 2),
      }],
    };
  }),
};
