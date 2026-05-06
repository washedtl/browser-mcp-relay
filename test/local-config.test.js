const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const localConfig = require("../src/local-config.js");

function mkTmpFile(contents) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-localconfig-"));
  const file = path.join(tmp, "local-config.json");
  fs.writeFileSync(file, contents, "utf8");
  return { dir: tmp, file };
}

test("loadLocalConfig returns {} when file is missing", () => {
  const cfg = localConfig.loadLocalConfig({
    path: path.join(os.tmpdir(), "relay-doesnt-exist-" + Date.now() + ".json"),
    refresh: true,
  });
  assert.deepStrictEqual(cfg, {});
});

test("loadLocalConfig parses meaningful keys, strips _doc keys + empty strings", () => {
  const { file } = mkTmpFile(JSON.stringify({
    _comment_1: "this is documentation",
    _BROWSER_RELAY_BRAVE_PATH_doc: "documentation",
    BROWSER_RELAY_BRAVE_PATH: "C:\\some\\brave.exe",
    BROWSER_RELAY_UPSTREAM_PATH: "",
    BROWSER_RELAY_POOL_DIR: "C:\\pool",
  }));
  const cfg = localConfig.loadLocalConfig({ path: file, refresh: true });
  assert.deepStrictEqual(cfg, {
    BROWSER_RELAY_BRAVE_PATH: "C:\\some\\brave.exe",
    BROWSER_RELAY_POOL_DIR: "C:\\pool",
  });
});

test("loadLocalConfig is fault-tolerant on malformed JSON", () => {
  const { file } = mkTmpFile("{ this is not json");
  // Should not throw — should warn + return {}.
  const cfg = localConfig.loadLocalConfig({ path: file, refresh: true });
  assert.deepStrictEqual(cfg, {});
});

test("applyLocalConfigToEnv overlays file values under env (env wins)", () => {
  const { file } = mkTmpFile(JSON.stringify({
    BROWSER_RELAY_BRAVE_PATH: "/from/file",
    BROWSER_RELAY_POOL_DIR: "/from/file/pool",
  }));
  const env = { BROWSER_RELAY_BRAVE_PATH: "/from/env" };
  const merged = localConfig.applyLocalConfigToEnv(env, { path: file, refresh: true });
  // Env wins for BRAVE_PATH; file fills in POOL_DIR.
  assert.strictEqual(merged.BROWSER_RELAY_BRAVE_PATH, "/from/env");
  assert.strictEqual(merged.BROWSER_RELAY_POOL_DIR, "/from/file/pool");
});

test("applyLocalConfigToEnv does NOT mutate the input env object", () => {
  const { file } = mkTmpFile(JSON.stringify({ BROWSER_RELAY_POOL_DIR: "/x" }));
  const env = { FOO: "bar" };
  const merged = localConfig.applyLocalConfigToEnv(env, { path: file, refresh: true });
  // Input untouched.
  assert.deepStrictEqual(env, { FOO: "bar" });
  // Output contains both.
  assert.strictEqual(merged.FOO, "bar");
  assert.strictEqual(merged.BROWSER_RELAY_POOL_DIR, "/x");
});

test("getLocalConfigPath points at <repo>/local-config.json", () => {
  const p = localConfig.getLocalConfigPath();
  assert.ok(p.endsWith("local-config.json"), `expected to end with local-config.json, got ${p}`);
});
