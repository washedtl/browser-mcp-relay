// process-shim.js — cross-platform process inspection.
//
// Two operations, three platforms:
//
//   listProcessesByCommand(needle)
//     Returns [{pid, command}] for every running process whose command line
//     contains `needle`. On Win this shells out to PowerShell's
//     Get-CimInstance Win32_Process (which gives us the full command line);
//     on Mac/Linux we use plain `ps -eo pid,command`.
//
//   isPidAlive(pid)
//     Returns true iff a process with that pid is currently running.
//     Every platform uses `process.kill(pid, 0)` (signal-zero — does no
//     work, throws ESRCH if dead). EPERM (alive but not ours) is alive.
//
//   getProcessStartTimes(pids)
//     Returns Map<pid, epochMs> of start times for the pids it could
//     resolve. Used to tell a lock's real owner from a recycled PID.
//
// All public functions accept an optional `_spawnSync` test seam; tests pass
// a fake to avoid hitting the real OS. `_platform` similarly defaults to
// `process.platform` but can be overridden.

const { spawnSync, execFile } = require("node:child_process");

/**
 * List running processes whose command line contains `needle`.
 *
 * @param {string} needle — substring to match against the command line.
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts._platform=process.platform]
 * @param {typeof spawnSync} [opts._spawnSync=spawnSync] — test seam
 * @returns {Array<{pid: number, command: string}>}
 */
function listProcessesByCommand(needle, opts = {}) {
  if (!needle || typeof needle !== "string") return [];
  const platform = opts._platform || process.platform;
  const spawn = opts._spawnSync || spawnSync;

  if (platform === "win32") {
    return listProcessesWin(needle, spawn);
  }
  // Mac/Linux/everything-POSIX-ish.
  return listProcessesPosix(needle, spawn);
}

/** Windows: PowerShell Get-CimInstance Win32_Process for the full command line.
 *
 *  We inject the needle into the script string after escaping any single
 *  quotes (PowerShell single-quoted literal — no expansion, no special chars
 *  except `'`). PowerShell's `-Command` parser does NOT pass extra args after
 *  the script string as named parameters to a `param()` block, so the
 *  inject-and-escape approach is the reliable cross-version path. */
function listProcessesWin(needle, spawn) {
  const escaped = String(needle).replace(/'/g, "''");
  const psScript =
    `Get-CimInstance Win32_Process | ` +
    `Where-Object { $_.CommandLine -and ($_.CommandLine -like '*${escaped}*') } | ` +
    `ForEach-Object { ''+$_.ProcessId+'|'+$_.CommandLine }`;
  const result = spawn(
    "powershell",
    ["-NoProfile", "-Command", psScript],
    {
      encoding: "utf8",
      windowsHide: true,
      // G1-3 (2026-05-10): cap stdout buffer at 16MB. Default Node 1MB
      // can truncate on systems with 100+ Brave helper processes (each
      // command line ~500-2000 chars), making findBraveProcessesForDir
      // miss entries → reaper no-ops → ghost Brave persists.
      maxBuffer: 16 * 1024 * 1024,
      // G1-3: cap PowerShell at 15s. spawnSync without timeout could hang
      // on a wedged kernel handle; without this, claimSlot's pre-claim
      // probe and the inspector's status poll would both hang the entire
      // relay.
      timeout: 15000,
    },
  );
  if (!result || result.status !== 0) {
    const stderr = result && result.stderr ? String(result.stderr).trim() : "";
    if (stderr) {
      process.stderr.write(`[mcp-relay] PowerShell process probe failed: ${stderr}\n`);
    }
    return [];
  }
  return parsePidPipeOutput(result.stdout || "");
}

/** Mac/Linux: `ps -eo pid,command` and filter rows containing needle.
 *  Filter is case-insensitive to match PowerShell's `-like` semantics on
 *  Windows (and to handle macOS where the binary is "Brave Browser" with
 *  capital B but callers may pass lowercase "brave"). */
function listProcessesPosix(needle, spawn) {
  // F0-7 (2026-05-10): pass `-ww` to disable command-column truncation on
  // BSD/macOS ps. Default truncates to ~80 chars per line — Brave on macOS
  // launches helpers with command lines well over 80 chars (paths inside
  // `Brave Browser.app` bundle are long), so the `--user-data-dir=` token
  // gets cut off → findBraveProcessesForDir misses helpers → reapOrphansFor
  // only kills the parent → helpers respawn → ghost processes.
  // Linux GNU ps also accepts -ww as a no-op (it doesn't truncate by default).
  //
  // F0-7: also force LC_ALL=C so the header line is "PID COMMAND" in ASCII
  // regardless of locale — line.startsWith("PID ") then works reliably on
  // non-English systems (where French/German/Russian/etc. would otherwise
  // produce a translated header that the skip would miss; harmless because
  // the line wouldn't match the digit regex anyway, but cleaner).
  const result = spawn("ps", ["-eo", "pid,command", "-ww"], {
    encoding: "utf8",
    // G1-3: same caps as Windows path — see listProcessesWin.
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000,
    env: { ...process.env, LC_ALL: "C" },
  });
  if (!result || result.status !== 0) {
    const stderr = result && result.stderr ? String(result.stderr).trim() : "";
    if (stderr) {
      process.stderr.write(`[mcp-relay] ps process probe failed: ${stderr}\n`);
    }
    return [];
  }
  const out = [];
  const needleLower = needle.toLowerCase();
  // ps output:  "  PID COMMAND" header, then "  1234 /path/to/cmd args..."
  for (const rawLine of (result.stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("PID ")) continue;
    if (!line.toLowerCase().includes(needleLower)) continue;
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const command = m[2];
    if (!Number.isFinite(pid)) continue;
    // Skip the parent ps invocation itself (defensive — ps shouldn't include
    // itself in -e listings on most platforms, but the listing for the spawn
    // shell can be present).
    if (command.startsWith("ps ") || command === "ps") continue;
    out.push({ pid, command });
  }
  return out;
}

/** Parse PowerShell `<pid>|<cmd>` lines into {pid, command} objects. */
function parsePidPipeOutput(stdoutText) {
  const out = [];
  for (const line of (stdoutText || "").split(/\r?\n/)) {
    const sep = line.indexOf("|");
    if (sep < 0) continue;
    const pid = parseInt(line.slice(0, sep), 10);
    if (!Number.isFinite(pid)) continue;
    const command = line.slice(sep + 1);
    out.push({ pid, command });
  }
  return out;
}

/**
 * Is `pid` currently a live process?
 *
 * @param {number} pid
 * @param {object} [opts]
 * @param {(p: number, sig: number) => void} [opts._processKill] — test seam
 * @returns {boolean}
 */
function isPidAlive(pid, opts = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return false;

  // Signal 0 does no work. Throws ESRCH if dead, EPERM if alive but owned
  // by another user (still alive).
  //
  // W0-2 (2026-11-03): Windows uses signal-zero too. libuv's uv_kill(pid, 0)
  // is OpenProcess + GetExitCodeProcess — no child process. The previous
  // `tasklist` probe cost ~350-900ms per call and ran once per locked slot
  // on every relay startup (measured: 13 locked slots ≈ 5-10s before the
  // MCP handshake). Measured signal-zero on Win11: ~0.02ms; dead → ESRCH,
  // protected live process (PID 4) → EPERM.
  //
  // F1-11 (2026-05-10): treat unknown errno (ENOSYS, EINVAL, EFAULT, EBUSY,
  // any future addition) as ALIVE rather than dead. Rationale: the
  // consequence of a false-dead is "we steal the slot from an actually-
  // running Brave + crash it"; the consequence of a false-alive is "we
  // wait an extra 5 minutes for the stale-lock TTL". The asymmetric blast
  // radius makes "fail safe = assume alive" the correct default for any
  // errno we haven't explicitly classified. Only ESRCH (definitively
  // "no such process") returns false. Errors with no `code` field also
  // get the safe-side treatment.
  const kill = opts._processKill || ((p, s) => process.kill(p, s));
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (!e) return true; // unparseable — fail safe
    if (e.code === "ESRCH") return false; // canonical "dead"
    return true; // EPERM, ENOSYS, EINVAL, anything else — treat as alive
  }
}

/**
 * Start times of the given pids, for telling a lock's real owner apart from
 * an unrelated process that was handed the same (recycled) PID.
 *
 * One child process for the whole batch: PowerShell Get-Process on Windows
 * (~1.1s measured), `ps -o pid=,lstart=` elsewhere. Best-effort: pids it
 * can't resolve (gone, access denied, probe failed) are simply absent from
 * the map, and callers treat absent as "unknown", never as "dead".
 *
 * @param {number[]} pids
 * @param {object} [opts]
 * @param {NodeJS.Platform} [opts._platform=process.platform]
 * @param {typeof spawnSync} [opts._spawnSync=spawnSync] — test seam
 * @param {number} [opts.timeoutMs=10000] — probe timeout
 * @returns {Map<number, number>} pid → start time (epoch ms)
 */
function getProcessStartTimes(pids, opts = {}) {
  const out = new Map();
  const ids = [...new Set((pids || []).filter((p) => Number.isInteger(p) && p > 0))];
  if (ids.length === 0) return out;
  const platform = opts._platform || process.platform;
  const spawn = opts._spawnSync || spawnSync;
  const timeout = opts.timeoutMs || 10000;

  let result;
  if (platform === "win32") {
    // ids are validated integers, so interpolating them is injection-safe.
    const psScript =
      `$ErrorActionPreference='SilentlyContinue'; ` +
      `foreach ($id in @(${ids.join(",")})) { $p = Get-Process -Id $id; ` +
      `if ($p -and $p.StartTime) { ''+$id+'|'+$p.StartTime.ToUniversalTime().ToString('o') } }`;
    result = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], {
      encoding: "utf8", windowsHide: true, timeout, maxBuffer: 1024 * 1024,
    });
  } else {
    // LC_ALL=C pins lstart to the parseable "Tue Nov  3 08:07:46 2026" form.
    result = spawn("ps", ["-o", "pid=,lstart=", "-p", ids.join(",")], {
      encoding: "utf8", timeout, maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    });
  }
  // ps exits 1 when some pids are gone; still parse whatever it printed.
  if (!result || result.error || !result.stdout) return out;

  for (const line of String(result.stdout).split(/\r?\n/)) {
    const m = platform === "win32"
      ? /^(\d+)\|(.+)$/.exec(line.trim())
      : /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const t = Date.parse(m[2].trim());
    if (ids.includes(pid) && Number.isFinite(t)) out.set(pid, t);
  }
  return out;
}

/** spawnSync's result shape from an async execFile, so a probe written
 *  against spawnSync can be fed a non-blocking run's output. */
function spawnAsync(cmd, args, options = {}) {
  const opts = { encoding: options.encoding || "utf8" };
  for (const k of ["windowsHide", "timeout", "maxBuffer", "env"]) {
    if (options[k] !== undefined) opts[k] = options[k];
  }
  return new Promise((resolve) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (!err) return resolve({ status: 0, stdout, stderr });
      // Non-zero exit: err.code is the exit status (spawnSync: status=N,
      // no error). Anything else (spawn failure, timeout, maxBuffer) is
      // spawnSync's status=null + error.
      if (typeof err.code === "number") return resolve({ status: err.code, stdout, stderr });
      resolve({ status: null, stdout, stderr, error: err });
    });
  });
}

/**
 * W1E-2 (2026-11-03): run a spawnSync-based probe (one of the above) without blocking the
 * event loop. The pool/process-shim probes (PowerShell on Windows, ~1s
 * each) are synchronous and take a `_spawnSync` seam: a dry run captures
 * the exact command the probe would spawn, that command runs async, and the
 * probe runs again on the real output — so command construction and
 * parsing stay in one place (process-shim) with no duplicate.
 *
 * @param {(spawn?: Function) => T} probe — calls its probe with `{ _spawnSync: spawn }`
 * @returns {Promise<T>}
 */
async function runProbeAsync(probe) {
  const calls = [];
  probe((cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0, stdout: "", stderr: "" };
  });
  // No spawn needed (e.g. empty pid list), or a shape we can't replay
  // faithfully: run it as-is.
  if (calls.length !== 1) return probe();
  const { cmd, args, options } = calls[0];
  const result = await spawnAsync(cmd, args, options);
  return probe(() => result);
}

module.exports = {
  listProcessesByCommand,
  isPidAlive,
  getProcessStartTimes,
  runProbeAsync,
  // Exposed for unit tests of the parser.
  parsePidPipeOutput,
};
