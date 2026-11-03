// tool-catalog.js — cached copy of the upstream browser-devtools-mcp catalog.
//
// tools/list is the first thing every MCP client sends. Answering it from the
// live upstream child meant every idle session paid for an upstream node
// process (~50MB) it might never use. The catalog only changes when the
// upstream build changes, so we cache it on disk:
//
//   key   = sha256(upstream version + entry path/mtime/size + hash of
//           scripts/patch-bdmcp-bundle.js + catalog-shaping upstream env)
//   file  = <repo>/.cache/upstream-catalog.json (gitignored), falling back to
//           a per-user cache dir when the repo is read-only
//   miss  = spawn a throwaway upstream (dummy CDP URL — no browser), ask
//           tools/list, write the file atomically (tmp + rename), kill it
//
// The cache stores the raw upstream tools; servedTool() trims what goes on
// the wire (outputSchema alone is ~62K chars across the 51 tools).

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { UpstreamClient } = require("./upstream-client.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const PATCH_SCRIPT = path.join(REPO_ROOT, "scripts", "patch-bdmcp-bundle.js");
const CACHE_FILE = "upstream-catalog.json";
const CACHE_FORMAT = 1;
// Upstream env vars that change which tools it registers or their schemas.
// FIGMA_ACCESS_TOKEN is keyed by presence only (it enables one tool).
const CATALOG_ENV_KEYS = [
  "TOOL_NAME_PREFIX",
  "AVAILABLE_TOOL_DOMAINS",
  "TOOL_INPUT_METADATA_ENABLE",
  "TOOL_OUTPUT_SCHEMA_DISABLE",
  "PLATFORM",
];
const SERVED_FIELDS = ["name", "title", "description", "inputSchema", "annotations"];
// Never connected to: upstream only attaches over CDP inside a tool call.
const DUMMY_CDP_URL = "http://127.0.0.1:9";
const FETCH_TIMEOUT_MS = 30_000;

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

/** Same resolution as index.js: BROWSER_RELAY_UPSTREAM_PATH, else the npm dep. */
function resolveUpstreamEntry(env, resolve = require.resolve) {
  const override = env.BROWSER_RELAY_UPSTREAM_PATH;
  if (override) {
    if (fs.existsSync(override)) return override;
    throw new Error(`[mcp-relay] BROWSER_RELAY_UPSTREAM_PATH="${override}" but no file at that path. Fix or unset.`);
  }
  try {
    return resolve("browser-devtools-mcp/dist/index.js");
  } catch {
    throw new Error(
      "[mcp-relay] Could not locate browser-devtools-mcp upstream entry. " +
      "Run `npm install` (so require.resolve finds it) or set " +
      "BROWSER_RELAY_UPSTREAM_PATH=/abs/path/to/browser-devtools-mcp/dist/index.js.",
    );
  }
}

/** <repo>/.cache, then the per-user cache root pool-shared.js's
 *  defaultStandaloneDir uses for read-only installs. */
function defaultCacheDirs(env) {
  let userRoot;
  if (process.platform === "win32") {
    userRoot = path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "browser-mcp-relay", "Cache");
  } else if (process.platform === "darwin") {
    userRoot = path.join(os.homedir(), "Library", "Caches", "browser-mcp-relay");
  } else {
    userRoot = path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "browser-mcp-relay");
  }
  return [path.join(REPO_ROOT, ".cache"), userRoot];
}

function catalogKey({ entry, env, patchScript = PATCH_SCRIPT }) {
  const stat = fs.statSync(entry);
  let version = "unknown";
  try {
    version = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "..", "package.json"), "utf8")).version;
  } catch { /* custom build without a package.json next to dist/ — mtime still keys it */ }
  let patchHash = "none";
  try { patchHash = sha256(fs.readFileSync(patchScript)); } catch { /* no patch script */ }
  return sha256(JSON.stringify({
    format: CACHE_FORMAT,
    version,
    entry: path.resolve(entry),
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    patchHash,
    env: CATALOG_ENV_KEYS.map((k) => env[k] || ""),
    figma: Boolean(env.FIGMA_ACCESS_TOKEN && env.FIGMA_ACCESS_TOKEN.trim()),
  }));
}

/** The fields an MCP client needs to show + call a tool. */
function servedTool(tool) {
  const out = {};
  for (const field of SERVED_FIELDS) {
    if (tool[field] !== undefined) out[field] = tool[field];
  }
  return out;
}

function readCache(dirs, key) {
  for (const dir of dirs) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, CACHE_FILE), "utf8"));
      if (data && data.key === key && Array.isArray(data.tools)) return data.tools;
    } catch { /* missing / corrupt → try the next dir, then refetch */ }
  }
  return null;
}

/** Atomic write (tmp + rename) to the first writable dir. Returns its path or null. */
function writeCache(dirs, payload) {
  const body = JSON.stringify(payload);
  for (const dir of dirs) {
    const file = path.join(dir, CACHE_FILE);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, file);
      return file;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* never created */ }
    }
  }
  return null;
}

function killTree(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const done = setTimeout(resolve, 5000);
    child.once("exit", () => { clearTimeout(done); resolve(); });
    if (process.platform === "win32" && child.pid) {
      const tk = spawn("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      tk.on("error", () => { try { child.kill(); } catch { /* already gone */ } });
    } else {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  });
}

function defaultApplyPatch() {
  return require("../scripts/patch-bdmcp-bundle.js").applyPatch();
}

/**
 * Spawn a throwaway upstream, ask tools/list, kill it. No browser: upstream
 * only connects to BROWSER_CDP_ENDPOINT_URL inside a tool call.
 */
async function fetchUpstreamTools({ entry, env, applyPatch = defaultApplyPatch, timeoutMs = FETCH_TIMEOUT_MS }) {
  // The live upstream is spawned after this same patch (index.js); its
  // HttpResourceType enum shows up in o11y_get-http-requests' inputSchema.
  try { applyPatch(); } catch { /* best-effort, as in index.js */ }
  const childEnv = { ...env, BROWSER_CDP_ENDPOINT_URL: DUMMY_CDP_URL, TELEMETRY_ENABLE: "false" };
  delete childEnv.BROWSER_PERSISTENT_USER_DATA_DIR;
  delete childEnv.BROWSER_PERSISTENT_ENABLE;
  const child = spawn(process.execPath, [entry, "--cursor-mcp-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
    windowsHide: true,
  });
  let stderrTail = "";
  child.stderr.on("data", (d) => { stderrTail = (stderrTail + d).slice(-500); });
  child.stdin.on("error", () => { /* child died first; the request rejects */ });
  const client = new UpstreamClient(child.stdout, child.stdin);
  try {
    const spawnFailed = new Promise((_, reject) => child.once("error", reject));
    const result = await Promise.race([client.request("tools/list", {}, timeoutMs), spawnFailed]);
    if (!result || !Array.isArray(result.tools)) throw new Error("tools/list returned no tools array");
    return result.tools;
  } catch (e) {
    const tail = stderrTail.trim();
    throw new Error(`[mcp-relay] upstream catalog fetch failed: ${e.message}${tail ? ` (upstream stderr: ${tail})` : ""}`);
  } finally {
    client.close();
    await killTree(child);
  }
}

/**
 * Raw upstream tools for the current upstream build, from the disk cache or
 * a throwaway upstream on a miss. All options are test seams.
 */
async function loadUpstreamCatalog(opts = {}) {
  const env = opts.env || require("./local-config.js").applyLocalConfigToEnv(process.env);
  const entry = opts.entry || resolveUpstreamEntry(env);
  const dirs = opts.cacheDirs || defaultCacheDirs(env);
  const fetchTools = opts.fetchTools || fetchUpstreamTools;
  const log = opts.log || ((m) => { try { process.stderr.write(m + "\n"); } catch { /* stderr gone */ } });

  const key = catalogKey({ entry, env, patchScript: opts.patchScript });
  // smoke/setup set this so a health check really starts the upstream.
  const cached = env.BROWSER_RELAY_CATALOG_REFRESH === "true" ? null : readCache(dirs, key);
  if (cached) return cached;

  const started = Date.now();
  const tools = await fetchTools({ entry, env });
  const file = writeCache(dirs, { key, createdAt: new Date().toISOString(), tools });
  log(
    `[mcp-relay] upstream catalog: ${tools.length} tools fetched in ${Date.now() - started}ms; ` +
    (file ? `cached at ${file}` : `not cached (no writable cache dir in ${dirs.join(", ")})`),
  );
  return tools;
}

module.exports = {
  loadUpstreamCatalog,
  fetchUpstreamTools,
  catalogKey,
  servedTool,
  resolveUpstreamEntry,
  defaultCacheDirs,
  CACHE_FILE,
};
