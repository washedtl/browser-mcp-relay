const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");

const { launchBrave, closeBrave, waitForCdpReady } = require("../src/cdp-bridge.js");

// ─────────────────── Unit tests via chromium mock ────────────────────
//
// Captures the launchOpts that launchBrave passes to launchPersistentContext.
// Bypasses the real Brave launch (too slow/flaky for unit tests) and asserts
// the launch shape is correct. Each test isolates the require cache + restores.

// W1E V1-6 (2026-11-03): never hardcode a CDP/listen port — other relays,
// agents and real Brave instances use the 93xx range. Ask the OS for one.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Proxy reachability seam for launchBrave (W1E V1-1): tests never touch
// a real proxy port unless they say so.
const PROXY_UP = async () => true;
const PROXY_DOWN = async () => false;
const BYPASS = "localhost,127.0.0.1,[::1]";

async function captureStderr(fn) {
  const origWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try { return { result: await fn(), log: lines.join("") }; }
  finally { process.stderr.write = origWrite; }
}

async function withMockChromium(fn) {
  const playwrightCorePath = require.resolve("playwright-core");
  const cdpBridgePath = require.resolve("../src/cdp-bridge.js");
  const origPlaywright = require.cache[playwrightCorePath];
  const origCdpBridge = require.cache[cdpBridgePath];
  const captured = { userDataDir: null, launchOpts: null };
  // Stub module
  require.cache[playwrightCorePath] = {
    id: playwrightCorePath,
    filename: playwrightCorePath,
    loaded: true,
    exports: {
      chromium: {
        launchPersistentContext: async (userDataDir, launchOpts) => {
          captured.userDataDir = userDataDir;
          captured.launchOpts = launchOpts;
          return { close: async () => {} };
        },
      },
    },
  };
  // Reset cdp-bridge so it picks up the stubbed chromium.
  delete require.cache[cdpBridgePath];
  // Stub fetch so waitForCdpReady resolves immediately.
  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: true });
  try {
    const fresh = require("../src/cdp-bridge.js");
    return await fn(fresh, captured);
  } finally {
    if (origPlaywright) require.cache[playwrightCorePath] = origPlaywright;
    else delete require.cache[playwrightCorePath];
    if (origCdpBridge) require.cache[cdpBridgePath] = origCdpBridge;
    else delete require.cache[cdpBridgePath];
    global.fetch = origFetch;
  }
}

test("launchBrave: ignoreDefaultArgs always includes --use-mock-keychain", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      headless: false,
      executablePath: "/fake/brave",
    });
    assert.ok(Array.isArray(captured.launchOpts.ignoreDefaultArgs));
    assert.ok(
      captured.launchOpts.ignoreDefaultArgs.includes("--use-mock-keychain"),
      "expected --use-mock-keychain in ignoreDefaultArgs",
    );
  });
});

test("launchBrave: when extensionPath is set, ignoreDefaultArgs also includes --disable-extensions", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      executablePath: "/fake/brave",
      extensionPath: "/fake/ext",
    });
    assert.ok(captured.launchOpts.ignoreDefaultArgs.includes("--use-mock-keychain"));
    assert.ok(captured.launchOpts.ignoreDefaultArgs.includes("--disable-extensions"));
  });
});

// W1E-6 (2026-11-03): certificate errors were ignored unconditionally, so
// any network MITM on a plain (no-proxy) relay was accepted silently —
// including on pages the vault autofills. Only a configured debug proxy
// (which presents its own cert) needs it.
test("W1E-6: launchBrave without a proxy keeps TLS verification on", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      executablePath: "/fake/brave",
      _relayEnv: {},
    });
    assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, false);
    assert.strictEqual(captured.launchOpts.proxy, undefined);
  });
});

test("W1E-6: launchBrave with a proxy ignores HTTPS errors (MITM debug proxy)", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      executablePath: "/fake/brave",
      proxyUrl: "http://127.0.0.1:8888",
      _probeProxy: PROXY_UP,
      _relayEnv: {},
    });
    assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, true);
  });
});

test("W2E: a REMOTE proxy (reachable, or kept while unreachable) keeps TLS verification on", async () => {
  for (const probe of [PROXY_UP, PROXY_DOWN]) {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({
        userDataDir: "/tmp/x",
        port: 9999,
        executablePath: "/fake/brave",
        proxyUrl: "http://10.0.0.5:8080",
        _probeProxy: probe,
        _relayEnv: {},
      });
      assert.strictEqual(captured.launchOpts.proxy.server, "http://10.0.0.5:8080", "the remote proxy is in use");
      assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, false);
    });
  }
});

test("W1E V1-2: BROWSER_RELAY_IGNORE_HTTPS_ERRORS=true restores always-ignore without a proxy", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      executablePath: "/fake/brave",
      _relayEnv: { BROWSER_RELAY_IGNORE_HTTPS_ERRORS: "true" },
    });
    assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, true);
  });
});

test("W1E V1-2: the opt-in is read from the relay env by default (process.env layer)", async () => {
  const orig = process.env.BROWSER_RELAY_IGNORE_HTTPS_ERRORS;
  process.env.BROWSER_RELAY_IGNORE_HTTPS_ERRORS = "true";
  try {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({ userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave" });
      assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, true);
      assert.strictEqual(captured.launchOpts.env.BROWSER_RELAY_IGNORE_HTTPS_ERRORS, undefined,
        "relay-internal key still stripped from Brave's env");
    });
  } finally {
    if (orig === undefined) delete process.env.BROWSER_RELAY_IGNORE_HTTPS_ERRORS;
    else process.env.BROWSER_RELAY_IGNORE_HTTPS_ERRORS = orig;
  }
});

test("W1E V1-2: any value other than \"true\" keeps verification on", async () => {
  for (const v of ["false", "1", "TRUE ", ""]) {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({
        userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave",
        _relayEnv: { BROWSER_RELAY_IGNORE_HTTPS_ERRORS: v },
      });
      assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, false, "value " + JSON.stringify(v));
    });
  }
});

test("W0-7: launchBrave with proxyUrl=null still strips BROWSER_RELAY_* from env", async () => {
  // Pre-W0-7: when proxyUrl was null, no `env` was set on launchOpts and
  // Playwright passed process.env wholesale (BROWSER_RELAY_* leaked).
  // Post-W0-7: env is always sanitized; BROWSER_RELAY_* never reaches Brave.
  //
  // F1-20 fixup (2026-05-10): also stash + clear HTTP_PROXY / HTTPS_PROXY
  // so the test passes on developer machines that have a system-wide HTTP
  // proxy set (e.g. powhttp debug proxy at 127.0.0.1:8888). Without this,
  // process.env.HTTP_PROXY leaks through the relay's
  // `for (k of Object.entries(process.env))` env copy and the assertion
  // `env.HTTP_PROXY === undefined` fires on a perfectly working relay.
  // CI runners don't have this env var → test passes there. CLAUDE.md
  // anti-pattern: "tests that pass on my env state."
  const stashed = {
    BROWSER_RELAY_INSPECTOR_PORT: process.env.BROWSER_RELAY_INSPECTOR_PORT,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
  };
  process.env.BROWSER_RELAY_INSPECTOR_PORT = "9091";
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  try {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({
        userDataDir: "/tmp/x",
        port: 9999,
        executablePath: "/fake/brave",
        proxyUrl: null,
      });
      assert.ok(captured.launchOpts.env, "env must be set even without proxy (W0-7)");
      assert.strictEqual(captured.launchOpts.env.BROWSER_RELAY_INSPECTOR_PORT, undefined,
        "BROWSER_RELAY_* must NEVER reach the spawned Brave");
      // No HTTP_PROXY when proxy is unset (and no host-env HTTP_PROXY leaked).
      assert.strictEqual(captured.launchOpts.env.HTTP_PROXY, undefined);
    });
  } finally {
    for (const [k, v] of Object.entries(stashed)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// W1E-6: Chromium ignores HTTP_PROXY/HTTPS_PROXY on Windows (it reads the
// system proxy or --proxy-server), so the env-var route didn't proxy the
// relay's Brave there. Playwright's `proxy` launch option becomes
// --proxy-server on every platform.
async function withHostProxyEnvCleared(fn) {
  const stashed = { HTTP_PROXY: process.env.HTTP_PROXY, HTTPS_PROXY: process.env.HTTPS_PROXY };
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  try { return await fn(); }
  finally {
    for (const [k, v] of Object.entries(stashed)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("W1E-6: proxyUrl → Playwright proxy launch option, not HTTP_PROXY env", async () => {
  await withHostProxyEnvCleared(() => withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      executablePath: "/fake/brave",
      proxyUrl: "http://127.0.0.1:8888",
      _probeProxy: PROXY_UP,
    });
    assert.deepStrictEqual(captured.launchOpts.proxy, { server: "http://127.0.0.1:8888", bypass: BYPASS });
    assert.strictEqual(captured.launchOpts.env.HTTP_PROXY, undefined);
    assert.strictEqual(captured.launchOpts.env.HTTPS_PROXY, undefined);
  }));
});

test("W1E-6: proxy credentials go to username/password, never into --proxy-server or the log", async () => {
  const origWrite = process.stderr.write;
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({
        userDataDir: "/tmp/x",
        port: 9999,
        executablePath: "/fake/brave",
        proxyUrl: "http://user:p%40ss@127.0.0.1:8888",
        _probeProxy: PROXY_UP,
      });
      assert.deepStrictEqual(captured.launchOpts.proxy, {
        server: "http://127.0.0.1:8888",
        bypass: BYPASS,
        username: "user",
        password: "p@ss",
      });
    });
  } finally {
    process.stderr.write = origWrite;
  }
  const log = lines.join("");
  assert.match(log, /proxy whitelist ACTIVE/);
  assert.ok(!log.includes("p%40ss") && !log.includes("p@ss"), "proxy password must not be logged: " + log);
});

test("W1E-6: short-form and socks proxy URLs reach Playwright as scheme://host:port", async () => {
  const cases = [
    ["127.0.0.1:8888", "http://127.0.0.1:8888"],
    ["localhost:8888", "http://localhost:8888"],
    ["socks5://127.0.0.1:1080", "socks5://127.0.0.1:1080"],
  ];
  for (const [proxyUrl, server] of cases) {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({ userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave", proxyUrl, _probeProxy: PROXY_UP });
      assert.deepStrictEqual(captured.launchOpts.proxy, { server, bypass: BYPASS }, proxyUrl);
    });
  }
});

// ──────────────────────────────────────────────────────────────────
// W1E V1-1 (2026-11-03): a configured-but-stopped LOCAL debug proxy must
// not break every navigation. Chromium on Windows ignored the old
// HTTP_PROXY env, so a dead 127.0.0.1:8888 used to be harmless; the real
// --proxy-server would fail every request. Loopback proxy unreachable at
// launch → go direct (it can't hide your IP anyway). A REMOTE proxy is
// kept even when unreachable: falling back to direct would leak the IP.
// ──────────────────────────────────────────────────────────────────

test("W1E V1-1: unreachable loopback proxy → launch direct, no proxy, TLS verified, one warning", async () => {
  const probed = [];
  const { log } = await captureStderr(() => withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave",
      proxyUrl: "http://127.0.0.1:8888",
      _probeProxy: async (host, port, timeoutMs) => { probed.push({ host, port, timeoutMs }); return false; },
      _relayEnv: {},
    });
    assert.strictEqual(captured.launchOpts.proxy, undefined, "direct launch must not set a proxy");
    assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, false, "direct launch must verify TLS");
  }));
  assert.deepStrictEqual(probed.map(({ host, port }) => ({ host, port })), [{ host: "127.0.0.1", port: 8888 }]);
  assert.ok(probed[0].timeoutMs <= 1500, "probe must be bounded at 1.5s");
  const warnings = log.split("\n").filter((l) => /WARNING/.test(l));
  assert.strictEqual(warnings.length, 1, log);
  assert.match(warnings[0], /DIRECT/);
  assert.match(warnings[0], /launch/i, "must say the check happens only at launch");
  assert.doesNotMatch(log, /proxy whitelist ACTIVE/);
});

test("W1E V1-1: every loopback spelling counts as loopback", async () => {
  for (const proxyUrl of ["http://localhost:8888", "http://127.1.2.3:8888", "http://[::1]:8888"]) {
    await captureStderr(() => withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({ userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave", proxyUrl, _probeProxy: PROXY_DOWN, _relayEnv: {} });
      assert.strictEqual(captured.launchOpts.proxy, undefined, proxyUrl);
    }));
  }
});

test("W1E V1-1: unreachable REMOTE proxy is kept (never silently direct) and logged loudly", async () => {
  const { log } = await captureStderr(() => withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave",
      proxyUrl: "http://proxy.example.net:3128",
      _probeProxy: PROXY_DOWN,
      _relayEnv: {},
    });
    assert.deepStrictEqual(captured.launchOpts.proxy, { server: "http://proxy.example.net:3128", bypass: BYPASS });
    // W2E: a remote proxy never turns certificate checks off
    assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, false);
  }));
  assert.match(log, /WARNING/);
  assert.match(log, /NOT reachable/);
  assert.match(log, /real IP/i);
});

test("W1E V1-1: the default probe really connects (closed port → direct, listening port → proxied)", async () => {
  const closed = await freePort();
  await captureStderr(() => withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({ userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave", proxyUrl: "http://127.0.0.1:" + closed, _relayEnv: {} });
    assert.strictEqual(captured.launchOpts.proxy, undefined);
  }));
  const srv = net.createServer((sock) => sock.destroy());
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  try {
    const port = srv.address().port;
    await captureStderr(() => withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({ userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave", proxyUrl: "http://127.0.0.1:" + port, _relayEnv: {} });
      assert.deepStrictEqual(captured.launchOpts.proxy, { server: "http://127.0.0.1:" + port, bypass: BYPASS });
    }));
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

// ──────────────────────────────────────────────────────────────────
// W1E V1-5 (2026-11-03): proxy URL parsing.
// ──────────────────────────────────────────────────────────────────

test("W1E V1-5: scheme-less user:pass@host:port defaults to http:// — credentials kept off argv and the log", async () => {
  const { log } = await captureStderr(() => withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave",
      proxyUrl: "bob:s3cret@127.0.0.1:8888",
      _probeProxy: PROXY_UP,
    });
    assert.deepStrictEqual(captured.launchOpts.proxy, {
      server: "http://127.0.0.1:8888", bypass: BYPASS, username: "bob", password: "s3cret",
    });
  }));
  assert.ok(!log.includes("s3cret"), log);
});

test("W1E V1-5: malformed %-escape in proxy credentials → clear error, no launch, no secret echoed", async () => {
  await withMockChromium(async (fresh, captured) => {
    await assert.rejects(
      fresh.launchBrave({
        userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave",
        proxyUrl: "http://bob:50%off@127.0.0.1:8888",
        _probeProxy: PROXY_UP,
      }),
      (e) => /BROWSER_RELAY_PROXY_URL/.test(e.message) && /%25/.test(e.message) && !e.message.includes("50%off"),
    );
    assert.strictEqual(captured.launchOpts, null, "Brave must not launch with a broken proxy URL");
  });
});

test("W1E V1-5: unsupported proxy scheme → clear error", async () => {
  await withMockChromium(async (fresh) => {
    await assert.rejects(
      fresh.launchBrave({ userDataDir: "/tmp/x", port: 9999, executablePath: "/fake/brave", proxyUrl: "ftp://127.0.0.1:21", _probeProxy: PROXY_UP }),
      /BROWSER_RELAY_PROXY_URL.*scheme/,
    );
  });
});

test("V2-7: launchBrave with proxyUrl strips BROWSER_RELAY_* env from spawned Brave", async () => {
  // Stash + set test env vars before triggering launchBrave.
  const stash = {};
  const testKeys = ["BROWSER_RELAY_INSPECTOR_PORT", "BROWSER_RELAY_VAULT_FILES", "BROWSER_RELAY_BRAVE_PATH"];
  for (const k of testKeys) {
    stash[k] = process.env[k];
    process.env[k] = "test-value-" + k;
  }
  process.env.PATH = process.env.PATH || "/usr/bin"; // make sure PATH passes through
  try {
    await withMockChromium(async (fresh, captured) => {
      await fresh.launchBrave({
        userDataDir: "/tmp/x",
        port: 9999,
        executablePath: "/fake/brave",
        proxyUrl: "http://127.0.0.1:8888",
        _probeProxy: PROXY_UP,
      });
      const env = captured.launchOpts.env;
      assert.ok(env, "env must be set with proxyUrl");
      // Critical: BROWSER_RELAY_* must NOT leak.
      for (const k of testKeys) {
        assert.strictEqual(env[k], undefined, `expected BROWSER_RELAY_* var ${k} to be stripped from Brave env`);
      }
      // Sanity: PATH still passes through. Case-insensitive lookup because
      // on Windows, process.env preserves key casing as `Path` (or rarely
      // `path`) — and the relay's `for (k of Object.entries(process.env))`
      // copy preserves whatever case the OS gave us. Locally on Win
      // git-bash it usually surfaces as PATH; on a fresh GitHub Actions
      // windows-latest pwsh runner it surfaces as Path. Either is correct.
      const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
      assert.ok(pathKey, `expected PATH to pass through to Brave (got keys: ${Object.keys(env).slice(0, 10).join(", ")}...)`);
      assert.ok(env[pathKey] && env[pathKey].length > 0, "PATH must have a non-empty value");
      // Sanity: proxy still set (launch option, W1E-6).
      assert.deepStrictEqual(captured.launchOpts.proxy, { server: "http://127.0.0.1:8888", bypass: BYPASS });
    });
  } finally {
    for (const k of testKeys) {
      if (stash[k] === undefined) delete process.env[k];
      else process.env[k] = stash[k];
    }
  }
});

// ─────────────── Original integration test (skips if no Brave) ───────────────

// playwright-core has no bundled chromium — use the system Brave install
// resolved via the same auto-detect logic the relay uses at launch time.
const { detectBravePath } = require("../src/detect-browser.js");
let SYSTEM_BRAVE;
try {
  SYSTEM_BRAVE = detectBravePath();
} catch {
  SYSTEM_BRAVE = null; // tests that need it will skip
}

test("launchBrave + connectOverCDP roundtrip on a throwaway profile", { skip: !SYSTEM_BRAVE }, async () => {
  const tmp = path.join(os.tmpdir(), `cdp-bridge-test-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const cdpPort = await freePort();
  const handle = await launchBrave({
    userDataDir: tmp,
    port: cdpPort,
    headless: false,
    extensionPath: null,
    executablePath: SYSTEM_BRAVE,
  });
  try {
    assert.strictEqual(handle.cdpConnectUrl, "http://127.0.0.1:" + cdpPort);
    const page = await handle.context.newPage();
    await page.goto("about:blank");
    const title = await page.title();
    assert.strictEqual(title, "");
  } finally {
    await closeBrave(handle);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("waitForCdpReady polls /json/version until it succeeds", async () => {
  // Nothing listens on a port the OS just handed out and released, so this
  // should time out fast (a fixed port collided with other agents' Brave).
  const port = await freePort();
  await assert.rejects(
    waitForCdpReady(port, 500),
    /timeout|not ready/i,
  );
});

// ──────────────────────────────────────────────────────────────────
// V0-3: launchBrave must close the BrowserContext if waitForCdpReady
// throws. Otherwise the live context (with its file lock on
// userDataDir) leaks until reboot, blocking any future relay from
// claiming the slot.
// ──────────────────────────────────────────────────────────────────

test("V0-3: launchBrave closes context if waitForCdpReady throws", async () => {
  const playwrightCorePath = require.resolve("playwright-core");
  const cdpBridgePath = require.resolve("../src/cdp-bridge.js");
  const origPlaywright = require.cache[playwrightCorePath];
  const origCdpBridge = require.cache[cdpBridgePath];
  const origFetch = global.fetch;
  let closeCalls = 0;
  // chromium stub returns a context whose close() bumps closeCalls.
  require.cache[playwrightCorePath] = {
    id: playwrightCorePath,
    filename: playwrightCorePath,
    loaded: true,
    exports: {
      chromium: {
        launchPersistentContext: async () => ({
          close: async () => { closeCalls++; },
        }),
      },
    },
  };
  delete require.cache[cdpBridgePath];
  // fetch always 503 → waitForCdpReady will eventually time out.
  global.fetch = async () => ({ ok: false, status: 503 });
  try {
    const fresh = require("../src/cdp-bridge.js");
    await assert.rejects(
      fresh.launchBrave({
        userDataDir: "/tmp/x",
        port: 9990,
        executablePath: "/fake/brave",
      }),
      /not ready/i,
    );
    // Critical assertion: context.close() was invoked exactly once on the
    // way out, so the user-data-dir lock isn't leaked.
    assert.strictEqual(closeCalls, 1, "expected context.close() to fire on waitForCdpReady throw");
  } finally {
    if (origPlaywright) require.cache[playwrightCorePath] = origPlaywright;
    else delete require.cache[playwrightCorePath];
    if (origCdpBridge) require.cache[cdpBridgePath] = origCdpBridge;
    else delete require.cache[cdpBridgePath];
    global.fetch = origFetch;
  }
});
