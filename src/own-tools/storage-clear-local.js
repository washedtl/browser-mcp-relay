// storage_clear-local — wipe localStorage / sessionStorage for the active
// page's origin. Useful for testing fresh-user flows or recovering after a
// stuck session — the only alternative is profile reset which kills all
// sessions across all sites.

const { parseStore, pageOrigin } = require("./_storage-common.js");
const { errorResult } = require("./_tool-args.js");

module.exports = {
  name: "storage_clear-local",
  description:
    "Clear localStorage or sessionStorage on the active page's origin and return how many keys were removed. " +
    "keys limits it to those keys; omit keys to clear the whole store.",
  inputSchema: {
    type: "object",
    properties: {
      store: { type: "string", enum: ["local", "session"], default: "local" },
      keys: { type: "array", items: { type: "string" }, description: "Remove only these keys." },
    },
  },
  handler: async (_args, { page }) => {
    // F0-9: store: null means "omitted". keys is the exception: this tool is
    // destructive, so keys: null is an error, never "clear everything" —
    // only leaving keys out clears the whole store.
    const args = _args || {};
    const parsed = parseStore("storage_clear-local", args.store);
    if (parsed.error) return errorResult(parsed.error);
    const store = parsed.store;
    const keys = args.keys;
    if (keys !== undefined && !Array.isArray(keys)) {
      return errorResult("storage_clear-local: keys must be an array of strings (or omit to clear all)");
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
      return errorResult(`storage_clear-local: page.evaluate failed: ${e.message}`);
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          origin: pageOrigin(page),
          store,
          mode: result.mode,
          removed: result.removed,
          totalAfter: result.totalAfter,
        }),
      }],
    };
  },
};
