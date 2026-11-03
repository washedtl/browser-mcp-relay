// tool-catalog.test.js — W1B: cached upstream catalog so tools/list never
// spawns the long-lived upstream child.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  catalogKey,
  loadUpstreamCatalog,
  fetchUpstreamTools,
  servedTool,
  resolveUpstreamEntry,
  defaultCacheDirs,
  CACHE_FILE,
} = require("../src/tool-catalog.js");
const { toolsetOf, TOOLSET_NAMES } = require("../src/own-tools/toolsets.js");

const REPO = path.resolve(__dirname, "..");

function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-catalog-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// A fake upstream install: <root>/pkg/package.json + <root>/pkg/dist/index.js,
// plus a fake patch script. Returns the paths catalogKey needs.
function fakeInstall(root, { version = "1.0.0", patch = "// patch v1" } = {}) {
  const pkg = path.join(root, "pkg");
  fs.mkdirSync(path.join(pkg, "dist"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "browser-devtools-mcp", version }));
  const entry = path.join(pkg, "dist", "index.js");
  if (!fs.existsSync(entry)) fs.writeFileSync(entry, "// entry");
  const patchScript = path.join(root, "patch.js");
  fs.writeFileSync(patchScript, patch);
  return { entry, patchScript };
}

const TOOLS = [
  { name: "a_tool", description: "A", inputSchema: { type: "object" }, outputSchema: { type: "object" } },
];

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// ─── catalogKey ──────────────────────────────────────────────────────────

test("catalogKey: stable for identical inputs", (t) => {
  const root = tmpDir(t);
  const { entry, patchScript } = fakeInstall(root);
  assert.strictEqual(catalogKey({ entry, env: {}, patchScript }), catalogKey({ entry, env: {}, patchScript }));
});

test("catalogKey: changes with upstream package version", (t) => {
  const root = tmpDir(t);
  const a = fakeInstall(root, { version: "1.0.0" });
  const k1 = catalogKey({ entry: a.entry, env: {}, patchScript: a.patchScript });
  fakeInstall(root, { version: "1.0.1" });
  assert.notStrictEqual(catalogKey({ entry: a.entry, env: {}, patchScript: a.patchScript }), k1);
});

test("catalogKey: changes with the patch script content", (t) => {
  const root = tmpDir(t);
  const a = fakeInstall(root, { patch: "// v1" });
  const k1 = catalogKey({ entry: a.entry, env: {}, patchScript: a.patchScript });
  fakeInstall(root, { patch: "// v2" });
  assert.notStrictEqual(catalogKey({ entry: a.entry, env: {}, patchScript: a.patchScript }), k1);
});

test("catalogKey: changes with the upstream entry path and its mtime", (t) => {
  const root = tmpDir(t);
  const a = fakeInstall(root);
  const k1 = catalogKey({ entry: a.entry, env: {}, patchScript: a.patchScript });
  const other = path.join(root, "custom-entry.js");
  fs.writeFileSync(other, "// entry");
  assert.notStrictEqual(catalogKey({ entry: other, env: {}, patchScript: a.patchScript }), k1, "BROWSER_RELAY_UPSTREAM_PATH override must change the key");
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(a.entry, later, later);
  assert.notStrictEqual(catalogKey({ entry: a.entry, env: {}, patchScript: a.patchScript }), k1, "rebuilt entry (new mtime) must change the key");
});

test("catalogKey: changes with catalog-shaping upstream env vars, not unrelated ones", (t) => {
  const root = tmpDir(t);
  const { entry, patchScript } = fakeInstall(root);
  const base = catalogKey({ entry, env: {}, patchScript });
  assert.notStrictEqual(catalogKey({ entry, env: { TOOL_NAME_PREFIX: "x_" }, patchScript }), base);
  assert.notStrictEqual(catalogKey({ entry, env: { AVAILABLE_TOOL_DOMAINS: "navigation" }, patchScript }), base);
  assert.notStrictEqual(catalogKey({ entry, env: { FIGMA_ACCESS_TOKEN: "secret" }, patchScript }), base,
    "FIGMA_ACCESS_TOKEN presence enables an extra upstream tool");
  assert.strictEqual(catalogKey({ entry, env: { SOME_OTHER_VAR: "1" }, patchScript }), base);
});

// ─── resolveUpstreamEntry / defaultCacheDirs ─────────────────────────────

test("resolveUpstreamEntry: missing upstream install says how to fix it", () => {
  assert.throws(
    () => resolveUpstreamEntry({}, () => { throw new Error("Cannot find module 'browser-devtools-mcp/dist/index.js'"); }),
    (e) => /npm install/.test(e.message) && /BROWSER_RELAY_UPSTREAM_PATH/.test(e.message),
  );
});

test("resolveUpstreamEntry: override wins; a missing override path is an actionable error", (t) => {
  const root = tmpDir(t);
  const custom = path.join(root, "custom.js");
  fs.writeFileSync(custom, "");
  assert.strictEqual(resolveUpstreamEntry({ BROWSER_RELAY_UPSTREAM_PATH: custom }), custom);
  assert.throws(() => resolveUpstreamEntry({ BROWSER_RELAY_UPSTREAM_PATH: path.join(root, "nope.js") }), /BROWSER_RELAY_UPSTREAM_PATH=.*no file/);
});

test("defaultCacheDirs: <repo>/.cache, then the same per-user cache root pool-shared uses", () => {
  const env = { ...process.env };
  const [repoDir, userDir] = defaultCacheDirs(env);
  assert.strictEqual(repoDir, path.join(REPO, ".cache"));
  const { defaultStandaloneDir } = require("../src/pool-shared.js");
  // A repo root that doesn't exist forces pool-shared onto its per-user fallback.
  const userBrowserData = defaultStandaloneDir(path.join(os.tmpdir(), "bmr-no-such-repo-root"), env);
  assert.strictEqual(userDir, path.dirname(userBrowserData));
});

// ─── servedTool ──────────────────────────────────────────────────────────

test("servedTool: drops outputSchema/execution, keeps name/description/inputSchema/annotations", () => {
  const raw = {
    name: "n", description: "d", inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
    outputSchema: { type: "object", properties: { big: {} } },
    execution: { taskSupport: "forbidden" },
  };
  assert.deepStrictEqual(servedTool(raw), {
    name: "n", description: "d", inputSchema: { type: "object" }, annotations: { readOnlyHint: true },
  });
});

test("servedTool: omits absent optional fields instead of emitting undefined", () => {
  const out = servedTool({ name: "n", description: "d", inputSchema: {} });
  assert.deepStrictEqual(Object.keys(out), ["name", "description", "inputSchema"]);
});

// ─── loadUpstreamCatalog ─────────────────────────────────────────────────

function loadOpts(root, extra = {}) {
  const { entry, patchScript } = fakeInstall(root);
  let fetches = 0;
  const opts = {
    env: {},
    entry,
    patchScript,
    cacheDirs: [path.join(root, "repo-cache"), path.join(root, "user-cache")],
    fetchTools: async () => { fetches++; return TOOLS; },
    log: () => {},
    ...extra,
  };
  return { opts, fetches: () => fetches };
}

test("loadUpstreamCatalog: miss fetches once and writes the cache; next load is a hit", async (t) => {
  const root = tmpDir(t);
  const { opts, fetches } = loadOpts(root);
  assert.deepStrictEqual(await loadUpstreamCatalog(opts), TOOLS);
  assert.strictEqual(fetches(), 1);
  const file = path.join(root, "repo-cache", CACHE_FILE);
  assert.ok(fs.existsSync(file), "cache file written to the first cache dir");
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "repo-cache")), [CACHE_FILE], "no leftover tmp files (atomic tmp+rename)");
  assert.deepStrictEqual(await loadUpstreamCatalog(opts), TOOLS);
  assert.strictEqual(fetches(), 1, "second load must come from the cache, not a new spawn");
});

test("loadUpstreamCatalog: key change (e.g. upstream upgrade) refetches and overwrites", async (t) => {
  const root = tmpDir(t);
  const { opts, fetches } = loadOpts(root);
  await loadUpstreamCatalog(opts);
  fakeInstall(root, { version: "9.9.9" });
  await loadUpstreamCatalog(opts);
  assert.strictEqual(fetches(), 2);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, "repo-cache")), [CACHE_FILE], "one cache file, overwritten — no accumulation");
});

test("loadUpstreamCatalog: corrupt cache file is treated as a miss", async (t) => {
  const root = tmpDir(t);
  const { opts, fetches } = loadOpts(root);
  fs.mkdirSync(path.join(root, "repo-cache"), { recursive: true });
  fs.writeFileSync(path.join(root, "repo-cache", CACHE_FILE), "{not json");
  assert.deepStrictEqual(await loadUpstreamCatalog(opts), TOOLS);
  assert.strictEqual(fetches(), 1);
});

test("loadUpstreamCatalog: unwritable repo cache dir falls back to the per-user dir", async (t) => {
  const root = tmpDir(t);
  // A FILE where the repo cache dir should be → mkdir/write fails.
  fs.writeFileSync(path.join(root, "repo-cache"), "not a dir");
  const { opts, fetches } = loadOpts(root);
  assert.deepStrictEqual(await loadUpstreamCatalog(opts), TOOLS);
  assert.ok(fs.existsSync(path.join(root, "user-cache", CACHE_FILE)), "fell back to the per-user cache dir");
  await loadUpstreamCatalog(opts);
  assert.strictEqual(fetches(), 1, "fallback cache is read back on the next load");
});

test("loadUpstreamCatalog: no writable cache dir still returns the fetched tools", async (t) => {
  const root = tmpDir(t);
  fs.writeFileSync(path.join(root, "repo-cache"), "x");
  fs.writeFileSync(path.join(root, "user-cache"), "x");
  const logs = [];
  const { opts } = loadOpts(root, { log: (m) => logs.push(m) });
  assert.deepStrictEqual(await loadUpstreamCatalog(opts), TOOLS);
  assert.ok(logs.some((m) => /not cached/i.test(m)), `expected a "not cached" log line, got: ${logs.join(" | ")}`);
});

test("loadUpstreamCatalog: BROWSER_RELAY_CATALOG_REFRESH=true skips a valid cache and rewrites it", async (t) => {
  const root = tmpDir(t);
  const { opts, fetches } = loadOpts(root);
  await loadUpstreamCatalog(opts);
  await loadUpstreamCatalog({ ...opts, env: { BROWSER_RELAY_CATALOG_REFRESH: "true" } });
  assert.strictEqual(fetches(), 2, "refresh must re-run the upstream (smoke/setup use this to exercise it)");
  await loadUpstreamCatalog(opts);
  assert.strictEqual(fetches(), 2, "the refreshed cache is used afterwards");
});

test("loadUpstreamCatalog: fetch failure rejects and writes nothing", async (t) => {
  const root = tmpDir(t);
  const { opts } = loadOpts(root, { fetchTools: async () => { throw new Error("spawn blew up"); } });
  await assert.rejects(loadUpstreamCatalog(opts), /spawn blew up/);
  assert.ok(!fs.existsSync(path.join(root, "repo-cache", CACHE_FILE)));
});

test(".cache/ (repo catalog cache dir) is gitignored", () => {
  const gi = fs.readFileSync(path.join(REPO, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
  assert.ok(gi.includes(".cache/"), ".gitignore must list .cache/");
});

// ─── fetchUpstreamTools (throwaway spawn) ────────────────────────────────

const FAKE_UPSTREAM = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "tools/list") return;
  const seen = {
    argv: process.argv.slice(2),
    cdp: process.env.BROWSER_CDP_ENDPOINT_URL,
    telemetry: process.env.TELEMETRY_ENABLE,
    persistentDir: process.env.BROWSER_PERSISTENT_USER_DATA_DIR || null,
    persistentEnable: process.env.BROWSER_PERSISTENT_ENABLE || null,
    passthrough: process.env.TOOL_NAME_PREFIX || null,
    pid: process.pid,
  };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [
    { name: "fake_tool", description: JSON.stringify(seen), inputSchema: { type: "object" } },
  ] } }) + "\\n");
});
setInterval(() => {}, 1000); // never exits on its own — the caller must kill it
`;

test("fetchUpstreamTools: spawns with dummy CDP URL, telemetry off, persistent env stripped; kills the child", async (t) => {
  const root = tmpDir(t);
  const entry = path.join(root, "fake-upstream.js");
  fs.writeFileSync(entry, FAKE_UPSTREAM);
  let patched = 0;
  const tools = await fetchUpstreamTools({
    entry,
    env: {
      ...process.env,
      BROWSER_PERSISTENT_USER_DATA_DIR: "C:/should/not/leak",
      BROWSER_PERSISTENT_ENABLE: "true",
      TOOL_NAME_PREFIX: "pre_",
    },
    applyPatch: () => { patched++; return { patched: true, action: "already" }; },
  });
  assert.strictEqual(tools.length, 1);
  const seen = JSON.parse(tools[0].description);
  assert.deepStrictEqual(seen.argv, ["--cursor-mcp-server"]);
  assert.match(seen.cdp, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.strictEqual(seen.telemetry, "false");
  assert.strictEqual(seen.persistentDir, null);
  assert.strictEqual(seen.persistentEnable, null);
  assert.strictEqual(seen.passthrough, "pre_", "catalog-shaping env must reach the throwaway upstream");
  assert.strictEqual(patched, 1, "applies the same bundle patch the live upstream gets before listing");
  assert.strictEqual(isPidAlive(seen.pid), false, "throwaway upstream must be dead when fetch resolves");
});

test("fetchUpstreamTools: upstream that exits early rejects with a useful message", async (t) => {
  const root = tmpDir(t);
  const entry = path.join(root, "dies.js");
  fs.writeFileSync(entry, "process.stderr.write('boom from upstream'); process.exit(3);");
  await assert.rejects(
    fetchUpstreamTools({ entry, env: process.env, applyPatch: () => ({}) }),
    /catalog fetch failed.*boom from upstream/s,
  );
});

test("fetchUpstreamTools: real pinned upstream lists its catalog without a browser", { timeout: 60_000 }, async (t) => {
  let entry;
  try { entry = require.resolve("browser-devtools-mcp/dist/index.js"); }
  catch { t.skip("browser-devtools-mcp not installed"); return; }
  // applyPatch stubbed: tests never write under node_modules.
  // The developer's own catalog-shaping vars must not change what we compare.
  const env = { ...process.env };
  for (const k of ["TOOL_NAME_PREFIX", "AVAILABLE_TOOL_DOMAINS", "TOOL_INPUT_METADATA_ENABLE", "TOOL_OUTPUT_SCHEMA_DISABLE", "PLATFORM", "FIGMA_ACCESS_TOKEN"]) delete env[k];
  const tools = await fetchUpstreamTools({ entry, env, applyPatch: () => ({}) });
  const names = tools.map((x) => x.name);
  assert.ok(names.includes("navigation_go-to"), "expected navigation_go-to in upstream catalog");
  assert.ok(tools.length >= 40, `expected the full upstream catalog, got ${tools.length}`);
  // Drift guards against the REAL upstream (not a hand-kept list):
  const documented = require("../scripts/inspector-forwarded-tools.js").tools.map((x) => x.name);
  assert.deepStrictEqual([...names].sort(), [...documented].sort(),
    "scripts/inspector-forwarded-tools.js (and REFERENCE.md) must list exactly the pinned upstream's tools");
  for (const set of TOOLSET_NAMES) {
    assert.ok(names.some((n) => toolsetOf(n) === set), `toolset "${set}" matches no real upstream tool (renamed upstream?)`);
  }
});
