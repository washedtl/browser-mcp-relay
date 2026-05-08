// inspector-server.js — reusable Inspector module.
//
// Two operating modes:
//   1. Standalone — launched via `npm run inspector` (scripts/inspector.js
//      is the thin entry). No live MCP traffic; Activity feed shows the
//      "no-emitter" message.
//   2. In-process — booted from src/index.js when
//      BROWSER_RELAY_INSPECTOR_PORT is set on the relay process. The relay
//      passes its trafficEmitter, so /ws/traffic streams real MCP traffic.
//
// Hard rules (carried over from W7-W9 inspector.js):
//   - Bind 127.0.0.1 by default; LAN exposure requires explicit bind override.
//   - GET-only on the HTTP side (no mutating endpoints — that's W11).
//   - WS endpoint /ws/traffic is read-only too: server pushes, client never
//     sends anything we trust beyond pong.
//   - Static files re-read from disk each request (no aggressive cache).
//   - User-facing UI never leaks absolute paths — see redactPath().
//   - Truncate large response bodies (~10KB cap) before emitting traffic
//     events (memory-safety on noisy capture_xhr / lighthouse_audit calls).
//
// Construction model: startInspector({ port, bind, getStatus, getTraffic,
// trafficEmitter, uiRoot }) returns { server, close, port, bind, wss }.
// Tests inject seams; the standalone entry just calls startInspector().

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const url = require("node:url");
const { WebSocketServer } = require("ws");

const pool = require("./pool-shared.js");
const { loadVaultFromEnv } = require("./vault.js");
const { tools: ownTools } = require("./own-tools/index.js");
const { detectBraveProfileDir } = require("./detect-browser.js");
const forwardedCatalog = require("../scripts/inspector-forwarded-tools.js");

const REPO_ROOT = path.resolve(__dirname, "..");
const PKG = require(path.join(REPO_ROOT, "package.json"));
const LOCAL_CONFIG_PATH = path.join(REPO_ROOT, "local-config.json");
const LOCAL_CONFIG_EXAMPLE = "local-config.example.json";

// Env vars whose set/unset state we surface on the Settings page. Booleans
// only — never the values themselves.
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

// Specialty MCPs we *can name* but *can't probe*. browser-devtools-mcp-2 is
// the one exception — we surface its mtime via pool-shared helpers.
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

/** Redact Windows / POSIX absolute paths to a basename. */
function redactPath(p) {
  if (!p) return p;
  return path.basename(p);
}

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
 *  via the seams object). */
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
  const _startedAt = seams._startedAt || moduleStartedAt;
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
          try {
            const st = _statFile(lockPath);
            lockHeldMs = _now() - st.mtimeMs;
          } catch { /* unreadable */ }
        }
      } catch {
        pid = null;
        pidAlive = false;
      }
    }

    const bravePids = _findBraveProcessesForDir(braveProcessText, dir);
    const liveBravePids = bravePids.filter((p) => _isPidAlive(p));

    if (lockExists && pidAlive && liveBravePids.length > 0) {
      state = "claimed";
    } else if (lockExists && pidAlive === false) {
      state = "orphan";
    } else if (lockExists && liveBravePids.length === 0) {
      state = pidAlive ? "claimed" : "orphan";
    } else {
      state = "idle";
    }

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
    vaultBlock.error = e.message;
  }

  const ownCount = _ownTools.length;
  const forwardedCount = 51;
  const uptimeSeconds = Math.floor((_now() - _startedAt) / 1000);
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

function buildSettings(seams = {}) {
  const _loadConfig = seams._loadConfig || pool.loadConfig;
  const _detectBraveProfileDir = seams._detectBraveProfileDir || detectBraveProfileDir;
  const _existsFile = seams._existsFile || ((p) => fs.existsSync(p));
  const _env = seams._env || process.env;

  const cfg = _loadConfig();

  let braveProfileDir = null;
  try {
    braveProfileDir = _detectBraveProfileDir({ env: _env });
  } catch { /* leave null */ }

  const envBooleans = {};
  for (const k of TRACKED_ENV_VARS) {
    envBooleans[k] = !!(_env[k] && _env[k].length > 0);
  }

  const localConfigExists = !!_existsFile(LOCAL_CONFIG_PATH);

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

const OWN_TOOL_META = {
  lighthouse_audit: { sourceFile: "lighthouse-audit.js", category: "performance" },
  "memory_take-heap-snapshot": { sourceFile: "memory-take-heap-snapshot.js", category: "performance" },
  emulate_device: { sourceFile: "emulate-device.js", category: "device" },
  tabs_list: { sourceFile: "tabs-list.js", category: "tabs" },
  tabs_new: { sourceFile: "tabs-new.js", category: "tabs" },
  tabs_select: { sourceFile: "tabs-select.js", category: "tabs" },
  tabs_close: { sourceFile: "tabs-close.js", category: "tabs" },
  dialog_handle: { sourceFile: "dialog-handle.js", category: "forms" },
  file_upload: { sourceFile: "file-upload.js", category: "forms" },
  form_fill: { sourceFile: "form-fill.js", category: "forms" },
  capture_xhr: { sourceFile: "capture-xhr.js", category: "network" },
  cookies_export: { sourceFile: "cookies-export.js", category: "session" },
  cookies_import: { sourceFile: "cookies-import.js", category: "session" },
  stealth_apply: { sourceFile: "stealth-apply.js", category: "session" },
  download_capture: { sourceFile: "download-capture.js", category: "downloads" },
  extract_structured: { sourceFile: "extract-structured.js", category: "data" },
};

function truncate(text, max) {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max - 1).trimEnd() + "…";
}

function inputSchemaPreview(inputSchema) {
  if (!inputSchema || !inputSchema.properties) return "";
  const keys = Object.keys(inputSchema.properties);
  if (!keys.length) return "";
  return keys.join(", ");
}

function buildToolsCatalog(seams = {}) {
  const _ownTools = seams._ownTools || ownTools;

  const own = _ownTools.map((t) => {
    const meta = OWN_TOOL_META[t.name] || {};
    return {
      name: t.name,
      description: truncate(t.description || "", 200),
      sourceFile: meta.sourceFile || `${t.name}.js`,
      category: meta.category || "data",
      inputSchemaPreview: inputSchemaPreview(t.inputSchema),
    };
  });

  const forwarded = forwardedCatalog.tools.map((t) => ({
    name: t.name,
    description: t.description,
    upstreamSource: forwardedCatalog.upstreamSource,
    category: t.category,
  }));

  return {
    total: own.length + forwarded.length,
    ownCount: own.length,
    forwardedCount: forwarded.length,
    own,
    forwarded,
  };
}

function buildSpecialty(seams = {}) {
  const _loadConfig = seams._loadConfig || pool.loadConfig;
  const _findCookiesFile = seams._findCookiesFile || pool.findCookiesFile;
  const _checkCookieAgeDays =
    seams._checkCookieAgeDays || pool.checkCookieAgeDays;

  const cfg = _loadConfig();
  const items = [];

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

/** Build the per-slot detail payload for /api/slot/:n. Returns null if `n`
 *  is out of range, so the caller can 404 cleanly. The payload is the full
 *  slot entry from buildStatus + a `recentTraffic` array (last 200 events). */
function buildSlotDetail(n, seams = {}) {
  const status = buildStatus(seams);
  const slot = status.slots.find((s) => s.index === n);
  if (!slot) return null;

  const trafficBuffer = seams._trafficBuffer || [];
  // No PID-based filter today: the relay process is the only producer of
  // traffic, and it always corresponds to ONE slot at a time. If we ever
  // multiplex slots inside one relay we can extend the event shape.
  const recentTraffic = Array.isArray(trafficBuffer) ? trafficBuffer.slice(-200) : [];

  return { slot, recentTraffic, totalSlots: status.slots.length };
}

// Module-level start time so /api/status uptime stays stable across reqs.
let moduleStartedAt = Date.now();

const STATIC_MAP = {
  "/": "index.html",
  "/index.html": "index.html",
  "/settings": "index.html",
  "/specialty": "index.html",
  "/tools": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
};

/** Build the request handler. */
function makeHandler({ uiRoot, seams = {}, getSlotDetail }) {
  return async function handler(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const parsed = url.parse(req.url || "/");
    const pathname = parsed.pathname || "/";

    // Per-slot detail API: /api/slot/:n. Validate n is integer >= 1 and
    // <= total slot count; otherwise 404.
    const slotApiMatch = pathname.match(/^\/api\/slot\/(.+)$/);
    if (slotApiMatch) {
      const raw = slotApiMatch[1];
      const n = parseInt(raw, 10);
      // String() round-trip catches "abc", "3abc", floats, etc — only accept
      // pure integers >= 1.
      if (!Number.isInteger(n) || n < 1 || String(n) !== raw) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      try {
        const detail = (getSlotDetail || buildSlotDetail)(n, seams);
        if (!detail) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "slot out of range" }));
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify(detail, null, 2));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "build failed", detail: e.message }));
      }
      return;
    }

    const apiBuilders = {
      "/api/status": buildStatus,
      "/api/settings": buildSettings,
      "/api/specialty": buildSpecialty,
      "/api/tools": buildToolsCatalog,
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

    // Static file routing. /slot/:n is an SPA route — serve index.html, the
    // frontend reads location.pathname.
    let fname = STATIC_MAP[pathname];
    if (!fname && /^\/slot\/\d+$/.test(pathname)) fname = "index.html";

    if (fname) {
      const file = path.join(uiRoot, fname);
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

/** Wire up /ws/traffic. Behavior depends on whether trafficEmitter was
 *  provided:
 *   - If yes: send {type:"backfill",events:[...]} immediately, then stream
 *     {type:"request"|"response", ...} events as they fire on the emitter.
 *     Ping every 25s; close clients that don't pong within 10s.
 *   - If no (standalone): send {type:"no-emitter", message:"..."} and close.
 *     Frontend handles this by showing the "Inspector running standalone"
 *     empty state.
 *
 *  The buffer accessor is { getRecent(): array } so the WS server pulls a
 *  snapshot at connect-time, not at construct-time.
 */
function attachWebsocket(httpServer, { trafficEmitter, getRecent, allowedOrigins } = {}) {
  // Defense-in-depth: clients should never send anything beyond pong frames,
  // so cap incoming payloads small. Stops a malicious or buggy client from
  // tying up memory with arbitrarily large frames.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  // Cross-origin WS protection. Browsers do NOT enforce SOP for WebSockets,
  // so a tab on evil.com could open ws://127.0.0.1:9090/ws/traffic and
  // receive every captured tool call — even though our HTTP bind is
  // localhost-only. We accept connections only when the Origin header is
  // absent (curl, native MCP client, our own UI fetched from same origin)
  // or when it matches an allowlist. Default allowlist = localhost / 127.0.0.1.
  const DEFAULT_ALLOWED = ["http://localhost", "http://127.0.0.1"];
  const allowList = (allowedOrigins && allowedOrigins.length) ? allowedOrigins : DEFAULT_ALLOWED;
  function isOriginAllowed(originHeader) {
    if (!originHeader) return true; // non-browser client (curl, native ws)
    // Match by URL prefix (allows any port). normalize: strip trailing slash.
    const probe = String(originHeader).replace(/\/$/, "");
    return allowList.some((prefix) => probe === prefix || probe.startsWith(prefix + ":"));
  }

  // Back-pressure cap: if a slow/paused client lets the send buffer grow
  // past this, drop the connection rather than OOM the relay during a
  // capture_xhr burst or a parallel scrape.
  const MAX_BUFFERED_BYTES = 1_000_000;

  // Per-client liveness: send ping every 25s; if no pong by 10s after the
  // ping, terminate. Tracked via `isAlive` flag flipped on `pong`.
  const PING_INTERVAL_MS = 25_000;
  const PONG_TIMEOUT_MS = 10_000;

  function setupClient(ws) {
    ws.isAlive = true;
    let pongTimer = null;

    ws.on("pong", () => {
      ws.isAlive = true;
      if (pongTimer) { clearTimeout(pongTimer); pongTimer = null; }
    });

    const pingTimer = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (!ws.isAlive) {
        try { ws.terminate(); } catch { /* noop */ }
        return;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /* noop */ }
      pongTimer = setTimeout(() => {
        if (!ws.isAlive) try { ws.terminate(); } catch { /* noop */ }
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);

    ws.on("close", () => {
      clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
    });
    ws.on("error", () => {
      clearInterval(pingTimer);
      if (pongTimer) clearTimeout(pongTimer);
    });
  }

  httpServer.on("upgrade", (req, socket, head) => {
    const parsed = url.parse(req.url || "/");
    if (parsed.pathname !== "/ws/traffic") {
      socket.destroy();
      return;
    }
    // Origin allowlist check — prevents cross-origin WS hijack from a
    // hostile webpage. Browsers ALWAYS send Origin on WS upgrade, so a
    // missing Origin = non-browser client (curl, ws-client) which is fine.
    const origin = req.headers && req.headers.origin;
    if (!isOriginAllowed(origin)) {
      try {
        socket.write(
          "HTTP/1.1 403 Forbidden\r\n" +
          "Connection: close\r\n" +
          "Content-Length: 0\r\n\r\n",
        );
      } catch { /* noop */ }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      setupClient(ws);

      if (!trafficEmitter) {
        // Standalone mode: tell the client immediately and close. Don't keep
        // the connection alive — clients reconnect with backoff and would
        // get the same message back, so closing avoids a busy loop.
        try {
          ws.send(JSON.stringify({
            type: "no-emitter",
            message:
              "Live traffic requires in-process launch via BROWSER_RELAY_INSPECTOR_PORT on the relay",
          }));
        } catch { /* noop */ }
        try { ws.close(1000, "no emitter"); } catch { /* noop */ }
        return;
      }

      // In-process mode: backfill then stream.
      try {
        const events = (typeof getRecent === "function") ? getRecent() : [];
        ws.send(JSON.stringify({ type: "backfill", events: events || [] }));
      } catch { /* noop — client will see the live stream regardless */ }

      // Back-pressure guard: drop the client if its send buffer balloons.
      // A paused/slow tab during a capture_xhr burst would otherwise let
      // `ws` queue frames in memory unboundedly. Better to lose one viewer
      // than OOM the relay process.
      const sendOrTerminate = (payload) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
          try { ws.terminate(); } catch { /* noop */ }
          return;
        }
        try { ws.send(payload); } catch { /* noop */ }
      };

      const onRequest = (evt) => {
        sendOrTerminate(JSON.stringify({ type: "request", ...evt }));
      };
      const onResponse = (evt) => {
        sendOrTerminate(JSON.stringify({ type: "response", ...evt }));
      };

      trafficEmitter.on("request", onRequest);
      trafficEmitter.on("response", onResponse);

      ws.on("close", () => {
        try { trafficEmitter.off("request", onRequest); } catch { /* noop */ }
        try { trafficEmitter.off("response", onResponse); } catch { /* noop */ }
      });
    });
  });

  return wss;
}

/** Construct + start the inspector. Returns a promise that resolves once
 *  the HTTP server is listening. Caller can `await close()` for clean
 *  teardown (closes the WS server too). */
function startInspector(opts = {}) {
  const port = opts.port == null ? 9090 : opts.port;
  const bind = opts.bind || "127.0.0.1";
  const uiRoot = opts.uiRoot || path.join(__dirname, "..", "scripts", "inspector-ui");
  const seams = opts.seams || {};
  // Traffic ring buffer: optional; if the caller has its own buffer we pull
  // from it via getRecent. Otherwise, fall back to the trafficEmitter's
  // buffer if it has one (RelayServer's emitter exposes getRecentTraffic).
  let getRecent = opts.getRecent;
  if (!getRecent && opts.trafficEmitter && typeof opts.trafficEmitter.getRecent === "function") {
    getRecent = () => opts.trafficEmitter.getRecent();
  }

  // Expose the in-memory buffer to /api/slot/:n via the seams object so the
  // slot detail endpoint can include `recentTraffic` without re-implementing
  // ring-buffer access.
  const enrichedSeams = { ...seams };
  if (!enrichedSeams._trafficBuffer && getRecent) {
    Object.defineProperty(enrichedSeams, "_trafficBuffer", {
      get: getRecent,
      enumerable: true,
    });
  }

  moduleStartedAt = Date.now();
  const handler = makeHandler({ uiRoot, seams: enrichedSeams });
  const server = http.createServer(handler);

  const wss = attachWebsocket(server, {
    trafficEmitter: opts.trafficEmitter || null,
    getRecent,
    allowedOrigins: opts.allowedOrigins,
  });

  return new Promise((resolve) => {
    server.listen(port, bind, () => {
      const addr = server.address();
      const actualPort = addr ? addr.port : port;
      const actualBind = addr ? addr.address : bind;
      resolve({
        server,
        wss,
        port: actualPort,
        bind: actualBind,
        close: () => new Promise((r) => {
          // Terminate any live WS clients first — wss.close() alone won't
          // return until all connected sockets close, which can hang in
          // tests where the client process never gracefully closes.
          try {
            for (const client of wss.clients) {
              try { client.terminate(); } catch { /* noop */ }
            }
          } catch { /* noop */ }
          try { wss.close(); } catch { /* noop */ }
          server.close(() => r());
        }),
      });
    });
  });
}

/** Synchronous variant for tests that prefer the unstarted server (back
 *  compat with the W7-W9 createInspector shape). */
function createInspector(seamsOrOpts = {}) {
  // Two calling shapes:
  //   - Old W7-W9: createInspector(seams) — seams has _loadConfig etc.
  //   - New W10:  createInspector({ uiRoot, seams, trafficEmitter, getRecent })
  // We disambiguate by looking for the seam properties.
  const looksLikeOptsBag =
    seamsOrOpts && (
      Object.prototype.hasOwnProperty.call(seamsOrOpts, "uiRoot") ||
      Object.prototype.hasOwnProperty.call(seamsOrOpts, "seams") ||
      Object.prototype.hasOwnProperty.call(seamsOrOpts, "trafficEmitter") ||
      Object.prototype.hasOwnProperty.call(seamsOrOpts, "getRecent")
    );
  const opts = looksLikeOptsBag
    ? seamsOrOpts
    : { seams: seamsOrOpts };
  const uiRoot = opts.uiRoot || path.join(__dirname, "..", "scripts", "inspector-ui");
  const seams = opts.seams || {};

  let getRecent = opts.getRecent;
  if (!getRecent && opts.trafficEmitter && typeof opts.trafficEmitter.getRecent === "function") {
    getRecent = () => opts.trafficEmitter.getRecent();
  }

  const enrichedSeams = { ...seams };
  if (!enrichedSeams._trafficBuffer && getRecent) {
    Object.defineProperty(enrichedSeams, "_trafficBuffer", {
      get: getRecent,
      enumerable: true,
    });
  }

  const handler = makeHandler({ uiRoot, seams: enrichedSeams });
  const server = http.createServer(handler);
  const wss = attachWebsocket(server, {
    trafficEmitter: opts.trafficEmitter || null,
    getRecent,
  });
  // Stash the wss on the server so test teardown can close it cleanly.
  server.__wss = wss;
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

module.exports = {
  startInspector,
  createInspector,
  attachWebsocket,
  buildStatus,
  buildSettings,
  buildSpecialty,
  buildToolsCatalog,
  buildSlotDetail,
  makeHandler,
  defaultPort,
  defaultBind,
  redactPath,
  formatDuration,
  truncate,
  inputSchemaPreview,
  TRACKED_ENV_VARS,
  OWN_TOOL_META,
  STATIC_SPECIALTY,
  BDMCP2_META,
};
