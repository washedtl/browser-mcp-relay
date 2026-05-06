const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { launchBrave, closeBrave, waitForCdpReady } = require("../src/cdp-bridge.js");

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
