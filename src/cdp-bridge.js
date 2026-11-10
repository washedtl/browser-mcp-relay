// cdp-bridge.js — launches Brave for a slot via Playwright launchPersistentContext
// with a remote-debugging-port that BOTH our relay AND upstream attach to via
// chromium.connectOverCDP. See docs/probe-cdp-access.js for the standalone
// probe used to verify this architecture.
//
// Legacy mode only, and it keeps that TCP port: it is unauthenticated, so
// while this Brave runs any local process can drive it and read its cookies.
// Broker mode has no port (W2G: src/broker/brave-supervisor.js runs Brave on
// --remote-debugging-pipe, src/broker/cdp-proxy.js serves it behind a secret).

const net = require("node:net");
const { chromium } = require("playwright-core");
const { applyLocalConfigToEnv } = require("./local-config.js");

// Loopback stays direct when a proxy is in use (Playwright otherwise adds
// `<-loopback>`, which sends even localhost through the proxy).
const PROXY_BYPASS = "localhost,127.0.0.1,[::1]";
const PROXY_PROBE_TIMEOUT_MS = 1500;
const DEFAULT_PROXY_PORTS = { "http:": 80, "https:": 443, "socks4:": 1080, "socks5:": 1080 };

/**
 * W1E-6 (2026-11-03): parse BROWSER_RELAY_PROXY_URL into Playwright's
 * `proxy` launch option plus the host/port to probe. Credentials move to
 * username/password: Chromium's --proxy-server takes none inline, and inline
 * ones would sit in Brave's command line (visible in any process listing)
 * and in our log. A scheme-less value ("127.0.0.1:8888",
 * "user:pass@host:port") is read as http://. Throws a clear error — never
 * echoing the value, which may hold a password — on anything unusable.
 */
function parseProxyUrl(proxyUrl) {
  const raw = String(proxyUrl).trim();
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw); }
  catch { throw new Error("[mcp-relay] BROWSER_RELAY_PROXY_URL is not a valid proxy URL (expected scheme://[user:pass@]host:port)"); }
  if (!(u.protocol in DEFAULT_PROXY_PORTS)) {
    throw new Error(`[mcp-relay] BROWSER_RELAY_PROXY_URL scheme "${u.protocol}" is not supported (use http, https, socks4 or socks5)`);
  }
  const proxy = { server: `${u.protocol}//${u.host}`, bypass: PROXY_BYPASS };
  try {
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
  } catch {
    throw new Error("[mcp-relay] BROWSER_RELAY_PROXY_URL credentials contain an invalid %-escape (write a literal % as %25)");
  }
  return {
    proxy,
    host: u.hostname.replace(/^\[|\]$/g, ""),
    port: u.port ? Number(u.port) : DEFAULT_PROXY_PORTS[u.protocol],
  };
}

function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  return net.isIPv4(h) && h.startsWith("127.");
}

/** Can we open a TCP connection to host:port within timeoutMs? */
function probeTcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

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
 * @param {string|null} [opts.proxyUrl] — when set, Brave's outbound traffic
 *   routes through this proxy (Playwright `proxy` launch option →
 *   --proxy-server; loopback bypassed), e.g. a local debug proxy like
 *   Charles, mitmproxy, powhttp, and TLS errors are ignored for its MITM
 *   cert. A loopback proxy that isn't listening at launch is skipped (Brave
 *   goes direct); a remote one is always kept. The user's system proxy
 *   stays untouched — only this launched Brave opts in.
 * @param {(host: string, port: number, timeoutMs: number) => Promise<boolean>} [opts._probeProxy] — test seam
 * @param {NodeJS.ProcessEnv} [opts._relayEnv] — test seam: local-config-merged env
 * @returns {Promise<{ context: import('playwright-core').BrowserContext, cdpConnectUrl: string }>}
 */
async function launchBrave({
  userDataDir,
  port,
  headless = false,
  extensionPath = null,
  executablePath,
  proxyUrl = null,
  _probeProxy = probeTcp,
  _relayEnv = applyLocalConfigToEnv(process.env),
}) {
  // Per-process proxy whitelist: when proxyUrl is set, this Brave's
  // outbound traffic routes through it. The user's system proxy stays off —
  // only this launched Brave opts in. W1E-6: Playwright's `proxy` option
  // (→ --proxy-server) instead of HTTP_PROXY / HTTPS_PROXY env, which
  // Chromium ignores on Windows.
  //
  // W1E V1-1: that env var being ignored is why a configured-but-stopped
  // local debug proxy (e.g. 127.0.0.1:8888) used to be harmless. A real
  // --proxy-server to a dead port fails every navigation, so probe it once
  // here. Loopback + unreachable → launch direct (a local proxy can't hide
  // the real IP anyway). Remote + unreachable → keep it: going direct would
  // silently expose the real IP.
  let proxy = null;
  let proxyIsLoopback = false;
  if (proxyUrl) {
    const parsed = parseProxyUrl(proxyUrl);
    const reachable = await _probeProxy(parsed.host, parsed.port, PROXY_PROBE_TIMEOUT_MS);
    if (!reachable && isLoopbackHost(parsed.host)) {
      process.stderr.write(
        `[mcp-relay] WARNING: proxy ${parsed.proxy.server} is not listening — launching Brave DIRECT (no proxy). ` +
        `Checked only at launch: start the proxy, then restart the relay to route through it.\n`,
      );
    } else {
      if (!reachable) {
        process.stderr.write(
          `[mcp-relay] WARNING: proxy ${parsed.proxy.server} is NOT reachable — keeping it anyway; Brave's requests will fail until it is up. ` +
          `Not falling back to direct, which would expose your real IP.\n`,
        );
      }
      proxy = parsed.proxy;
      proxyIsLoopback = isLoopbackHost(parsed.host);
      process.stderr.write(
        `[mcp-relay] proxy whitelist ACTIVE — Brave traffic routes through ${proxy.server}\n`,
      );
    }
  }

  // --do-not-de-elevate: precaution, as in the broker's launch (there, Brave
  // 157 relaunched itself from an elevated parent and the process exited).
  const args = [`--remote-debugging-port=${port}`, "--do-not-de-elevate"];
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
    // Accept any TLS cert — ONLY while a LOOPBACK proxy is in use (W1E-6;
    // W2E: a remote proxy, e.g. a residential one, must never be able to MITM
    // the profile holding every login), or when the user opts in with
    // BROWSER_RELAY_IGNORE_HTTPS_ERRORS=true (env or local-config.json; e.g. a
    // corporate MITM proxy configured at the OS level). A debug proxy presents its own MITM cert, and Chromium's cert
    // verifier under Playwright doesn't reliably honor user-installed
    // Windows roots, so navigation through it can throw
    // ERR_CERT_AUTHORITY_INVALID even with the CA trusted at the OS level.
    // Otherwise there's no reason to: unconditional acceptance let any
    // network MITM through silently, including on pages the vault autofills.
    //
    // Scoped to this BrowserContext only — does not affect the user's main
    // browser. Preferred over `--ignore-certificate-errors` because that flag
    // requires `--test-type=webdriver`, which suppresses Brave's password-
    // manager UI.
    ignoreHTTPSErrors: proxyIsLoopback || _relayEnv.BROWSER_RELAY_IGNORE_HTTPS_ERRORS === "true",
    handleSIGINT: false,
    handleSIGTERM: false,
  };
  if (executablePath) launchOpts.executablePath = executablePath;

  // W0-7 (2026-05-09): unconditionally strip BROWSER_RELAY_* env vars from
  // the env passed to Brave. Previously the strip only happened when proxyUrl
  // was set — when proxyUrl was unset, no `env` was set on launchOpts at all,
  // so Playwright defaulted to passing process.env wholesale to Chromium.
  // BROWSER_RELAY_INSPECTOR_PORT, BROWSER_RELAY_VAULT_FILES, BROWSER_RELAY_*
  // are relay-internal and shouldn't be visible to Brave (which would try
  // to interpret them on a chrome:// extension page that loads Node-aware
  // code, etc.). Always sanitize.
  const sanitizedEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("BROWSER_RELAY_")) continue; // relay-internal
    sanitizedEnv[k] = v;
  }

  if (proxy) launchOpts.proxy = proxy;
  launchOpts.env = sanitizedEnv;

  const context = await chromium.launchPersistentContext(userDataDir, launchOpts);

  // Wait for the CDP HTTP endpoint to respond before returning. Upstream's
  // connectOverCDP will hit /json/version, so we want it ready first.
  //
  // V0-3: launchPersistentContext returned a LIVE context that holds a file
  // lock on userDataDir. If waitForCdpReady throws (timeout, unreachable CDP),
  // the context would leak forever — the lock blocks any other relay from
  // claiming this slot until the user reboots / kills brave.exe by hand. So
  // we close the context on any waitForCdpReady failure before re-throwing.
  // attachWithCleanupOnError in index.js only wraps post-launch steps, so
  // this cleanup must live here.
  try {
    await waitForCdpReady(port, 10000);
  } catch (e) {
    try { await context.close(); }
    catch (closeErr) {
      process.stderr.write(
        `[mcp-relay] cdp-bridge: context.close() failed during waitForCdpReady cleanup: ${closeErr.message}\n`,
      );
    }
    throw e;
  }

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
