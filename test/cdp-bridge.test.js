const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { launchBrave, closeBrave, waitForCdpReady } = require("../src/cdp-bridge.js");

// playwright-core has no bundled chromium — use the system Brave install
// (same path production reads from CONFIG.bravePath).
const wrapper = require("../../wrap-browser-devtools-mcp.js");
const SYSTEM_BRAVE = wrapper.CONFIG.bravePath;

test("launchBrave + connectOverCDP roundtrip on a throwaway profile", async () => {
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
