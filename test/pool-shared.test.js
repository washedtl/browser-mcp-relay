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
  // standalone default ([<repo>/.browser-data]). With wrapper present (Washed's
  // setup) poolDirs is the wrapper's pool. Both shapes are valid.
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
