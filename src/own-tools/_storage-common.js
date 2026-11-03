// _storage-common.js — store validation + origin lookup shared by
// storage_get-local / storage_set-local / storage_clear-local.

/**
 * F0-9: null/undefined → "local" (JSON-RPC clients send unset optionals as
 * null). Returns { store } or { error } (error text prefixed with the tool).
 */
function parseStore(tool, store) {
  if (store == null) return { store: "local" };
  if (store === "local" || store === "session") return { store };
  return { error: `${tool}: store must be 'local' or 'session' (got ${JSON.stringify(store)})` };
}

/**
 * The active page's origin, or "" when it has none. Opaque origins
 * (about:, chrome:, file:, data:, …) serialize as the literal string
 * "null", which reads like JSON null, so they report "".
 */
function pageOrigin(page) {
  let origin = "";
  try { origin = new URL(page.url()).origin; } catch { /* not a URL */ }
  return origin === "null" ? "" : origin;
}

module.exports = { parseStore, pageOrigin };
