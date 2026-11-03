// brave-supervisor.js — the broker's ONE Brave on ONE persistent profile.
//
// Raw `spawn` (not Playwright), so the flags are exactly ours. Owns the
// launch, the PID, CDP readiness, crash detection, the wait-for-old-PID
// before a relaunch, and graceful close. Every number quoted below was
// measured while building the broker (Brave 147, Windows 11, elevated
// Claude Code).
//
// W2G: CDP runs over --remote-debugging-pipe (fd 3/4), not a TCP port, so no
// other local process can reach Brave. The supervisor keeps the pipe's root
// session; each verified launch's pipe is handed out ('pipe') to the
// broker's CdpProxy, which serves every other CDP client (cdp-proxy.js).

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PipeConnection } = require("./cdp-proxy.js");
const { detectBravePath } = require("../detect-browser.js");

const PREFIX = "[mcp-relay] brave-supervisor:";
const KILL_WAIT_MS = 5000;
const CLOSE_TIMEOUT_MS = 10000;
const SHUTDOWN_GRACE_MS = 20000;
// An unexpected pipe EOF → the process exit, then a kill. EOF comes first:
// measured, Brave exited 3.9 s after closing its pipe (graceful close, young
// profile), so a Brave shutting down on its own gets time to flush cookies.
const EXIT_WAIT_MS = 10000;
// fd 3: Brave reads (we write), fd 4: Brave writes. stderr is ignored: an
// unread pipe would fill and stall Brave.
const STDIO = Object.freeze(["ignore", "ignore", "ignore", "pipe", "pipe"]);
// Chromium's exit code when another browser process holds the profile
const RESULT_CODE_PROFILE_IN_USE = 21;

/**
 * Supervises one Brave on one persistent profile.
 *
 *   ensure()          → {pid}; launches if needed, concurrent calls share one launch
 *   closeGracefully() → Browser.close over CDP, kill fallback (see _close)
 *   isUp()            → launched, CDP pipe connected, PID alive
 *   checkAlive()      → isUp(), after a PID found gone has gone 'down' at once
 *   pid               → the running Brave's PID, or null
 *   proxyCredentials  → {username, password} of the proxy the last launched Brave uses, or null
 *   'pipe' (pipe)     → once per launch that came up, before ensure() resolves:
 *                       its PipeConnection, verified (PID check) and with the
 *                       certificate policy set. Give it to the CdpProxy.
 *   'down' (reason)   → once per launch that came up: "closed" | "cdp disconnected" | "exited (code=N)" | "exited (pid gone)"
 *
 * Death is detected on the CDP pipe (EOF 26 ms after a kill; the process
 * exit came at 84 ms) and on the process exit. After an unexpected 'down'
 * the PID gets exitWaitMs to exit, then is killed, and a relaunch always
 * waits for it: a new brave.exe on a profile whose old Brave is still
 * exiting hands off to it and exits.
 *
 * A Brave this supervisor did not start (left by an earlier broker) is
 * reaped before a launch on the same profile: see _reapStrays.
 */
class BraveSupervisor extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.profileDir — persistent --user-data-dir (created if missing)
   * @param {string} [opts.executablePath] — default: detectBravePath() at first launch
   * @param {string|null} [opts.extensionPath] — unpacked extension for --load-extension
   * @param {boolean} [opts.headless=false] — --headless=new (BROWSER_HEADLESS_ENABLE, as in legacy mode)
   * @param {boolean} [opts.ignoreHttpsErrors=false] — accept any TLS certificate
   *   (BROWSER_RELAY_IGNORE_HTTPS_ERRORS). Also on, per launch, while Brave uses a
   *   LOOPBACK proxy (a local debug proxy's MITM certificate); never for a remote one.
   * @param {string|null} [opts.proxyUrl] — --proxy-server (scheme://host:port only);
   *   policy in resolveProxy(); credentials go to `proxyCredentials`
   * @param {(msg: string) => void} [opts.log] — default: stderr
   * @param {number} [opts.launchTimeoutMs=20000] — spawn → CDP ready (first reply on the pipe)
   * @param {number} [opts.closeTimeoutMs=10000] — Browser.close → exit, then kill
   *   (unless Brave accepted the close: see shutdownGraceMs)
   * @param {number} [opts.shutdownGraceMs=20000] — extra wait after closeTimeoutMs
   *   for a Brave that accepted Browser.close (dropped CDP) and is still shutting down
   * @param {number} [opts.exitWaitMs=10000] — unexpected 'down' → exit, then kill
   * @param {number} [opts.proxyProbeTimeoutMs=1500]
   * @param {number} [opts.strayExitWaitMs=10000] — a reaped stray Brave → its profile lock freed
   * @param {typeof spawn} [opts._spawn] — test seam
   * @param {{lockHeld?: (profileDir: string) => boolean, find?: (profileDir: string, exeName: string) => Promise<number[]>,
   *   kill?: (pid: number) => void}} [opts._strays] — test seams for _reapStrays
   */
  constructor(opts = {}) {
    super();
    if (!opts.profileDir) throw new Error(`${PREFIX} profileDir is required`);
    this.profileDir = path.resolve(opts.profileDir);
    this._executablePath = opts.executablePath || null;
    this._extensionPath = opts.extensionPath || null;
    this._headless = Boolean(opts.headless);
    this._ignoreHttpsErrors = Boolean(opts.ignoreHttpsErrors);
    this._loggedCertsIgnored = false;
    this._proxyUrl = opts.proxyUrl || null;
    this._log = opts.log || ((m) => process.stderr.write(`${PREFIX} ${m}\n`));
    this._t = {
      launchTimeoutMs: opts.launchTimeoutMs || 20000,
      closeTimeoutMs: opts.closeTimeoutMs || CLOSE_TIMEOUT_MS,
      shutdownGraceMs: opts.shutdownGraceMs || SHUTDOWN_GRACE_MS,
      exitWaitMs: opts.exitWaitMs || EXIT_WAIT_MS,
      proxyProbeTimeoutMs: opts.proxyProbeTimeoutMs || 1500,
      strayExitWaitMs: opts.strayExitWaitMs || 10000,
    };
    this._spawn = opts._spawn || spawn;
    this._strays = { lockHeld: profileLockHeld, find: findBraveOnProfile, kill: killPid, ...opts._strays };
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

  /** @returns {number|null} */
  get pid() {
    return this.isUp() ? this._proc.pid : null;
  }

  /**
   * W2E: Brave's PID can be gone before its process exit and CDP close are
   * processed (they lag the death; a call 24 ms after a kill got the dead
   * browser). Call before handing out a page: a dead Brave goes 'down' now,
   * once (the late exit / close are then no-ops).
   * @returns {boolean} isUp()
   */
  checkAlive() {
    const p = this._proc;
    if (p && p.up && !isPidAlive(p.pid)) this._onDown(p, p.closing ? "closed" : "exited (pid gone)");
    return this.isUp();
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

  /** @returns {Promise<{pid: number}>} */
  async ensure() {
    for (;;) {
      // Never race a relaunch against a planned close of the same profile.
      while (this._closing) await this._closing;
      // A launch in flight may already be up (CDP answers) but not done
      // (certificate policy, 'pipe' to the proxy): join it, never pass it.
      if (!this._launching && this.isUp()) return { pid: this._proc.pid };
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
   * closeTimeoutMs, or within closeTimeoutMs + shutdownGraceMs once it
   * accepted the close. Concurrent calls share one close.
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
    // pipe EOF by up to ~4 s): let it finish its flush. Its background
    // reap still kills it after exitWaitMs, so that case waits
    // min(exitWaitMs, closeTimeoutMs).
    if (proc.up && !proc.pipe.closed) proc.pipe.call("Browser.close", null, { timeoutMs: this._t.closeTimeoutMs });
    let exited = await waitExit(proc, this._t.closeTimeoutMs);
    // Measured: Brave answers Browser.close and closes its pipe within
    // ~6-55 ms, then shuts down (flushing cookies and prefs), which took 6 s
    // on a machine at 100% CPU. A Brave that closed the pipe has accepted the
    // close: give it more time before a kill that could lose those writes.
    // One whose pipe is still open ignored the close: kill it now.
    if (!exited && proc.pipe && proc.pipe.closed) {
      this._log(`brave pid=${proc.pid} accepted the close but is still shutting down after ${this._t.closeTimeoutMs} ms (busy machine?); waiting up to ${this._t.shutdownGraceMs} ms more`);
      exited = await waitExit(proc, this._t.shutdownGraceMs);
    }
    if (!exited) {
      this._log(`brave pid=${proc.pid} still running ${Date.now() - t0} ms after close was requested; killing it (cookie changes since the last flush may be lost)`);
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
    await this._reapStrays(exe);
    disableMemorySaver(this.profileDir, this._log);
    const proxy = await resolveProxy(this._proxyUrl, { log: this._log, timeoutMs: this._t.proxyProbeTimeoutMs });
    const proxyServer = proxy ? proxy.server : null;
    const args = buildBraveArgs({ profileDir: this.profileDir, extensionPath: this._extensionPath, proxyServer, headless: this._headless });
    const t0 = Date.now();
    const proc = this._spawnBrave(exe, args);
    this._proc = proc;
    try {
      await this._waitUntilUp(proc, exe, t0);
    } catch (e) {
      await this._kill(proc);
      throw e;
    }
    await this._setCertificateChecks(proc, this._certificateChecksOffReason(proxyServer));
    this._proxyCredentials = proxy ? proxy.credentials : null;
    this._launches++;
    const via = proxyServer ? `, traffic via proxy ${proxyServer}` : "";
    this._log(`brave pid=${proc.pid} up (CDP over a pipe, no port) in ${Date.now() - t0} ms (launch #${this._launches}${via})`);
    // Before ensure() resolves, so the proxy serves this Brave from then on.
    this._emitSafe("pipe", proc.pipe);
    return { pid: proc.pid };
  }

  /**
   * Reap a Brave left on OUR profile by an earlier broker. It normally dies
   * with that broker (Node puts its children in a kill-on-close job object;
   * measured: gone ~30 ms after a hard kill of the broker), but one that
   * survived anyway would make our launch hand off to it and exit with
   * code 21. Chromium holds <profile>/lockfile open while it runs, so only
   * then are processes listed: those whose --user-data-dir is exactly this
   * profile are killed (nothing else, no tree walk), and the launch waits
   * for the lock to go.
   */
  async _reapStrays(exe) {
    const { lockHeld, find, kill } = this._strays;
    if (!lockHeld(this.profileDir)) return;
    const pids = await find(this.profileDir, path.basename(exe));
    if (pids.length) {
      this._log(`${this.profileDir} is in use by Brave pid(s) ${pids.join(", ")}, not started by this broker; killing them`);
      for (const pid of pids) {
        try {
          kill(pid);
        } catch (e) {
          if (e.code !== "ESRCH") this._log(`could not kill stray Brave pid=${pid}: ${e.message}`);
        }
      }
    }
    const deadline = Date.now() + this._t.strayExitWaitMs;
    while (lockHeld(this.profileDir)) {
      if (Date.now() >= deadline) {
        const what = pids.length ? `after killing pid(s) ${pids.join(", ")}` : "and no process has exactly this --user-data-dir";
        throw new Error(`${PREFIX} ${this.profileDir} is still locked by another browser (${what}); not launching on it`);
      }
      await sleep(100);
    }
  }

  _spawnBrave(exe, args) {
    const child = this._spawn(exe, args, { stdio: [...STDIO], env: braveEnv(process.env) });
    const proc = {
      child, pid: child.pid, pipe: null,
      up: false, down: false, closing: false, killed: false, exited: false, exitCode: null, spawnError: null, reaping: null,
    };
    if (child.stdio && child.stdio[3] && child.stdio[4]) {
      proc.pipe = new PipeConnection(child.stdio[3], child.stdio[4]);
      proc.pipe.on("close", () => this._onDown(proc, proc.closing ? "closed" : "cdp disconnected"));
    }
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
    // Brave answers on the pipe once DevTools is up (208 ms warm, ~3 s on a
    // fresh profile, measured). Each poll writes another Browser.getVersion;
    // the first reply wins, late ones are dropped.
    const exitedError = () => {
      if (proc.spawnError) return new Error(`${PREFIX} could not start ${exe}: ${proc.spawnError.message}`);
      if (!proc.exited) return null;
      const inUse = proc.exitCode === RESULT_CODE_PROFILE_IN_USE ? ": the profile is in use" : "";
      return new Error(
        `${PREFIX} Brave exited during launch (code=${proc.exitCode}${inUse}) after ${Date.now() - t0} ms. ` +
        `If another Brave already runs on ${this.profileDir}, a new one hands off to it and exits; close that Brave first.`,
      );
    };
    for (;;) {
      if (exitedError()) throw exitedError();
      if (!proc.pipe || proc.pipe.closed) {
        // The pipe closes just before the process exits: wait for the exit code.
        await waitExit(proc, 2000);
        throw exitedError() || new Error(`${PREFIX} Brave pid ${proc.pid} closed its CDP pipe during launch (after ${Date.now() - t0} ms)`);
      }
      const left = this._t.launchTimeoutMs - (Date.now() - t0);
      if (left <= 0) throw new Error(`${PREFIX} Brave CDP (pipe) not ready after ${this._t.launchTimeoutMs} ms`);
      const reply = await proc.pipe.call("Browser.getVersion", null, { timeoutMs: Math.min(1000, left) });
      if (reply && reply.result) break;
      if (reply) await sleep(100); // an error reply: not ready yet
    }
    // Only adopt the pipe if it is OUR process behind it (an AutoDeElevate-
    // style handoff would leave the PID we track pointing elsewhere). A pipe
    // can't be served by a foreign browser, so this is defence in depth now.
    // Deliberately fail-OPEN (V2-6): if getProcessInfo itself errors or times
    // out we only warn and adopt it, so a Brave that drops or changes this
    // method can't brick every launch. A PID mismatch fails.
    const browserPid = await cdpBrowserPid(proc);
    if (proc.down || proc.exited) throw new Error(`${PREFIX} Brave pid ${proc.pid} went away during launch`);
    if (browserPid === null) {
      this._log(`warning: could not confirm that the CDP pipe is served by pid ${proc.pid} (SystemInfo.getProcessInfo failed)`);
    } else if (browserPid !== proc.pid) {
      throw new Error(`${PREFIX} the CDP pipe is served by browser pid ${browserPid}, not the Brave we launched (pid ${proc.pid})`);
    }
    proc.up = true;
  }

  /**
   * Why TLS certificate checks go off for a launch through `proxyServer`
   * (the proxy actually chosen, or null), or null: they stay on. Same rule as
   * legacy mode (cdp-bridge.js): the opt-in, or a LOOPBACK proxy (a local
   * debug proxy presenting its own certificate). A remote proxy, reachable
   * or kept while unreachable, must never be able to MITM the profile that
   * holds every login, so it gets verified TLS.
   */
  _certificateChecksOffReason(proxyServer) {
    if (this._ignoreHttpsErrors) return "BROWSER_RELAY_IGNORE_HTTPS_ERRORS=true";
    if (proxyServer && isLoopbackHost(parseProxyUrl(proxyServer).host)) return `local proxy ${proxyServer}`;
    return null;
  }

  /**
   * Security.setIgnoreCertificateErrors on the pipe's root session, set
   * explicitly on every launch (re-applied after a relaunch, or cleared):
   * browser-wide, for as long as that session (this launch) lives. A failure
   * to turn checks off leaves certificates verified.
   */
  async _setCertificateChecks(proc, why) {
    const r = await proc.pipe.call("Security.setIgnoreCertificateErrors", { ignore: Boolean(why) });
    if (!why) return;
    if (!r || r.error) {
      this._log(`warning: could not turn off TLS certificate checks (${why}): ${r ? r.error.message : "no CDP answer"}; certificates stay verified`);
      return;
    }
    if (!this._loggedCertsIgnored) {
      this._loggedCertsIgnored = true;
      this._log(`TLS certificate errors are ignored in this Brave (${why})`);
    }
  }

  _onDown(proc, reason) {
    if (proc.down) return;
    proc.down = true;
    const wasUp = proc.up;
    proc.up = false;
    if (proc.pipe) proc.pipe.close(); // the proxy stops serving it (503) at once
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

/**
 * Is a browser running on `profileDir`? Windows: Chromium holds
 * `<profile>/lockfile` open (no write sharing) for its whole life and the
 * file goes when it exits, so opening it for writing fails while one runs
 * (EBUSY; EPERM while it is being deleted). POSIX: `SingletonLock` links to
 * "<host>-<pid>" and outlives a crash, so the pid must still be alive.
 * @param {string} profileDir
 * @returns {boolean}
 */
function profileLockHeld(profileDir, platform = process.platform) {
  if (platform === "win32") {
    try {
      fs.closeSync(fs.openSync(path.join(profileDir, "lockfile"), "r+"));
      return false;
    } catch (e) {
      return e.code === "EBUSY" || e.code === "EPERM";
    }
  }
  let target;
  try {
    target = fs.readlinkSync(path.join(profileDir, "SingletonLock"));
  } catch {
    return false;
  }
  const m = /^(.*)-(\d+)$/.exec(target);
  return !!m && m[1] === os.hostname() && require("../process-shim.js").isPidAlive(Number(m[2]));
}

/**
 * PIDs of `exeName` processes (browser and helpers) whose command line passes
 * exactly `profileDir` as --user-data-dir (pool-shared's whole-argument
 * matcher: profile never matches profile-2). The process listing runs off
 * the event loop.
 * @returns {Promise<number[]>}
 */
async function findBraveOnProfile(profileDir, exeName) {
  const shim = require("../process-shim.js");
  const matches = require("../pool-shared.js").userDataDirMatcher(profileDir);
  const procs = await shim.runProbeAsync((spawn) => shim.listProcessesByCommand(exeName, spawn ? { _spawnSync: spawn } : {}));
  return procs.filter((p) => matches(p.command)).map((p) => p.pid);
}

function killPid(pid) {
  process.kill(pid, "SIGKILL");
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

/** The browser process id CDP reports, or null if it can't be read. */
async function cdpBrowserPid(proc) {
  const reply = await proc.pipe.call("SystemInfo.getProcessInfo");
  const browser = reply && reply.result && (reply.result.processInfo || []).find((p) => p.type === "browser");
  return browser ? browser.id : null;
}

/**
 * Brave's command line: the broker's flag set, plus the optional extras.
 *
 * @param {object} opts
 * @param {string} opts.profileDir — persistent --user-data-dir
 * @param {string|null} [opts.extensionPath] — unpacked extension dir
 * @param {string|null} [opts.proxyServer] — already-probed proxy server string
 * @param {boolean} [opts.headless]
 * @returns {string[]}
 */
function buildBraveArgs({ profileDir, extensionPath = null, proxyServer = null, headless = false }) {
  const args = [
    // CDP on fd 3/4 only (spawn with STDIO): never a TCP port, which any
    // local process could use to drive this logged-in Brave.
    "--remote-debugging-pipe",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    // CDP still comes up (0 pages) and Target.createTarget{newWindow} still
    // works; without it Brave opens a window and steals the OS foreground.
    "--no-startup-window",
    // AutoDeElevate: spawned from an elevated process, brave.exe relaunches
    // itself de-elevated and the PID we spawned exits in ~150-750 ms, so
    // kills and crash detection hit nothing, and the relaunched Brave has no
    // pipe (measured: exit 0 at 393 ms, pipe EOF, no CDP). Keep this ONE switch: Chromium
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
 * vars (same rule as cdp-bridge.js), minus BROWSER_CDP_ENDPOINT_URL (the
 * broker's secret CDP URL while upstream imports), and minus HTTP(S)_PROXY /
 * ALL_PROXY, so `--proxy-server` is the only proxy decision and "direct"
 * means direct.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function braveEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("BROWSER_RELAY_") || k.toUpperCase() === "BROWSER_CDP_ENDPOINT_URL") continue; // Windows names ignore case
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
  profileLockHeld,
  findBraveOnProfile,
  CLOSE_TIMEOUT_MS,
  SHUTDOWN_GRACE_MS,
};
