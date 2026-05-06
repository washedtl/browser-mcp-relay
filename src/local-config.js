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

let cached = null;
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
  if (!opts.refresh && cached !== null && cacheKey === filePath) return cached;
  cacheKey = filePath;

  let parsed;
  try {
    if (!fs.existsSync(filePath)) {
      cached = {};
      return cached;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    parsed = JSON.parse(raw);
  } catch (e) {
    // Silent failure — log to stderr but don't crash. Mis-edited config
    // shouldn't take down the relay.
    process.stderr.write(`[mcp-relay] WARN: failed to parse ${filePath}: ${e.message}\n`);
    cached = {};
    return cached;
  }

  const out = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (k.startsWith("_")) continue; // doc comment / placeholder
    if (typeof v !== "string") continue; // ignore non-string values defensively
    if (v.length === 0) continue; // empty placeholder
    out[k] = v;
  }
  cached = out;
  return cached;
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
