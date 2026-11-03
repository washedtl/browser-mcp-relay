// brave-supervisor.js — the broker's ONE Brave on ONE persistent profile.
//
// Raw `spawn` (not Playwright), so the flags are exactly ours. Owns the
// launch, the PID, CDP readiness, crash detection, the wait-for-old-PID
// before a relaunch, and graceful close. Every number quoted below was
// measured by the W2-S spike or the W2C build (Brave 147, Windows 11,
// elevated Claude Code), see docs/plans/2026-11-03-broker-design.md.

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const WebSocket = require("ws");
const { detectBravePath } = require("../detect-browser.js");

const PREFIX = "[mcp-relay] brave-supervisor:";
const KILL_WAIT_MS = 5000;

/**
 * Supervises one Brave on one persistent profile.
 *
 *   ensure()          → {cdpUrl, pid}; launches if needed, concurrent calls share one launch
 *   closeGracefully() → Browser.close over CDP, kill fallback after closeTimeoutMs
 *   isUp()            → launched, CDP connected, PID alive
 *   proxyCredentials  → {username, password} of the proxy the last launched Brave uses, or null
 *   'down' (reason)   → once per launch that came up: "closed" | "cdp disconnected" | "exited (code=N)"
 *   'fatal' (reason)  → a relaunch cannot get back the CDP port a Brave of
 *                       ours already served cdpUrl on (still taken after
 *                       portFreeWaitMs); ensure() rejects as well. The port
 *                       is fixed for the supervisor's life, so a later
 *                       ensure() only succeeds if that port frees again.
 *                       Policy: the broker exits on 'fatal' so the shims
 *                       start a fresh broker on a new port. Not emitted for
 *                       a port that never served a launch that came up.
 *
 * Death is detected on our own browser-level CDP websocket (its close fires
 * at once; the process exit lags 20 ms-2 s) and on the process exit. After
 * an unexpected 'down' the PID gets exitWaitMs to exit, then is killed, and a
 * relaunch always waits for it: a new brave.exe on a profile whose old
 * Brave is still exiting hands off to it and exits.
 */
class BraveSupervisor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.profileDir — persistent --user-data-dir (created if missing)
   * @param {number} [opts.port=0] — CDP port, fixed for the supervisor's whole
   *   life: caller-chosen, or (0) OS-assigned at the first launch. Every
   *   relaunch reuses it, because upstream reads BROWSER_CDP_ENDPOINT_URL once
   *   per broker process. If it is still taken after portFreeWaitMs, the
   *   launch fails; it never switches ports.
   * @param {string} [opts.executablePath] — default: detectBravePath() at first launch
   * @param {string|null} [opts.extensionPath] — unpacked extension for --load-extension
   * @param {boolean} [opts.headless=false] — --headless=new (BROWSER_HEADLESS_ENABLE, as in legacy mode)
   * @param {string|null} [opts.proxyUrl] — --proxy-server (scheme://host:port only);
   *   policy in resolveProxy(); credentials go to `proxyCredentials`
   * @param {(msg: string) => void} [opts.log] — default: stderr
   * @param {number} [opts.launchTimeoutMs=20000] — spawn → CDP ready
   * @param {number} [opts.closeTimeoutMs=10000] — Browser.close → exit, then kill
   * @param {number} [opts.exitWaitMs=5000] — unexpected 'down' → exit, then kill
   * @param {number} [opts.portFreeWaitMs=3000] — relaunch: wait for our port to free
   * @param {number} [opts.proxyProbeTimeoutMs=1500]
   * @param {typeof spawn} [opts._spawn] — test seam
   */
  constructor(opts = {}) {
    super();
    if (!opts.profileDir) throw new Error(`${PREFIX} profileDir is required`);
    const port = opts.port || 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`${PREFIX} invalid CDP port ${opts.port}`);
    this.profileDir = path.resolve(opts.profileDir);
    this._callerPort = port; // 0 = OS-assigned
    this._port = port;
    this._portUsed = false; // true once a launch on it came up (cdpUrl handed out)
    this._executablePath = opts.executablePath || null;
    this._extensionPath = opts.extensionPath || null;
    this._headless = Boolean(opts.headless);
    this._proxyUrl = opts.proxyUrl || null;
    this._log = opts.log || ((m) => process.stderr.write(`${PREFIX} ${m}\n`));
    this._t = {
      launchTimeoutMs: opts.launchTimeoutMs || 20000,
      closeTimeoutMs: opts.closeTimeoutMs || 10000,
      exitWaitMs: opts.exitWaitMs || 5000,
      portFreeWaitMs: opts.portFreeWaitMs || 3000,
      proxyProbeTimeoutMs: opts.proxyProbeTimeoutMs || 1500,
    };
    this._spawn = opts._spawn || spawn;
    this._proc = null;
    this._launching = null;
    this._closing = null;
    this._launches = 0;
    this._proxyCredentials = null;
  }

  /** @returns {boolean} */
  isUp() {
    const p = this._proc;
    return !!p && p.up && isPidAlive(p.pid);
  }

  /**
   * Credentials of the proxy the last launched Brave routes through, or null
   * (no proxy, or a dead loopback proxy sent it direct). They are never on
   * Brave's command line, so an authenticating proxy answers 407 until the
   * broker supplies them (W2A/W2E).
   *
   * Answer ONLY proxy challenges: CDP Fetch.enable({handleAuthRequests: true})
   * and, on Fetch.authRequired, ProvideCredentials when
   * authChallenge.source === "Proxy", else "Default". Do NOT use Playwright's
   * context.setHTTPCredentials(): its handler (crNetworkManager
   * _onAuthRequired) ignores authChallenge.source, so it would also hand the
   * proxy password to any website that sends a 401 Basic challenge.
   * Chromium cannot authenticate to SOCKS proxies at all.
   *
   * @returns {{username: string, password: string} | null}
   */
  get proxyCredentials() {
    return this._proxyCredentials ? { ...this._proxyCredentials } : null;
  }

  /** @returns {Promise<{cdpUrl: string, pid: number}>} */
  async ensure() {
    for (;;) {
      // Never race a relaunch against a planned close of the same profile.
      while (this._closing) await this._closing;
      if (this.isUp()) return cdpInfo(this._proc);
      if (!this._launching) {
        this._launching = this._launch().finally(() => { this._launching = null; });
      }
      const info = await this._launching;
      // A closeGracefully() that started while this launch was in flight is
      // tearing that Brave down: go round again (wait for it, relaunch)
      // rather than hand out a Brave that is about to close.
      if (!this._closing) return info;
    }
  }

  /**
   * Browser.close over CDP (Chromium flushes cookies only every ~30 s, so a
   * hard kill loses recent logins), then kill if it has not exited within
   * closeTimeoutMs. Concurrent calls share one close.
   *
   * @returns {Promise<{graceful: boolean, ms: number} | null>} null if Brave was not running
   */
  closeGracefully() {
    if (!this._closing) {
      this._closing = this._close().finally(() => { this._closing = null; });
    }
    return this._closing;
  }

  async _close() {
    if (this._launching) await this._launching.catch(() => {});
    const proc = this._proc;
    if (!proc || proc.exited) return null;
    const t0 = Date.now();
    proc.closing = true;
    // A Brave whose CDP already dropped may be mid-shutdown (exit lags the
    // disconnect by up to ~2 s): let it finish its flush. Its background
    // reap still kills it after exitWaitMs, so that case waits
    // min(exitWaitMs, closeTimeoutMs).
    if (proc.up && proc.ws.readyState === WebSocket.OPEN) {
      proc.ws.send(JSON.stringify({ id: proc.nextId++, method: "Browser.close" }));
    }
    if (!(await waitExit(proc, this._t.closeTimeoutMs))) {
      this._log(`brave pid=${proc.pid} still running ${this._t.closeTimeoutMs} ms after close was requested; killing it (cookie changes since the last flush may be lost)`);
      await this._kill(proc);
    }
    this._onDown(proc, "closed");
    const graceful = !proc.killed;
    const ms = Date.now() - t0;
    this._log(`brave pid=${proc.pid} ${graceful ? "closed gracefully" : "killed"} in ${ms} ms`);
    return { graceful, ms };
  }

  async _launch() {
    const prev = this._proc;
    if (prev && !prev.exited) await this._reap(prev);
    const exe = this._executablePath || (this._executablePath = detectBravePath());
    fs.mkdirSync(this.profileDir, { recursive: true });
    disableMemorySaver(this.profileDir, this._log);
    const proxy = await resolveProxy(this._proxyUrl, { log: this._log, timeoutMs: this._t.proxyProbeTimeoutMs });
    const proxyServer = proxy ? proxy.server : null;
    // Last step before the spawn: the proxy probe can take 1.5 s, and a port
    // taken in that window must fail loudly here, not as a 20 s CDP timeout.
    const port = await this._choosePort();
    const args = buildBraveArgs({ port, profileDir: this.profileDir, extensionPath: this._extensionPath, proxyServer, headless: this._headless });
    const t0 = Date.now();
    const proc = this._spawnBrave(exe, args, port);
    this._proc = proc;
    try {
      await this._waitUntilUp(proc, exe, t0);
    } catch (e) {
      await this._kill(proc);
      throw e;
    }
    this._portUsed = true; // from here on cdpUrl is out there: the port is pinned
    this._proxyCredentials = proxy ? proxy.credentials : null;
    this._launches++;
    const via = proxyServer ? `, traffic via proxy ${proxyServer}` : "";
    this._log(`brave pid=${proc.pid} up on :${port} in ${Date.now() - t0} ms (launch #${this._launches}${via})`);
    return cdpInfo(proc);
  }

  async _choosePort() {
    // An OS-assigned port is only pinned once a launch came up (ensure() has
    // handed out the cdpUrl); until then nobody can depend on it.
    if (!this._callerPort && !this._portUsed) {
      this._port = await pickFreePort();
      return this._port;
    }
    // A relaunch waits briefly for our old Brave's port to free; a first
    // launch on a caller-chosen port fails at once.
    const deadline = Date.now() + (this._portUsed ? this._t.portFreeWaitMs : 0);
    while (!(await portIsFree(this._port))) {
      if (Date.now() >= deadline) {
        const reason =
          `CDP port ${this._port} is in use by another process. This broker keeps one port ` +
          `for its whole life (upstream pins BROWSER_CDP_ENDPOINT_URL), so it will not switch; free the port or restart the broker.`;
        // Lost the port our Brave already used: only a new broker (new port) recovers.
        if (this._portUsed) this._emitSafe("fatal", reason);
        throw new Error(`${PREFIX} ${reason}`);
      }
      await sleep(100);
    }
    return this._port;
  }

  _spawnBrave(exe, args, port) {
    const child = this._spawn(exe, args, { stdio: "ignore", env: braveEnv(process.env) });
    const proc = {
      child, pid: child.pid, port, ws: null, nextId: 1,
      up: false, down: false, closing: false, killed: false, exited: false, exitCode: null, spawnError: null, reaping: null,
    };
    proc.exitPromise = new Promise((resolve) => {
      const onExit = (code, signal) => {
        if (proc.exited) return;
        proc.exited = true;
        proc.exitCode = code ?? signal;
        resolve();
        this._onDown(proc, proc.closing ? "closed" : `exited (code=${proc.exitCode})`);
      };
      child.once("exit", onExit);
      child.once("error", (e) => {
        proc.spawnError = e;
        if (!child.pid) onExit(null, "spawn-error");
      });
    });
    return proc;
  }

  async _waitUntilUp(proc, exe, t0) {
    let version = null;
    for (;;) {
      if (proc.spawnError) throw new Error(`${PREFIX} could not start ${exe}: ${proc.spawnError.message}`);
      if (proc.exited) {
        throw new Error(
          `${PREFIX} Brave exited during launch (code=${proc.exitCode}) after ${Date.now() - t0} ms. ` +
          `If another Brave already runs on ${this.profileDir}, a new one hands off to it and exits; close that Brave first.`,
        );
      }
      version = await fetchVersion(proc.port);
      if (version && version.webSocketDebuggerUrl) break;
      if (Date.now() - t0 > this._t.launchTimeoutMs) {
        throw new Error(`${PREFIX} Brave CDP on :${proc.port} not ready after ${this._t.launchTimeoutMs} ms`);
      }
      await sleep(100);
    }
    proc.ws = await openWebSocket(version.webSocketDebuggerUrl, 5000);
    proc.ws.on("error", () => { /* 'close' follows */ });
    proc.ws.on("close", () => this._onDown(proc, proc.closing ? "closed" : "cdp disconnected"));
    // Only adopt the CDP endpoint if it is OUR process behind it: after an
    // AutoDeElevate-style handoff, or with a foreign browser on the port,
    // /json/version answers but the PID we track is not the browser.
    // Deliberately fail-OPEN (V2-6): if getProcessInfo itself errors or times
    // out we only warn and adopt the endpoint, so a Brave that drops or
    // changes this method can't brick every launch. A PID mismatch fails.
    const browserPid = await cdpBrowserPid(proc);
    if (proc.down || proc.exited) throw new Error(`${PREFIX} Brave pid ${proc.pid} went away during launch`);
    if (browserPid === null) {
      this._log(`warning: could not confirm that CDP on :${proc.port} is pid ${proc.pid} (SystemInfo.getProcessInfo failed)`);
    } else if (browserPid !== proc.pid) {
      throw new Error(`${PREFIX} CDP on :${proc.port} is served by browser pid ${browserPid}, not the Brave we launched (pid ${proc.pid})`);
    }
    proc.up = true;
  }

  _onDown(proc, reason) {
    if (proc.down) return;
    proc.down = true;
    const wasUp = proc.up;
    proc.up = false;
    if (proc.ws) proc.ws.terminate();
    if (!wasUp) return;
    if (!proc.exited && !proc.closing) this._reap(proc).catch((e) => this._log(e.message));
    this._log(`brave pid=${proc.pid} down: ${reason}`);
    this._emitSafe("down", reason);
  }

  /**
   * Emits run inside ws/process event handlers, close() and launch: a
   * throwing listener must not become an uncaught exception or change what
   * the supervisor does next.
   */
  _emitSafe(event, reason) {
    // Each listener on its own: emit() stops at the first one that throws,
    // and the ones after it (e.g. the session registry) must still hear it.
    for (const listener of this.listeners(event)) {
      try {
        listener.call(this, reason);
      } catch (e) {
        this._log(`a '${event}' listener threw: ${e.message}`);
      }
    }
  }

  /** Wait for a downed Brave to exit; kill it after exitWaitMs. Memoized per process. */
  _reap(proc) {
    if (!proc.reaping) {
      const p = (async () => {
        if (await waitExit(proc, this._t.exitWaitMs)) return;
        this._log(`brave pid=${proc.pid} still running ${this._t.exitWaitMs} ms after it went down; killing it`);
        if (!(await this._kill(proc))) {
          throw new Error(`${PREFIX} brave pid ${proc.pid} survived a kill; not relaunching on ${this.profileDir}`);
        }
      })();
      proc.reaping = p;
      p.catch(() => { if (proc.reaping === p) proc.reaping = null; });
    }
    return proc.reaping;
  }

  /**
   * Hard-kill a Brave WE spawned, through the process handle Node holds (no
   * PID lookup, so nothing recycled can be hit). Root only: measured, its
   * renderer/GPU/utility/crashpad children all exit within 300 ms on their
   * own, while a /T tree walk by parent PID could reach unrelated processes.
   */
  async _kill(proc) {
    if (proc.exited) return true;
    proc.killed = true;
    proc.child.kill("SIGKILL");
    return waitExit(proc, KILL_WAIT_MS);
  }
}

function cdpInfo(proc) {
  return { cdpUrl: `http://127.0.0.1:${proc.port}`, pid: proc.pid };
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function waitExit(proc, ms) {
  if (proc.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    proc.exitPromise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchVersion(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function openWebSocket(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`${PREFIX} CDP websocket did not open within ${timeoutMs} ms`));
    }, timeoutMs);
    ws.once("open", () => { clearTimeout(timer); resolve(ws); });
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

/** The browser process id CDP reports, or null if it can't be read. */
function cdpBrowserPid(proc, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const id = proc.nextId++;
    const done = (pid) => {
      clearTimeout(timer);
      proc.ws.off("message", onMessage);
      proc.ws.off("close", onClose);
      resolve(pid);
    };
    const onMessage = (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.id !== id) return;
      const browser = msg.result && (msg.result.processInfo || []).find((p) => p.type === "browser");
      done(browser ? browser.id : null);
    };
    const onClose = () => done(null);
    const timer = setTimeout(() => done(null), timeoutMs);
    proc.ws.on("message", onMessage);
    proc.ws.on("close", onClose);
    proc.ws.send(JSON.stringify({ id, method: "SystemInfo.getProcessInfo" }));
  });
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen({ port, host: "127.0.0.1", exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen({ port: 0, host: "127.0.0.1", exclusive: true }, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Brave's command line. The design-§3 flag set, plus the two optional extras.
 *
 * @param {object} opts
 * @param {number} opts.port — CDP port
 * @param {string} opts.profileDir — persistent --user-data-dir
 * @param {string|null} [opts.extensionPath] — unpacked extension dir
 * @param {string|null} [opts.proxyServer] — already-probed proxy server string
 * @param {boolean} [opts.headless]
 * @returns {string[]}
 */
function buildBraveArgs({ port, profileDir, extensionPath = null, proxyServer = null, headless = false }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // CDP still comes up (0 pages) and Target.createTarget{newWindow} still
    // works; without it Brave opens a window and steals the OS foreground.
    "--no-startup-window",
    // AutoDeElevate: spawned from an elevated process, brave.exe relaunches
    // itself de-elevated and the PID we spawned exits in ~150-750 ms, so
    // kills and crash detection hit nothing. Keep this ONE switch: Chromium
    // reads only the last copy of a repeated switch (measured: adding a second
    // --disable-features dropped AutoDeElevate and Brave exited, code 0, 183 ms).
    "--disable-features=AutoDeElevate,CalculateNativeWinOcclusion",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ];
  // Deliberately absent: Playwright's --enable-automation (infobar + bot
  // tells) and --use-mock-keychain (breaks DPAPI cookie decryption).
  if (extensionPath) args.push(`--load-extension=${extensionPath}`);
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  if (headless) args.push("--headless=new");
  return args;
}

/**
 * Turn Memory Saver off before launch (discarded tabs hang connectOverCDP).
 *
 * The pref is `performance_tuning.high_efficiency_mode.state` (0 = off) and
 * Brave 147 keeps it in `<profile>/Local State`, NOT `Default/Preferences`
 * (measured: a value pre-written to Local State is what chrome://settings
 * reports; the same key in Default/Preferences is ignored). Must run while
 * Brave is NOT running on the profile, or Brave overwrites it on exit.
 *
 * Local State also holds os_crypt.encrypted_key (the cookie key), so the
 * write is atomic (temp file + rename) and a file we can't parse is left
 * alone.
 *
 * @param {string} profileDir
 * @param {(msg: string) => void} [log]
 * @returns {boolean} true if the file was written
 */
function disableMemorySaver(profileDir, log = () => {}) {
  const file = path.join(profileDir, "Local State");
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") {
      log(`warning: could not read ${file} (${e.message}); leaving Memory Saver as it is`);
      return false;
    }
  }
  if (!isObject(state)) {
    log(`warning: ${file} is not a JSON object; leaving Memory Saver as it is`);
    return false;
  }
  const tuning = isObject(state.performance_tuning) ? state.performance_tuning : (state.performance_tuning = {});
  const mode = isObject(tuning.high_efficiency_mode) ? tuning.high_efficiency_mode : (tuning.high_efficiency_mode = {});
  if (mode.state === 0) return false;
  mode.state = 0;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    // fsync before the rename: after a power cut the rename must not land
    // without the data (this file holds the cookie key).
    const fd = fs.openSync(tmp, "w");
    try {
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing written */ }
    log(`warning: could not write ${file} (${e.message}); Memory Saver may stay on`);
    return false;
  }
  return true;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const PROXY_DEFAULT_PORTS = { http: 80, https: 443, socks4: 1080, socks5: 1080 };

/**
 * The proxy for one Brave launch: `{server, credentials}`, or null to launch
 * direct. Same policy as the legacy relay (W1E-6, cdp-bridge.js), ported
 * rather than required because cdp-bridge.js is a W3 deletion:
 *
 *   reachable                 → use it
 *   LOOPBACK + not listening  → direct (the owner's local debug proxy is
 *                               usually off; a dead --proxy-server fails every
 *                               navigation, and a local proxy can't hide the
 *                               real IP anyway)
 *   REMOTE + unreachable/slow → KEEP it, loud warning: going direct would
 *                               silently expose the real IP (PX-protected sites)
 *   unusable URL              → throw (never guess "direct")
 *
 * Probed with a TCP connect capped at `timeoutMs` (a closed localhost port
 * takes ~2.3 s to refuse on Windows). Logs and errors show scheme://host:port
 * only, never the raw URL or its credentials. Credentials come back
 * separately: --proxy-server cannot carry them, and on a command line they
 * would be visible in any process listing.
 *
 * @param {string|null} proxyUrl — e.g. http://user:pass@host:port, socks5://h:1080, or bare host:port
 * @param {object} [opts]
 * @param {(msg: string) => void} [opts.log]
 * @param {number} [opts.timeoutMs=1500]
 * @returns {Promise<{server: string, credentials: {username: string, password: string}|null} | null>}
 */
async function resolveProxy(proxyUrl, { log = () => {}, timeoutMs = 1500 } = {}) {
  if (!proxyUrl) return null;
  const target = parseProxyUrl(proxyUrl);
  const reachable = await tcpAccepts(target.host, target.port, timeoutMs);
  if (!reachable && isLoopbackHost(target.host)) {
    log(`warning: proxy ${target.server} is not listening; launching Brave direct (no proxy). The next Brave launch checks again.`);
    return null;
  }
  if (!reachable) {
    log(
      `WARNING: proxy ${target.server} is NOT reachable (checked for ${timeoutMs} ms); keeping it anyway, so Brave's ` +
      `requests fail until it is up. Not falling back to direct, which would expose the real IP.`,
    );
  }
  return { server: target.server, credentials: target.credentials };
}

/** Same as cdp-bridge.js (W1E): 127.0.0.0/8, localhost and its subdomains, ::1. */
function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1") return true;
  return net.isIPv4(h) && h.startsWith("127.");
}

/** Throws on anything unusable; messages never echo the value (it may hold a password). */
function parseProxyUrl(proxyUrl) {
  const s = String(proxyUrl).trim();
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  } catch {
    u = null;
  }
  if (!u || !u.hostname) {
    throw new Error(`${PREFIX} the proxy URL is not valid (expected scheme://[user:pass@]host:port)`);
  }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (!(scheme in PROXY_DEFAULT_PORTS)) {
    throw new Error(`${PREFIX} proxy scheme "${scheme}" is not supported (use http, https, socks4 or socks5)`);
  }
  let credentials = null;
  if (u.username || u.password) {
    try {
      credentials = { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
    } catch {
      throw new Error(`${PREFIX} the proxy credentials contain an invalid %-escape (write a literal % as %25)`);
    }
  }
  const port = u.port ? Number(u.port) : PROXY_DEFAULT_PORTS[scheme];
  return { server: `${scheme}://${u.hostname}:${port}`, host: u.hostname.replace(/^\[|\]$/g, ""), port, credentials };
}

function tcpAccepts(host, port, timeoutMs) {
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
 * Brave's environment: the broker's, minus relay-internal BROWSER_RELAY_*
 * vars (same rule as cdp-bridge.js) and minus HTTP(S)_PROXY / ALL_PROXY, so
 * `--proxy-server` is the only proxy decision and "direct" means direct.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function braveEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("BROWSER_RELAY_")) continue;
    if (/^(http|https|all)_proxy$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  BraveSupervisor,
  buildBraveArgs,
  disableMemorySaver,
  resolveProxy,
  isLoopbackHost,
  braveEnv,
};
