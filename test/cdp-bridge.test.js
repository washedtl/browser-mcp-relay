const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { launchBrave, closeBrave, waitForCdpReady } = require("../src/cdp-bridge.js");

// ─────────────────── Unit tests via chromium mock ────────────────────
//
// Captures the launchOpts that launchBrave passes to launchPersistentContext.
// Bypasses the real Brave launch (too slow/flaky for unit tests) and asserts
// the launch shape is correct. Each test isolates the require cache + restores.

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

test("launchBrave: ignoreHTTPSErrors is true on launchOpts", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      executablePath: "/fake/brave",
    });
    assert.strictEqual(captured.launchOpts.ignoreHTTPSErrors, true);
  });
});

test("launchBrave: proxyUrl=null → no env override on launchOpts", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      executablePath: "/fake/brave",
      proxyUrl: null,
    });
    assert.strictEqual(captured.launchOpts.env, undefined);
  });
});

test("launchBrave: proxyUrl set → HTTP_PROXY + HTTPS_PROXY in launchOpts.env", async () => {
  await withMockChromium(async (fresh, captured) => {
    await fresh.launchBrave({
      userDataDir: "/tmp/x",
      port: 9999,
      executablePath: "/fake/brave",
      proxyUrl: "http://127.0.0.1:8888",
    });
    assert.ok(captured.launchOpts.env, "expected env to be set");
    assert.strictEqual(captured.launchOpts.env.HTTP_PROXY, "http://127.0.0.1:8888");
    assert.strictEqual(captured.launchOpts.env.HTTPS_PROXY, "http://127.0.0.1:8888");
  });
});

// V2-7: BROWSER_RELAY_* env vars are relay-internal — Brave shouldn't see them.
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
      });
      const env = captured.launchOpts.env;
      assert.ok(env, "env must be set with proxyUrl");
      // Critical: BROWSER_RELAY_* must NOT leak.
      for (const k of testKeys) {
        assert.strictEqual(env[k], undefined, `expected BROWSER_RELAY_* var ${k} to be stripped from Brave env`);
      }
      // Sanity: PATH still passes through.
      assert.ok(env.PATH, "expected PATH to pass through to Brave");
      // Sanity: proxy still set.
      assert.strictEqual(env.HTTP_PROXY, "http://127.0.0.1:8888");
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
  const handle = await launchBrave({
    userDataDir: tmp,
    port: 9399, // unused-port range
    headless: false,
    extensionPath: null,
    executablePath: SYSTEM_BRAVE,
  });
  try {
    assert.strictEqual(handle.cdpConnectUrl, "http://127.0.0.1:9399");
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
  // Brave from previous test should be down by now; this should timeout fast.
  await assert.rejects(
    waitForCdpReady(9399, 500),
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
