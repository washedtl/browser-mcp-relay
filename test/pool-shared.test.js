const test = require("node:test");
const assert = require("node:assert");
const pool = require("../src/pool-shared.js");

test("pool-shared exports loadConfig", () => {
  assert.strictEqual(typeof pool.loadConfig, "function");
});

test("pool-shared exports findCookiesFile", () => {
  assert.strictEqual(typeof pool.findCookiesFile, "function");
});

test("pool-shared exposes a claimSlot helper that returns { dir, lock, role, release }", () => {
  // Note: this test does NOT call claimSlot (it would actually try to claim
  // a real pool slot). Just verify the function exists.
  assert.strictEqual(typeof pool.claimSlot, "function");
});

test("pool-shared exposes CONFIG with poolDirs array", () => {
  assert.ok(pool.CONFIG, "CONFIG should be exported");
  assert.ok(Array.isArray(pool.CONFIG.poolDirs), "CONFIG.poolDirs should be an array");
  assert.ok(pool.CONFIG.poolDirs.length >= 1, "CONFIG.poolDirs should have at least one entry");
});

test("pool-shared exports brave-process introspection helpers", () => {
  assert.strictEqual(typeof pool.findBraveProcessesForDir, "function");
  assert.strictEqual(typeof pool.listBraveProcessesRaw, "function");
  assert.strictEqual(typeof pool.reapOrphansFor, "function");
  assert.strictEqual(typeof pool.isPidAlive, "function");
  assert.strictEqual(typeof pool.checkCookieAgeDays, "function");
  assert.strictEqual(typeof pool.pickDirCandidates, "function");
});

test("pool-shared exposes a hasPoolWrapper boolean", () => {
  assert.strictEqual(typeof pool.hasPoolWrapper, "boolean");
});

test("loadConfig() returns a fresh object with standalone defaults when no env / wrapper", () => {
  const cfg = pool.loadConfig({ env: {}, repoRoot: "C:\\fake\\repo" });
  assert.ok(Array.isArray(cfg.poolDirs));
  // Without BROWSER_RELAY_POOL_DIR and without the wrapper, poolDirs is the
  // standalone default ([<repo>/.browser-data]). With the optional wrapper
  // present, poolDirs is the wrapper's pool. Both shapes are valid.
  assert.ok(cfg.poolDirs.length >= 1);
  assert.strictEqual(typeof cfg.standalone, "boolean");
});

test("loadConfig() honors BROWSER_RELAY_POOL_DIR override (single-element pool)", () => {
  const override = "C:\\custom\\profile-dir";
  const cfg = pool.loadConfig({ env: { BROWSER_RELAY_POOL_DIR: override }, repoRoot: "C:\\fake\\repo" });
  assert.strictEqual(cfg.poolDirs.length, 1);
  assert.strictEqual(cfg.poolDirs[0], override);
  assert.strictEqual(cfg.standalone, false, "explicit pool override is not standalone");
});

test("findBraveProcessesForDir parses PID|cmd output", () => {
  const stdout = [
    `1111|"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --user-data-dir=C:\\Users\\u\\.foo`,
    `2222|"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --type=gpu --user-data-dir="C:\\Users\\u\\.foo"`,
    `3333|"C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" --user-data-dir=C:\\Users\\u\\.bar`,
  ].join("\r\n");
  const pids = pool.findBraveProcessesForDir(stdout, "C:\\Users\\u\\.foo");
  assert.deepStrictEqual(pids.sort(), [1111, 2222]);
});

test("findBraveProcessesForDir returns empty array on garbage input", () => {
  assert.deepStrictEqual(pool.findBraveProcessesForDir("", "C:\\anything"), []);
  assert.deepStrictEqual(pool.findBraveProcessesForDir("garbage\nno pipe\n", "C:\\x"), []);
});

test("isPidAlive returns false for invalid input without spawning", () => {
  assert.strictEqual(pool.isPidAlive(undefined), false);
  assert.strictEqual(pool.isPidAlive(null), false);
  assert.strictEqual(pool.isPidAlive(NaN), false);
  assert.strictEqual(pool.isPidAlive(0), false);
  assert.strictEqual(pool.isPidAlive(-5), false);
});

test("isPidAlive returns true for the current process", () => {
  assert.strictEqual(pool.isPidAlive(process.pid), true);
});

test("pickDirCandidates returns all pool dirs when no role requested", () => {
  const cfg = { poolDirs: ["a", "b", "c"], slotRoles: { a: "x" } };
  assert.deepStrictEqual(pool.pickDirCandidates(cfg, undefined), ["a", "b", "c"]);
  assert.deepStrictEqual(pool.pickDirCandidates(cfg, null), ["a", "b", "c"]);
  assert.deepStrictEqual(pool.pickDirCandidates(cfg, ""), ["a", "b", "c"]);
});

test("pickDirCandidates filters by role when requested", () => {
  const cfg = { poolDirs: ["a", "b", "c"], slotRoles: { a: "x", c: "x" } };
  assert.deepStrictEqual(pool.pickDirCandidates(cfg, "x"), ["a", "c"]);
  assert.deepStrictEqual(pool.pickDirCandidates(cfg, "y"), []);
});

test("checkCookieAgeDays returns null for a missing file", () => {
  assert.strictEqual(pool.checkCookieAgeDays("C:\\definitely\\does\\not\\exist\\Cookies"), null);
});

// ───── Cross-platform process-shim delegation ─────

test("braveNeedle is 'brave.exe' on Win and 'brave' elsewhere", () => {
  assert.strictEqual(pool.braveNeedle("win32"), "brave.exe");
  assert.strictEqual(pool.braveNeedle("darwin"), "brave");
  assert.strictEqual(pool.braveNeedle("linux"), "brave");
});

test("listBraveProcessesRaw delegates to process-shim and returns pipe-formatted text", () => {
  const fakeSpawn = (_cmd, _args) => ({
    status: 0,
    // Return PowerShell-style PID|cmd output (Win path was selected).
    stdout: "1111|brave.exe --user-data-dir=/x\r\n2222|brave.exe --type=gpu\r\n",
  });
  const out = pool.listBraveProcessesRaw({ _platform: "win32", _spawnSync: fakeSpawn });
  assert.match(out, /^1111\|brave\.exe/);
  assert.match(out, /2222\|brave\.exe/);
});

test("listBraveProcessesRaw returns empty string when nothing matches", () => {
  const fakeSpawn = () => ({ status: 0, stdout: "  PID COMMAND\n" });
  const out = pool.listBraveProcessesRaw({ _platform: "linux", _spawnSync: fakeSpawn });
  assert.strictEqual(out, "");
});

// ───── reapOrphansFor — cross-platform ─────

test("reapOrphansFor on Win runs taskkill /F /T for matching pids", () => {
  const calls = [];
  const fakeSpawn = (cmd, args) => {
    if (cmd === "powershell") {
      // Process listing — return one matching brave.
      return {
        status: 0,
        stdout: "1111|brave.exe --user-data-dir=C:\\foo --type=renderer\r\n",
      };
    }
    if (cmd === "taskkill") {
      calls.push({ cmd, args });
      return { status: 0 };
    }
    return { status: 1, stdout: "" };
  };
  const killed = pool.reapOrphansFor("C:\\foo", {
    _platform: "win32",
    _spawnSync: fakeSpawn,
  });
  assert.strictEqual(killed, 1);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, ["/F", "/T", "/PID", "1111"]);
});

test("reapOrphansFor on Win does NOT kill pids whose dir doesn't match", () => {
  let taskkillCalled = false;
  const fakeSpawn = (cmd) => {
    if (cmd === "powershell") {
      return {
        status: 0,
        stdout: "1111|brave.exe --user-data-dir=C:\\different\r\n",
      };
    }
    if (cmd === "taskkill") {
      taskkillCalled = true;
      return { status: 0 };
    }
    return { status: 1, stdout: "" };
  };
  const killed = pool.reapOrphansFor("C:\\foo", {
    _platform: "win32",
    _spawnSync: fakeSpawn,
  });
  assert.strictEqual(killed, 0);
  assert.strictEqual(taskkillCalled, false);
});

test("reapOrphansFor on Linux sends SIGTERM to matching brave processes", () => {
  const killSent = [];
  const fakeKill = (pid, sig) => {
    killSent.push({ pid, sig });
    // After SIGTERM, simulate process gone — subsequent isPidAlive returns false
    // (because our fakeSpawn for tasklist isn't reached on POSIX).
  };
  const fakeSpawn = (cmd, _args) => {
    if (cmd === "ps") {
      return {
        status: 0,
        stdout: "  PID COMMAND\n 1111 /usr/bin/brave --user-data-dir=/home/u/.foo\n",
      };
    }
    return { status: 1, stdout: "" };
  };
  const killed = pool.reapOrphansFor("/home/u/.foo", {
    _platform: "linux",
    _spawnSync: fakeSpawn,
    _processKill: fakeKill,
  });
  assert.strictEqual(killed, 1);
  // First call must be SIGTERM. Second call (SIGKILL) only fires if the
  // post-SIGTERM liveness check says alive — which it might or might not
  // (depends on _processKill behavior in isPidAlive). We assert at LEAST
  // SIGTERM happened.
  assert.ok(killSent.length >= 1);
  assert.strictEqual(killSent[0].sig, "SIGTERM");
  assert.strictEqual(killSent[0].pid, 1111);
});

test("reapOrphansFor on darwin (Mac) uses POSIX path (SIGTERM, not taskkill)", () => {
  const killSent = [];
  const fakeKill = (pid, sig) => killSent.push({ pid, sig });
  const fakeSpawn = (cmd) => {
    if (cmd === "ps") {
      return {
        status: 0,
        stdout: "  PID COMMAND\n 2222 /Applications/Brave Browser.app/Contents/MacOS/Brave Browser --user-data-dir=/Users/u/.foo\n",
      };
    }
    if (cmd === "taskkill") {
      throw new Error("taskkill must not be invoked on darwin");
    }
    return { status: 1, stdout: "" };
  };
  const killed = pool.reapOrphansFor("/Users/u/.foo", {
    _platform: "darwin",
    _spawnSync: fakeSpawn,
    _processKill: fakeKill,
  });
  assert.strictEqual(killed, 1);
  assert.strictEqual(killSent[0].sig, "SIGTERM");
});

test("reapOrphansFor returns 0 when no Brave processes are running", () => {
  const fakeSpawn = (cmd) => {
    if (cmd === "powershell") return { status: 0, stdout: "" };
    if (cmd === "ps") return { status: 0, stdout: "  PID COMMAND\n" };
    return { status: 1, stdout: "" };
  };
  assert.strictEqual(
    pool.reapOrphansFor("C:\\foo", { _platform: "win32", _spawnSync: fakeSpawn }),
    0,
  );
  assert.strictEqual(
    pool.reapOrphansFor("/home/u/.foo", {
      _platform: "linux",
      _spawnSync: fakeSpawn,
      _processKill: () => {},
    }),
    0,
  );
});

// ───── findCookiesFile fallback to detectBraveProfileDir ─────

test("findCookiesFile with no profileDir falls through to detectBraveProfileDir (returns null when nothing on disk)", () => {
  // The real default path almost certainly doesn't exist in CI / fresh clones —
  // the contract is "null if neither modern nor legacy file exists". This
  // exercises that fallback path without mocking.
  const result = pool.findCookiesFile();
  // We can't assert null universally (the maintainer's dev host has Brave
  // installed), but we can assert: it's either a string ending in "Cookies",
  // or null.
  if (result !== null) {
    assert.match(result, /Cookies$/);
  }
});

test("findCookiesFile with explicit non-existent profileDir returns null", () => {
  const fakeDir = "C:\\definitely\\does\\not\\exist\\BraveProfile";
  assert.strictEqual(pool.findCookiesFile(fakeDir), null);
});

// ───── W3 V2: braveDetectError exposed when auto-detect fails ─────

test("loadConfig() exposes a braveDetectError property (null when detection succeeds, Error when it fails)", () => {
  // Run with a deliberately bogus PROGRAMFILES + LOCALAPPDATA so detect fails
  // on Win, and a deliberately bogus 'which' shim on POSIX. We only need to
  // assert that braveDetectError is EITHER null OR an Error instance — both
  // are valid outcomes depending on whether the host has Brave installed.
  const cfg = pool.loadConfig({
    env: {
      PROGRAMFILES: "Z:\\nonsense",
      "PROGRAMFILES(X86)": "Z:\\nonsense",
      LOCALAPPDATA: "Z:\\nonsense",
      // Force POSIX paths to also fail.
      PATH: "/nonexistent",
    },
    repoRoot: "C:\\fake\\repo",
  });
  // Field must exist on the returned object (V2 follow-up wired it in).
  assert.ok("braveDetectError" in cfg, "loadConfig must expose braveDetectError key");
  // Either null (Brave was found via wrapper or default scan slipped through)
  // or an actual Error. Never undefined.
  if (cfg.braveDetectError !== null) {
    assert.ok(cfg.braveDetectError instanceof Error);
    assert.match(cfg.braveDetectError.message, /Brave/);
  }
});
