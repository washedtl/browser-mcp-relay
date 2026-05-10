// pool-shared.js — slot/lock/cookie helpers for the relay.
//
// Two modes:
//
//   1. STANDALONE (default) — the relay manages a single user-data-dir.
//      Resolution: if the repo dir is writable, use `<repo>/.browser-data`
//      (gitignored, matches the legacy behavior most users expect). If the
//      repo lives somewhere read-only (e.g. system-wide install at
//      /opt/browser-mcp-relay or a read-only npm global) we fall back to a
//      per-user cache dir: $XDG_CACHE_HOME/browser-mcp-relay/browser-data
//      (Linux) / ~/Library/Caches/browser-mcp-relay/browser-data (macOS) /
//      %LOCALAPPDATA%\browser-mcp-relay\Cache\browser-data (Windows). Atomic
//      wrapper-lock on the chosen dir prevents two relay processes from
//      corrupting one Brave profile. Cookie snapshot is skipped (no source
//      profile to snapshot from).
//
//   2. POOL (opt-in) — set both BROWSER_RELAY_POOL_DIR and BROWSER_RELAY_POOL_SLOT.
//      The relay claims that one specific dir. If the host also has an
//      optional wrap-browser-devtools-mcp.js wrapper sitting next to this repo,
//      its richer config (slotRoles, cookieSourceProfile, multiple poolDirs)
//      is used. Otherwise pool mode degrades to "use this single dir as
//      if it were standalone".
//
// All helpers here are pure JS — no required dependencies on the parent
// wrapper file. The wrapper require is wrapped in try/catch so a clean
// clone of the relay repo works without it.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { detectBravePath, detectBraveProfileDir } = require("./detect-browser.js");
const processShim = require("./process-shim.js");
const { applyLocalConfigToEnv } = require("./local-config.js");

// ───────────────────────────── Constants ─────────────────────────────

const WRAPPER_LOCK = ".mcp-wrapper-lock";

// SNAPSHOT_FILES: profile files snapshotted from the cookie source into the
// claimed pool slot. Local State carries the DPAPI-wrapped os_crypt key
// (without it nothing else decrypts). Cookies live at Default/Network/ on
// Brave 92+ (Default/ is the legacy fallback). Login Data + Login Data For
// Account are SQLite password stores using the same os_crypt key. WAL/SHM
// files copy alongside main DBs because Brave 92+ runs SQLite in WAL mode,
// so recent writes in the source profile live in -wal until checkpoint;
// copying main DB without -wal can produce a stale snapshot. -journal is
// the legacy rollback path. copyOne silently skips missing entries.
const SNAPSHOT_FILES = [
  "Local State",
  "Default/Network/Cookies",
  "Default/Network/Cookies-wal",
  "Default/Network/Cookies-shm",
  "Default/Network/Cookies-journal",
  "Default/Cookies",
  "Default/Cookies-wal",
  "Default/Cookies-shm",
  "Default/Cookies-journal",
  "Default/Login Data",
  "Default/Login Data-wal",
  "Default/Login Data-shm",
  "Default/Login Data-journal",
  "Default/Login Data For Account",
  "Default/Login Data For Account-journal",
];

// SNAPSHOT_DIRS: localStorage / sessionStorage. Many SPAs (Discord, Slack,
// Linear, Notion, Mercury) store auth tokens in localStorage rather than
// cookies — without these you can have all the cookies in the world and
// still hit a login wall. fs.cpSync recursive copy handles LevelDB sub-files
// (CURRENT, MANIFEST-NNNNNN, NNNNNN.ldb, NNNNNN.log, LOCK). IndexedDB is
// opt-in only — typically 100+ MB across 1000+ files. Set
// BROWSER_RELAY_SNAPSHOT_INDEXEDDB=true to include it.
const SNAPSHOT_DIRS = [
  "Default/Local Storage/leveldb",
  "Default/Session Storage",
];

// Backwards-compat alias — older code referenced COOKIE_FILES.
const COOKIE_FILES = SNAPSHOT_FILES;

// ───────────────────────── Optional wrapper bridge ───────────────────
//
// If a sibling-of-sibling pool wrapper exists, we reuse its richer config.
// This is the maintainer's local-development layout
// (`<parent>/wrap-browser-devtools-mcp.js`); most public users won't have
// this file, which is fine — pool mode is opt-in via BROWSER_RELAY_POOL_DIR
// and standalone mode is the default.

let upstreamWrapper = null;
try {
  // The wrapper file is a sibling-of-sibling of this module
  // (`<parent>/wrap-browser-devtools-mcp.js`). Try to load it; if missing,
  // leave wrapper null and operate standalone.
  const wrapperPath = path.resolve(__dirname, "..", "..", "wrap-browser-devtools-mcp.js");
  if (fs.existsSync(wrapperPath)) {
    upstreamWrapper = require(wrapperPath);
  }
} catch (e) {
  // Defensive: any require failure (syntax, transitive) is silently treated
  // as "wrapper unavailable". Standalone mode keeps working.
  upstreamWrapper = null;
}

// ───────────────────────────── Config ────────────────────────────────

/**
 * Compute the standalone-mode default user-data-dir.
 *
 * Behavior (F1-9): legacy `<repo>/.browser-data` when the repo dir is
 * writable; per-user cache dir otherwise. Writability is probed via
 * fs.accessSync(repoRoot, W_OK) — synchronous, no probe file written.
 * Errors during fallback path resolution all degrade to the legacy
 * path so a misconfigured env never produces "no path at all".
 *
 * Pure (no side effects). Idempotent — safe to call repeatedly.
 *
 * Per-user cache dir resolution:
 *   - linux:   $XDG_CACHE_HOME/browser-mcp-relay/browser-data
 *              (falls back to ~/.cache when XDG_CACHE_HOME is unset/empty)
 *   - darwin:  ~/Library/Caches/browser-mcp-relay/browser-data
 *   - win32:   %LOCALAPPDATA%\browser-mcp-relay\Cache\browser-data
 *
 * @param {string} repoRoot
 * @param {NodeJS.ProcessEnv} env
 * @returns {string} absolute path to the standalone user-data-dir
 */
function defaultStandaloneDir(repoRoot, env) {
  const legacy = path.join(repoRoot, ".browser-data");
  // Writability check: prefer fs.accessSync (POSIX W_OK / Win cursory perm
  // bit) over a write-probe so we don't litter the repo with sentinel
  // files at module-load. fs.accessSync's win32 contract is loose
  // (effectively just "exists"), so the legacy path on Windows is taken
  // whenever repoRoot exists — that matches user expectation (npm install
  // into AppData puts repoRoot under user-writable LOCALAPPDATA anyway).
  let writable = false;
  try {
    fs.accessSync(repoRoot, fs.constants.W_OK);
    writable = true;
  } catch { /* not writable */ }
  if (writable) return legacy;

  try {
    const platform = process.platform;
    let cacheRoot;
    if (platform === "win32") {
      const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      cacheRoot = path.join(localAppData, "browser-mcp-relay", "Cache");
    } else if (platform === "darwin") {
      cacheRoot = path.join(os.homedir(), "Library", "Caches", "browser-mcp-relay");
    } else {
      const xdg = env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
        ? env.XDG_CACHE_HOME
        : path.join(os.homedir(), ".cache");
      cacheRoot = path.join(xdg, "browser-mcp-relay");
    }
    return path.join(cacheRoot, "browser-data");
  } catch {
    return legacy;
  }
}

/**
 * Build the relay's runtime config. Resolution order:
 *
 *   - bravePath: BROWSER_RELAY_BRAVE_PATH > wrapper.CONFIG.bravePath > detectBravePath()
 *     (V1-2: wrapper now wins over auto-detect when present, since auto-detect
 *     might find a stale Brave at the standard path even when the wrapper has
 *     an explicit override.)
 *   - proxyUrl:  BROWSER_RELAY_PROXY_URL > wrapper.CONFIG.proxyUrl > null
 *     (V1-1: wrapper.proxyUrl is now bridged so the relay's launched Brave
 *     inherits the same per-process proxy whitelist that wrapper-spawned
 *     BDMCP gets. Previously the field was wrapper-only.)
 *   - poolDirs:  BROWSER_RELAY_POOL_DIR (single-element array, opt-in)
 *                > wrapper.CONFIG.poolDirs (when the optional wrapper is present)
 *                > [<repo>/.browser-data] (standalone default)
 *   - cookieSourceProfile: wrapper.CONFIG.cookieSourceProfile if present, else null
 *   - cookieFreshnessWarnDays: wrapper.CONFIG or 7
 *   - slotRoles: wrapper.CONFIG or {}
 *
 * Mutating the returned object is safe — each call returns a fresh
 * object; nothing else in the module reads from it.
 */
function loadConfig({ env = process.env, repoRoot = path.resolve(__dirname, "..") } = {}) {
  const wrapperConfig = upstreamWrapper && upstreamWrapper.CONFIG ? upstreamWrapper.CONFIG : null;

  // Layer local-config.json under env vars. Real env values win; otherwise
  // the file's value (if any) is used. Auto-detection still runs underneath.
  env = applyLocalConfigToEnv(env);

  // Brave path resolution order (V1-2):
  //   1. BROWSER_RELAY_BRAVE_PATH (env override)  — explicit, always wins
  //   2. wrapper.CONFIG.bravePath                 — when the optional wrapper
  //                                                 declares one, trust it
  //                                                 over auto-detect because
  //                                                 the user explicitly set it
  //   3. detectBravePath() auto-detect            — standard install paths,
  //                                                 then registry/which probes
  //
  // braveDetectError captures any auto-detect failure so launch-time error
  // messages can include the original detection context.
  //
  // V1-2 follow-up: step 1 now validates the env path with fs.statSync
  // directly (not via detectBravePath, which would itself fall through to
  // auto-detect when the env path doesn't exist). That way a bad env path
  // truly falls through to step 2 (wrapper), not step 3 (auto-detect),
  // matching what the doc claims.
  let bravePath = null;
  let braveDetectError = null;
  // Step 1: explicit env override — only succeeds when file exists.
  if (env.BROWSER_RELAY_BRAVE_PATH && env.BROWSER_RELAY_BRAVE_PATH.length > 0) {
    const envPath = env.BROWSER_RELAY_BRAVE_PATH;
    try {
      if (fs.statSync(envPath).isFile()) {
        bravePath = envPath;
      } else {
        braveDetectError = new Error(
          `[browser-mcp-relay] BROWSER_RELAY_BRAVE_PATH="${envPath}" is not a file. Falling through to wrapper / auto-detect.`,
        );
      }
    } catch (statErr) {
      braveDetectError = new Error(
        `[browser-mcp-relay] BROWSER_RELAY_BRAVE_PATH="${envPath}" but stat failed: ${statErr.message}. Falling through to wrapper / auto-detect.`,
      );
    }
  }
  // Step 2: wrapper hint (only if step 1 didn't produce a value).
  if (!bravePath && wrapperConfig && typeof wrapperConfig.bravePath === "string" && wrapperConfig.bravePath.length > 0) {
    try {
      if (fs.statSync(wrapperConfig.bravePath).isFile()) {
        bravePath = wrapperConfig.bravePath;
      }
    } catch { /* file missing or stat failed — fall through to auto-detect */ }
  }
  // Step 3: auto-detect (only if neither step 1 nor step 2 produced a value).
  if (!bravePath) {
    try {
      bravePath = detectBravePath({ env });
    } catch (detectErr) {
      // Defer error: many tests just want CONFIG.poolDirs and shouldn't crash
      // because Brave isn't installed in CI. Store null + capture the error
      // so launch-path code can fold its message into a richer error.
      braveDetectError = braveDetectError || detectErr;
      bravePath = null;
    }
  }

  // Pool dirs: env > wrapper > standalone default
  let poolDirs;
  let slotRoles = {};
  let cookieSourceProfile = null;
  let cookieFreshnessWarnDays = 7;
  let staleAfterMs = 5 * 60 * 1000;

  if (env.BROWSER_RELAY_POOL_DIR) {
    poolDirs = [env.BROWSER_RELAY_POOL_DIR];
    if (wrapperConfig) {
      // Inherit cookie source + freshness if wrapper exists.
      cookieSourceProfile = wrapperConfig.cookieSourceProfile || null;
      cookieFreshnessWarnDays = wrapperConfig.cookieFreshnessWarnDays || 7;
      staleAfterMs = wrapperConfig.staleAfterMs || staleAfterMs;
    }
  } else if (wrapperConfig && Array.isArray(wrapperConfig.poolDirs) && wrapperConfig.poolDirs.length > 0) {
    poolDirs = wrapperConfig.poolDirs.slice();
    slotRoles = wrapperConfig.slotRoles || {};
    cookieSourceProfile = wrapperConfig.cookieSourceProfile || null;
    cookieFreshnessWarnDays = wrapperConfig.cookieFreshnessWarnDays || 7;
    staleAfterMs = wrapperConfig.staleAfterMs || staleAfterMs;
  } else {
    // Standalone default. F1-9 (2026-05-10): prefer `<repo>/.browser-data`
    // (legacy) when the repo is writable; fall back to a per-user cache
    // dir for system-wide / read-only install paths (npm -g into a root-
    // owned prefix, /opt/<dir>, etc.). The per-user cache path is XDG-ish
    // on Linux, ~/Library/Caches on macOS, %LOCALAPPDATA%\Cache on Win.
    poolDirs = [defaultStandaloneDir(repoRoot, env)];
  }

  // V1-1: proxyUrl resolution. The wrapper's browser-mcp-config.json may
  // declare a proxy that wrapper-spawned BDMCP routes through; bridge it
  // into the relay's CONFIG so index.js can pass it to launchBrave too.
  // Env override (BROWSER_RELAY_PROXY_URL) still wins.
  let proxyUrl = null;
  if (env.BROWSER_RELAY_PROXY_URL && env.BROWSER_RELAY_PROXY_URL.length > 0) {
    proxyUrl = env.BROWSER_RELAY_PROXY_URL;
  } else if (wrapperConfig && typeof wrapperConfig.proxyUrl === "string" && wrapperConfig.proxyUrl.length > 0) {
    proxyUrl = wrapperConfig.proxyUrl;
  }

  return {
    bravePath,
    braveDetectError,
    proxyUrl,
    poolDirs,
    slotRoles,
    cookieSourceProfile,
    cookieFreshnessWarnDays,
    staleAfterMs,
    standalone: !env.BROWSER_RELAY_POOL_DIR && !wrapperConfig,
  };
}

const CONFIG = loadConfig();

// ───────────────────────── Process introspection ─────────────────────
// Cross-platform via `./process-shim.js`. Win uses PowerShell; Mac/Linux use
// plain `ps`. The brave-process needle differs by platform: Windows command
// lines contain `brave.exe` literally, Mac/Linux contain `brave` (no .exe).

/** Pure parser. Given the stdout of the brave-process probe (one
 *  `<PID>|<command-line>` line per process) and a profile dir, return the
 *  PIDs of brave processes whose command line includes `--user-data-dir=<dir>`
 *  either unquoted or with `"..."` around dir.
 *
 *  Kept as the canonical Windows-shape parser for backwards compat with
 *  external callers and for unit tests. Internally we use the structured
 *  output of `processShim.listProcessesByCommand`. */
function findBraveProcessesForDir(stdoutText, dir) {
  const needleBare = `--user-data-dir=${dir}`;
  const needleQuoted = `--user-data-dir="${dir}"`;
  const pids = [];
  for (const line of (stdoutText || "").split(/\r?\n/)) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const cmd = line.slice(sep + 1);
    if (!cmd.includes(needleBare) && !cmd.includes(needleQuoted)) continue;
    const pid = parseInt(line.slice(0, sep), 10);
    if (Number.isFinite(pid)) pids.push(pid);
  }
  return pids;
}

/** Brave-needle for the current platform — needs to differ because Win
 *  command lines include `brave.exe` literally while Mac/Linux just say
 *  `brave`. Exposed for testing. */
function braveNeedle(platform) {
  return platform === "win32" ? "brave.exe" : "brave";
}

/** Snapshot all Brave processes. Returns one `PID|CommandLine` line per
 *  process, joined by `\r\n`. Empty string on failure or no matches.
 *
 *  Cross-platform via processShim. Backwards compat: still returns the
 *  pipe-formatted text shape so existing callers and tests work unchanged. */
function listBraveProcessesRaw(opts = {}) {
  const platform = opts._platform || process.platform;
  const procs = processShim.listProcessesByCommand(braveNeedle(platform), opts);
  return procs.map((p) => `${p.pid}|${p.command}`).join("\r\n");
}

/** Find orphan Brave PIDs holding `dir` as their user-data-dir (parent +
 *  any child helpers Brave spawned) and kill them. On Windows we use
 *  `taskkill /F /T` to take the whole tree; on POSIX we send SIGTERM, then
 *  SIGKILL after a brief grace period.
 *
 *  Best-effort; logs failures to stderr; returns the count of processes
 *  we successfully signaled. Caller must already hold the wrapper lock
 *  for `dir`. */
function reapOrphansFor(dir, opts = {}) {
  const platform = opts._platform || process.platform;
  const spawn = opts._spawnSync || spawnSync;
  const procs = processShim.listProcessesByCommand(braveNeedle(platform), opts);
  const needleBare = `--user-data-dir=${dir}`;
  const needleQuoted = `--user-data-dir="${dir}"`;
  const matched = procs.filter(
    (p) => p.command.includes(needleBare) || p.command.includes(needleQuoted),
  );

  let killed = 0;
  for (const { pid } of matched) {
    if (platform === "win32") {
      // G1-4 (2026-05-10): cap taskkill at 10s. Normally fast (<200ms) but
      // a wedged kernel handle (target stuck in uninterruptible kernel wait)
      // can make it block forever. Without this cap, claimSlot's pre-claim
      // reap could hang the entire relay startup.
      const result = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        timeout: 10000,
      });
      if (result && result.status === 0) {
        killed++;
        process.stderr.write(`[mcp-relay] reaped orphan brave.exe pid=${pid} holding ${dir}\n`);
      } else {
        const err = (result && (result.stderr || result.error)) || "non-zero exit";
        process.stderr.write(`[mcp-relay] taskkill pid=${pid} failed: ${err}\n`);
      }
    } else {
      // POSIX: SIGTERM, then immediate SIGKILL if still alive.
      const kill = opts._processKill || ((p, s) => process.kill(p, s));
      try {
        kill(pid, "SIGTERM");
        killed++;
        process.stderr.write(`[mcp-relay] reaped orphan brave pid=${pid} holding ${dir} (SIGTERM)\n`);
      } catch (e) {
        process.stderr.write(`[mcp-relay] kill SIGTERM pid=${pid} failed: ${e.message}\n`);
        continue;
      }
      // Synchronous SIGKILL escalation with no sleep — claimSlot is on the hot
      // path and we can't block. SIGTERM is async at the kernel level, so this
      // check usually still sees the process alive and double-signals. Fine for
      // orphan reaping (we want them dead either way); not a graceful shutdown.
      try {
        if (processShim.isPidAlive(pid, opts)) {
          kill(pid, "SIGKILL");
        }
      } catch {
        // Best-effort: if the process is already gone, that's fine.
      }
    }
  }
  return killed;
}

/** PID liveness check. Delegates to processShim for cross-platform handling
 *  (Win uses `tasklist`; Mac/Linux use POSIX `process.kill(pid, 0)`). */
function isPidAlive(pid, opts) {
  return processShim.isPidAlive(pid, opts);
}

// ───────────────────────── Cookie helpers ────────────────────────────

/** Return days since `absPath` was last modified (fractional). Returns
 *  null on any stat failure (missing file, permission denied, etc.).
 *  Caller treats null as "unknown" — NOT as "recent". */
function checkCookieAgeDays(absPath) {
  try {
    const stat = fs.statSync(absPath);
    return (Date.now() - stat.mtimeMs) / (24 * 60 * 60 * 1000);
  } catch {
    return null;
  }
}

/** Return the path to the canonical cookie SQLite store inside a
 *  Chromium profile dir, preferring the modern Brave/Chrome 92+
 *  path (Default/Network/Cookies) and falling back to the legacy
 *  path (Default/Cookies). Returns null if neither exists.
 *
 *  When called with no `profileDir`, falls back to {@link detectBraveProfileDir}
 *  for the host's default Brave install. This makes `findCookiesFile()` a
 *  one-call helper for cookie-export tools that just want "give me the user's
 *  Brave cookies on whatever OS they're on". */
function findCookiesFile(profileDir) {
  let dir = profileDir;
  if (!dir) {
    dir = detectBraveProfileDir();
  }
  if (!dir) return null;
  const modern = path.join(dir, "Default", "Network", "Cookies");
  if (fs.existsSync(modern)) return modern;
  const legacy = path.join(dir, "Default", "Cookies");
  if (fs.existsSync(legacy)) return legacy;
  return null;
}

/** Pure helper. When `requestedRole` is falsy returns a fresh copy of
 *  all pool dirs (role-less mode). Otherwise returns only dirs whose
 *  entry in `cfg.slotRoles` matches the requested role. Returns []
 *  when role is requested but no slot is configured for it. */
function pickDirCandidates(cfg, requestedRole) {
  if (!requestedRole) return cfg.poolDirs.slice();
  return cfg.poolDirs.filter((d) => (cfg.slotRoles || {})[d] === requestedRole);
}

// ───────────────────────── Slot claim ────────────────────────────────

/**
 * Claim a pool slot for the relay. Atomic O_CREAT|O_EXCL lock on
 * `<dir>/.mcp-wrapper-lock`; clears stale locks where the recorded PID is
 * dead. After the lock is acquired, reaps orphan brave processes still
 * holding that dir (Windows-only; non-Windows skips reap).
 *
 * @returns {{ dir: string, lock: { fd: number, path: string }, role: string, release: () => void }}
 */
function claimSlot() {
  const requestedRole = process.env.BROWSER_MCP_ROLE || undefined;
  const candidates = pickDirCandidates(CONFIG, requestedRole);
  if (candidates.length === 0) {
    throw new Error(
      `[mcp-relay] no pool dirs configured for role="${requestedRole}". ` +
      `In standalone mode, this should never happen — check pool-shared.js.`,
    );
  }

  for (const dir of candidates) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const lockPath = path.join(dir, WRAPPER_LOCK);

    // Stale-clean: dead-PID-only.
    try {
      if (fs.existsSync(lockPath)) {
        let pidAlive;
        try {
          const meta = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          pidAlive = isPidAlive(meta.pid);
        } catch {
          pidAlive = false;
        }
        if (!pidAlive) {
          fs.unlinkSync(lockPath);
          process.stderr.write(`[mcp-relay] cleared stale lock at ${lockPath} (pidAlive=false)\n`);
        }
      }
    } catch { /* race: file vanished */ }

    let fd;
    try {
      // F1-10 (2026-05-10): explicit 0o600 mode on POSIX so the lock file
      // (which contains pid + hostname + start-time) isn't world-readable
      // on multi-user systems. Windows ignores the mode arg.
      fd = fs.openSync(lockPath, "wx", 0o600);
    } catch (e) {
      if (e.code === "EEXIST") continue;
      throw e;
    }
    fs.writeSync(
      fd,
      JSON.stringify({
        pid: process.pid,
        startedAt: new Date().toISOString(),
        host: os.hostname(),
        relay: true,
      }),
    );
    // V1-4: fdatasync flushes the lock contents to disk so a crash between
    // write and the OS's lazy flush doesn't leave a zero-length / partial
    // lock file that other relays would see as "stale" (and unlink) — even
    // though this process is alive and holding fd. The stale-clean in this
    // function self-heals partial files via JSON.parse failure → pidAlive
    // false, but the data loss window during that gap could cause a brief
    // double-claim. fdatasync closes that window.
    try { fs.fdatasyncSync(fd); } catch { /* fdatasync unsupported on platform */ }

    // Reap orphan brave AFTER lock acquired.
    reapOrphansFor(dir);

    const role = (CONFIG.slotRoles || {})[dir] || "default";

    function release() {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }

    return { dir, lock: { fd, path: lockPath }, role, release };
  }

  throw new Error(
    `[mcp-relay] pool exhausted for role="${requestedRole || "any"}" — ` +
    `all of ${candidates.join(", ")} are in use.`,
  );
}

// ───────────────────────── Profile snapshot ──────────────────────────

/**
 * Snapshot profile files (cookies + Local State + password DBs) from
 * cookieSourceProfile (if configured & present) into the slot dir. No-op in
 * standalone mode (sourceProfile is null). Returns the count of files copied
 * — caller can log it.
 */
function snapshotCookiesFrom(srcProfile, dstProfile) {
  if (!srcProfile || !fs.existsSync(srcProfile)) return 0;
  let copied = 0;
  for (const rel of SNAPSHOT_FILES) {
    const s = path.join(srcProfile, rel);
    const d = path.join(dstProfile, rel);
    try {
      if (fs.existsSync(s)) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        // F1-4 (2026-05-10): tighten permissions on copied secrets. These
        // files contain DPAPI-wrapped cookie keys, encrypted password DBs,
        // and SQLite stores with auth tokens — should be 0o600 (owner-only)
        // on multi-user POSIX systems. Windows ignores chmod.
        if (process.platform !== "win32") {
          try { fs.chmodSync(d, 0o600); } catch { /* best-effort */ }
        }
        copied++;
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] snapshot copy ${rel} failed: ${e.code || e.message}\n`);
    }
  }
  return copied;
}

/**
 * Snapshot profile directories (localStorage / sessionStorage / optional
 * IndexedDB) from cookieSourceProfile into the slot dir. fs.cpSync handles
 * LevelDB sub-files including LOCK; force:true overwrites any prior snapshot.
 *
 * @param {string} srcProfile
 * @param {string} dstProfile
 * @param {object} [opts]
 * @param {boolean} [opts.includeIndexedDB] — when true, also snapshot
 *   Default/IndexedDB. Off by default (typically 100+ MB).
 * @returns {{ copied: number, total: number, bytes: number, elapsedMs: number }}
 */
function snapshotDirsFrom(srcProfile, dstProfile, { includeIndexedDB = false } = {}) {
  if (!srcProfile || !fs.existsSync(srcProfile)) {
    return { copied: 0, total: 0, bytes: 0, elapsedMs: 0 };
  }
  const dirs = SNAPSHOT_DIRS.slice();
  if (includeIndexedDB) dirs.push("Default/IndexedDB");
  let copied = 0;
  let bytes = 0;
  const t0 = Date.now();
  for (const rel of dirs) {
    const s = path.join(srcProfile, rel);
    const d = path.join(dstProfile, rel);
    try {
      if (fs.existsSync(s)) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.cpSync(s, d, { recursive: true, force: true });
        copied++;
        // Best-effort byte counter for the launch banner. Walks dest after copy.
        try {
          const stack = [d];
          while (stack.length) {
            const p = stack.pop();
            const stat = fs.statSync(p);
            if (stat.isDirectory()) {
              for (const e of fs.readdirSync(p)) stack.push(path.join(p, e));
            } else bytes += stat.size;
          }
        } catch {}
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] snapshot dir ${rel} failed: ${e.code || e.message}\n`);
    }
  }
  return { copied, total: dirs.length, bytes, elapsedMs: Date.now() - t0 };
}

module.exports = {
  CONFIG,
  COOKIE_FILES,
  SNAPSHOT_FILES,
  SNAPSHOT_DIRS,
  loadConfig,
  claimSlot,
  findBraveProcessesForDir,
  listBraveProcessesRaw,
  reapOrphansFor,
  isPidAlive,
  braveNeedle,
  checkCookieAgeDays,
  findCookiesFile,
  pickDirCandidates,
  snapshotCookiesFrom,
  snapshotDirsFrom,
  /** F1-9: exported for tests of the standalone-default fallback path. */
  defaultStandaloneDir,
  /** Test seam: whether the optional pool wrapper was found at require time. */
  hasPoolWrapper: upstreamWrapper !== null,
};
