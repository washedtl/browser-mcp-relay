// storage_set-local — write keys into localStorage / sessionStorage on the
// active page. Inverse of storage_get-local. Used to restore an authed
// session after a fresh navigation, or to inject test fixtures.

const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "storage_set-local",
  description:
    "Write keys into localStorage or sessionStorage on the active page's origin. " +
    "Pass `entries` as { key: value, ... }. Existing keys with the same name " +
    "are overwritten. Use `clearFirst: true` to wipe the store before writing. " +
    "Inverse of storage_get-local.",
  inputSchema: {
    type: "object",
    properties: {
      store: {
        type: "string",
        enum: ["local", "session"],
        default: "local",
      },
      entries: {
        type: "object",
        description: "Map of key → value. Both must be strings (browser storage only stores strings).",
        additionalProperties: { type: "string" },
      },
      clearFirst: {
        type: "boolean",
        default: false,
        description: "If true, call store.clear() before writing the new entries.",
      },
    },
    required: ["entries"],
  },
  handler: async ({ store = "local", entries, clearFirst = false } = {}) => withActivePage(async ({ page }) => {
    if (store !== "local" && store !== "session") {
      return {
        content: [{ type: "text", text: `storage_set-local: store must be 'local' or 'session' (got ${JSON.stringify(store)})` }],
        isError: true,
      };
    }
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return {
        content: [{ type: "text", text: "storage_set-local: entries must be an object { key: value }" }],
        isError: true,
      };
    }
    // Reject non-string values upfront — the browser would coerce them but
    // round-tripping the result through storage_get-local would surprise
    // the caller (numbers come back as strings).
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== "string") {
        return {
          content: [{ type: "text", text: `storage_set-local: entries.${k} must be a string (got ${typeof v}); browser storage only accepts strings` }],
          isError: true,
        };
      }
    }
    let result;
    try {
      result = await page.evaluate(({ store, entries, clearFirst }) => {
        const s = store === "session" ? sessionStorage : localStorage;
        if (clearFirst) s.clear();
        let written = 0;
        for (const [k, v] of Object.entries(entries)) {
          s.setItem(k, v);
          written++;
        }
        return { written, total: s.length };
      }, { store, entries, clearFirst });
    } catch (e) {
      return {
        content: [{ type: "text", text: `storage_set-local: page.evaluate failed: ${e.message}` }],
        isError: true,
      };
    }
    // Reviewer V1: URL("about:blank").origin is the literal string "null".
    // Skip about:*/chrome:* explicitly so the payload doesn't carry an
    // ambiguous "null" string.
    let origin = "";
    const rawUrl = page.url();
    if (rawUrl && !rawUrl.startsWith("about:") && !rawUrl.startsWith("chrome:")) {
      try { origin = new URL(rawUrl).origin; } catch { /* not a real URL */ }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          origin,
          store,
          written: result.written,
          totalAfter: result.total,
          clearedFirst: !!clearFirst,
        }, null, 2),
      }],
    };
  }),
};
