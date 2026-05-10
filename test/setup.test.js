const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SETUP_PATH = path.resolve(__dirname, "..", "scripts", "setup.js");
const SMOKE_PATH = path.resolve(__dirname, "..", "scripts", "smoke.js");
const REPO_ROOT = path.resolve(__dirname, "..");

// ─────────────────── Static-analysis tests ───────────────────
//
// The user's strongest constraint: setup.js must never write outside the repo
// (no writes to ~/.claude.json, no writes to user-home dotfiles). We don't
// mock the filesystem here — instead we statically inspect the script source.

test("setup.js source: does NOT call os.homedir() — no user-home file operations", () => {
  // Hard prohibition: setup.js must never resolve a path inside the user's
  // home directory and write/read it. (Mentioning ~/.claude.json in a
  // printed instruction string is fine — that's just text the user reads.)
  // The way to enforce "no home-dir writes" is to forbid os.homedir() and
  // process.env.HOME / USERPROFILE access entirely.
  const src = fs.readFileSync(SETUP_PATH, "utf8");
  assert.ok(!/\bos\.homedir\s*\(/.test(src), "setup.js must not call os.homedir()");
  assert.ok(!/process\.env\.HOME\b/.test(src), "setup.js must not read process.env.HOME");
  assert.ok(!/process\.env\.USERPROFILE\b/.test(src), "setup.js must not read process.env.USERPROFILE");
});

test("setup.js source: .claude.json appears ONLY in printed strings, never in fs paths", () => {
  // We allow the literal `~/.claude.json` to appear inside the printed
  // instruction snippet. We forbid it from appearing as an argument to any
  // fs.* method or inside a path.join / path.resolve call.
  const src = fs.readFileSync(SETUP_PATH, "utf8");
  // Look for any line that simultaneously mentions `claude.json` AND `fs.` or
  // `path.join` — that would mean it's being constructed as a file operation.
  const lines = src.split("\n");
  for (const line of lines) {
    if (/claude\.json/.test(line)) {
      assert.ok(
        !/\bfs\./.test(line) && !/\bpath\.(join|resolve)\b/.test(line),
        `setup.js line uses claude.json near an fs/path call: ${line.trim()}`,
      );
    }
  }
});

test("setup.js source: writeFileSync is only ever called against LOCAL_CONFIG_PATH", () => {
  const src = fs.readFileSync(SETUP_PATH, "utf8");
  // Find every fs.writeFileSync(...) call and confirm the first arg is LOCAL_CONFIG_PATH.
  const calls = src.match(/writeFileSync\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g) || [];
  for (const call of calls) {
    const m = call.match(/writeFileSync\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/);
    assert.ok(m, `unexpected writeFileSync call shape: ${call}`);
    assert.strictEqual(
      m[1],
      "LOCAL_CONFIG_PATH",
      `writeFileSync target must be LOCAL_CONFIG_PATH, got ${m[1]}`,
    );
  }
});

test("setup.js source: no network calls (no http/https/fetch/dns)", () => {
  const src = fs.readFileSync(SETUP_PATH, "utf8");
  assert.ok(!/require\(['"]node:https?['"]\)/.test(src), "no http/https require");
  assert.ok(!/\bfetch\s*\(/.test(src), "no fetch calls");
  assert.ok(!/require\(['"]node:dns['"]\)/.test(src), "no dns require");
});

test("setup.js source: spawn() target is always RELAY_ENTRY (the repo's src/index.js)", () => {
  const src = fs.readFileSync(SETUP_PATH, "utf8");
  // Count spawn calls. Allow only ones that pass [RELAY_ENTRY] as args.
  const spawnCalls = src.split("spawn(").slice(1);
  // First piece is before any spawn — slice from 1 gives slices STARTING with the args.
  for (const piece of spawnCalls) {
    // Look at the first ~200 chars after "spawn(" to find what's being launched.
    const head = piece.slice(0, 200);
    assert.ok(
      /process\.execPath/.test(head) && /RELAY_ENTRY/.test(head),
      `unexpected spawn target — must be process.execPath + RELAY_ENTRY: ${head}`,
    );
  }
});

// ─────────────────── Smoke-test helper unit tests ───────────────────

test("setup.js exports step9_smokeTest as a function", () => {
  const mod = require("../scripts/setup.js");
  assert.strictEqual(typeof mod.step9_smokeTest, "function");
});

test("smoke.js exports smokeTest as a function", () => {
  const mod = require("../scripts/smoke.js");
  assert.strictEqual(typeof mod.smokeTest, "function");
});

test("smoke.js exits with non-zero reason within timeout when given a fake fast timeout", async () => {
  // We can't actually run the real smoke (spawns a real Brave / upstream).
  // But we CAN run smokeTest() with a tiny timeout to verify the timeout
  // path works and returns a structured failure.
  const { smokeTest } = require("../scripts/smoke.js");
  const result = await smokeTest({ timeoutMs: 50 });
  // The relay can't possibly initialize in 50ms, so we expect a timeout
  // OR a premature exit (depending on how fast spawn fails). Either way:
  // not ok, count 0, reason populated.
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.count, 0);
  assert.ok(typeof result.reason === "string" && result.reason.length > 0);
}, { timeout: 10000 });

// ─────────────────── package.json scripts wiring ───────────────────

test("package.json: setup + smoke scripts are wired", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.ok(pkg.scripts && typeof pkg.scripts === "object");
  assert.strictEqual(pkg.scripts.setup, "node scripts/setup.js");
  assert.strictEqual(pkg.scripts.smoke, "node scripts/smoke.js");
  // Test script: either inline `node --test ...globs...` (legacy bash-only)
  // or the cross-shell wrapper `node scripts/run-tests.js` (current). Either
  // form is acceptable; the wrapper just shells through to `node --test`.
  assert.ok(
    pkg.scripts.test &&
      (pkg.scripts.test.includes("node --test") ||
        pkg.scripts.test.includes("scripts/run-tests.js")),
    `expected pkg.scripts.test to invoke node --test (got: ${pkg.scripts.test})`,
  );
  assert.strictEqual(pkg.scripts.start, "node src/index.js");
});

// ─────────────────── V0-5: killTree process-tree cleanup ───────────────────
//
// Reproduces: on Windows, `child.kill()` orphans the relay's spawned upstream
// + Brave subprocess. `taskkill /F /T /PID` takes the full tree.

test("V0-5: smoke.js exports killTree", () => {
  const { killTree } = require("../scripts/smoke.js");
  assert.strictEqual(typeof killTree, "function");
});

test("V0-5: setup.js exports killTree", () => {
  const { killTree } = require("../scripts/setup.js");
  assert.strictEqual(typeof killTree, "function");
});

test("V0-5: killTree no-ops on null / pid-less child", () => {
  const { killTree } = require("../scripts/smoke.js");
  // Must not throw.
  killTree(null);
  killTree(undefined);
  killTree({});
  killTree({ pid: 0 });
});

test("V0-5: smoke.js source uses taskkill /F /T on win32", () => {
  // The bug: `child.kill()` on Windows is TerminateProcess — no signal
  // cascade — so the spawned upstream BDMCP + Brave subprocess get orphaned.
  // Fix: `taskkill /F /T /PID <pid>` takes the whole process tree at once.
  const src = fs.readFileSync(SMOKE_PATH, "utf8");
  assert.ok(/taskkill\s+\/F\s+\/T\s+\/PID/.test(src),
    "smoke.js must call taskkill /F /T /PID on win32");
  assert.ok(/process\.platform\s*===\s*['"]win32['"]/.test(src),
    "smoke.js must branch on process.platform === 'win32'");
});

test("V0-5: setup.js source uses taskkill /F /T on win32", () => {
  const src = fs.readFileSync(SETUP_PATH, "utf8");
  assert.ok(/taskkill\s+\/F\s+\/T\s+\/PID/.test(src),
    "setup.js must call taskkill /F /T /PID on win32");
  assert.ok(/process\.platform\s*===\s*['"]win32['"]/.test(src),
    "setup.js must branch on process.platform === 'win32'");
});

test("V0-5: killTree on win32 invokes taskkill (mocked execSync)", () => {
  // Inject a mock execSync via require cache. We require fresh copies so
  // we don't pollute other tests.
  const realChildProcess = require("node:child_process");
  const captured = { calls: [] };
  // Monkey-patch execSync; restore in finally.
  const originalExecSync = realChildProcess.execSync;
  realChildProcess.execSync = (cmd, opts) => {
    captured.calls.push({ cmd, opts });
    return Buffer.from("");
  };
  try {
    // Bust the require cache so smoke.js picks up the patched execSync.
    const smokePath = require.resolve("../scripts/smoke.js");
    delete require.cache[smokePath];
    const { killTree } = require("../scripts/smoke.js");
    killTree({ pid: 99999 });
    if (process.platform === "win32") {
      assert.strictEqual(captured.calls.length, 1, "expected one taskkill invocation on win32");
      assert.match(captured.calls[0].cmd, /taskkill\s+\/F\s+\/T\s+\/PID\s+99999/);
    } else {
      // POSIX path uses child.kill, no execSync call expected.
      assert.strictEqual(captured.calls.length, 0, "POSIX path should NOT invoke execSync");
    }
  } finally {
    realChildProcess.execSync = originalExecSync;
    // Bust again so subsequent tests get a clean module.
    const smokePath = require.resolve("../scripts/smoke.js");
    delete require.cache[smokePath];
  }
});

test("local-config.example.json contains all keys the setup wizard writes", () => {
  const example = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "local-config.example.json"), "utf8"),
  );
  // The wizard writes these top-level keys (per step7_writeLocalConfig in setup.js).
  const expectedKeys = [
    "BROWSER_RELAY_BRAVE_PATH",
    "BROWSER_RELAY_BRAVE_PROFILE_DIR",
    "BROWSER_RELAY_UPSTREAM_PATH",
    "BROWSER_RELAY_POOL_DIR",
    "BROWSER_RELAY_POOL_SLOT",
    "BROWSER_HEADLESS_ENABLE",
    "BROWSER_LOAD_EXTENSIONS",
  ];
  for (const k of expectedKeys) {
    assert.ok(k in example, `expected key ${k} in local-config.example.json`);
    // Each meaningful key has a sibling _<k>_doc explaining it.
    assert.ok(`_${k}_doc` in example, `expected sibling _${k}_doc in local-config.example.json`);
  }
});
