#!/usr/bin/env node
// scripts/smoke.js — non-interactive smoke test.
//
// Spawns `node src/index.js`, sends MCP handshake + tools/list over stdin,
// waits for the response, verifies ≥60 tools (51 forwarded + 21 own = 72),
// kills the relay, exits 0 on success / non-zero on failure. Checks broker
// mode (the Windows default) and legacy mode; see smokeModes.
//
// For CI / sanity checks. <60 seconds. No prompts. Reads local-config.json
// (via the relay itself) and falls through to env vars + auto-detect
// otherwise — same precedence as a real run.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execSync } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_ENTRY = path.join(REPO_ROOT, "src", "index.js");
// W0-9 (2026-05-09): bumped from 50 → 60. Expectation today is 51 forwarded
// + 20 own = 71 (smoke enables every toolset). The previous 50 threshold allowed ~34/51 forwarded missing
// (2/3 of the catalog) and still reported "healthy" — false positive. 60
// catches catastrophic upstream-tool registration failures while still
// tolerating minor upstream churn (one new tool added, one renamed).
const MIN_TOOLS = 60;
const DEFAULT_TIMEOUT_MS = 60000;

/**
 * V0-5: cross-platform process-tree kill.
 *
 * On Windows, `child.kill()` calls TerminateProcess on the relay node
 * process — which sends NO signal cascade. The relay's spawned upstream
 * BDMCP child + Brave subprocess + (transitively) any browser windows
 * are orphaned. Each `npm run smoke` adds a phantom Brave; eventually
 * "user-data-dir is locked" on the next launch.
 *
 * Fix: on win32, `taskkill /F /T /PID <pid>` takes the whole process
 * tree at once. Fall back to child.kill() if taskkill fails (e.g. PID
 * already exited). On POSIX, SIGTERM gives a chance to clean up, then
 * SIGKILL after 2s.
 */
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore" });
    } catch {
      try { child.kill(); } catch { /* already gone */ }
    }
  } else {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref?.();
  }
}

/**
 * The relay's env for one check. Every check counts the whole catalog (all
 * toolsets) from a refreshed catalog cache, so the upstream really starts.
 * Broker mode runs on a private pipe, an empty temp profile and a temp
 * broker home, and that broker exits 2 s after the check: nothing is left
 * running, and the real broker (its pipe, profile, key) is never touched.
 */
function modeEnv(mode, scratchDir) {
  const env = { BROWSER_RELAY_MODE: mode, BROWSER_RELAY_TOOLSETS: "all", BROWSER_RELAY_CATALOG_REFRESH: "true" };
  if (mode === "broker") {
    Object.assign(env, {
      BROWSER_RELAY_BROKER_PIPE: process.platform === "win32"
        ? `\\\\.\\pipe\\browser-mcp-relay-smoke-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
        : path.join(scratchDir, "smoke.sock"),
      BROWSER_RELAY_BROKER_PROFILE_DIR: path.join(scratchDir, "profile"),
      BROWSER_RELAY_BROKER_LOG: path.join(scratchDir, "broker.log"),
      BROWSER_RELAY_BROKER_IDLE_EXIT_MS: "2000",
      // the broker home (its key, work dir) too: never the real one under LOCALAPPDATA
      LOCALAPPDATA: scratchDir,
      XDG_STATE_HOME: scratchDir,
    });
  }
  return env;
}

// Broker mode is only the default (and only checked) on Windows.
const SMOKE_MODES = process.platform === "win32" ? ["broker", "legacy"] : ["legacy"];

/** smokeTest for each mode, in order. Resolves [{ mode, ok, count, reason, seconds }]. */
async function smokeModes({ modes = SMOKE_MODES, log = () => {} } = {}) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-smoke-"));
  fs.mkdirSync(path.join(scratch, "profile")); // exists, so the smoke broker seeds nothing into it
  const results = [];
  try {
    for (const mode of modes) {
      log(`[smoke] ${mode} mode: spawning the relay, sending tools/list...\n`);
      const t0 = Date.now();
      const r = await smokeTest({ env: modeEnv(mode, scratch) });
      results.push({ mode, ...r, seconds: (Date.now() - t0) / 1000 });
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return results;
}

/** One check: legacy mode unless `env` says otherwise (see modeEnv). */
function smokeTest({ timeoutMs = DEFAULT_TIMEOUT_MS, env = { BROWSER_RELAY_MODE: "legacy", BROWSER_RELAY_TOOLSETS: "all", BROWSER_RELAY_CATALOG_REFRESH: "true" } } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });

    let resolved = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    function settle(result) {
      if (resolved) return;
      resolved = true;
      killTree(child);
      resolve(result);
    }

    const timer = setTimeout(() => {
      settle({
        ok: false,
        count: 0,
        reason: `timeout after ${timeoutMs}ms (stderr tail: ${stderrBuf.slice(-500) || "<empty>"})`,
      });
    }, timeoutMs);

    child.on("error", (e) => {
      clearTimeout(timer);
      settle({ ok: false, count: 0, reason: `spawn error: ${e.message}` });
    });

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (!resolved) {
        settle({
          ok: false,
          count: 0,
          reason: `relay exited prematurely (code=${code} signal=${signal}, stderr tail: ${stderrBuf.slice(-500) || "<empty>"})`,
        });
      }
    });

    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });

    // Swallow async stdin errors. With killTree (V0-5), the child can die
    // synchronously before deferred stdin.write fires; the resulting EPIPE
    // surfaces async on the stream's `error` event and would otherwise
    // bubble as an uncaughtException. We've already settled the test
    // outcome — the write was just trying to drive the handshake.
    child.stdin.on("error", () => { /* settled or pre-settle race */ });

    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg && msg.id === 1 && msg.result && Array.isArray(msg.result.tools)) {
            clearTimeout(timer);
            settle({ ok: true, count: msg.result.tools.length, reason: "" });
            return;
          }
        } catch { /* not JSON yet */ }
      }
    });

    // MCP handshake (initialize, then tools/list).
    const initialize = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "browser-mcp-relay-smoke", version: "0.0.0" },
      },
    };
    const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    try {
      child.stdin.write(JSON.stringify(initialize) + "\n");
      setTimeout(() => {
        try { child.stdin.write(JSON.stringify(toolsList) + "\n"); }
        catch (e) { settle({ ok: false, count: 0, reason: `stdin write failed: ${e.message}` }); }
      }, 100);
    } catch (e) {
      settle({ ok: false, count: 0, reason: `stdin write failed: ${e.message}` });
    }
  });
}

/** One line per checked mode; true when every mode is healthy. */
function report(results, write = (s) => process.stdout.write(s)) {
  for (const r of results) {
    const t = `[${r.mode}, ${r.seconds.toFixed(1)}s]`;
    if (r.ok && r.count >= MIN_TOOLS) write(`✓ Relay healthy. ${r.count} tools available (≥${MIN_TOOLS}). ${t}\n`);
    else if (r.ok) write(`✗ Smoke test FAILED: only ${r.count} tools returned (expected ≥${MIN_TOOLS}). ${t}\n`);
    else write(`✗ Smoke test FAILED: ${r.reason} ${t}\n`);
  }
  return results.every((r) => r.ok && r.count >= MIN_TOOLS);
}

async function main() {
  const results = await smokeModes({ log: (m) => process.stderr.write(m) });
  process.exit(report(results) ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[smoke] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { smokeTest, smokeModes, modeEnv, report, killTree, MIN_TOOLS };
