// storage_set-local — write keys into localStorage / sessionStorage on the
// active page. Inverse of storage_get-local. Used to restore an authed
// session after a fresh navigation, or to inject test fixtures.

const { withActivePage } = require("./_active-page.js");
const { parseStore, pageOrigin } = require("./_storage-common.js");
const { errorResult } = require("./_tool-args.js");

module.exports = {
  name: "storage_set-local",
  description:
    "Write entries ({ key: value }, strings only) into localStorage or sessionStorage on the active page's origin, " +
    "replacing same-name keys. clearFirst: true wipes the store first. Inverse of storage_get-local.",
  inputSchema: {
    type: "object",
    properties: {
      store: { type: "string", enum: ["local", "session"], default: "local" },
      entries: {
        type: "object",
        description: "Map of key → value (strings).",
        additionalProperties: { type: "string" },
      },
      clearFirst: { type: "boolean", default: false },
    },
    required: ["entries"],
  },
  handler: async (_args) => withActivePage(async ({ page }) => {
    // F0-9: null means "omitted" for store / clearFirst.
    const args = _args || {};
    const { entries, clearFirst } = args;
    const parsed = parseStore("storage_set-local", args.store);
    if (parsed.error) return errorResult(parsed.error);
    const store = parsed.store;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      return errorResult("storage_set-local: entries must be an object { key: value }");
    }
    // Reject non-string values upfront — the browser would coerce them but
    // round-tripping the result through storage_get-local would surprise
    // the caller (numbers come back as strings).
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== "string") {
        return errorResult(`storage_set-local: entries.${k} must be a string (got ${typeof v}); browser storage only accepts strings`);
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
      }, { store, entries, clearFirst: !!clearFirst });
    } catch (e) {
      return errorResult(`storage_set-local: page.evaluate failed: ${e.message}`);
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          origin: pageOrigin(page),
          store,
          written: result.written,
          totalAfter: result.total,
          clearedFirst: !!clearFirst,
        }),
      }],
    };
  }),
};
