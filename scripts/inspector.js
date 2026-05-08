#!/usr/bin/env node
/**
 * inspector.js — local read-only HTTP dashboard for browser-mcp-relay.
 *
 * Off by default. Friend runs `npm run inspector` when they want to peek at
 * pool slot state, specialty MCP cookie freshness, vault status, etc.
 *
 * Hard rules:
 *   - Bind 127.0.0.1 by default; LAN exposure requires explicit
 *     BROWSER_RELAY_INSPECTOR_BIND override (with a printed warning).
 *   - GET-only. Any non-GET request returns 405 — the inspector is
 *     observe-only in W7. Mutating endpoints are W8+.
 *   - No new npm deps — node:http / node:fs / node:url / node:path only.
 *   - Static files re-read from disk each request (no aggressive cache).
 *   - User-facing UI never leaks absolute Windows paths — see redactPath().
 *
 * The HTTP server is constructed via `createInspector({...seams})`. Tests
 * inject fake `_loadConfig`, `_listProcesses`, etc. so we don't have to
 * launch real Brave instances or sit on a real pool to verify shape.
 */

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const url = require("node:url");

const pool = require("../src/pool-shared.js");
const processShim = require("../src/process-shim.js");
const { loadVaultFromEnv } = require("../src/vault.js");
const { tools: ownTools } = require("../src/own-tools/index.js");
const { detectBraveProfileDir } = require("../src/detect-browser.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const UI_DIR = path.join(__dirname, "inspector-ui");
const PKG = require(path.join(REPO_ROOT, "package.json"));
const LOCAL_CONFIG_PATH = path.join(REPO_ROOT, "local-config.json");
const LOCAL_CONFIG_EXAMPLE = "local-config.example.json";

// Env vars whose set/unset state we surface on the Settings page. We only
// expose booleans — never the values themselves — so this list also acts as
// the allowlist for `/api/settings`.env.
const TRACKED_ENV_VARS = [
  "BROWSER_RELAY_BRAVE_PATH",
  "BROWSER_RELAY_UPSTREAM_PATH",
  "BROWSER_RELAY_BRAVE_PROFILE_DIR",
  "BROWSER_RELAY_POOL_DIR",
  "BROWSER_RELAY_POOL_SLOT",
  "BROWSER_RELAY_PROXY_URL",
  "BROWSER_RELAY_VAULT_FILES",
  "BROWSER_RELAY_SNAPSHOT_INDEXEDDB",
  "BROWSER_HEADLESS_ENABLE",
];

// Specialty MCPs we *can name* but *can't probe* directly (they're separate
// MCP server processes the user's IDE talks to, not this relay). The inspector
// just lists them so the operator knows they exist. browser-devtools-mcp-2 is
// the one exception — it doubles as the cookie-source profile, so we can
// surface its mtime via pool-shared helpers.
const STATIC_SPECIALTY = [
  {
    name: "puppeteer-real-browser",
    displayName: "puppeteer-real-browser",
    role: "scrape-fallback",
    description:
      "Fingerprint-aware Chrome. Use when standard scrape hits PX/Akamai/Cloudflare walls. Standalone MCP — runs in its own process.",
    note: "Standalone — separate MCP process, not introspectable from here.",
    docsUrl: "https://www.npmjs.com/package/puppeteer-real-browser",
    sourceRepoUrl: "https://github.com/zfcsoftware/puppeteer-real-browser",
  },
  {
    name: "amz-aff-firefox-mcp",
    displayName: "amz-aff-firefox-mcp",
    role: "walmart-b2b",
    description:
      "Walmart B2B authed via Firefox profile. Single-session. Used when the relay's Brave can't get past Walmart B2B's bot detection.",
    note: "Standalone — separate MCP process, not introspectable from here.",
    docsUrl: null,
    sourceRepoUrl: null,
  },
  {
    name: "claude-in-chrome",
    displayName: "claude-in-chrome",
    role: "live-debug",
    description:
      "Live page debugging via the official Anthropic Chrome extension. Use to inspect a page already open in your daily-driver Chrome profile.",
    note: "Extension — not introspectable from here.",
    docsUrl: "https://chromewebstore.google.com/",
    sourceRepoUrl: null,
  },
];

// Description for browser-devtools-mcp-2 — surfaced on the Specialty page.
// Stored separate from STATIC_SPECIALTY because mcp-2 is the one specialty
// we *can* introspect (it's the cookie-source profile).
const BDMCP2_META = {
  displayName: "browser-devtools-mcp-2",
  role: "cookie-source",
  description:
    "Cookie source profile. Feeds saved-login cookies into every pool slot at launch — log in once via this MCP, every subsequent pool launch inherits the session. Refresh by opening a new mcp-2 session and logging back in.",
  docsUrl: "https://www.npmjs.com/package/browser-devtools-mcp",
  sourceRepoUrl: "https://github.com/iansatish/browser-devtools-mcp",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Redact Windows / POSIX absolute paths down to a basename so we don't
 *  leak `C:\Users\<name>\.claude\...` onto the rendered page. */
function redactPath(p) {
  if (!p) return p;
  // For pool dirs we usually want the trailing folder name (e.g. ".browser-data-mcp-pool-1")
  return path.basename(p);
}

/** Format a Date diff in a compact "1h 12m" / "47m" / "12s" shape. */
function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Build the /api/status payload. Pure-ish (everything stateful is injected
 *  via the seams object) so tests can pin behavior without real pool state. */
function buildStatus(seams = {}) {
  const _loadConfig = seams._loadConfig || pool.loadConfig;
  const _findBraveProcessesForDir =
    seams._findBraveProcessesForDir || pool.findBraveProcessesForDir;
  const _listBraveProcessesRaw =
    seams._listBraveProcessesRaw || pool.listBraveProcessesRaw;
  const _isPidAlive = seams._isPidAlive || pool.isPidAlive;
  const _findCookiesFile = seams._findCookiesFile || pool.findCookiesFile;
  const _checkCookieAgeDays =
    seams._checkCookieAgeDays || pool.checkCookieAgeDays;
  const _loadVault = seams._loadVault || loadVaultFromEnv;
  const _readFile = seams._readFile || ((p) => fs.readFileSync(p, "utf8"));
  const _statFile = seams._statFile || ((p) => fs.statSync(p));
  const _existsFile = seams._existsFile || ((p) => fs.existsSync(p));
  const _now = seams._now || (() => Date.now());
  const _startedAt = seams._startedAt || serverStartedAt;
  const _ownTools = seams._ownTools || ownTools;
  const _env = seams._env || process.env;

  const cfg = _loadConfig();
  const braveProcessText = _listBraveProcessesRaw();

  const slots = (cfg.poolDirs || []).map((dir, idx) => {
    const lockPath = path.join(dir, ".mcp-wrapper-lock");
    let pid = null;
    let pidAlive = null;
    let lockHeldMs = null;
    let state = "idle";
    let lockExists = false;

    try {
      lockExists = _existsFile(lockPath);
    } catch {
      lockExists = false;
    }

    if (lockExists) {
      try {
        const meta = JSON.parse(_readFile(lockPath));
        if (meta && Number.isFinite(meta.pid)) {
          pid = meta.pid;
          pidAlive = !!_isPidAlive(meta.pid);
        }
        if (meta && meta.startedAt) {
          const started = Date.parse(meta.startedAt);
          if (Number.isFinite(started)) lockHeldMs = _now() - started;
        } else {
          // Fall back to lock-file mtime so callers still get an age.
          try {
            const st = _statFile(lockPath);
            lockHeldMs = _now() - st.mtimeMs;
          } catch { /* unreadable */ }
        }
      } catch {
        // Garbled lock file — still surface as orphan so user notices.
        pid = null;
        pidAlive = false;
      }
    }

    // Are there real brave processes running for this dir?
    const bravePids = _findBraveProcessesForDir(braveProcessText, dir);
    const liveBravePids = bravePids.filter((p) => _isPidAlive(p));

    if (lockExists && pidAlive && liveBravePids.length > 0) {
      state = "claimed";
    } else if (lockExists && pidAlive === false) {
      state = "orphan";
    } else if (lockExists && liveBravePids.length === 0) {
      // Lock held by what claims to be a live PID but no Brave => probably
      // mid-launch or something stale. Treat as orphan to draw operator eyes.
      state = pidAlive ? "claimed" : "orphan";
    } else {
      state = "idle";
    }

    // Cookie age: prefer the slot's own snapshot path; fall back to whatever
    // pool-shared.findCookiesFile() returns for the slot dir.
    let cookieAgeDays = null;
    try {
      const cookiesPath = _findCookiesFile(dir);
      if (cookiesPath) {
        cookieAgeDays = _checkCookieAgeDays(cookiesPath);
      }
    } catch { /* leave null */ }

    return {
      index: idx + 1,
      dir: redactPath(dir),
      role: (cfg.slotRoles || {})[dir] || "default",
      state,
      pid,
      pidAlive,
      lockHeldMs,
      cookieAgeDays,
      bravePids: liveBravePids,
    };
  });

  // Specialty: introspect browser-devtools-mcp-2 (cookie source profile)
  // age via the cookieSourceProfile config.
  const specialty = {};
  let bdmcp2CookieAge = null;
  let bdmcp2Status = "unknown";
  try {
    if (cfg.cookieSourceProfile) {
      const cookiesPath = _findCookiesFile(cfg.cookieSourceProfile);
      if (cookiesPath) {
        bdmcp2CookieAge = _checkCookieAgeDays(cookiesPath);
        if (bdmcp2CookieAge != null) {
          bdmcp2Status =
            bdmcp2CookieAge <= cfg.cookieFreshnessWarnDays ? "fresh" : "stale";
        }
      }
    }
  } catch { /* leave unknown */ }

  specialty["browser-devtools-mcp-2"] = {
    cookieSourceProfile: cfg.cookieSourceProfile
      ? redactPath(cfg.cookieSourceProfile)
      : null,
    cookieAgeDays: bdmcp2CookieAge,
    thresholdDays: cfg.cookieFreshnessWarnDays,
    status: bdmcp2Status,
    description:
      "Cookie source profile — feeds the pool's cookie snapshots on launch.",
  };
  for (const s of STATIC_SPECIALTY) {
    specialty[s.name] = {
      cookieSourceProfile: null,
      cookieAgeDays: null,
      thresholdDays: cfg.cookieFreshnessWarnDays,
      status: "unknown",
      description: s.description,
      note: s.note,
    };
  }

  // Vault.
  let vaultBlock = {
    enabled: false,
    totalEntries: 0,
    uniqueHosts: 0,
    filesLoaded: [],
    filesSkipped: [],
  };
  try {
    const vault = _loadVault();
    const summary = vault.summary();
    vaultBlock = {
      enabled: !!_env.BROWSER_RELAY_VAULT_FILES,
      totalEntries: summary.totalEntries,
      uniqueHosts: summary.uniqueHosts,
      filesLoaded: (summary.filesLoaded || []).map((f) => ({
        path: redactPath(f.path),
        entries: f.entries,
      })),
      filesSkipped: (summary.filesSkipped || []).map((f) => ({
        path: redactPath(f.path),
        reason: f.reason,
      })),
    };
  } catch (e) {
    // Defensive — never crash status on a vault load failure.
    vaultBlock.error = e.message;
  }

  // Tools count. Forwarded count is a static stand-in — actually fetching
  // the real upstream count requires comms with the upstream MCP, which is
  // a W8+ enhancement.
  const ownCount = _ownTools.length;
  const forwardedCount = 51;

  const uptimeSeconds = Math.floor((_now() - _startedAt) / 1000);

  // Detect mode for the pill in the header. If only one pool dir AND the
  // standalone flag is set on the config, call it standalone; otherwise pool.
  let mode = cfg.standalone ? "standalone" : "pool";

  return {
    config: {
      mode,
      poolDirs: (cfg.poolDirs || []).map(redactPath),
      slotRoles: Object.fromEntries(
        Object.entries(cfg.slotRoles || {}).map(([k, v]) => [redactPath(k), v]),
      ),
      cookieFreshnessWarnDays: cfg.cookieFreshnessWarnDays,
      bravePath: cfg.bravePath ? redactPath(cfg.bravePath) : null,
      braveDetectError: cfg.braveDetectError
        ? cfg.braveDetectError.message || String(cfg.braveDetectError)
        : null,
    },
    slots,
    specialty,
    vault: vaultBlock,
    tools: {
      total: ownCount + forwardedCount,
      ownCount,
      forwardedCount,
      forwardedCountSource: "static-placeholder",
    },
    server: {
      uptimeSeconds,
      startedAt: new Date(_startedAt).toISOString(),
      version: PKG.version,
    },
  };
}

/** Build the /api/settings payload. Surfaces resolved config + which env
 *  vars are SET (booleans only — never values) + a paste-ready
 *  local-config.json snippet for friends who'd rather configure once on disk
 *  than maintain env vars. Read-only by design — W8 has no /api/settings POST
 *  counterpart. Mutating endpoints land in W10 with proper CORS gating. */
function buildSettings(seams = {}) {
  const _loadConfig = seams._loadConfig || pool.loadConfig;
  const _detectBraveProfileDir = seams._detectBraveProfileDir || detectBraveProfileDir;
  const _existsFile = seams._existsFile || ((p) => fs.existsSync(p));
  const _env = seams._env || process.env;

  const cfg = _loadConfig();

  // detectBraveProfileDir() reads BROWSER_RELAY_BRAVE_PROFILE_DIR if set.
  // We pass the same env so tests / overrides are honored.
  let braveProfileDir = null;
  try {
    braveProfileDir = _detectBraveProfileDir({ env: _env });
  } catch { /* leave null */ }

  // Booleans only — never values. The loop is the allowlist; any env var not
  // in TRACKED_ENV_VARS is invisible to this endpoint.
  const envBooleans = {};
  for (const k of TRACKED_ENV_VARS) {
    envBooleans[k] = !!(_env[k] && _env[k].length > 0);
  }

  const localConfigExists = !!_existsFile(LOCAL_CONFIG_PATH);

  // Build a paste-ready snippet using the values currently being used. We
  // redact paths in the *displayed* snippet too — friends see basenames and
  // know where to fill in their own absolute paths. Better than leaking
  // C:\Users\<them>\... back into the page.
  const localConfigSnippet = JSON.stringify(
    {
      BROWSER_RELAY_BRAVE_PATH: cfg.bravePath ? redactPath(cfg.bravePath) : "",
      BROWSER_RELAY_BRAVE_PROFILE_DIR: braveProfileDir
        ? redactPath(braveProfileDir)
        : "",
      BROWSER_RELAY_POOL_DIR: "",
      BROWSER_RELAY_POOL_SLOT: "",
      BROWSER_HEADLESS_ENABLE: "false",
      BROWSER_RELAY_PROXY_URL: "",
      BROWSER_RELAY_VAULT_FILES: "",
      BROWSER_RELAY_SNAPSHOT_INDEXEDDB: "false",
    },
    null,
    2,
  );

  return {
    config: {
      bravePath: cfg.bravePath ? redactPath(cfg.bravePath) : null,
      braveProfileDir: braveProfileDir ? redactPath(braveProfileDir) : null,
      poolDirs: (cfg.poolDirs || []).map(redactPath),
      slotRoles: Object.fromEntries(
        Object.entries(cfg.slotRoles || {}).map(([k, v]) => [redactPath(k), v]),
      ),
      cookieSourceProfile: cfg.cookieSourceProfile
        ? redactPath(cfg.cookieSourceProfile)
        : null,
      cookieFreshnessWarnDays: cfg.cookieFreshnessWarnDays,
      mode: cfg.standalone ? "standalone" : "pool",
    },
    env: envBooleans,
    localConfigExists,
    localConfigSnippet,
    localConfigExamplePath: LOCAL_CONFIG_EXAMPLE,
  };
}

/** Build the /api/specialty payload — 4 cards (mcp-2 + 3 static). mcp-2's
 *  status is derived from cookieSourceProfile freshness; everything else is
 *  unknown because the inspector can't probe other MCP server processes. */
function buildSpecialty(seams = {}) {
  const _loadConfig = seams._loadConfig || pool.loadConfig;
  const _findCookiesFile = seams._findCookiesFile || pool.findCookiesFile;
  const _checkCookieAgeDays =
    seams._checkCookieAgeDays || pool.checkCookieAgeDays;

  const cfg = _loadConfig();
  const items = [];

  // browser-devtools-mcp-2 — cookie source. Same derivation as buildStatus
  // so the two pages can't disagree on freshness.
  let mcp2CookieAge = null;
  let mcp2Status = "unknown";
  try {
    if (cfg.cookieSourceProfile) {
      const cookiesPath = _findCookiesFile(cfg.cookieSourceProfile);
      if (cookiesPath) {
        mcp2CookieAge = _checkCookieAgeDays(cookiesPath);
        if (mcp2CookieAge != null) {
          mcp2Status =
            mcp2CookieAge <= cfg.cookieFreshnessWarnDays ? "fresh" : "stale";
        }
      }
    }
  } catch { /* leave unknown */ }

  items.push({
    id: "browser-devtools-mcp-2",
    displayName: BDMCP2_META.displayName,
    role: BDMCP2_META.role,
    description: BDMCP2_META.description,
    status: mcp2Status,
    cookieSourceProfile: cfg.cookieSourceProfile
      ? redactPath(cfg.cookieSourceProfile)
      : null,
    cookieAgeDays: mcp2CookieAge,
    thresholdDays: cfg.cookieFreshnessWarnDays,
    docsUrl: BDMCP2_META.docsUrl,
    sourceRepoUrl: BDMCP2_META.sourceRepoUrl,
  });

  for (const s of STATIC_SPECIALTY) {
    items.push({
      id: s.name,
      displayName: s.displayName,
      role: s.role,
      description: s.description,
      status: "unknown",
      cookieSourceProfile: null,
      cookieAgeDays: null,
      thresholdDays: cfg.cookieFreshnessWarnDays,
      docsUrl: s.docsUrl,
      sourceRepoUrl: s.sourceRepoUrl,
    });
  }

  return { items };
}

// Module-level start time so /api/status uptime stays stable across reqs.
let serverStartedAt = Date.now();

/** Build the request handler. Wired via createInspector(); exposed for unit
 *  tests so we don't have to bind a port to test routing. */
function makeHandler(seams = {}) {
  return async function handler(req, res) {
    // GET and HEAD are both read-only; everything else is rejected.
    // (HEAD returns the same headers as GET but with no body — the http
    //  module strips the body automatically when method is HEAD.)
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const parsed = url.parse(req.url || "/");
    const pathname = parsed.pathname || "/";

    // JSON API endpoints. Each wraps its build* in try/catch so a single
    // bad seam can't kill the whole inspector.
    const apiBuilders = {
      "/api/status": buildStatus,
      "/api/settings": buildSettings,
      "/api/specialty": buildSpecialty,
    };
    const apiBuilder = apiBuilders[pathname];
    if (apiBuilder) {
      try {
        const payload = apiBuilder(seams);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(payload, null, 2));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "build failed", detail: e.message }));
      }
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Whitelist of static UI files. Never let the URL drive a path join into
    // arbitrary disk — pin to the named files we serve. SPA routes /settings
    // and /specialty also resolve to index.html so the frontend can route on
    // location.pathname (no pushState yet — full nav per W8 brief).
    const staticMap = {
      "/": "index.html",
      "/index.html": "index.html",
      "/settings": "index.html",
      "/specialty": "index.html",
      "/styles.css": "styles.css",
      "/app.js": "app.js",
    };
    const fname = staticMap[pathname];
    if (fname) {
      const file = path.join(UI_DIR, fname);
      try {
        const buf = await fsp.readFile(file);
        const mime = MIME[path.extname(fname)] || "application/octet-stream";
        res.writeHead(200, {
          "Content-Type": mime,
          "Cache-Control": "no-store",
        });
        res.end(buf);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "static read failed", detail: e.message }));
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not found" }));
  };
}

/** Construct the inspector HTTP server. Returns the unstarted server so
 *  tests can server.listen(0) on a random port. */
function createInspector(seams = {}) {
  const handler = makeHandler(seams);
  const server = http.createServer(handler);
  return server;
}

function defaultPort(env = process.env) {
  const raw = env.BROWSER_RELAY_INSPECTOR_PORT;
  if (!raw) return 9090;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0 || n > 65535) return 9090;
  return n;
}

function defaultBind(env = process.env) {
  const raw = env.BROWSER_RELAY_INSPECTOR_BIND;
  if (!raw) return "127.0.0.1";
  return raw;
}

// Run-as-script entrypoint.
if (require.main === module) {
  const port = defaultPort();
  const bind = defaultBind();

  if (bind !== "127.0.0.1" && bind !== "localhost") {
    process.stderr.write(
      `[mcp-relay-inspector] WARNING: binding to ${bind} (not 127.0.0.1). ` +
      `The inspector has no auth — anyone who can reach this address can read pool state.\n`,
    );
  }

  serverStartedAt = Date.now();
  const server = createInspector();
  server.listen(port, bind, () => {
    process.stdout.write(
      `Inspector running at http://${bind === "0.0.0.0" ? "localhost" : bind}:${port}\n`,
    );
  });

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
    });
  }
}

module.exports = {
  createInspector,
  buildStatus,
  buildSettings,
  buildSpecialty,
  makeHandler,
  defaultPort,
  defaultBind,
  redactPath,
  formatDuration,
  TRACKED_ENV_VARS,
};
