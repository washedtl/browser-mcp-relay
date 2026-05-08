#!/usr/bin/env node
// scripts/setup.js — interactive wizard.
//
// Goal: a friend who clones the repo can run `npm run setup`, get a working
// `local-config.json`, and copy a paste-ready MCP registration snippet into
// their Claude Code / Cursor config — all in <2 minutes.
//
// What this script DOES:
//   - Reads from disk (auto-detect Brave / profile dir / upstream)
//   - Writes ONE file: <repo-root>/local-config.json (gitignored)
//   - Spawns `node src/index.js` once for a smoke test
//   - Prints output to stdout/stderr
//
// What this script INTENTIONALLY DOES NOT do:
//   - Modify ~/.claude.json, the user's Cursor config, or any other file
//     outside this repo. The MCP registration snippet is PRINTED — the user
//     pastes it. (Safer than a botched write to a file holding their other
//     MCP entries.)
//   - Make network calls.
//   - Install npm packages.
//
// Pure stdlib. CommonJS.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, execSync } = require("node:child_process");

/**
 * V0-5: cross-platform process-tree kill (mirrors smoke.js's killTree).
 * On Windows, `child.kill()` orphans the relay's spawned upstream BDMCP
 * + Brave subprocess. `taskkill /F /T /PID <pid>` takes the whole tree.
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

const REPO_ROOT = path.resolve(__dirname, "..");
const LOCAL_CONFIG_PATH = path.join(REPO_ROOT, "local-config.json");
const RELAY_ENTRY = path.join(REPO_ROOT, "src", "index.js");

// Internal modules. Required dynamically so `node scripts/setup.js` from a
// fresh clone with `npm install` not yet run still gives a clear error
// rather than a stack trace from missing deps.
let detectBrowser;
try {
  detectBrowser = require("../src/detect-browser.js");
} catch (e) {
  process.stderr.write(
    "[setup] Couldn't load src/detect-browser.js. Did you run `npm install` first?\n" +
      `Underlying error: ${e.message}\n`,
  );
  process.exit(1);
}

// ─────────────────────────── readline helpers ───────────────────────────
//
// We use readline for line-event parsing but DRIVE prompts with a single
// queue of pending resolvers, instead of `rl.question`. Reason: Node's
// `rl.question` has a documented issue with non-TTY stdin (e.g. piped
// stdin from a file), where after the first answer EOF closes the
// interface and subsequent question callbacks never fire. Using the
// 'line' event with our own queue is reliable on both TTYs and pipes —
// important for automated integration tests + CI smoke runs.

function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const pendingResolvers = [];
  let stdinClosed = false;

  rl.on("line", (line) => {
    const resolver = pendingResolvers.shift();
    if (resolver) resolver(line);
  });
  rl.on("close", () => {
    stdinClosed = true;
    // Drain any waiting questions with empty string so callers see EOF
    // as "default" (matches what users get by hitting enter on a TTY).
    while (pendingResolvers.length > 0) {
      const r = pendingResolvers.shift();
      r("");
    }
  });

  function question(q) {
    process.stdout.write(q);
    if (stdinClosed) return Promise.resolve("");
    return new Promise((resolve) => {
      pendingResolvers.push((line) => resolve((line || "").trim()));
    });
  }
  function close() { rl.close(); }
  return { question, close };
}

async function ask(prompter, q, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const ans = await prompter.question(`${q}${suffix} `);
  return ans.length > 0 ? ans : (defaultValue || "");
}

async function askYesNo(prompter, q, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]";
  const raw = (await prompter.question(`${q}${suffix} `)).toLowerCase();
  if (raw === "") return defaultYes;
  return raw === "y" || raw === "yes";
}

// ─────────────────────────── steps ──────────────────────────────────────

function step1_welcome() {
  process.stdout.write([
    "",
    "browser-mcp-relay setup wizard",
    "──────────────────────────────",
    "This script writes one file: local-config.json (gitignored) and prints an",
    "MCP registration snippet for you to paste into your Claude Code config.",
    "It does NOT modify any of your existing config files.",
    "",
  ].join("\n") + "\n");
}

function step2_detectOs() {
  process.stdout.write(`Detected platform: ${process.platform}\n`);
  return process.platform;
}

async function step3_detectBrave(prompter) {
  let detected = null;
  let detectError = null;
  try {
    detected = detectBrowser.detectBravePath();
  } catch (e) {
    detectError = e;
  }

  if (detected) {
    // Re-validate: detection caches its result, but a path that resolved at
    // module-load time may have been uninstalled / moved since. If the file
    // is gone, fall through to the manual-entry prompt below rather than
    // silently writing a dead path into local-config.json.
    if (!fs.existsSync(detected)) {
      process.stdout.write(`Detected Brave path no longer exists on disk: ${detected}\n`);
      detected = null;
    } else {
      process.stdout.write(`Detected Brave: ${detected}\n`);
      const useIt = await askYesNo(prompter, "Use this Brave install?", true);
      if (useIt) return detected;
    }
  }
  if (!detected) {
    const checked = detectBrowser.standardLocations(process.platform, process.env);
    process.stdout.write("Brave was not found at any standard location:\n");
    for (const loc of checked) process.stdout.write(`  - ${loc}\n`);
    if (detectError && detectError.message) {
      // Only print the headline of the error, not the whole multi-line block
      // (we already listed the candidates above).
      process.stdout.write("\n");
    }
  }

  for (;;) {
    const entered = await ask(
      prompter,
      "Enter absolute path to your Brave executable (or leave empty to abort):",
      "",
    );
    if (!entered) {
      process.stderr.write("[setup] Aborting — Brave path is required.\n");
      process.exit(1);
    }
    if (fs.existsSync(entered)) return entered;
    process.stdout.write(`No file at "${entered}". Try again.\n`);
  }
}

async function step4_detectProfileDir(prompter) {
  const detected = detectBrowser.detectBraveProfileDir();
  if (detected && fs.existsSync(detected)) {
    process.stdout.write(`Detected Brave profile dir: ${detected}\n`);
    const useIt = await askYesNo(prompter, "Use this profile dir?", true);
    if (useIt) return detected;
  } else if (detected) {
    process.stdout.write(`Default Brave profile dir would be: ${detected}\n`);
    process.stdout.write("(directory doesn't exist yet — Brave will create it on first run)\n");
    const useIt = await askYesNo(prompter, "Use this default?", true);
    if (useIt) return detected;
  } else {
    process.stdout.write("Could not determine a default Brave profile dir for this platform.\n");
  }

  const entered = await ask(
    prompter,
    "Enter absolute path to your Brave User Data directory (or leave empty to skip):",
    "",
  );
  return entered || "";
}

function step5_detectUpstream() {
  try {
    const resolved = require.resolve("browser-devtools-mcp/dist/index.js", { paths: [REPO_ROOT] });
    process.stdout.write(`Detected upstream browser-devtools-mcp at: ${resolved}\n`);
    return resolved;
  } catch {
    process.stderr.write([
      "",
      "[setup] Could not resolve `browser-devtools-mcp` via require.resolve.",
      "        This usually means `npm install` hasn't been run, or the package",
      "        was removed from node_modules.",
      "",
      "        Either run `npm install` and re-run setup, OR set",
      "        BROWSER_RELAY_UPSTREAM_PATH in local-config.json to point at a",
      "        custom build of browser-devtools-mcp/dist/index.js.",
      "",
    ].join("\n") + "\n");
    process.exit(1);
  }
}

async function step6_chooseMode(prompter) {
  process.stdout.write([
    "",
    "Mode:",
    "  standalone — relay manages a single Brave profile at <repo>/.browser-data (default)",
    "  pool       — relay claims a profile dir you specify (advanced)",
    "",
  ].join("\n"));
  const ans = (await ask(prompter, "Choose mode (standalone/pool):", "standalone")).toLowerCase();
  if (ans === "pool") {
    const dir = await ask(prompter, "Pool mode — absolute path to Brave user-data-dir:", "");
    if (!dir) {
      process.stderr.write("[setup] Pool mode requires BROWSER_RELAY_POOL_DIR. Aborting.\n");
      process.exit(1);
    }
    return { mode: "pool", poolDir: dir };
  }
  return { mode: "standalone", poolDir: "" };
}

async function step7_writeLocalConfig(prompter, values) {
  if (fs.existsSync(LOCAL_CONFIG_PATH)) {
    const overwrite = await askYesNo(prompter, "local-config.json already exists. Overwrite?", false);
    if (!overwrite) {
      process.stdout.write("[setup] Keeping existing local-config.json. Skipping write.\n");
      return false;
    }
  }
  const obj = {
    _comment_1: "Generated by `npm run setup` on " + new Date().toISOString() + ". This file is gitignored. Edit freely; env vars override these values.",
    BROWSER_RELAY_BRAVE_PATH: values.bravePath || "",
    BROWSER_RELAY_BRAVE_PROFILE_DIR: values.profileDir || "",
    BROWSER_RELAY_UPSTREAM_PATH: values.upstreamPath || "",
    BROWSER_RELAY_POOL_DIR: values.mode === "pool" ? (values.poolDir || "") : "",
    BROWSER_RELAY_POOL_SLOT: "",
    BROWSER_HEADLESS_ENABLE: "false",
    BROWSER_LOAD_EXTENSIONS: "",
  };
  fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(obj, null, 2) + "\n", "utf8");
  process.stdout.write(`[setup] Wrote ${LOCAL_CONFIG_PATH}\n`);
  return true;
}

function step8_printMcpSnippet() {
  // Build the MCP registration JSON snippet. Use the absolute path to
  // src/index.js so the snippet works regardless of the user's cwd.
  const snippet = {
    "browser-mcp-relay": {
      command: "node",
      args: [RELAY_ENTRY],
    },
  };
  const json = JSON.stringify(snippet, null, 2);
  process.stdout.write([
    "",
    "─────────────────────── MCP registration snippet ───────────────────────",
    "Paste the following into the `mcpServers` section of your Claude Code or",
    "Cursor config (e.g. ~/.claude.json):",
    "",
    json,
    "",
    "If you already have other MCP entries, merge this one in alongside them",
    "(don't replace the whole `mcpServers` object).",
    "────────────────────────────────────────────────────────────────────────",
    "",
  ].join("\n"));
}

// ─────────────────────────── smoke test ─────────────────────────────────

/**
 * Spawn `node src/index.js`, send a single tools/list JSON-RPC request over
 * stdin, and wait for a reply. Verify ≥50 tools (51 forwarded + 16 own = 67).
 * Kill the relay regardless of outcome. Returns { ok, count, reason }.
 *
 * Self-contained — does NOT require any of the relay's modules itself, so
 * a parse error in the relay won't take this script down.
 */
function step9_smokeTest({ timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    process.stdout.write("[setup] Running smoke test (spawning relay, calling tools/list)...\n");
    const child = spawn(process.execPath, [RELAY_ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let resolved = false;
    let stdout = "";
    let stderr = "";

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
        reason: `timeout after ${timeoutMs}ms (stderr tail: ${stderr.slice(-300) || "<empty>"})`,
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
          reason: `relay exited prematurely (code=${code} signal=${signal}, stderr tail: ${stderr.slice(-300) || "<empty>"})`,
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      // Try to parse line-delimited JSON-RPC responses.
      const lines = stdout.split("\n");
      // Keep the last (possibly incomplete) line in the buffer.
      stdout = lines.pop();
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
        } catch { /* not JSON yet — keep buffering */ }
      }
    });

    // MCP handshake: initialize, then tools/list. The MCP SDK requires
    // initialization before regular requests. We send both immediately.
    const initialize = {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "browser-mcp-relay-setup", version: "0.0.0" },
      },
    };
    const toolsList = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
    try {
      child.stdin.write(JSON.stringify(initialize) + "\n");
      // Send tools/list a tick later so initialize has a chance to be processed.
      setTimeout(() => {
        try {
          child.stdin.write(JSON.stringify(toolsList) + "\n");
        } catch (e) {
          settle({ ok: false, count: 0, reason: `stdin write failed: ${e.message}` });
        }
      }, 100);
    } catch (e) {
      settle({ ok: false, count: 0, reason: `stdin write failed: ${e.message}` });
    }
  });
}

// ─────────────────────────── main ───────────────────────────────────────

async function main() {
  step1_welcome();
  step2_detectOs();

  const prompter = makePrompter();
  let bravePath, profileDir, upstreamPath, modeChoice;
  try {
    bravePath = await step3_detectBrave(prompter);
    profileDir = await step4_detectProfileDir(prompter);
    upstreamPath = step5_detectUpstream();
    modeChoice = await step6_chooseMode(prompter);
    await step7_writeLocalConfig(prompter, {
      bravePath,
      profileDir,
      upstreamPath,
      mode: modeChoice.mode,
      poolDir: modeChoice.poolDir,
    });
  } finally {
    prompter.close();
  }

  step8_printMcpSnippet();

  const smoke = await step9_smokeTest();
  if (smoke.ok) {
    process.stdout.write(`✓ Relay healthy. ${smoke.count} tools available.\n`);
  } else {
    process.stdout.write(`✗ Smoke test failed: ${smoke.reason}\n`);
    process.stdout.write("[setup] You can re-run the smoke test anytime with `npm run smoke`.\n");
  }

  process.stdout.write([
    "",
    "Next steps:",
    "  1. Paste the MCP snippet above into your Claude Code config (~/.claude.json).",
    "  2. Restart Cursor / Claude Code.",
    "  3. The relay's tools should appear (browser-devtools-mcp + 16 own-tools).",
    "  4. Re-run `npm run smoke` anytime to verify the relay still launches cleanly.",
    "",
  ].join("\n"));
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[setup] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  // Exported for tests.
  step9_smokeTest,
  killTree,
};
