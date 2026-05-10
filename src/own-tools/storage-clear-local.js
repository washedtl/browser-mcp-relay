// storage_clear-local — wipe localStorage / sessionStorage for the active
// page's origin. Useful for testing fresh-user flows or recovering after a
// stuck session — the only alternative is profile reset which kills all
// sessions across all sites.

const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "storage_clear-local",
  description:
    "Clear localStorage or sessionStorage on the active page's origin. " +
    "Returns the count of keys that were removed. Use `keys` to remove only " +
    "specific keys; omit it to clear the entire store.",
  inputSchema: {
    type: "object",
    properties: {
      store: {
        type: "string",
        enum: ["local", "session"],
        default: "local",
      },
      keys: {
        type: "array",
        items: { type: "string" },
        description: "Optional. If provided, only these keys are removed. Omit to clear the entire store.",
      },
    },
  },
  handler: async ({ store = "local", keys } = {}) => withActivePage(async ({ page }) => {
    if (store !== "local" && store !== "session") {
      return {
        content: [{ type: "text", text: `storage_clear-local: store must be 'local' or 'session' (got ${JSON.stringify(store)})` }],
        isError: true,
      };
    }
    if (keys !== undefined && !Array.isArray(keys)) {
      return {
        content: [{ type: "text", text: "storage_clear-local: keys must be an array of strings (or omit to clear all)" }],
        isError: true,
      };
    }
    let result;
    try {
      result = await page.evaluate(({ store, keys }) => {
        const s = store === "session" ? sessionStorage : localStorage;
        const before = s.length;
        if (keys) {
          let removed = 0;
          for (const k of keys) {
            if (s.getItem(k) !== null) {
              s.removeItem(k);
              removed++;
            }
          }
          return { removed, totalAfter: s.length, mode: "selective" };
        }
        s.clear();
        return { removed: before, totalAfter: 0, mode: "all" };
      }, { store, keys });
    } catch (e) {
      return {
        content: [{ type: "text", text: `storage_clear-local: page.evaluate failed: ${e.message}` }],
        isError: true,
      };
    }
    // Reviewer V1: URL("about:blank").origin is "null" string. Skip about:*.
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
          mode: result.mode,
          removed: result.removed,
          totalAfter: result.totalAfter,
        }, null, 2),
      }],
    };
  }),
};
