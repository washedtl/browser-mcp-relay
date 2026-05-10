// local-config.js — reads `local-config.json` from the repo root if present.
//
// Precedence (highest first):
//   1. Environment variable
//   2. local-config.json key
//   3. Auto-detect (Brave path, profile dir)
//   4. Legacy fallback
//
// The file is gitignored. Keys mirror env-var names exactly so a user can
// either edit the file OR set an env var — whichever they prefer. Values
// of empty-string ("") in the file are treated as "not set" so the example
// file (with empty placeholders) doesn't accidentally override defaults.
//
// Pure module — safe to require from anywhere. Reads the file on first
// `loadLocalConfig()` call and caches; pass `{ refresh: true }` to re-read.

const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const LOCAL_CONFIG_PATH = path.join(REPO_ROOT, "local-config.json");

// F0-2 (2026-05-10): cache an mtime alongside the parsed result so the
// next call can detect file changes. Previously a "missing file" or
// "parse error" cached `{}` permanently — user creating local-config.json
// or fixing JSON syntax mid-session never saw it until restart.
//
// Cache shape: { value: object, mtimeMs: number | null }
// mtimeMs === null means we cached a "file didn't exist" result; on every
// subsequent call we re-stat to see if it appeared. mtimeMs as a number
// means we cached a successful parse; we re-stat and only re-read if the
// mtime changed.
let cached = null; // { value, mtimeMs } | null
let cacheKey = null;

/**
 * Load local-config.json if it exists. Returns an object with only the
 * meaningful (non-empty, non-doc) keys. Lines beginning with `_` (e.g.
 * `_BROWSER_RELAY_BRAVE_PATH_doc`) are stripped — they're documentation
 * comments in the example file.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] — override file path (test seam)
 * @param {boolean} [opts.refresh] — bypass cache
 * @returns {Record<string, string>} — possibly empty
 */
function loadLocalConfig(opts = {}) {
  const filePath = opts.path || LOCAL_CONFIG_PATH;

  // F0-2: cache reuse only when (a) same file path, (b) cache is for THIS
  // file's current mtime (or both null = "file still doesn't exist").
  if (!opts.refresh && cached !== null && cacheKey === filePath) {
    let currentMtime = null;
    try { currentMtime = fs.statSync(filePath).mtimeMs; } catch { /* missing */ }
    if (currentMtime === cached.mtimeMs) return cached.value;
    // mtime drift → fall through to re-read.
  }
  cacheKey = filePath;

  let parsed;
  let mtimeMs = null;
  try {
    if (!fs.existsSync(filePath)) {
      cached = { value: {}, mtimeMs: null };
      return cached.value;
    }
    mtimeMs = fs.statSync(filePath).mtimeMs;
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (e) {
    // F0-2: do NOT cache parse failures. Previous behavior: parse failure
    // cached `{}` permanently — user fixing JSON syntax mid-session never
    // saw the fix until restart. Now: log + return `{}` but invalidate
    // the cache so the next call re-reads.
    process.stderr.write(`[mcp-relay] WARN: failed to parse ${filePath}: ${e.message}\n`);
    cached = null;
    return {};
  }

  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith("_")) continue; // doc comment / placeholder
    if (typeof v !== "string") continue; // ignore non-string values defensively
    if (v.length === 0) continue; // empty placeholder
    out[k] = v;
  }
  cached = { value: out, mtimeMs };
  return out;
}

/**
 * Apply local-config.json values as a base layer under the given env object.
 * Env values that are already set (non-empty) win; otherwise the local-config
 * value is used. Returns a NEW env-shaped object — does NOT mutate input.
 *
 * Use this at the top of a config-resolution chain so subsequent code can
 * read env vars and transparently see the local-config layer.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {object} [opts] — forwarded to loadLocalConfig
 * @returns {NodeJS.ProcessEnv}
 */
function applyLocalConfigToEnv(env, opts = {}) {
  const local = loadLocalConfig(opts);
  const merged = { ...env };
  for (const [k, v] of Object.entries(local)) {
    if (!merged[k] || merged[k].length === 0) {
      merged[k] = v;
    }
  }
  return merged;
}

/** Path to the canonical local-config.json — exposed for tests / setup script. */
function getLocalConfigPath() { return LOCAL_CONFIG_PATH; }

module.exports = {
  loadLocalConfig,
  applyLocalConfigToEnv,
  getLocalConfigPath,
};
