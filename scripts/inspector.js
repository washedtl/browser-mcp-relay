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

const REPO_ROOT = path.resolve(__dirname, "..");
const UI_DIR = path.join(__dirname, "inspector-ui");
const PKG = require(path.join(REPO_ROOT, "package.json"));

// Specialty MCPs we *can name* but *can't probe* directly (they're separate
// MCP server processes the user's IDE talks to, not this relay). The inspector
// just lists them so the operator knows they exist. browser-devtools-mcp-2 is
// the one exception — it doubles as the cookie-source profile, so we can
// surface its mtime via pool-shared helpers.
const STATIC_SPECIALTY = [
  {
    name: "puppeteer-real-browser",
    description: "Fingerprint-aware Chrome. Use when standard scrape hits PX/Akamai walls.",
    note: "Standalone — separate MCP process, not introspectable from here.",
  },
  {
    name: "amz-aff-firefox-mcp",
    description: "Walmart B2B authed via Firefox profile. Single-session.",
    note: "Standalone — separate MCP process, not introspectable from here.",
  },
  {
    name: "claude-in-chrome",
    description: "Live page debugging via the Chrome extension.",
    note: "Extension — not introspectable from here.",
  },
];

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

    if (pathname === "/api/status") {
      try {
        const status = buildStatus(seams);
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(status, null, 2));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "status build failed", detail: e.message }));
      }
      return;
    }

    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Whitelist of static UI files. Never let the URL drive a path join into
    // arbitrary disk — pin to the three files we serve.
    const staticMap = {
      "/": "index.html",
      "/index.html": "index.html",
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
  makeHandler,
  defaultPort,
  defaultBind,
  redactPath,
  formatDuration,
};
