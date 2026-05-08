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
