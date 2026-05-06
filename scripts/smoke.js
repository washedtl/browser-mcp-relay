#!/usr/bin/env node
// scripts/smoke.js — non-interactive smoke test.
//
// Spawns `node src/index.js`, sends MCP handshake + tools/list over stdin,
// waits for the response, verifies ≥50 tools (41 forwarded + 16 own = 57),
// kills the relay, exits 0 on success / non-zero on failure.
//
// For CI / sanity checks. <60 seconds. No prompts. Reads local-config.json
// (via the relay itself) and falls through to env vars + auto-detect
// otherwise — same precedence as a real run.

const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_ENTRY = path.join(REPO_ROOT, "src", "index.js");
const MIN_TOOLS = 50; // expectation: 41 forwarded + 16 own = 57; threshold 50 allows minor upstream churn
const DEFAULT_TIMEOUT_MS = 60000;

function smokeTest({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RELAY_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let resolved = false;
    let stdoutBuf = "";
    let stderrBuf = "";

    function settle(result) {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch { /* ignore */ }
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

async function main() {
  process.stderr.write("[smoke] spawning relay, sending tools/list...\n");
  const t0 = Date.now();
  const result = await smokeTest();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  if (result.ok && result.count >= MIN_TOOLS) {
    process.stdout.write(`✓ Relay healthy. ${result.count} tools available (≥${MIN_TOOLS}). [${elapsed}s]\n`);
    process.exit(0);
  }
  if (result.ok) {
    process.stdout.write(`✗ Smoke test FAILED: only ${result.count} tools returned (expected ≥${MIN_TOOLS}). [${elapsed}s]\n`);
    process.exit(1);
  }
  process.stdout.write(`✗ Smoke test FAILED: ${result.reason} [${elapsed}s]\n`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[smoke] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { smokeTest };
