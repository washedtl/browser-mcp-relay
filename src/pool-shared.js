// pool-shared.js — slot/lock/cookie helpers for the relay.
//
// Two modes:
//
//   1. STANDALONE (default) — the relay manages a single user-data-dir at
//      `<repo>/.browser-data` (gitignored). Atomic wrapper-lock on that dir
//      prevents two relay processes from corrupting one Brave profile.
//      Cookie snapshot is skipped (no source profile to snapshot from).
//
//   2. POOL (opt-in) — set both BROWSER_RELAY_POOL_DIR and BROWSER_RELAY_POOL_SLOT.
//      The relay claims that one specific dir. If the host also has the
//      private wrap-browser-devtools-mcp.js wrapper sitting next to this repo,
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

// ───────────────────────────── Constants ─────────────────────────────

const WRAPPER_LOCK = ".mcp-wrapper-lock";

const COOKIE_FILES = [
  "Local State",
  "Default/Network/Cookies",
  "Default/Network/Cookies-journal",
  "Default/Cookies",
  "Default/Cookies-journal",
];

// ───────────────────────── Optional wrapper bridge ───────────────────
//
// If the user has the private pool wrapper installed (Washed's setup), we
// reuse its richer config. Otherwise we operate standalone. The require is
// best-effort — failure here is the normal published-repo path.

let upstreamWrapper = null;
try {
  // Resolve from the user's ~/.claude/scripts/ if present. The wrapper file
  // is a sibling-of-sibling of this module ONLY in Washed's local layout
  // (.claude/scripts/browser-mcp-relay/src/pool-shared.js). Try that first;
  // if missing, leave wrapper null.
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
 * Build the relay's runtime config. Resolution order:
 *
 *   - bravePath: BROWSER_RELAY_BRAVE_PATH > detectBravePath() > wrapper config
 *   - poolDirs:  BROWSER_RELAY_POOL_DIR (single-element array, opt-in)
 *                > wrapper.CONFIG.poolDirs (Washed's pool)
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

  // Brave path: env override wins; otherwise auto-detect; otherwise wrapper hint.
  let bravePath = null;
  try {
    bravePath = detectBravePath({ env });
  } catch (detectErr) {
    if (wrapperConfig && wrapperConfig.bravePath) {
      bravePath = wrapperConfig.bravePath;
    } else {
      // Re-throw the detect error — we'll only need bravePath at launch time
      // anyway, but tests / CONFIG inspection should see the failure.
      // Actually: defer. Many tests just want CONFIG.poolDirs and shouldn't
      // crash because Brave isn't installed in CI. Store null and surface
      // the error via getBravePath() when the launch path actually needs it.
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
    // Standalone default: one dir under the repo, gitignored.
    poolDirs = [path.join(repoRoot, ".browser-data")];
  }

  return {
    bravePath,
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
      const result = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
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
      fd = fs.openSync(lockPath, "wx");
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

// ───────────────────────── Cookie snapshot ────────────────────────────

/**
 * Snapshot cookies from cookieSourceProfile (if configured & present) into
 * the slot dir. No-op in standalone mode (sourceProfile is null). Returns
 * the count of files copied — caller can log it.
 */
function snapshotCookiesFrom(srcProfile, dstProfile) {
  if (!srcProfile || !fs.existsSync(srcProfile)) return 0;
  let copied = 0;
  for (const rel of COOKIE_FILES) {
    const s = path.join(srcProfile, rel);
    const d = path.join(dstProfile, rel);
    try {
      if (fs.existsSync(s)) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        copied++;
      }
    } catch (e) {
      process.stderr.write(`[mcp-relay] cookie copy ${rel} failed: ${e.code || e.message}\n`);
    }
  }
  return copied;
}

module.exports = {
  CONFIG,
  COOKIE_FILES,
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
  /** Test seam: whether the optional pool wrapper was found at require time. */
  hasPoolWrapper: upstreamWrapper !== null,
};
