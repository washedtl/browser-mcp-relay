// storage_get-local — read localStorage / sessionStorage from the active page.
//
// Why this exists: cookies_export covers HTTP cookies, but modern OAuth and
// chat apps (Discord, Notion, Slack, Linear, Mercury, etc.) keep auth tokens
// in localStorage / sessionStorage. Without this tool, those sessions can't
// be inspected or copied between profiles even though Local Storage / Session
// Storage IS already in the cookie-source snapshot's directory list.
//
// W1C1 (2026-11-03): some apps keep MBs of cache in localStorage, so a dump
// is capped (maxBytes) and narrowable (keyFilter). Values that don't fit are
// omitted whole (a cut-off token is worse than none) and listed by key.

const { withActivePage } = require("./_active-page.js");
const { parseStore, pageOrigin } = require("./_storage-common.js");
const { errorResult, intArg } = require("./_tool-args.js");

const DEFAULT_MAX_BYTES = 50_000;
const MAX_OMITTED_KEYS_LISTED = 100;

module.exports = {
  name: "storage_get-local",
  description:
    "Read localStorage or sessionStorage entries on the active page's origin (many SaaS apps keep auth tokens there, not in cookies). " +
    "key reads one value; keyFilter (regex) narrows a dump. Values that don't fit in maxBytes are left out and listed in omittedKeys.",
  inputSchema: {
    type: "object",
    properties: {
      store: { type: "string", enum: ["local", "session"], default: "local" },
      key: { type: "string", description: "Read just this key." },
      keyFilter: { type: "string", description: "Regex on key names." },
      maxBytes: {
        type: "integer", default: DEFAULT_MAX_BYTES, minimum: 1024,
        description: "Cap on returned keys + values.",
      },
    },
  },
  handler: async (_args) => withActivePage(async ({ page }) => {
    // F0-9: null means "omitted" for every optional argument.
    const args = _args || {};
    const parsed = parseStore("storage_get-local", args.store);
    if (parsed.error) return errorResult(parsed.error);
    const store = parsed.store;
    const { key, keyFilter } = args;
    if (key != null && typeof key !== "string") {
      return errorResult(`storage_get-local: key must be a string (got ${JSON.stringify(key)})`);
    }
    if (keyFilter != null) {
      if (typeof keyFilter !== "string") {
        return errorResult(`storage_get-local: keyFilter must be a regex string (got ${JSON.stringify(keyFilter)})`);
      }
      try {
        new RegExp(keyFilter);
      } catch (e) {
        return errorResult(`storage_get-local: invalid keyFilter regex: ${e.message}`);
      }
    }
    const max = intArg("storage_get-local", "maxBytes", args.maxBytes, DEFAULT_MAX_BYTES, 1024);
    if (max.error) return errorResult(max.error);
    let result;
    try {
      // Filter and cap in the page so a multi-MB store never crosses CDP.
      // Sizes are JSON-escaped lengths — what actually reaches the model.
      result = await page.evaluate(({ store, key, keyFilter, maxBytes, maxListed }) => {
        const s = store === "session" ? sessionStorage : localStorage;
        let keys = [];
        if (typeof key === "string") {
          keys = [key];
        } else {
          const re = typeof keyFilter === "string" ? new RegExp(keyFilter) : null;
          for (let i = 0; i < s.length; i++) {
            const k = s.key(i);
            if (k != null && (!re || re.test(k))) keys.push(k);
          }
        }
        const entries = {};
        const omittedKeys = [];
        let omittedCount = 0;
        let used = 0;
        for (const k of keys) {
          const v = s.getItem(k);
          if (v === null) continue;
          const size = JSON.stringify(k).length + JSON.stringify(v).length;
          if (used + size > maxBytes) {
            omittedCount++;
            if (omittedKeys.length < maxListed) omittedKeys.push(k);
            continue;
          }
          entries[k] = v;
          used += size;
        }
        return { entries, omittedKeys, omittedCount };
      }, { store, key, keyFilter, maxBytes: max.value, maxListed: MAX_OMITTED_KEYS_LISTED });
    } catch (e) {
      return errorResult(`storage_get-local: page.evaluate failed: ${e.message}`);
    }
    const payload = { origin: pageOrigin(page), store, count: Object.keys(result.entries).length, entries: result.entries };
    if (result.omittedCount > 0) {
      payload.omittedCount = result.omittedCount;
      payload.omittedKeys = result.omittedKeys;
    }
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  }),
};
