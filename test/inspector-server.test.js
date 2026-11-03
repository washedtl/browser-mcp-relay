// inspector-server.test.js — W7 inspector backend tests.
//
// We never bind to a fixed port (use 0 → OS picks). Pool state is fully
// stubbed via the seams object so tests don't depend on whether Brave is
// running, what dirs exist, etc.

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");

const {
  createInspector,
  buildStatus,
  buildSettings,
  buildToolsCatalog,
  defaultPort,
  defaultBind,
  redactPath,
  formatDuration,
  truncate,
  inputSchemaPreview,
  TRACKED_ENV_VARS,
} = require("../scripts/inspector.js");

// ─── Test seams: a fully stubbed config + lock state ────────────────────

function makeSeams(overrides = {}) {
  const cfg = overrides.config || {
    poolDirs: ["C:/fake/.browser-data-mcp-pool-1", "C:/fake/.browser-data-mcp-pool-2"],
    slotRoles: { "C:/fake/.browser-data-mcp-pool-2": "scrape" },
    cookieFreshnessWarnDays: 7,
    cookieSourceProfile: "C:/fake/.browser-data-mcp-2",
    bravePath: "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
    standalone: false,
  };

  const lockFilesRaw = overrides.lockFiles || {
    // slot 1 — claimed (live PID + brave running)
    "C:/fake/.browser-data-mcp-pool-1/.mcp-wrapper-lock": JSON.stringify({
      pid: 1111,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  };
  // Normalize keys so we accept either separator (the inspector path.joins on
  // Windows produces \, the test stub authors with /).
  const lockFiles = {};
  for (const [k, v] of Object.entries(lockFilesRaw)) lockFiles[k.replace(/\\/g, "/")] = v;
  const norm = (p) => String(p).replace(/\\/g, "/");
  // slot 2 — idle (no lock file)

  return {
    _loadConfig: () => ({ ...cfg }),
    _existsFile: (p) => Object.prototype.hasOwnProperty.call(lockFiles, norm(p)),
    _readFile: (p) => {
      if (lockFiles[norm(p)] != null) return lockFiles[norm(p)];
      throw new Error("ENOENT: " + p);
    },
    _statFile: (p) => {
      if (lockFiles[norm(p)] != null) return { mtimeMs: Date.now() - 60_000 };
      throw new Error("ENOENT: " + p);
    },
    _listBraveProcessesRaw: () => "1111|brave.exe --user-data-dir=C:/fake/.browser-data-mcp-pool-1 --remote-debugging-port=12345",
    _findBraveProcessesForDir: (text, dir) => {
      const needle = `--user-data-dir=${dir}`;
      const out = [];
      for (const line of text.split(/\r?\n/)) {
        const sep = line.indexOf("|");
        if (sep < 0) continue;
        if (line.includes(needle)) out.push(parseInt(line.slice(0, sep), 10));
      }
      return out;
    },
    _isPidAlive: (pid) => pid === 1111,
    _getProcessStartTimes: () => new Map(),
    _findCookiesFile: () => null,
    _checkCookieAgeDays: () => null,
    _loadVault: () => ({
      summary: () => ({
        totalEntries: 0,
        uniqueHosts: 0,
        filesLoaded: [],
        filesSkipped: [],
      }),
    }),
    _now: () => Date.now(),
    _startedAt: Date.now() - 5000,
    _ownTools: new Array(19).fill({ name: "x" }),
    _env: {},
    ...overrides.extra,
  };
}

// ─── Server helpers ─────────────────────────────────────────────────────

function startServer(seams = makeSeams()) {
  return new Promise((resolve) => {
    const server = createInspector(seams);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port, host: addr.address });
    });
  });
}

function fetch(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

// ─── Pure-helper tests ──────────────────────────────────────────────────

test("redactPath: returns basename, hides absolute parents", () => {
  assert.strictEqual(redactPath("C:/Users/fakeuser/foo/.browser-data-1"), ".browser-data-1");
  assert.strictEqual(redactPath("/home/x/.cache/y"), "y");
  assert.strictEqual(redactPath(null), null);
});

test("formatDuration: handles seconds, minutes, hours", () => {
  assert.strictEqual(formatDuration(45), "45s");
  assert.strictEqual(formatDuration(125), "2m 5s");
  assert.strictEqual(formatDuration(3725), "1h 2m");
  assert.strictEqual(formatDuration(null), null);
});

test("defaultPort: 9090 when env unset", () => {
  assert.strictEqual(defaultPort({}), 9090);
});

test("defaultPort: respects BROWSER_RELAY_INSPECTOR_PORT", () => {
  assert.strictEqual(defaultPort({ BROWSER_RELAY_INSPECTOR_PORT: "9999" }), 9999);
});

test("defaultBind: 127.0.0.1 by default (security gate)", () => {
  assert.strictEqual(defaultBind({}), "127.0.0.1");
});

test("defaultBind: respects BROWSER_RELAY_INSPECTOR_BIND override", () => {
  assert.strictEqual(defaultBind({ BROWSER_RELAY_INSPECTOR_BIND: "0.0.0.0" }), "0.0.0.0");
});

// ─── buildStatus shape tests ────────────────────────────────────────────

test("buildStatus: returns expected top-level keys", async () => {
  const status = await buildStatus(makeSeams());
  assert.ok(status.config);
  assert.ok(Array.isArray(status.slots));
  assert.ok(status.cookieSource);
  assert.ok(status.vault);
  assert.ok(status.tools);
  assert.ok(status.server);
});

test("buildStatus: claimed slot detected when lock + live PID + brave proc", async () => {
  const status = await buildStatus(makeSeams());
  const slot1 = status.slots.find((s) => s.index === 1);
  assert.strictEqual(slot1.state, "claimed");
  assert.strictEqual(slot1.pid, 1111);
  assert.strictEqual(slot1.pidAlive, true);
});

test("buildStatus: idle slot when no lock file present", async () => {
  const status = await buildStatus(makeSeams());
  const slot2 = status.slots.find((s) => s.index === 2);
  assert.strictEqual(slot2.state, "idle");
  assert.strictEqual(slot2.pid, null);
});

test("buildStatus: orphan slot when lock present but PID dead", async () => {
  const seams = makeSeams({
    lockFiles: {
      "C:/fake/.browser-data-mcp-pool-1/.mcp-wrapper-lock": JSON.stringify({
        pid: 9999, // not in our isPidAlive whitelist
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    },
  });
  const status = await buildStatus(seams);
  const slot1 = status.slots.find((s) => s.index === 1);
  assert.strictEqual(slot1.state, "orphan");
  assert.strictEqual(slot1.pidAlive, false);
});

test("buildStatus: poolDirs in config are redacted to basenames", async () => {
  const status = await buildStatus(makeSeams());
  for (const dir of status.config.poolDirs) {
    assert.ok(!dir.includes("C:/"), "absolute path leaked: " + dir);
    assert.ok(!dir.includes("\\"), "absolute path leaked: " + dir);
  }
});

test("buildStatus: bravePath is redacted to basename", async () => {
  const status = await buildStatus(makeSeams());
  assert.strictEqual(status.config.bravePath, "brave.exe");
});

test("buildStatus: tools.ownCount comes from ownTools length", async () => {
  const status = await buildStatus(makeSeams());
  assert.strictEqual(status.tools.ownCount, 19);
  assert.strictEqual(status.tools.total, 19 + 51);
});

// ─── v0.2.1: cookieSource block on buildStatus ──────────────────────────

test("buildStatus: cookieSource block exposes profile, ageDays, thresholdDays, status", async () => {
  const status = await buildStatus(makeSeams());
  const cs = status.cookieSource;
  assert.ok(cs);
  assert.ok(Object.prototype.hasOwnProperty.call(cs, "profile"));
  assert.ok(Object.prototype.hasOwnProperty.call(cs, "ageDays"));
  assert.ok(Object.prototype.hasOwnProperty.call(cs, "thresholdDays"));
  assert.ok(Object.prototype.hasOwnProperty.call(cs, "status"));
  assert.strictEqual(cs.thresholdDays, 7);
});

test("buildStatus: cookieSource.profile is path-redacted to basename", async () => {
  const seams = makeSeams({
    extra: {
      _findCookiesFile: (dir) => dir + "/Default/Network/Cookies",
      _checkCookieAgeDays: () => 2,
    },
  });
  const status = await buildStatus(seams);
  // Default seams use absolute path "C:/fake/.browser-data-mcp-2"
  assert.strictEqual(status.cookieSource.profile, ".browser-data-mcp-2");
  assert.ok(!status.cookieSource.profile.includes("C:"), "absolute path leaked");
  assert.ok(!status.cookieSource.profile.includes("/"), "path separator leaked");
});

test("buildStatus: cookieSource.status = 'fresh' when age <= threshold", async () => {
  const seams = makeSeams({
    extra: {
      _findCookiesFile: () => "/fake/cookies",
      _checkCookieAgeDays: () => 2, // < 7-day threshold
    },
  });
  const status = await buildStatus(seams);
  assert.strictEqual(status.cookieSource.status, "fresh");
  assert.strictEqual(status.cookieSource.ageDays, 2);
});

test("buildStatus: cookieSource.status = 'stale' when age > threshold", async () => {
  const seams = makeSeams({
    extra: {
      _findCookiesFile: () => "/fake/cookies",
      _checkCookieAgeDays: () => 14, // > 7-day threshold
    },
  });
  const status = await buildStatus(seams);
  assert.strictEqual(status.cookieSource.status, "stale");
  assert.strictEqual(status.cookieSource.ageDays, 14);
});

test("buildStatus: cookieSource.status = 'unknown' when profile is null", async () => {
  const seams = makeSeams({
    config: {
      poolDirs: ["C:/fake/.browser-data-mcp-pool-1"],
      slotRoles: {},
      cookieFreshnessWarnDays: 7,
      cookieSourceProfile: null,
      bravePath: null,
      standalone: false,
    },
  });
  const status = await buildStatus(seams);
  assert.strictEqual(status.cookieSource.profile, null);
  assert.strictEqual(status.cookieSource.ageDays, null);
  assert.strictEqual(status.cookieSource.status, "unknown");
});

test("buildStatus: no `specialty` block on status response (removed v0.2.1)", async () => {
  const status = await buildStatus(makeSeams());
  assert.strictEqual(status.specialty, undefined);
});

// ─── HTTP routing tests ─────────────────────────────────────────────────

test("GET /api/status → 200 with valid JSON shape", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/status");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    const body = JSON.parse(r.body);
    assert.ok(body.config);
    assert.ok(Array.isArray(body.slots));
    assert.ok(body.tools);
    assert.ok(body.server);
  } finally {
    server.close();
  }
});

test("GET /index.html → 200 text/html", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/index.html");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.ok(r.body.includes("Inspector"));
  } finally {
    server.close();
  }
});

test("GET / → serves index.html", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
  } finally {
    server.close();
  }
});

test("GET /styles.css → 200 text/css", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/styles.css");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /text\/css/);
  } finally {
    server.close();
  }
});

test("GET /app.js → 200 application/javascript", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/app.js");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /application\/javascript/);
  } finally {
    server.close();
  }
});

test("GET /favicon.ico → 204 silent", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/favicon.ico");
    assert.strictEqual(r.status, 204);
  } finally {
    server.close();
  }
});

test("GET /unknown → 404 with JSON error", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/whatever");
    assert.strictEqual(r.status, 404);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.error, "not found");
  } finally {
    server.close();
  }
});

test("POST /api/status → 405 method not allowed", async () => {
  // V1-6: must send a valid Origin header to pass the CSRF gate, otherwise
  // the request is rejected with 403 before reaching the route's method check.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/status", "POST", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.error, "method not allowed");
  } finally {
    server.close();
  }
});

test("server binds to 127.0.0.1 by default (security gate)", async () => {
  const { server, host } = await startServer();
  try {
    assert.strictEqual(host, "127.0.0.1");
  } finally {
    server.close();
  }
});

test("inspector-ui directory exists with all 3 expected files", () => {
  const ui = path.resolve(__dirname, "..", "scripts", "inspector-ui");
  assert.ok(fs.existsSync(path.join(ui, "index.html")));
  assert.ok(fs.existsSync(path.join(ui, "styles.css")));
  assert.ok(fs.existsSync(path.join(ui, "app.js")));
});

// ─── v0.2.3 regression: Settings page MCP snippet must point to src/index.js ──
// (The original W11 ship pointed at scripts/wrap-browser-devtools-mcp.js which
// doesn't exist in the public repo — friend following the snippet hit
// "Cannot find module". Fix in v0.2.2; this test prevents silent regression.)

test("Settings page MCP snippet points to src/index.js (not wrap-browser-devtools-mcp.js)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const appJsPath = path.join(__dirname, "..", "scripts", "inspector-ui", "app.js");
  const src = fs.readFileSync(appJsPath, "utf8");
  // Find the buildMcpSnippet function body and the args line within it.
  const idx = src.indexOf("buildMcpSnippet");
  assert.ok(idx >= 0, "buildMcpSnippet function must exist in app.js");
  const slice = src.slice(idx, idx + 600);
  assert.match(
    slice,
    /args:\s*\[\s*"<absolute-path-to-repo>\/src\/index\.js"\s*\]/,
    "MCP snippet args must point to src/index.js",
  );
  assert.doesNotMatch(
    slice,
    /wrap-browser-devtools-mcp\.js/,
    "MCP snippet must NOT reference wrap-browser-devtools-mcp.js (file not in public repo)",
  );
});

// ─── W8: buildSettings shape + redaction tests ──────────────────────────

function makeSettingsSeams(overrides = {}) {
  const base = makeSeams();
  return {
    ...base,
    _detectBraveProfileDir: ({ env } = {}) =>
      "C:/Users/fakeuser/AppData/Local/BraveSoftware/Brave-Browser/User Data",
    _existsFile: () => false, // local-config absent by default
    _env: {},
    ...overrides,
  };
}

test("buildSettings: returns expected top-level shape", () => {
  const s = buildSettings(makeSettingsSeams());
  assert.ok(s.config);
  assert.ok(s.env);
  assert.strictEqual(typeof s.localConfigExists, "boolean");
  assert.strictEqual(typeof s.localConfigSnippet, "string");
  assert.strictEqual(typeof s.localConfigExamplePath, "string");
});

test("buildSettings: paths are redacted to basenames (no C:/ leak)", () => {
  const s = buildSettings(makeSettingsSeams());
  // Walk the entire response body — no full Windows path may appear.
  const blob = JSON.stringify(s);
  assert.ok(!/C:\\/.test(blob), "absolute Win path leaked: " + blob);
  assert.ok(!/C:\//.test(blob), "absolute forward Win path leaked: " + blob);
  assert.ok(!blob.includes("/Users/fakeuser/"), "POSIX absolute leaked: " + blob);
  assert.ok(!blob.includes("/fake/"), "POSIX absolute leaked: " + blob);
});

test("buildSettings: env unset → all booleans false", () => {
  const s = buildSettings(makeSettingsSeams({ _env: {} }));
  for (const k of TRACKED_ENV_VARS) {
    assert.strictEqual(s.env[k], false, k + " should be false when unset");
  }
});

test("buildSettings: env set → matching boolean is true (value not leaked)", () => {
  const s = buildSettings(
    makeSettingsSeams({
      _env: {
        BROWSER_RELAY_BRAVE_PATH: "C:/secret/path/brave.exe",
        BROWSER_RELAY_VAULT_FILES: "C:/secret/passwords.csv",
      },
    }),
  );
  assert.strictEqual(s.env.BROWSER_RELAY_BRAVE_PATH, true);
  assert.strictEqual(s.env.BROWSER_RELAY_VAULT_FILES, true);
  assert.strictEqual(s.env.BROWSER_RELAY_POOL_DIR, false);
  // Crucially: the value strings must not appear anywhere in the response.
  const blob = JSON.stringify(s);
  assert.ok(!blob.includes("secret"), "env value leaked into response: " + blob);
});

test("buildSettings: localConfigExists reflects _existsFile result", () => {
  const present = buildSettings(makeSettingsSeams({ _existsFile: () => true }));
  const absent = buildSettings(makeSettingsSeams({ _existsFile: () => false }));
  assert.strictEqual(present.localConfigExists, true);
  assert.strictEqual(absent.localConfigExists, false);
});

test("buildSettings: localConfigSnippet is valid JSON", () => {
  const s = buildSettings(makeSettingsSeams());
  // Should round-trip through JSON.parse without throwing.
  const parsed = JSON.parse(s.localConfigSnippet);
  assert.ok(parsed && typeof parsed === "object");
  assert.ok(Object.prototype.hasOwnProperty.call(parsed, "BROWSER_RELAY_BRAVE_PATH"));
});

// ─── W8: HTTP routing tests ─────────────────────────────────────────────

test("GET /api/settings → 200 with valid shape", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/settings");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    const body = JSON.parse(r.body);
    assert.ok(body.config);
    assert.ok(body.env);
    assert.strictEqual(typeof body.localConfigExists, "boolean");
  } finally {
    server.close();
  }
});

test("GET /api/specialty → 404 (endpoint removed v0.2.1)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/specialty");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("GET /settings → 200 serves index.html", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/settings");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.ok(r.body.includes("Inspector"));
  } finally {
    server.close();
  }
});

test("GET /specialty → 404 (page removed v0.2.1)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/specialty");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/settings → 405 method not allowed (no mutating endpoints in W8)", async () => {
  // V1-6: send Origin to pass CSRF gate so we test the method check.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/settings", "POST", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

test("/api/settings response never contains absolute paths", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/settings");
    assert.strictEqual(r.status, 200);
    // Default seam uses C:/fake/... and C:/Program Files/... — neither
    // should leak into the wire payload after redaction.
    assert.ok(!/C:\\/.test(r.body), "Win backslash path leaked: " + r.body);
    assert.ok(!/C:\/fake/.test(r.body), "Win forward path leaked: " + r.body);
    assert.ok(!r.body.includes("Program Files"), "Program Files leaked: " + r.body);
  } finally {
    server.close();
  }
});

// ─── W9: Tools catalog tests ───────────────────────────────────────────

test("truncate: returns short text unchanged, long text gets ellipsis", () => {
  assert.strictEqual(truncate("hi", 10), "hi");
  assert.strictEqual(truncate("", 10), "");
  const long = "x".repeat(220);
  const out = truncate(long, 200);
  assert.strictEqual(out.length, 200);
  assert.ok(out.endsWith("…"));
});

test("inputSchemaPreview: returns empty for missing/empty schemas", () => {
  assert.strictEqual(inputSchemaPreview(undefined), "");
  assert.strictEqual(inputSchemaPreview({}), "");
  assert.strictEqual(inputSchemaPreview({ type: "object", properties: {} }), "");
});

test("inputSchemaPreview: returns comma-separated top-level field names", () => {
  const s = inputSchemaPreview({
    type: "object",
    properties: { url: {}, formFactor: {}, onlyCategories: {} },
  });
  assert.strictEqual(s, "url, formFactor, onlyCategories");
});

test("buildToolsCatalog: total = own + forwarded = 72 (21 + 51)", () => {
  // Updated 2026-05-09: added storage_get-local / storage_set-local /
  // storage_clear-local own-tools (auth tokens for Discord/Notion/etc live
  // in localStorage, not HTTP cookies). 16 → 19 own-tools.
  // Updated 2026-11-03 (W1B): + toolsets (hidden-toolset control). 19 → 20.
  // Updated 2026-11-03 (W2D): + browser_show (window on-screen). 20 → 21.
  const c = buildToolsCatalog();
  assert.strictEqual(c.total, 72);
  assert.strictEqual(c.ownCount, 21);
  assert.strictEqual(c.forwardedCount, 51);
  assert.ok(Array.isArray(c.own));
  assert.ok(Array.isArray(c.forwarded));
  assert.strictEqual(c.own.length, 21);
  assert.strictEqual(c.forwarded.length, 51);
});

test("buildToolsCatalog: each own-tool entry has required fields + valid category", () => {
  const c = buildToolsCatalog();
  const ownCategories = new Set([
    "performance", "device", "tabs", "forms",
    "network", "session", "downloads", "data",
  ]);
  for (const t of c.own) {
    assert.strictEqual(typeof t.name, "string");
    assert.ok(t.name.length > 0);
    assert.strictEqual(typeof t.description, "string");
    assert.ok(t.description.length <= 200, t.name + " description > 200 chars");
    assert.strictEqual(typeof t.sourceFile, "string");
    assert.ok(t.sourceFile.endsWith(".js"), t.name + " sourceFile not .js");
    assert.ok(ownCategories.has(t.category), t.name + " has bad category " + t.category);
    assert.strictEqual(typeof t.inputSchemaPreview, "string");
  }
});

test("buildToolsCatalog: each forwarded entry has name + description + category + upstreamSource", () => {
  const c = buildToolsCatalog();
  const fwdCategories = new Set([
    "accessibility", "content", "debug", "interaction", "navigation",
    "observability", "react", "stub", "scenario", "execute", "sync",
  ]);
  for (const t of c.forwarded) {
    assert.strictEqual(typeof t.name, "string");
    assert.ok(t.name.length > 0);
    assert.strictEqual(typeof t.description, "string");
    assert.ok(t.description.length > 0);
    assert.strictEqual(t.upstreamSource, "browser-devtools-mcp");
    assert.ok(fwdCategories.has(t.category), t.name + " has bad category " + t.category);
  }
});

test("buildToolsCatalog: seam test — mocked own-tools registry produces matching shape", () => {
  const fakeRegistry = [
    {
      name: "tabs_list",
      description: "Stub description",
      inputSchema: { type: "object", properties: { idx: {} } },
    },
    {
      name: "made_up_tool",
      description: "Not in OWN_TOOL_META",
      inputSchema: { type: "object", properties: {} },
    },
  ];
  const c = buildToolsCatalog({ _ownTools: fakeRegistry });
  assert.strictEqual(c.ownCount, 2);
  assert.strictEqual(c.forwardedCount, 51);
  assert.strictEqual(c.total, 53);
  // Known entry: pulls sourceFile + category from OWN_TOOL_META.
  const known = c.own.find((t) => t.name === "tabs_list");
  assert.strictEqual(known.sourceFile, "tabs-list.js");
  assert.strictEqual(known.category, "tabs");
  assert.strictEqual(known.inputSchemaPreview, "idx");
  // Unknown entry: falls back to <name>.js + "data" category.
  const unknown = c.own.find((t) => t.name === "made_up_tool");
  assert.strictEqual(unknown.sourceFile, "made_up_tool.js");
  assert.strictEqual(unknown.category, "data");
  assert.strictEqual(unknown.inputSchemaPreview, "");
});

test("GET /api/tools → 200 with valid shape", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/tools");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /application\/json/);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.total, 70);
    assert.strictEqual(body.ownCount, 19);
    assert.strictEqual(body.forwardedCount, 51);
    assert.strictEqual(body.own.length, 19);
    assert.strictEqual(body.forwarded.length, 51);
  } finally {
    server.close();
  }
});

test("GET /tools → 200 serves index.html", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/tools");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.ok(r.body.includes("Inspector"));
  } finally {
    server.close();
  }
});

test("/api/tools response never leaks absolute paths (sourceFile basename only)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/tools");
    assert.strictEqual(r.status, 200);
    assert.ok(!/C:\\/.test(r.body), "Win backslash path leaked: " + r.body);
    assert.ok(!/[A-Z]:\//.test(r.body), "Win forward absolute path leaked: " + r.body);
    // POSIX absolute under common roots — should also not appear.
    assert.ok(!/"sourceFile":"\//.test(r.body), "POSIX absolute sourceFile leaked: " + r.body);
  } finally {
    server.close();
  }
});

test("POST /api/tools → 405 method not allowed (read-only in W9)", async () => {
  // V1-6: send Origin to pass CSRF gate.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/tools", "POST", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

// ─── W10: startInspector + slot detail + WebSocket tests ───────────────

const { EventEmitter } = require("node:events");
const WebSocket = require("ws");
const { startInspector, buildSlotDetail } = require("../src/inspector-server.js");

// Helper: small TrafficEmitter clone for tests, matching the API the
// Inspector reads (on/off + getRecent).
function makeTestEmitter() {
  const ee = new EventEmitter();
  ee.setMaxListeners(50);
  ee._ring = [];
  ee.push = (evt) => { ee._ring.push(evt); if (ee._ring.length > 200) ee._ring.shift(); };
  ee.getRecent = () => ee._ring.slice();
  return ee;
}

test("startInspector: boots on port 0 + can close", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1" });
  try {
    assert.ok(handle.server);
    assert.ok(handle.port > 0);
    assert.strictEqual(handle.bind, "127.0.0.1");
    assert.strictEqual(typeof handle.close, "function");
  } finally {
    await handle.close();
  }
});

test("startInspector: standalone mode → /api/slot/:n has empty recentTraffic", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    const r = await fetch(handle.port, "/api/slot/1");
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.deepStrictEqual(body.recentTraffic, []);
  } finally {
    await handle.close();
  }
});

test("startInspector: in-process mode → /api/slot/:n surfaces buffered traffic", async () => {
  const ee = makeTestEmitter();
  ee.push({ id: 1, time: new Date().toISOString(), method: "tools/call", name: "capture_xhr", args: { foo: 1 }, source: "own" });
  ee.push({ id: 1, time: new Date().toISOString(), status: "ok", durationMs: 42, response: { content: [] } });

  const handle = await startInspector({
    port: 0, bind: "127.0.0.1",
    seams: makeSeams(),
    trafficEmitter: ee,
    getRecent: () => ee.getRecent(),
  });
  try {
    const r = await fetch(handle.port, "/api/slot/1");
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.recentTraffic.length, 2);
    assert.strictEqual(body.recentTraffic[0].name, "capture_xhr");
  } finally {
    await handle.close();
  }
});

test("buildSlotDetail: returns null for out-of-range index", async () => {
  const detail = await buildSlotDetail(99, makeSeams());
  assert.strictEqual(detail, null);
});

test("buildSlotDetail: returns slot + totalSlots for valid n", async () => {
  const detail = await buildSlotDetail(2, makeSeams());
  assert.ok(detail.slot);
  assert.strictEqual(detail.slot.index, 2);
  assert.strictEqual(detail.totalSlots, 2);
  assert.ok(Array.isArray(detail.recentTraffic));
});

test("GET /api/slot/3 → 404 (out of range with 2-slot pool)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/slot/3");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("GET /api/slot/0 → 404 (slots are 1-indexed)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/slot/0");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("GET /api/slot/abc → 404 (not an integer)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/slot/abc");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("GET /api/slot/1 → 200 with slot + recentTraffic shape", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/slot/1");
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(body.slot);
    assert.strictEqual(body.slot.index, 1);
    assert.ok(Array.isArray(body.recentTraffic));
    assert.strictEqual(typeof body.totalSlots, "number");
  } finally {
    server.close();
  }
});

test("GET /slot/3 → 200 (SPA — frontend handles invalid n)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/slot/3");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.ok(r.body.includes("Inspector"));
  } finally {
    server.close();
  }
});

test("GET /slot/1 → 200 (SPA, normal slot)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/slot/1");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
  } finally {
    server.close();
  }
});

// ─── WebSocket /ws/traffic tests ───────────────────────────────────────

function awaitMessage(ws, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    const onMsg = (data) => {
      try {
        const obj = JSON.parse(data.toString("utf8"));
        if (!predicate || predicate(obj)) {
          clearTimeout(t);
          ws.off("message", onMsg);
          resolve(obj);
        }
      } catch (e) { /* ignore */ }
    };
    ws.on("message", onMsg);
  });
}

function awaitClose(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for close")), timeoutMs);
    ws.once("close", () => { clearTimeout(t); resolve(); });
  });
}

test("WS /ws/traffic standalone mode → no-emitter then close", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    const ws = new WebSocket("ws://127.0.0.1:" + handle.port + "/ws/traffic");
    const msg = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no message")), 2000);
      ws.on("message", (data) => { clearTimeout(t); resolve(JSON.parse(data.toString("utf8"))); });
      ws.on("error", (e) => { clearTimeout(t); reject(e); });
    });
    assert.strictEqual(msg.type, "no-emitter");
    assert.match(msg.message, /BROWSER_RELAY_INSPECTOR_PORT/);
    await awaitClose(ws);
  } finally {
    await handle.close();
  }
});

test("WS /ws/traffic in-process mode → backfill then live request/response", async () => {
  const ee = makeTestEmitter();
  // Pre-seed one event for backfill verification.
  ee.push({ id: 7, time: new Date().toISOString(), method: "tools/call", name: "tabs_list", args: {}, source: "own" });

  const handle = await startInspector({
    port: 0, bind: "127.0.0.1", seams: makeSeams(),
    trafficEmitter: ee,
    getRecent: () => ee.getRecent(),
  });
  try {
    // Collect every message into a queue so we don't race the server's
    // immediate backfill-on-open send against our listener registration.
    const ws = new WebSocket("ws://127.0.0.1:" + handle.port + "/ws/traffic");
    const queue = [];
    let resolveNext = null;
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString("utf8"));
      queue.push(msg);
      if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
    });
    function nextMatching(predicate, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        const tryNow = () => {
          const idx = queue.findIndex(predicate);
          if (idx >= 0) {
            clearTimeout(t);
            const found = queue.splice(idx, 1)[0];
            resolve(found);
            return true;
          }
          return false;
        };
        if (tryNow()) return;
        const onArrive = () => { if (!tryNow()) resolveNext = onArrive; };
        resolveNext = onArrive;
      });
    }

    const backfill = await nextMatching((m) => m.type === "backfill");
    assert.ok(Array.isArray(backfill.events));
    assert.strictEqual(backfill.events.length, 1);
    assert.strictEqual(backfill.events[0].name, "tabs_list");

    const liveRequest = { id: 8, time: new Date().toISOString(), method: "tools/call", name: "lighthouse_audit", args: { url: "https://example.com" }, source: "own" };
    const liveP = nextMatching((m) => m.type === "request" && m.id === 8);
    ee.emit("request", liveRequest);
    const live = await liveP;
    assert.strictEqual(live.name, "lighthouse_audit");

    ws.close();
    await awaitClose(ws);
  } finally {
    await handle.close();
  }
});

test("WS /ws/traffic non-/ws/traffic upgrade is rejected", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    const ws = new WebSocket("ws://127.0.0.1:" + handle.port + "/ws/wrong-path");
    await new Promise((resolve) => {
      // Either error or close fires — both prove the server didn't accept us.
      ws.on("error", () => resolve());
      ws.on("close", () => resolve());
      setTimeout(resolve, 1500);
    });
    assert.notStrictEqual(ws.readyState, ws.OPEN);
  } finally {
    await handle.close();
  }
});

// ─── W10 V1 fixes: Origin allowlist + back-pressure ─────────────────

test("WS upgrade rejects hostile Origin (cross-origin protection)", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    // ws lib lets us set arbitrary Origin via options.
    const ws = new WebSocket(
      "ws://127.0.0.1:" + handle.port + "/ws/traffic",
      { origin: "http://evil.example.com" },
    );
    const result = await new Promise((resolve) => {
      ws.on("error", () => resolve("error"));
      ws.on("close", () => resolve("close"));
      ws.on("open", () => resolve("open"));
      setTimeout(() => resolve("timeout"), 1500);
    });
    assert.notStrictEqual(result, "open", "evil-origin must NOT open");
    assert.notStrictEqual(ws.readyState, ws.OPEN);
  } finally {
    await handle.close();
  }
});

test("WS upgrade allows http://localhost Origin", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    const ws = new WebSocket(
      "ws://127.0.0.1:" + handle.port + "/ws/traffic",
      { origin: "http://localhost:" + handle.port },
    );
    const result = await new Promise((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      setTimeout(() => resolve("timeout"), 1500);
    });
    assert.strictEqual(result, "open", "localhost origin must connect");
    ws.close();
  } finally {
    await handle.close();
  }
});

test("WS upgrade allows http://127.0.0.1 Origin", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    const ws = new WebSocket(
      "ws://127.0.0.1:" + handle.port + "/ws/traffic",
      { origin: "http://127.0.0.1:" + handle.port },
    );
    const result = await new Promise((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      setTimeout(() => resolve("timeout"), 1500);
    });
    assert.strictEqual(result, "open", "127.0.0.1 origin must connect");
    ws.close();
  } finally {
    await handle.close();
  }
});

test("WS upgrade allows missing Origin (non-browser client)", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    // Don't set origin option → ws lib omits the header for native clients.
    const ws = new WebSocket("ws://127.0.0.1:" + handle.port + "/ws/traffic");
    const result = await new Promise((resolve) => {
      ws.on("open", () => resolve("open"));
      ws.on("error", () => resolve("error"));
      setTimeout(() => resolve("timeout"), 1500);
    });
    assert.strictEqual(result, "open", "missing Origin must connect");
    ws.close();
  } finally {
    await handle.close();
  }
});

test("WS upgrade allowedOrigins option overrides default allowlist", async () => {
  const handle = await startInspector({
    port: 0,
    bind: "127.0.0.1",
    seams: makeSeams(),
    allowedOrigins: ["http://my-custom-host:8080"],
  });
  try {
    const wsAllowed = new WebSocket(
      "ws://127.0.0.1:" + handle.port + "/ws/traffic",
      { origin: "http://my-custom-host:8080" },
    );
    const wsRejected = new WebSocket(
      "ws://127.0.0.1:" + handle.port + "/ws/traffic",
      { origin: "http://localhost:" + handle.port },
    );
    const allowedResult = await new Promise((resolve) => {
      wsAllowed.on("open", () => resolve("open"));
      wsAllowed.on("error", () => resolve("error"));
      setTimeout(() => resolve("timeout"), 1500);
    });
    const rejectedResult = await new Promise((resolve) => {
      wsRejected.on("open", () => resolve("open"));
      wsRejected.on("error", () => resolve("error"));
      wsRejected.on("close", () => resolve("close"));
      setTimeout(() => resolve("timeout"), 1500);
    });
    assert.strictEqual(allowedResult, "open", "custom-host origin allowed");
    assert.notStrictEqual(rejectedResult, "open", "default localhost rejected when custom allowlist set");
    try { wsAllowed.close(); } catch { /* noop */ }
    try { wsRejected.close(); } catch { /* noop */ }
  } finally {
    await handle.close();
  }
});

// ─── W11: V2 polish — path traversal, method enforcement, headers ───

test("GET /../package.json → 404 (path traversal blocked)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/../package.json");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("GET /styles.css/../inspector.js → 404 (path traversal blocked)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/styles.css/../inspector.js");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("GET /%2e%2e/foo → 404 (encoded path traversal blocked)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/%2e%2e/foo");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("PUT /api/status → 405 (read-only method enforcement)", async () => {
  // V1-6: include Origin so the CSRF gate doesn't 403 first.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/status", "PUT", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

test("DELETE /api/status → 405", async () => {
  // V1-6: include Origin to pass CSRF gate.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/status", "DELETE", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

test("PATCH /api/status → 405", async () => {
  // V1-6: include Origin to pass CSRF gate.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/status", "PATCH", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

test("OPTIONS /api/status → 405 (we don't honor CORS preflight)", async () => {
  // V1-6: include Origin to pass CSRF gate so we test method enforcement.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/status", "OPTIONS", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

test("All responses include X-Frame-Options: DENY (clickjacking gate)", async () => {
  const { server, port } = await startServer();
  try {
    for (const p of ["/api/status", "/", "/styles.css", "/notfound"]) {
      const r = await fetch(port, p);
      assert.strictEqual(r.headers["x-frame-options"], "DENY", p + " missing X-Frame-Options");
      assert.match(r.headers["content-security-policy"] || "", /frame-ancestors 'none'/, p + " CSP missing");
    }
  } finally {
    server.close();
  }
});

test("Cache-Control: no-store on /api/* responses", async () => {
  const { server, port } = await startServer();
  try {
    for (const p of ["/api/status", "/api/settings", "/api/tools", "/api/slot/1"]) {
      const r = await fetch(port, p);
      assert.match(r.headers["cache-control"] || "", /no-store/, p + " missing no-store");
    }
  } finally {
    server.close();
  }
});

test("redactErrorPaths: redacts Win absolute paths inside an error message", () => {
  const { redactErrorPaths } = require("../scripts/inspector.js");
  const out = redactErrorPaths(
    "tried C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe — not found",
  );
  assert.ok(!out.includes("Program Files"), "absolute path leaked: " + out);
  assert.ok(out.includes("brave.exe"));
});

test("redactErrorPaths: redacts POSIX absolute paths", () => {
  const { redactErrorPaths } = require("../scripts/inspector.js");
  const out = redactErrorPaths("could not access /home/me/.config/brave-something");
  assert.ok(!out.includes("/home/me"), "POSIX path leaked: " + out);
  assert.ok(out.includes("brave-something"));
});

test("buildStatus: braveDetectError is redacted (no full path leak)", async () => {
  const seams = makeSeams({
    config: {
      poolDirs: ["C:/fake/.browser-data-mcp-pool-1"],
      slotRoles: {},
      cookieFreshnessWarnDays: 7,
      cookieSourceProfile: null,
      bravePath: null,
      braveDetectError: new Error(
        "tried C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
      ),
      standalone: true,
    },
  });
  const status = await buildStatus(seams);
  const detect = status.config.braveDetectError;
  assert.ok(detect, "braveDetectError should pass through");
  assert.ok(!detect.includes("Program Files"), "braveDetectError leaked path: " + detect);
  assert.ok(detect.includes("brave.exe"));
});

// ─── W11: Activity endpoint ─────────────────────────────────────────

test("GET /api/activity → 200 with empty events when no traffic buffer", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/activity");
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.events));
    assert.strictEqual(body.events.length, 0);
    assert.strictEqual(body.totalCaptured, 0);
  } finally {
    server.close();
  }
});

test("GET /api/activity → returns ring-buffer events when in-process", async () => {
  const ee = makeTestEmitter();
  ee.push({ id: 1, time: new Date().toISOString(), method: "tools/call", name: "tabs_list", args: {}, source: "own" });
  ee.push({ id: 1, time: new Date().toISOString(), status: "ok", durationMs: 12, response: { content: [] } });
  const handle = await startInspector({
    port: 0, bind: "127.0.0.1",
    seams: makeSeams(),
    trafficEmitter: ee,
    getRecent: () => ee.getRecent(),
  });
  try {
    const r = await fetch(handle.port, "/api/activity");
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.events.length, 2);
    assert.strictEqual(body.totalCaptured, 2);
    assert.strictEqual(body.events[0].name, "tabs_list");
  } finally {
    await handle.close();
  }
});

test("GET /activity → 200 serves index.html (SPA route)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/activity");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.ok(r.body.includes("Inspector"));
  } finally {
    server.close();
  }
});

test("POST /api/activity → 405 (read-only)", async () => {
  // V1-6: send Origin to pass CSRF gate.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/activity", "POST", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

// ─── W11: Mutating endpoints + Origin gating ────────────────────────

const { createInspector: createInspectorRaw } = require("../src/inspector-server.js");

function fetchWithHeaders(port, path, method, headers, body) {
  headers = headers || {};
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("POST /api/slots/1/reap with hostile Origin → 403", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", {
      Origin: "http://evil.example.com",
    });
    assert.strictEqual(r.status, 403);
  } finally {
    server.close();
  }
});

test("V1-6: POST /api/slots/1/reap with NO Origin → 403 missing origin (CSRF defense)", async () => {
  // V1-6 contract change: previously a missing Origin header was treated as
  // "trusted" (curl path) and the request fell through to the route. CSRF
  // defense now requires Origin to be PRESENT and allowed for any mutating
  // method. CLI clients can still call read-only GETs without an Origin.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", {});
    assert.strictEqual(r.status, 403, "expected 403 when Origin header is absent on POST");
    const body = JSON.parse(r.body);
    assert.match(body.error || "", /missing origin/i);
  } finally {
    server.close();
  }
});

test("V1-6: GET /api/status with NO Origin still works (read-only, no CSRF impact)", async () => {
  // Confirm we didn't break the curl path for GETs — Origin is only required
  // on mutating methods.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/status", "GET", {});
    assert.strictEqual(r.status, 200);
  } finally {
    server.close();
  }
});

test("POST /api/slots/1/reap on a non-orphan slot → 400", async () => {
  // Default seams: slot 1 is claimed. Reaping should refuse with 400.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", {
      Origin: "http://localhost:" + port,
    });
    assert.strictEqual(r.status, 400);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.ok, false);
    assert.match(body.message || "", /not orphan/);
  } finally {
    server.close();
  }
});

test("POST /api/slots/2/reap on orphan slot → 200 with reaped:true (mutator seam)", async () => {
  // Set up a seam where slot 2 is orphan (lock present, PID dead).
  const orphanSeams = makeSeams({
    lockFiles: {
      "C:/fake/.browser-data-mcp-pool-2/.mcp-wrapper-lock": JSON.stringify({
        pid: 9999, // not alive
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    },
  });
  let mutatorCalled = false;
  let mutatorArg = null;
  const server = createInspectorRaw({
    seams: orphanSeams,
    mutators: {
      reapSlot: (dir, n) => {
        mutatorCalled = true;
        mutatorArg = { dir, n };
        return 1;
      },
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const r = await fetchWithHeaders(port, "/api/slots/2/reap", "POST", {
      Origin: "http://localhost:" + port,
    });
    assert.strictEqual(r.status, 200);
    const body = JSON.parse(r.body);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.reaped, true);
    assert.match(body.message || "", /Reaped/);
    assert.strictEqual(mutatorCalled, true);
    assert.strictEqual(mutatorArg.n, 2);
    // The dir we passed to the mutator must be the absolute pool dir, NOT
    // the redacted basename — the mutator needs the real path to act.
    assert.ok(mutatorArg.dir.includes("/fake/"), "mutator must receive abs path: " + mutatorArg.dir);
  } finally {
    server.close();
  }
});

test("POST /api/slots/99/reap → 404 (out of range)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/slots/99/reap", "POST", {
      Origin: "http://localhost:" + port,
    });
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("GET /api/slots/1/reap → 405 (POST only)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/slots/1/reap");
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

test("GET /api/specialty/mcp-2/refresh-hint → 404 (endpoint removed v0.2.1)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/specialty/mcp-2/refresh-hint");
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/specialty/mcp-2/refresh-hint → 405 (no longer a mutating route)", async () => {
  // Falls through to the post-mutating-route gate, which 405s any non-GET
  // for unrecognized paths. Confirms the route was removed (formerly 200).
  // V1-6: pass an Origin header so the CSRF gate doesn't intercept first.
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/specialty/mcp-2/refresh-hint", "POST", { Origin: "http://localhost:" + port });
    assert.strictEqual(r.status, 405);
  } finally {
    server.close();
  }
});

test("POST /api/slots/abc/reap → 404 (slot index validation)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/slots/abc/reap", "POST", {
      Origin: "http://localhost:" + port,
    });
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("POST /api/slots/0/reap → 404 (slots are 1-indexed)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/slots/0/reap", "POST", {
      Origin: "http://localhost:" + port,
    });
    assert.strictEqual(r.status, 404);
  } finally {
    server.close();
  }
});

test("buildActivity: returns events from _trafficBuffer seam", () => {
  const { buildActivity } = require("../src/inspector-server.js");
  const buf = [
    { id: 1, time: new Date().toISOString(), method: "tools/call", name: "x" },
    { id: 1, time: new Date().toISOString(), status: "ok" },
  ];
  const out = buildActivity({ _trafficBuffer: buf });
  assert.strictEqual(out.events.length, 2);
  assert.strictEqual(out.totalCaptured, 2);
});

test("forwardedCount matches the actual hardcoded catalog length (drift guard)", async () => {
  const forwarded = require("../scripts/inspector-forwarded-tools.js");
  const catalogLen = (forwarded.tools || []).length;
  // The status response hardcodes forwardedCount: 51. If upstream gets a tool added
  // and the catalog list is updated but not the constant, this test catches it.
  // If both stay in sync, this passes.
  // V2-6: previously this fixture passed `mode: "standalone"` (string) — production
  // reads `cfg.standalone` (boolean), so the field was ignored and "standalone"
  // would resolve to "pool" by accident. Use the production shape.
  const status = await buildStatus({
    _loadConfig: () => ({ poolDirs: [], slotRoles: {}, cookieFreshnessWarnDays: 7, standalone: true }),
    _findCookiesFile: () => null,
    _checkCookieAgeDays: () => null,
    _existsFile: () => false,
    _now: () => Date.now(),
    _startedAt: Date.now(),
    _ownTools: [],
    _listBraveProcessesRaw: () => "",
    _getProcessStartTimes: () => new Map(),
    _isPidAlive: () => false,
    _loadVault: () => ({ summary: () => ({ totalEntries: 0, uniqueHosts: 0, filesLoaded: [], filesSkipped: [] }) }),
  });
  // V2-6: drift guard for the boolean cfg.standalone contract. Previously
  // the fixture passed `mode: "standalone"` (string) which prod ignored —
  // boolean form is what loadConfig() actually returns. The mode lives at
  // status.config.mode (and cookieSource.mode) on the response shape.
  assert.strictEqual(status.config.mode, "standalone", "buildStatus must read cfg.standalone (boolean) and emit config.mode='standalone' when true");
  assert.strictEqual(
    status.tools.forwardedCount,
    catalogLen,
    "buildStatus.tools.forwardedCount must equal the catalog length — update the constant when adding a forwarded tool",
  );
});

// F1-6 (2026-05-10): inspector-forwarded-tools.js shape + duplicate-name guard.
// The catalog is hand-maintained; a missing field or accidentally-pasted-twice
// entry would silently render with broken UI. Catch at test time instead.
test("inspector-forwarded-tools: every entry has name+description+category", () => {
  const forwarded = require("../scripts/inspector-forwarded-tools.js");
  assert.ok(Array.isArray(forwarded.tools), "tools must be an array");
  assert.ok(typeof forwarded.upstreamSource === "string" && forwarded.upstreamSource.length > 0,
    "upstreamSource must be a non-empty string");
  assert.ok(typeof forwarded.upstreamRepoUrl === "string" && /^https?:\/\//.test(forwarded.upstreamRepoUrl),
    "upstreamRepoUrl must be a real http(s) URL");
  for (let i = 0; i < forwarded.tools.length; i++) {
    const t = forwarded.tools[i];
    assert.ok(t && typeof t === "object" && !Array.isArray(t),
      `tools[${i}] must be a plain object`);
    assert.ok(typeof t.name === "string" && t.name.length > 0,
      `tools[${i}].name must be a non-empty string (got ${JSON.stringify(t.name)})`);
    assert.ok(typeof t.description === "string" && t.description.length > 0,
      `tools[${i}].description must be a non-empty string (entry: ${t.name})`);
    assert.ok(typeof t.category === "string" && t.category.length > 0,
      `tools[${i}].category must be a non-empty string (entry: ${t.name})`);
    // Categories should be lowercase identifier-ish — drift signal if a
    // refactor introduces "Accessibility" vs "accessibility" inconsistency.
    assert.match(t.category, /^[a-z][a-z0-9_-]*$/,
      `tools[${i}].category should be lowercase identifier-ish (entry: ${t.name}, got ${t.category})`);
  }
});

test("inspector-forwarded-tools: no duplicate names", () => {
  const forwarded = require("../scripts/inspector-forwarded-tools.js");
  const seen = new Set();
  const dupes = [];
  for (const t of forwarded.tools) {
    if (seen.has(t.name)) dupes.push(t.name);
    else seen.add(t.name);
  }
  assert.deepStrictEqual(dupes, [], `forwarded tool names must be unique; duplicates: ${dupes.join(", ")}`);
});

test("inspector-forwarded-tools: names match upstream prefix → category mapping", () => {
  // Catch the failure mode where an entry's category doesn't match its name
  // prefix — e.g. an `interaction_*` tool tagged `category: "navigation"`.
  const forwarded = require("../scripts/inspector-forwarded-tools.js");
  // upstream prefix → expected category. If a new prefix is added, extend this map.
  const expected = {
    a11y: "accessibility",
    content: "content",
    debug: "debug",
    interaction: "interaction",
    navigation: "navigation",
    o11y: "observability",
    react: "react",
    "scenario-add": "scenario",
    "scenario-delete": "scenario",
    "scenario-list": "scenario",
    "scenario-run": "scenario",
    "scenario-search": "scenario",
    "scenario-update": "scenario",
    stub: "stub",
    sync: "sync",
    execute: "execute",
  };
  for (const t of forwarded.tools) {
    // Strip "<prefix>_<rest>" or use the full token as prefix (e.g. "execute").
    const prefix = t.name.includes("_") ? t.name.slice(0, t.name.indexOf("_")) : t.name;
    const want = expected[prefix];
    if (!want) continue; // unknown prefix — drift will show up if the catalog grows a new prefix family
    assert.strictEqual(t.category, want,
      `tool "${t.name}" has prefix "${prefix}" → expected category "${want}", got "${t.category}"`);
  }
});

// ─── W1E-1 (2026-11-03): Host allowlist (DNS rebinding) + exact Origin ──
//
// Audit probe: `GET /api/activity` with `Host: rebind.attacker.example:9091`
// returned 200 + traffic. A rebinding page's requests carry the attacker's
// hostname in Host, so only the inspector's own loopback names (on the port
// the connection actually arrived on) are accepted. Origin used to be any
// `http://localhost:*` (a POST from a :5173 dev server passed); it must now
// be the inspector's own origin.

function rawRequest(port, path, { method = "GET", headers = {}, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, headers, setHost },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function wsOutcome(ws, timeoutMs = 1500) {
  return new Promise((resolve) => {
    ws.on("open", () => resolve("open"));
    ws.on("error", () => resolve("error"));
    ws.on("close", () => resolve("close"));
    setTimeout(() => resolve("timeout"), timeoutMs);
  });
}

test("W1E-1: GET /api/activity with a rebinding Host → 403, no traffic leaked", async () => {
  const ee = makeTestEmitter();
  ee.push({ id: 1, time: new Date().toISOString(), method: "tools/call", name: "cookies_export", args: { secret: "s3cret-cookie" }, source: "own" });
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams(), trafficEmitter: ee });
  try {
    const r = await rawRequest(handle.port, "/api/activity", {
      headers: { Host: "rebind.attacker.example:" + handle.port },
    });
    assert.strictEqual(r.status, 403);
    assert.ok(!r.body.includes("s3cret-cookie"), "traffic must not be served to a foreign Host");
  } finally {
    await handle.close();
  }
});

test("W1E-1: Host must name the port the connection arrived on", async () => {
  const { server, port } = await startServer();
  try {
    const other = port === 9091 ? 9092 : 9091;
    const wrongPort = await rawRequest(port, "/api/status", { headers: { Host: "localhost:" + other } });
    assert.strictEqual(wrongPort.status, 403);
    for (const host of ["127.0.0.1:" + port, "localhost:" + port, "LOCALHOST:" + port]) {
      const ok = await rawRequest(port, "/api/status", { headers: { Host: host } });
      assert.strictEqual(ok.status, 200, "own loopback Host must be accepted: " + host);
    }
  } finally {
    server.close();
  }
});

test("W1E-1: request without a Host header → 403", async () => {
  const { server, port } = await startServer();
  try {
    const r = await rawRequest(port, "/api/status", { setHost: false });
    // Node >= 20 rejects a Host-less HTTP/1.1 request itself (400,
    // requireHostHeader); the inspector's own gate answers 403 otherwise.
    assert.ok(r.status === 400 || r.status === 403, "expected rejection, got " + r.status);
  } finally {
    server.close();
  }
});

test("W1E-1: static UI is Host-gated too (rebinding can't read the page)", async () => {
  const { server, port } = await startServer();
  try {
    const r = await rawRequest(port, "/", { headers: { Host: "rebind.attacker.example" } });
    assert.strictEqual(r.status, 403);
  } finally {
    server.close();
  }
});

test("W1E-1: WS upgrade with a rebinding Host is rejected", async () => {
  const ee = makeTestEmitter();
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams(), trafficEmitter: ee });
  try {
    const ws = new WebSocket("ws://127.0.0.1:" + handle.port + "/ws/traffic", {
      headers: { Host: "rebind.attacker.example:" + handle.port },
    });
    assert.notStrictEqual(await wsOutcome(ws), "open", "foreign Host must not get the traffic stream");
  } finally {
    await handle.close();
  }
});

test("W1E-1: POST with Origin http://localhost:5173 (another local port) → 403", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", { Origin: "http://localhost:5173" });
    assert.strictEqual(r.status, 403);
    assert.match(JSON.parse(r.body).error, /forbidden origin/);
  } finally {
    server.close();
  }
});

test("W1E-1: POST with the inspector's own Origin passes the CSRF gate", async () => {
  const { server, port } = await startServer();
  try {
    for (const origin of ["http://127.0.0.1:" + port, "http://localhost:" + port]) {
      // Slot 1 is claimed in the default seams → the route answers 400,
      // which proves the Origin gate let the request through.
      const r = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", { Origin: origin });
      assert.strictEqual(r.status, 400, "own origin must pass: " + origin);
    }
    const https = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", { Origin: "https://localhost:" + port });
    assert.strictEqual(https.status, 403, "scheme must match too");
    const nul = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", { Origin: "null" });
    assert.strictEqual(nul.status, 403, "opaque Origin must be rejected");
  } finally {
    server.close();
  }
});

test("W1E-1: WS upgrade rejects a localhost Origin on another port", async () => {
  const handle = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    const other = handle.port === 5173 ? 5174 : 5173;
    const ws = new WebSocket("ws://127.0.0.1:" + handle.port + "/ws/traffic", { origin: "http://localhost:" + other });
    assert.notStrictEqual(await wsOutcome(ws), "open");
  } finally {
    await handle.close();
  }
});

// ─── W1E (2026-11-03): quietPortInUse for callers that retry the bind ──
// The relay (W1A) retries the inspector bind every 30s while the port is
// busy and logs its own line; startInspector's "Set
// BROWSER_RELAY_INSPECTOR_PORT=9091" hint would print on every retry.

async function captureStderr(fn) {
  const orig = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return true; };
  try { return { result: await fn(), lines }; }
  catch (e) { return { error: e, lines }; }
  finally { process.stderr.write = orig; }
}

test("startInspector: quietPortInUse → EADDRINUSE rejects without the stderr hint", async () => {
  const first = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    const { error, lines } = await captureStderr(() =>
      startInspector({ port: first.port, bind: "127.0.0.1", seams: makeSeams(), quietPortInUse: true }));
    assert.ok(error, "second bind must reject so the caller can retry");
    assert.strictEqual(error.code, "EADDRINUSE");
    assert.ok(!lines.some((l) => /already in use/.test(l)), "quiet mode must not print the hint: " + lines.join(""));
  } finally {
    await first.close();
  }
});

test("startInspector: default still prints the port-in-use hint on EADDRINUSE", async () => {
  const first = await startInspector({ port: 0, bind: "127.0.0.1", seams: makeSeams() });
  try {
    const { error, lines } = await captureStderr(() =>
      startInspector({ port: first.port, bind: "127.0.0.1", seams: makeSeams() }));
    assert.strictEqual(error && error.code, "EADDRINUSE");
    assert.ok(lines.some((l) => /already in use/.test(l)), "default keeps the standalone hint");
  } finally {
    await first.close();
  }
});

// ─── W1E-2 (2026-11-03): async + cached buildStatus, vault reuse, reap ─
//
// buildStatus ran two synchronous PowerShell probes (Brave listing + lock
// owner start times) on the event loop for every 5s UI poll, re-parsed the
// password CSV each time, and re-probed liveness of PIDs it had just read
// from the live process list. The reap route also unlinked the lock
// unconditionally, so a lock a new relay wrote mid-reap was deleted.

const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { runProbeAsync } = require("../src/inspector-server.js");
const vaultMod = require("../src/vault.js");

const emptyVaultSeam = () => ({ summary: () => ({ totalEntries: 0, uniqueHosts: 0, filesLoaded: [], filesSkipped: [] }) });

test("W1E-2: runProbeAsync runs a spawnSync-style probe without blocking the event loop", async () => {
  const probe = (spawn) => {
    const r = (spawn || spawnSync)(process.execPath, ["-e", "setTimeout(() => process.stdout.write('done'), 300)"], { encoding: "utf8" });
    return r.status === 0 ? r.stdout : "failed:" + r.status;
  };
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  try {
    assert.strictEqual(await runProbeAsync(probe), "done");
    assert.ok(ticks >= 5, "event loop must keep turning while the probe runs (ticks=" + ticks + ")");
  } finally {
    clearInterval(timer);
  }
});

test("W1E-2: runProbeAsync hands a non-zero exit status + stdout back like spawnSync", async () => {
  const probe = (spawn) => (spawn || spawnSync)(
    process.execPath, ["-e", "process.stdout.write('partial'); process.exit(3)"], { encoding: "utf8" });
  const r = await runProbeAsync(probe);
  assert.strictEqual(r.status, 3);
  assert.strictEqual(r.stdout, "partial");
});

test("W1E-2: buildStatus awaits async process probes", async () => {
  const seams = makeSeams({ extra: {
    _listBraveProcessesRaw: async () => "1111|brave.exe --user-data-dir=C:/fake/.browser-data-mcp-pool-1",
    _getProcessStartTimes: async () => new Map(),
  } });
  const status = await buildStatus(seams);
  assert.strictEqual(status.slots[0].state, "claimed");
  assert.deepStrictEqual(status.slots[0].bravePids, [1111]);
});

test("W1E-2: Brave PIDs from the live process listing aren't re-probed for liveness", async () => {
  const probed = [];
  const seams = makeSeams({ extra: {
    _listBraveProcessesRaw: () => "4444|brave.exe --user-data-dir=C:/fake/.browser-data-mcp-pool-1",
    _isPidAlive: (pid) => { probed.push(pid); return pid === 1111; },
  } });
  const status = await buildStatus(seams);
  assert.deepStrictEqual(status.slots[0].bravePids, [4444]);
  assert.ok(!probed.includes(4444), "listed Brave PIDs must not get a second liveness probe");
});

test("W0 V2-3: recycled-PID lock → orphan, genuine owner → claimed (real userDataDirMatcher)", async () => {
  const now = Date.now();
  const pool1 = "C:/fake/.browser-data-mcp-pool-1";
  const pool10 = "C:/fake/.browser-data-mcp-pool-10";
  const seams = makeSeams({
    config: { poolDirs: [pool1, pool10], slotRoles: {}, cookieFreshnessWarnDays: 7, cookieSourceProfile: null, bravePath: null, standalone: false },
    lockFiles: {
      // Genuine owner: process started before it wrote the lock.
      [pool1 + "/.mcp-wrapper-lock"]: JSON.stringify({ pid: 2222, startedAt: new Date(now - 3600_000).toISOString() }),
      // Recycled PID: the lock is a week old, the live process holding
      // PID 3333 started an hour ago — the owner is long dead.
      [pool10 + "/.mcp-wrapper-lock"]: JSON.stringify({ pid: 3333, startedAt: new Date(now - 7 * 86400_000).toISOString() }),
    },
    extra: {
      _listBraveProcessesRaw: () => [
        `4444|brave.exe --user-data-dir=${pool1} --remote-debugging-port=9301`,
        `6666|brave.exe --user-data-dir="${pool10}" --type=renderer`,
      ].join("\r\n"),
      _isPidAlive: () => true,
      _getProcessStartTimes: () => new Map([[2222, now - 2 * 3600_000], [3333, now - 3600_000]]),
    },
  });
  // Use the production matcher (pool.findBraveProcessesForDir →
  // userDataDirMatcher), not makeSeams' substring stub — the substring
  // stub would also hand pool-10's Brave to pool-1.
  delete seams._findBraveProcessesForDir;
  const status = await buildStatus(seams);
  const [slot1, slot10] = status.slots;
  assert.strictEqual(slot1.state, "claimed");
  assert.strictEqual(slot1.pidAlive, true);
  assert.deepStrictEqual(slot1.bravePids, [4444], "pool-1 must not claim pool-10's Brave");
  assert.strictEqual(slot10.state, "orphan");
  assert.strictEqual(slot10.pidAlive, false);
  assert.deepStrictEqual(slot10.bravePids, [6666]);
});

test("W1E-2: buildStatus reports the vault already loaded in-process — no CSV re-read per poll", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w1e-vault-"));
  const csv = path.join(dir, "fake-passwords.csv");
  fs.writeFileSync(csv, "name,url,username,password,note\n,https://a.example,u1,p1,\n,https://b.example,u2,p2,\n");
  try {
    // What the relay does at startup (hermetic: no real local-config.json).
    vaultMod.loadVaultFromEnv({ env: { BROWSER_RELAY_VAULT_FILES: csv }, localConfigPath: path.join(dir, "absent.json") });
    fs.unlinkSync(csv); // a per-poll re-read would now find nothing
    const seams = makeSeams();
    delete seams._loadVault;
    seams._env = {}; // enabled must follow the loaded vault, not this process's raw env
    const status = await buildStatus(seams);
    assert.strictEqual(status.vault.enabled, true);
    assert.strictEqual(status.vault.totalEntries, 2);
    assert.deepStrictEqual(status.vault.filesLoaded.map((f) => f.path), ["fake-passwords.csv"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1E-2: /api/status + /api/slot/:n share one cached status build", async () => {
  let listings = 0;
  const seams = makeSeams({ extra: { _listBraveProcessesRaw: () => { listings++; return ""; } } });
  const { server, port } = await startServer(seams);
  try {
    const rs = await Promise.all([fetch(port, "/api/status"), fetch(port, "/api/status"), fetch(port, "/api/slot/1")]);
    for (const r of rs) assert.strictEqual(r.status, 200);
    await fetch(port, "/api/status");
    assert.strictEqual(listings, 1, "concurrent + follow-up polls inside the TTL must reuse one probe");
  } finally {
    server.close();
  }
});

test("W1E-2: statusCacheMs: 0 rebuilds on every request", async () => {
  let listings = 0;
  const seams = makeSeams({ extra: { _listBraveProcessesRaw: () => { listings++; return ""; } } });
  const server = createInspectorRaw({ seams, statusCacheMs: 0 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await fetch(port, "/api/status");
    await fetch(port, "/api/status");
    assert.strictEqual(listings, 2);
  } finally {
    server.close();
  }
});

test("W1E-2: reap refuses (409) when the lock is replaced after the orphan check", async () => {
  const lockPath = "C:/fake/.browser-data-mcp-pool-2/.mcp-wrapper-lock";
  const dead = JSON.stringify({ pid: 9999, startedAt: new Date(Date.now() - 60_000).toISOString() });
  const newOwner = JSON.stringify({ pid: 1111, startedAt: new Date().toISOString() });
  const seams = makeSeams({ lockFiles: { [lockPath]: dead } });
  // A new relay claims the slot while the (slow, ~1s on Windows) process
  // probe is running — after the lock was judged, before the kill.
  let swapped = false;
  seams._listBraveProcessesRaw = () => { swapped = true; return ""; };
  const baseRead = seams._readFile;
  seams._readFile = (p) => (swapped && String(p).split(path.sep).join("/") === lockPath ? newOwner : baseRead(p));
  let reaped = false;
  const server = createInspectorRaw({ seams, mutators: { reapSlot: () => { reaped = true; return 1; } } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const r = await fetchWithHeaders(port, "/api/slots/2/reap", "POST", { Origin: "http://127.0.0.1:" + port });
    assert.strictEqual(r.status, 409, r.body);
    assert.strictEqual(reaped, false, "must not kill the new owner's Brave");
  } finally {
    server.close();
  }
});

function realFsReapSetup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w1e-reap-"));
  const lockPath = path.join(dir, ".mcp-wrapper-lock");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date(Date.now() - 60_000).toISOString() }));
  const seams = makeSeams({
    config: { poolDirs: [dir], slotRoles: {}, cookieFreshnessWarnDays: 7, cookieSourceProfile: null, bravePath: null, standalone: false },
    extra: { _isPidAlive: () => false, _listBraveProcessesRaw: () => "", _loadVault: emptyVaultSeam },
  });
  // Real fs for the lock (defaults), fake process side.
  delete seams._existsFile;
  delete seams._readFile;
  delete seams._statFile;
  return { dir, lockPath, seams };
}

test("W1E-2: default reap keeps a lock that a new relay wrote during the kill", async () => {
  const { dir, lockPath, seams } = realFsReapSetup();
  const newOwner = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  seams._reapOrphansFor = () => { fs.writeFileSync(lockPath, newOwner); return 1; };
  const server = createInspectorRaw({ seams });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const r = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", { Origin: "http://127.0.0.1:" + port });
    assert.strictEqual(r.status, 200, r.body);
    assert.ok(fs.existsSync(lockPath), "a lock rewritten mid-reap must not be unlinked");
    assert.strictEqual(fs.readFileSync(lockPath, "utf8"), newOwner);
    assert.strictEqual(JSON.parse(r.body).lockCleared, false, "response must say the lock was left in place");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1E-2: default reap clears an unchanged stale lock and invalidates the status cache", async () => {
  const { dir, lockPath, seams } = realFsReapSetup();
  let listings = 0;
  seams._listBraveProcessesRaw = () => { listings++; return ""; };
  seams._reapOrphansFor = () => 2;
  const server = createInspectorRaw({ seams });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const before = JSON.parse((await fetch(port, "/api/status")).body);
    assert.strictEqual(before.slots[0].state, "orphan");
    const r = await fetchWithHeaders(port, "/api/slots/1/reap", "POST", { Origin: "http://127.0.0.1:" + port });
    assert.strictEqual(r.status, 200, r.body);
    assert.match(JSON.parse(r.body).message, /Reaped orphan slot 1 · 2 brave proc/);
    assert.strictEqual(JSON.parse(r.body).lockCleared, true);
    assert.ok(!fs.existsSync(lockPath), "unchanged stale lock must be removed");
    const after = JSON.parse((await fetch(port, "/api/status")).body);
    assert.strictEqual(after.slots[0].state, "idle", "status after a reap must not come from the pre-reap cache");
    assert.strictEqual(listings, 3, "initial poll + fresh pre-reap build + post-reap rebuild");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── W1E-3 (2026-11-03): CSP without 'unsafe-inline'; export no-store ──

test("W1E-3: CSP allows no inline script or style", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/");
    const csp = r.headers["content-security-policy"];
    assert.ok(csp, "CSP header must be present");
    assert.ok(!csp.includes("'unsafe-inline'"), "CSP must not allow inline: " + csp);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.match(csp, /style-src 'self'(;|$)/);
  } finally {
    server.close();
  }
});

test("W1E-3: inspector UI uses no inline script, inline style or style attribute (CSP drift guard)", () => {
  const uiDir = path.join(__dirname, "..", "scripts", "inspector-ui");
  const html = fs.readFileSync(path.join(uiDir, "index.html"), "utf8");
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  for (const tag of scripts) assert.match(tag, /\ssrc=/i, "inline <script> would be blocked by CSP: " + tag);
  assert.ok(!/<style\b/i.test(html), "inline <style> would be blocked by CSP");
  assert.ok(!/\sstyle\s*=/i.test(html), "style= attribute would be blocked by CSP");
  assert.ok(!/\son[a-z]+\s*=/i.test(html), "inline event handler would be blocked by CSP");
  const app = fs.readFileSync(path.join(uiDir, "app.js"), "utf8");
  // el(tag, { style: ... }) goes through setAttribute("style", ...), which
  // CSP blocks without 'unsafe-inline'. CSSOM writes (node.style.x = ...)
  // are allowed and are not matched here.
  assert.ok(!/[{,]\s*style\s*:/.test(app), "el() style attribute would be blocked by CSP");
  assert.ok(!/setAttribute\(\s*["']style["']/.test(app), "style attribute would be blocked by CSP");
  assert.ok(!/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|cssText/.test(app), "HTML/CSS string injection would bypass the CSP intent");
});

test("W1E-3: /api/activity/export is Cache-Control: no-store", async () => {
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/activity/export");
    assert.strictEqual(r.status, 200);
    assert.match(r.headers["content-disposition"] || "", /attachment/);
    assert.strictEqual(r.headers["cache-control"], "no-store");
  } finally {
    server.close();
  }
});

// ─── W1E V1-3 (2026-11-03): reap follow-ups from review ────────────────

test("W1E V1-3: a 409 reap invalidates the status cache (no stale 'orphan' served)", async () => {
  const lockPath = "C:/fake/.browser-data-mcp-pool-2/.mcp-wrapper-lock";
  const dead = JSON.stringify({ pid: 9999, startedAt: new Date(Date.now() - 60_000).toISOString() });
  const newOwner = JSON.stringify({ pid: 1111, startedAt: new Date().toISOString() });
  const seams = makeSeams({ lockFiles: { [lockPath]: dead } });
  let swapped = false;
  let listings = 0;
  seams._listBraveProcessesRaw = () => { listings++; swapped = true; return ""; };
  const baseRead = seams._readFile;
  seams._readFile = (p) => (swapped && String(p).split(path.sep).join("/") === lockPath ? newOwner : baseRead(p));
  const server = createInspectorRaw({ seams, mutators: { reapSlot: () => 1 } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const r = await fetchWithHeaders(port, "/api/slots/2/reap", "POST", { Origin: "http://127.0.0.1:" + port });
    assert.strictEqual(r.status, 409, r.body);
    const after = JSON.parse((await fetch(port, "/api/status")).body);
    assert.strictEqual(listings, 2, "the status poll after a 409 must rebuild");
    assert.strictEqual(after.slots[1].state, "claimed", "status must reflect the new owner, not the judged orphan");
  } finally {
    server.close();
  }
});

test("W1E V1-3: orphan card doesn't claim the lock PID is dead (it may be recycled)", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "scripts", "inspector-ui", "app.js"), "utf8");
  assert.ok(!/not alive/.test(app), "orphan wording must not say the PID is not alive");
  assert.ok(app.includes("lock owner gone (dead or recycled PID)"));
});

// ─── W1E V1-4 (2026-11-03): standalone inspector keeps only the summary ─
// With no relay in the process, the inspector used to keep a full Vault
// (every password) alive for its lifetime just to show counts. Run in a
// fresh process so no other test's loaded vault is in module state.

test("W1E V1-4: standalone inspector reports vault counts without retaining the vault", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w1e-standalone-vault-"));
  const csv = path.join(dir, "fake-passwords.csv");
  fs.writeFileSync(csv, "name,url,username,password,note\n,https://a.example,u1,fake-pw-1,\n,https://b.example,u2,fake-pw-2,\n");
  const script = `
    const fs = require("node:fs");
    const { buildStatus } = require(${JSON.stringify(path.join(__dirname, "..", "src", "inspector-server.js"))});
    const vault = require(${JSON.stringify(path.join(__dirname, "..", "src", "vault.js"))});
    const seams = {
      _loadConfig: () => ({ poolDirs: [], slotRoles: {}, cookieFreshnessWarnDays: 7, standalone: true }),
      _listBraveProcessesRaw: () => "",
      _getProcessStartTimes: () => new Map(),
      _isPidAlive: () => false,
      _findCookiesFile: () => null,
    };
    (async () => {
      const first = await buildStatus(seams);
      fs.unlinkSync(${JSON.stringify(csv)}); // a re-read would now find nothing
      const second = await buildStatus(seams);
      process.stdout.write(JSON.stringify({
        retained: vault.getLoadedVault() !== null,
        first: first.vault.totalEntries,
        second: second.vault.totalEntries,
        enabled: second.vault.enabled,
      }));
    })().catch((e) => { process.stderr.write(String(e.stack)); process.exit(1); });
  `;
  try {
    const r = spawnSync(process.execPath, ["-e", script], {
      encoding: "utf8",
      env: { ...process.env, BROWSER_RELAY_VAULT_FILES: csv },
      timeout: 20000,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.retained, false, "no Vault (passwords) may stay loaded in the standalone inspector");
    assert.strictEqual(out.first, 2);
    assert.strictEqual(out.second, 2, "summary is computed once, not re-read per poll");
    assert.strictEqual(out.enabled, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
