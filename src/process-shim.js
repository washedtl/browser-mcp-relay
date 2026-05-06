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
//     Win uses `tasklist /fi "PID eq N"`; Mac/Linux uses POSIX `process.kill(pid, 0)`
//     (kernel signal-zero — does no work, just returns ESRCH if dead).
//     EPERM (alive but not ours) is treated as alive.
//
// All public functions accept an optional `_spawnSync` test seam; tests pass
// a fake to avoid hitting the real OS. `_platform` similarly defaults to
// `process.platform` but can be overridden.

const { spawnSync } = require("node:child_process");

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
    { encoding: "utf8", windowsHide: true },
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
  const result = spawn("ps", ["-eo", "pid,command"], { encoding: "utf8" });
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
 * @param {NodeJS.Platform} [opts._platform=process.platform]
 * @param {typeof spawnSync} [opts._spawnSync=spawnSync] — test seam (Win only)
 * @param {(p: number, sig: number) => void} [opts._processKill] — test seam (POSIX)
 * @returns {boolean}
 */
function isPidAlive(pid, opts = {}) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  const platform = opts._platform || process.platform;

  if (platform === "win32") {
    const spawn = opts._spawnSync || spawnSync;
    const result = spawn(
      "tasklist",
      ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"],
      { encoding: "utf8", windowsHide: true },
    );
    if (!result || result.status !== 0) return false;
    const stdout = result.stdout || "";
    // tasklist prints `INFO: No tasks are running...` to stdout when nothing
    // matches; a real match has the pid quoted as a CSV cell.
    return stdout.includes(`,"${pid}",`);
  }

  // POSIX: signal 0 does no work. Throws ESRCH if dead, EPERM if alive but
  // owned by another user (still alive). Anything else (rare) → treat as dead.
  const kill = opts._processKill || ((p, s) => process.kill(p, s));
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    if (e && e.code === "EPERM") return true;
    return false;
  }
}

module.exports = {
  listProcessesByCommand,
  isPidAlive,
  // Exposed for unit tests of the parser.
  parsePidPipeOutput,
};
