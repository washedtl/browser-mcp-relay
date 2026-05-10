#!/usr/bin/env node
// scripts/manual-test-tabs-active.js
//
// Manual end-to-end repro for the tabs_select / tabs_new active-page
// propagation fix. Spins up the relay, sends:
//
//   1. initialize
//   2. tools/list
//   3. tabs_new("file:///<repo>/scripts/manual-test-page-A.html")
//   4. content_take-screenshot
//   5. tabs_new("file:///<repo>/scripts/manual-test-page-B.html")
//   6. content_take-screenshot
//
// Then asserts:
//   - Both screenshots exist on disk.
//   - Each screenshot's saved bytes differ (different content) — a cheap
//     way to confirm the screenshots aren't both of the same page.
//
// Pre-condition: Brave installed at one of the standard paths so the
// relay can launch it. This script DOES require a real Brave to exercise
// the upstream propagation path — that's why it's not part of the unit
// suite.
//
// Usage:
//   node scripts/manual-test-tabs-active.js
//
// Exit code 0 on pass, non-zero with a diagnostic on failure.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const url = require("node:url");
const { spawn } = require("node:child_process");

const REPO_ROOT = path.resolve(__dirname, "..");
const RELAY_ENTRY = path.join(REPO_ROOT, "src", "index.js");
// W1-8 (2026-05-09): write fixtures into a fresh tmp dir, not into scripts/.
// Previously left manual-test-page-{A,B}.html under scripts/ which polluted
// the working tree and showed up as untracked files on every clone.
const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tabs-active-test-"));
const PAGE_A = path.join(FIXTURE_DIR, "manual-test-page-A.html");
const PAGE_B = path.join(FIXTURE_DIR, "manual-test-page-B.html");
const TIMEOUT_MS = 90_000;

const FIXTURE_A = `<!doctype html><html><head><title>Page A</title></head><body style="background:#ff0000;font:48px monospace;color:#fff;padding:80px;">PAGE A — RED — ${Date.now()}</body></html>`;
const FIXTURE_B = `<!doctype html><html><head><title>Page B</title></head><body style="background:#0000ff;font:48px monospace;color:#fff;padding:80px;">PAGE B — BLUE — ${Date.now()}</body></html>`;

// F0-8 (2026-05-10): use Node's standard url.pathToFileURL. Previously this
// hand-rolled `"file:///" + p.replace(/\\/g,"/")` which produced
// `file:////home/...` (4 slashes) on POSIX where p already starts with /.
// Brave was lenient and loaded it anyway, but the URL was non-standard.
function pathToFileURL(p) { return url.pathToFileURL(p).href; }

function send(child, msg) { child.stdin.write(JSON.stringify(msg) + "\n"); }

function awaitId(awaiting, id) {
  return new Promise((resolve, reject) => {
    awaiting.set(id, { resolve, reject });
  });
}

async function main() {
  fs.writeFileSync(PAGE_A, FIXTURE_A, "utf8");
  fs.writeFileSync(PAGE_B, FIXTURE_B, "utf8");

  const child = spawn(process.execPath, [RELAY_ENTRY], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });
  const awaiting = new Map();
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let msg;
      try { msg = JSON.parse(t); } catch { continue; }
      if (msg.id != null && awaiting.has(msg.id)) {
        const w = awaiting.get(msg.id);
        awaiting.delete(msg.id);
        if (msg.error) w.reject(new Error(JSON.stringify(msg.error)));
        else w.resolve(msg.result);
      }
    }
  });

  let nextId = 0;
  function rpc(method, params) {
    const id = ++nextId;
    send(child, { jsonrpc: "2.0", id, method, params });
    return Promise.race([
      awaitId(awaiting, id),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`rpc timeout: ${method} id=${id}`)), TIMEOUT_MS)),
    ]);
  }

  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "manual-test", version: "0" },
    });
    process.stderr.write("[manual] initialize OK\n");

    await rpc("tools/list", {});
    process.stderr.write("[manual] tools/list OK\n");

    // Open page A and screenshot.
    const newARes = await rpc("tools/call", {
      name: "tabs_new",
      arguments: { url: pathToFileURL(PAGE_A) },
    });
    process.stderr.write(`[manual] tabs_new(A) → ${JSON.stringify(extractText(newARes))}\n`);

    const tmpA = path.join(os.tmpdir(), "manual-shot-A");
    const shotARes = await rpc("tools/call", {
      name: "content_take-screenshot",
      arguments: { outputPath: tmpA, name: "shotA" },
    });
    const shotAPath = extractScreenshotPath(shotARes);
    process.stderr.write(`[manual] screenshot A → ${shotAPath}\n`);

    // Open page B and screenshot.
    const newBRes = await rpc("tools/call", {
      name: "tabs_new",
      arguments: { url: pathToFileURL(PAGE_B) },
    });
    process.stderr.write(`[manual] tabs_new(B) → ${JSON.stringify(extractText(newBRes))}\n`);

    const tmpB = path.join(os.tmpdir(), "manual-shot-B");
    const shotBRes = await rpc("tools/call", {
      name: "content_take-screenshot",
      arguments: { outputPath: tmpB, name: "shotB" },
    });
    const shotBPath = extractScreenshotPath(shotBRes);
    process.stderr.write(`[manual] screenshot B → ${shotBPath}\n`);

    if (!fs.existsSync(shotAPath)) throw new Error(`screenshot A not on disk: ${shotAPath}`);
    if (!fs.existsSync(shotBPath)) throw new Error(`screenshot B not on disk: ${shotBPath}`);
    const a = fs.readFileSync(shotAPath);
    const b = fs.readFileSync(shotBPath);
    if (a.length === b.length && a.equals(b)) {
      throw new Error(
        "FAIL: screenshots A and B are byte-identical — upstream is screenshotting the same page both times.",
      );
    }
    process.stderr.write(
      `[manual] PASS: screenshot bytes differ (A=${a.length}, B=${b.length}) — upstream tracked the active tab.\n`,
    );
    process.stdout.write("OK\n");
    cleanupAndExit(child, 0);
  } catch (e) {
    process.stderr.write(`[manual] FAIL: ${e.message}\n`);
    cleanupAndExit(child, 1);
  }
}

// W1-8: cross-platform process-tree kill + tmp-dir cleanup.
// Same pattern as smoke.js / setup.js — bare `child.kill()` on Windows
// orphans the relay's spawned upstream BDMCP + Brave process tree.
function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try { require("node:child_process").execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore", windowsHide: true }); } catch {}
  } else {
    try { child.kill("SIGTERM"); } catch {}
  }
}
function cleanupAndExit(child, code) {
  killTree(child);
  // Best-effort fixture-dir cleanup so manual-test runs leave no residue.
  try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {}
  process.exit(code);
}

function extractText(res) {
  try {
    const txt = res?.content?.[0]?.text;
    if (!txt) return res;
    return JSON.parse(txt);
  } catch { return res; }
}

function extractScreenshotPath(res) {
  // Upstream returns a JSON-encoded body in content[0].text with `filePath`.
  try {
    const txt = res?.content?.[0]?.text;
    if (!txt) throw new Error("no screenshot result text");
    const obj = JSON.parse(txt);
    if (obj.filePath) return obj.filePath;
    throw new Error("no filePath in screenshot result");
  } catch (e) {
    throw new Error(`could not parse screenshot result: ${e.message} — raw: ${JSON.stringify(res)}`);
  }
}

if (require.main === module) main();
