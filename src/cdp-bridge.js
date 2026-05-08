// cdp-bridge.js — launches Brave for a slot via Playwright launchPersistentContext
// with a remote-debugging-port that BOTH our relay AND upstream attach to via
// chromium.connectOverCDP. See docs/probe-cdp-access.js for the standalone
// probe used to verify this architecture.

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
 * @param {string|null} [opts.proxyUrl] — when set, Brave inherits HTTP_PROXY /
 *   HTTPS_PROXY env so its outbound traffic routes through an HTTP proxy you
 *   control (e.g. a local debug proxy like Charles, mitmproxy, powhttp). The
 *   user's system proxy stays untouched — only this launched Brave opts in.
 * @returns {Promise<{ context: import('playwright-core').BrowserContext, cdpConnectUrl: string }>}
 */
async function launchBrave({
  userDataDir,
  port,
  headless = false,
  extensionPath = null,
  executablePath,
  proxyUrl = null,
}) {
  const args = [`--remote-debugging-port=${port}`];
  // Strip Playwright's default `--use-mock-keychain`. That flag tells Chromium
  // to bypass the OS keychain (DPAPI on Windows, Keychain on macOS, libsecret
  // on Linux), which prevents Brave from unwrapping `Local State.os_crypt
  // .encrypted_key` and decrypting the v10 encrypted_value blobs in Cookies /
  // Login Data SQLite. Result: cookies and DPAPI-protected password rows
  // copied from the snapshot source decrypt as garbage.
  //
  // Caveat: Brave 127+ App-Bound Encryption (ABE) wraps a separate
  // `app_bound_encrypted_key` validated by an elevated COM service that
  // checks the calling exe identity. Removing mock-keychain restores the
  // OS keychain fallback path, so v10 rows decrypt; v20 (ABE-only) rows may
  // still fail under Playwright-launched Brave.
  const ignoreDefaultArgs = ["--use-mock-keychain"];
  if (extensionPath) {
    args.push(`--load-extension=${extensionPath}`);
    args.push(`--disable-extensions-except=${extensionPath}`);
    ignoreDefaultArgs.push("--disable-extensions");
  }
  const launchOpts = {
    headless,
    args,
    ignoreDefaultArgs,
    // Accept any TLS cert. Useful when Brave is routed through a debug proxy
    // (see proxyUrl below) that presents its own MITM cert, or behind a
    // corporate proxy with a private CA. Chromium's built-in cert verifier
    // under Playwright doesn't reliably honor user-installed Windows roots,
    // so navigation through a MITM cert can throw ERR_CERT_AUTHORITY_INVALID
    // even with the CA trusted at the OS level.
    //
    // Scoped to this BrowserContext only — does not affect the user's main
    // browser. Preferred over `--ignore-certificate-errors` because that flag
    // requires `--test-type=webdriver`, which suppresses Brave's password-
    // manager UI.
    ignoreHTTPSErrors: true,
    handleSIGINT: false,
    handleSIGTERM: false,
  };
  if (executablePath) launchOpts.executablePath = executablePath;

  // Per-process proxy whitelist: when proxyUrl is set, Brave inherits
  // HTTP_PROXY / HTTPS_PROXY env so outbound traffic routes through the
  // configured HTTP proxy. The user's system proxy stays off — only this
  // launched Brave opts in.
  if (proxyUrl) {
    launchOpts.env = { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl };
    process.stderr.write(
      `[mcp-relay] proxy whitelist ACTIVE — Brave traffic routes through ${proxyUrl}\n`,
    );
  }

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
