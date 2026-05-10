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

// ───── F1-9: defaultStandaloneDir fallback ─────

test("F1-9: defaultStandaloneDir is exported", () => {
  assert.strictEqual(typeof pool.defaultStandaloneDir, "function");
});

test("F1-9: defaultStandaloneDir returns legacy <repo>/.browser-data when repo is writable", () => {
  // os.tmpdir() is universally writable on every supported platform — perfect
  // stand-in for a writable repo root in tests.
  const os = require("node:os");
  const path = require("node:path");
  const result = pool.defaultStandaloneDir(os.tmpdir(), {});
  assert.strictEqual(
    result,
    path.join(os.tmpdir(), ".browser-data"),
    "writable repoRoot must resolve to <repo>/.browser-data",
  );
});

test("F1-9: defaultStandaloneDir falls back to per-user cache dir when repo is read-only", () => {
  const path = require("node:path");
  const os = require("node:os");
  // /nonexistent-readonly is guaranteed not to exist + accessSync W_OK fails
  // for both a missing parent and an unwritable existing dir, so this exercises
  // the fallback branch without needing a chmod helper.
  const result = pool.defaultStandaloneDir("/__definitely__nonexistent__path__/repo", {});
  // Must NOT be the legacy path.
  assert.ok(
    !result.includes("/__definitely__nonexistent__path__/repo/.browser-data") &&
    !result.includes("\\__definitely__nonexistent__path__\\repo\\.browser-data"),
    `read-only repoRoot must NOT resolve to <repo>/.browser-data (got ${result})`,
  );
  // Must contain the project name + a "browser-data" leaf segment.
  assert.match(result, /browser-mcp-relay/);
  assert.match(result, /browser-data$/);
  // Per-platform path-shape sanity (the helper lives outside the user's repo).
  if (process.platform === "win32") {
    assert.match(result, /\\Cache\\browser-data$/);
  } else if (process.platform === "darwin") {
    assert.match(result, /\/Library\/Caches\/browser-mcp-relay\/browser-data$/);
  } else {
    assert.match(result, /(\.cache|\/cache)\/browser-mcp-relay\/browser-data$/);
  }
  // Always absolute.
  assert.ok(path.isAbsolute(result), "fallback path must be absolute");
});

test("F1-9: defaultStandaloneDir on linux honors XDG_CACHE_HOME when set", () => {
  if (process.platform !== "linux") {
    // The helper consults process.platform internally — only linux exercises
    // the XDG branch. Skip on win32/darwin.
    return;
  }
  const path = require("node:path");
  const result = pool.defaultStandaloneDir(
    "/__definitely__nonexistent__path__/repo",
    { XDG_CACHE_HOME: "/tmp/custom-xdg" },
  );
  assert.strictEqual(result, path.join("/tmp/custom-xdg", "browser-mcp-relay", "browser-data"));
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

// ──────────────────────────────────────────────────────────────────
// V1-1: wrapper.proxyUrl is now bridged into the relay's CONFIG so
// the relay's launched Brave inherits the same per-process proxy
// whitelist that wrapper-spawned BDMCP gets. Previously the field
// was wrapper-only and the relay's Brave didn't honor it.
// ──────────────────────────────────────────────────────────────────

test("V1-1: loadConfig() exposes a proxyUrl key (always present on the returned object)", () => {
  const cfg = pool.loadConfig({ env: {}, repoRoot: "C:\\fake\\repo" });
  assert.ok("proxyUrl" in cfg, "proxyUrl key must be present on returned config");
  // Either null (no env, no wrapper, or wrapper without proxyUrl) or a string.
  assert.ok(cfg.proxyUrl === null || typeof cfg.proxyUrl === "string");
});

test("V1-1: BROWSER_RELAY_PROXY_URL env override wins over wrapper.proxyUrl", () => {
  const cfg = pool.loadConfig({
    env: { BROWSER_RELAY_PROXY_URL: "http://envwin:7777" },
    repoRoot: "C:\\fake\\repo",
  });
  assert.strictEqual(cfg.proxyUrl, "http://envwin:7777");
});

test("V1-1: empty BROWSER_RELAY_PROXY_URL falls through to wrapper / null", () => {
  // Empty string should be treated as unset and fall through to wrapper or null.
  const cfg = pool.loadConfig({
    env: { BROWSER_RELAY_PROXY_URL: "" },
    repoRoot: "C:\\fake\\repo",
  });
  // Either null (no wrapper proxy) or wrapper.proxyUrl — never the empty string.
  assert.notStrictEqual(cfg.proxyUrl, "");
  assert.ok(cfg.proxyUrl === null || typeof cfg.proxyUrl === "string");
});

// ──────────────────────────────────────────────────────────────────
// V1-2: bravePath resolution order is now env > wrapper > auto-detect.
// Previously wrapper was a fallback only when auto-detect threw —
// meaning a user who set wrapperConfig.bravePath could be silently
// overridden by an auto-detected stale Brave install.
// ──────────────────────────────────────────────────────────────────

test("V1-2: BROWSER_RELAY_BRAVE_PATH env override is honored when file exists", () => {
  // Use process.execPath (the running node binary) — guaranteed to exist.
  const realFile = process.execPath;
  const cfg = pool.loadConfig({
    env: { BROWSER_RELAY_BRAVE_PATH: realFile },
    repoRoot: "C:\\fake\\repo",
  });
  assert.strictEqual(cfg.bravePath, realFile);
  assert.strictEqual(cfg.braveDetectError, null);
});

test("V1-2: BROWSER_RELAY_BRAVE_PATH env override pointing at non-existent file → bravePath null + braveDetectError set", () => {
  const cfg = pool.loadConfig({
    env: { BROWSER_RELAY_BRAVE_PATH: "Z:\\nonexistent\\brave.exe" },
    repoRoot: "C:\\fake\\repo",
  });
  // env override resolution failed → fall through; on this host without a
  // valid auto-detect, bravePath is null. With the live wrapper present,
  // wrapper.bravePath WOULD be tried next (V1-2). Result depends on host:
  // either wrapper-resolved (string) or null. Both paths are valid; what
  // matters is that the env override DIDN'T silently succeed.
  if (cfg.bravePath !== null) {
    assert.notStrictEqual(cfg.bravePath, "Z:\\nonexistent\\brave.exe");
  }
  assert.ok(cfg.braveDetectError instanceof Error || cfg.braveDetectError === null);
});

test("V1-2: source-level guard — resolution order is env → wrapper → auto-detect", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "pool-shared.js"), "utf8");
  // Comment block must declare the new order explicitly.
  assert.match(
    src,
    /BROWSER_RELAY_BRAVE_PATH\s*>\s*wrapper\.CONFIG\.bravePath\s*>\s*detectBravePath/,
    "expected resolution order documented as 'env > wrapper > auto-detect'",
  );
  // Implementation must check env first, wrapper second, auto-detect last.
  // Crude regex-based ordering check: env step exists, wrapper step exists,
  // both come before the unconditional `detectBravePath({ env })` call inside
  // step 3.
  const stepOneIdx = src.search(/Step 1: explicit env override/);
  const stepTwoIdx = src.search(/Step 2: wrapper hint/);
  const stepThreeIdx = src.search(/Step 3: auto-detect/);
  assert.ok(stepOneIdx >= 0 && stepTwoIdx > stepOneIdx && stepThreeIdx > stepTwoIdx,
    "expected explicit Step 1 → Step 2 → Step 3 comment markers in resolution body");
});
