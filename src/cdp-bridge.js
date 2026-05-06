// cdp-bridge.js — launches Brave for a slot via Playwright launchPersistentContext
// with a remote-debugging-port that BOTH our relay AND upstream attach to via
// chromium.connectOverCDP. Verified architecture from Phase 0
// (see docs/phase-0-research.md and docs/probe-cdp-access.js).

const { chromium } = require("playwright-core");

/**
 * Launch Brave for the slot. Returns a handle the caller passes back to
 * closeBrave on shutdown.
 *
 * @param {object} opts
 * @param {string} opts.userDataDir — pool slot dir
 * @param {number} opts.port — unique per slot, exposes CDP HTTP endpoint
 * @param {boolean} [opts.headless]
 * @param {string|null} [opts.extensionPath] — passed via --load-extension
 * @param {string} [opts.executablePath] — overrides bundled chromium
 * @returns {Promise<{ context: import('playwright-core').BrowserContext, cdpConnectUrl: string }>}
 */
async function launchBrave({ userDataDir, port, headless = false, extensionPath = null, executablePath }) {
  const args = [`--remote-debugging-port=${port}`];
  let ignoreDefaultArgs;
  if (extensionPath) {
    args.push(`--load-extension=${extensionPath}`);
    args.push(`--disable-extensions-except=${extensionPath}`);
    ignoreDefaultArgs = ["--disable-extensions"];
  }
  const launchOpts = {
    headless,
    args,
    handleSIGINT: false,
    handleSIGTERM: false,
  };
  if (ignoreDefaultArgs) launchOpts.ignoreDefaultArgs = ignoreDefaultArgs;
  if (executablePath) launchOpts.executablePath = executablePath;

  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);

  // Wait for the CDP HTTP endpoint to respond before returning. Upstream's
  // connectOverCDP will hit /json/version, so we want it ready first.
  await waitForCdpReady(port, 10000);

  return {
    context,
    cdpConnectUrl: `http://127.0.0.1:${port}`,
  };
}

/**
 * Graceful close. Best-effort — never throws. The caller's relay shutdown
 * handler invokes this even on signal-driven exits, so it must be quiet.
 */
async function closeBrave(handle) {
  if (!handle) return;
  try {
    await handle.context.close();
  } catch (e) {
    process.stderr.write(`[mcp-relay] cdp-bridge close failed: ${e.message}\n`);
  }
}

/**
 * Poll /json/version (the standard CDP discovery endpoint) until it returns
 * 200, or timeout. Throws on timeout. Used after launchPersistentContext to
 * confirm the CDP endpoint is reachable before letting upstream try to attach.
 */
async function waitForCdpReady(port, timeoutMs) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (resp.ok) return;
      lastErr = new Error(`status ${resp.status}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `[mcp-relay] CDP endpoint http://127.0.0.1:${port}/json/version not ready after ${timeoutMs}ms: ${lastErr?.message || "unknown"}`,
  );
}

module.exports = { launchBrave, closeBrave, waitForCdpReady };
