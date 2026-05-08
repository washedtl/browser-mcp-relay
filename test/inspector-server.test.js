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
  defaultPort,
  defaultBind,
  redactPath,
  formatDuration,
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
    _ownTools: new Array(16).fill({ name: "x" }),
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
  assert.strictEqual(redactPath("C:/Users/tlip9/foo/.browser-data-1"), ".browser-data-1");
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

test("buildStatus: returns expected top-level keys", () => {
  const status = buildStatus(makeSeams());
  assert.ok(status.config);
  assert.ok(Array.isArray(status.slots));
  assert.ok(status.specialty);
  assert.ok(status.vault);
  assert.ok(status.tools);
  assert.ok(status.server);
});

test("buildStatus: claimed slot detected when lock + live PID + brave proc", () => {
  const status = buildStatus(makeSeams());
  const slot1 = status.slots.find((s) => s.index === 1);
  assert.strictEqual(slot1.state, "claimed");
  assert.strictEqual(slot1.pid, 1111);
  assert.strictEqual(slot1.pidAlive, true);
});

test("buildStatus: idle slot when no lock file present", () => {
  const status = buildStatus(makeSeams());
  const slot2 = status.slots.find((s) => s.index === 2);
  assert.strictEqual(slot2.state, "idle");
  assert.strictEqual(slot2.pid, null);
});

test("buildStatus: orphan slot when lock present but PID dead", () => {
  const seams = makeSeams({
    lockFiles: {
      "C:/fake/.browser-data-mcp-pool-1/.mcp-wrapper-lock": JSON.stringify({
        pid: 9999, // not in our isPidAlive whitelist
        startedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    },
  });
  const status = buildStatus(seams);
  const slot1 = status.slots.find((s) => s.index === 1);
  assert.strictEqual(slot1.state, "orphan");
  assert.strictEqual(slot1.pidAlive, false);
});

test("buildStatus: poolDirs in config are redacted to basenames", () => {
  const status = buildStatus(makeSeams());
  for (const dir of status.config.poolDirs) {
    assert.ok(!dir.includes("C:/"), "absolute path leaked: " + dir);
    assert.ok(!dir.includes("\\"), "absolute path leaked: " + dir);
  }
});

test("buildStatus: bravePath is redacted to basename", () => {
  const status = buildStatus(makeSeams());
  assert.strictEqual(status.config.bravePath, "brave.exe");
});

test("buildStatus: tools.ownCount comes from ownTools length", () => {
  const status = buildStatus(makeSeams());
  assert.strictEqual(status.tools.ownCount, 16);
  assert.strictEqual(status.tools.total, 16 + 51);
});

test("buildStatus: specialty includes browser-devtools-mcp-2 + 3 static MCPs", () => {
  const status = buildStatus(makeSeams());
  assert.ok(status.specialty["browser-devtools-mcp-2"]);
  assert.ok(status.specialty["puppeteer-real-browser"]);
  assert.ok(status.specialty["amz-aff-firefox-mcp"]);
  assert.ok(status.specialty["claude-in-chrome"]);
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
  const { server, port } = await startServer();
  try {
    const r = await fetch(port, "/api/status", "POST");
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
