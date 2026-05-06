const test = require("node:test");
const assert = require("node:assert");
const pool = require("../src/pool-shared.js");

test("pool-shared re-exports loadConfig from upstream wrapper", () => {
  assert.strictEqual(typeof pool.loadConfig, "function");
});

test("pool-shared re-exports findCookiesFile from upstream wrapper", () => {
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
});

test("pool-shared exports the brave-process introspection helpers", () => {
  assert.strictEqual(typeof pool.findBraveProcessesForDir, "function");
  assert.strictEqual(typeof pool.listBraveProcessesRaw, "function");
  assert.strictEqual(typeof pool.reapOrphansFor, "function");
  assert.strictEqual(typeof pool.isPidAlive, "function");
  assert.strictEqual(typeof pool.checkCookieAgeDays, "function");
  assert.strictEqual(typeof pool.pickDirCandidates, "function");
});
