// pool-shared.js — bridge to the existing v2 wrapper's pool/lock/cookie/role
// layer. Initial implementation: re-export from the wrapper module. Future:
// lift those helpers into this module for full ownership.

const path = require("node:path");
const upstreamWrapper = require(path.join(
  __dirname, "..", "..", "wrap-browser-devtools-mcp.js"
));

// Re-export the pure helpers we already trust (Tasks 1-7 of the v2 plan
// shipped these with full test coverage).
module.exports.loadConfig = upstreamWrapper.loadConfig;
module.exports.CONFIG = upstreamWrapper.CONFIG;
module.exports.findBraveProcessesForDir = upstreamWrapper.findBraveProcessesForDir;
module.exports.listBraveProcessesRaw = upstreamWrapper.listBraveProcessesRaw;
module.exports.reapOrphansFor = upstreamWrapper.reapOrphansFor;
module.exports.isPidAlive = upstreamWrapper.isPidAlive;
module.exports.checkCookieAgeDays = upstreamWrapper.checkCookieAgeDays;
module.exports.findCookiesFile = upstreamWrapper.findCookiesFile;
module.exports.pickDirCandidates = upstreamWrapper.pickDirCandidates;

/**
 * Claim a pool slot for the relay. Mirrors the v2 wrapper's main() flow:
 * pickDir → return { dir, lock, role, release }. The v2 wrapper's takeWrapperLock
 * isn't exported, so we replicate the minimal claim sequence here using the
 * exported atomics. Long-term, the v2 wrapper should export takeWrapperLock
 * and we replace this with a single call.
 *
 * @returns {{ dir: string, lock: { fd: number, path: string }, role: string, release: () => void }}
 */
function claimSlot() {
  const fs = require("node:fs");
  const os = require("node:os");
  const cfg = upstreamWrapper.CONFIG;
  const requestedRole = process.env.BROWSER_MCP_ROLE || undefined;
  const candidates = upstreamWrapper.pickDirCandidates(cfg, requestedRole);
  if (candidates.length === 0) {
    throw new Error(
      `[mcp-relay] no pool dirs configured for role="${requestedRole}". Check slotRoles in browser-mcp-config.json.`,
    );
  }

  const WRAPPER_LOCK = ".mcp-wrapper-lock";

  for (const dir of candidates) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const lockPath = path.join(dir, WRAPPER_LOCK);

    // Stale-clean: dead-PID-only (matching v2 post-fix semantics).
    try {
      if (fs.existsSync(lockPath)) {
        let pidAlive;
        try {
          const meta = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          pidAlive = upstreamWrapper.isPidAlive(meta.pid);
        } catch {
          pidAlive = false;
        }
        if (!pidAlive) {
          fs.unlinkSync(lockPath);
          process.stderr.write(
            `[mcp-relay] cleared stale lock at ${lockPath} (pidAlive=false)\n`,
          );
        }
      }
    } catch { /* race: file vanished */ }

    let fd;
    try {
      fd = fs.openSync(lockPath, "wx");
    } catch (e) {
      if (e.code === "EEXIST") continue; // someone else owns it
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

    // Reap orphan brave AFTER lock acquired — same ordering as v2's pickDir.
    upstreamWrapper.reapOrphansFor(dir);

    const role = (cfg.slotRoles || {})[dir] || "default";

    function release() {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lockPath); } catch { /* already gone */ }
    }

    return { dir, lock: { fd, path: lockPath }, role, release };
  }

  throw new Error(
    `[mcp-relay] pool exhausted for role="${requestedRole || "any"}" — all of ${candidates.join(", ")} are in use.`,
  );
}

module.exports.claimSlot = claimSlot;
