#!/usr/bin/env node
// broker/main.js — the shared browser broker (v0.4).
//
// One broker per user and Brave profile, started on demand by a shim
// (src/shim.js) and reached over a named pipe (pipe-server.js). Each pipe
// connection is one Claude session and gets its own MCP Server + RelayServer,
// so hidden toolsets, elicitation and tools/list_changed work per session
// exactly as in the stdio relay. Underneath, all sessions share:
//
//   - ONE Brave (W2C BraveSupervisor) with CDP on a pipe, no TCP port (W2G);
//   - ONE CDP endpoint, the broker's CdpProxy (cdp-proxy.js): bound here, up
//     front, for the broker's life, at ws://127.0.0.1:<port>/<secret>/devtools/browser.
//     Upstream reads its CDP URL once per process, and the URL never changes.
//     The secret never leaves the process: logs, status and tool results are
//     redacted;
//   - upstream browser-devtools-mcp IN-PROCESS (W2B upstream-inproc), loaded
//     lazily on the first tools/call;
//   - a SessionRegistry: (connection, tabId) → upstream session context, one
//     window per tab (W2B window-pages).
//
// tools/list comes from W1B's cached catalog (plus an optional tabId on page
// tools), so a session that never calls a tool costs no upstream import and
// no Brave. Upstream tools run in-process with their args parsed by
// upstream's own zod shapes; own-tools (W2D) run with the ctx W2D's
// toolContext builds; only tabs_new opens tabs. Idle policy:
// Brave closes after 20 min without a tool call; the broker exits after 10
// min without connections. Both close Brave gracefully (Browser.close
// flushes cookies; a kill loses ~30 s).
//
// CLI: node src/broker/main.js [--pipe <name>] [--profile-dir <dir>] [--log <file>]
// (the shim passes --pipe and --profile-dir so both sides agree).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { claimPipe, resolveEndpoint, brokerHome, keyFileFor, loadOrCreateKey, restoreKeyFile, verifyPipeOwner, serverHello, settingsHash } = require("./pipe-server.js");

const MINUTE = 60_000;
const DEFAULT_EXIT_IDLE_MS = 10 * MINUTE;
const DEFAULT_BROWSER_IDLE_MS = 20 * MINUTE;
const LOG_ROTATE_BYTES = 1024 * 1024;
const DEFAULT_WATCHDOG_MS = 60_000;
const MIN_WATCHDOG_MS = 30_000; // code is stopped at a third of this: shorter would hit a healthy broker busy for a few seconds
const KEY_CHECK_MS = 30_000;
const DEFAULT_RECYCLE_RSS_MB = 1024;
const RECYCLE_CHECK_MS = 60_000;

/**
 * Watchdog, in a worker thread: one broker serves every session, and code
 * upstream runs (execute / scenario-run) can block the event loop for good
 * (a vm timeout only covers the code before its first await). The main
 * thread stamps a shared clock every second. If it stops for a third of
 * timeoutMs, the worker stops the code holding the thread
 * (Runtime.terminateExecution, in-process: every other session keeps its tabs).
 * Stopped code's promises never settle, so onStopped lets the broker answer
 * the calls left in flight. If it stops for all of timeoutMs (blocked in
 * native code, or frozen again), the worker logs and kills the process, and
 * the shims start a fresh broker.
 * A gap in the worker's own ticks means the machine slept: skip that check.
 * While an inspector is attached (a debugger may hold the thread at a
 * breakpoint), the main thread raises a flag and the worker stands down.
 */
const WATCHDOG_SOURCE = `
"use strict";
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const inspector = require("node:inspector");
const beat = new BigInt64Array(workerData.sab); // [0] heartbeat ms, [1] inspector attached, [2] code was stopped
const { timeoutMs, logFile, pid } = workerData;
const stopAfterMs = Math.floor(timeoutMs / 3);
const every = Math.max(50, Math.min(1000, Math.floor(stopAfterMs / 4)));
const note = (msg) => {
  if (!logFile) return;
  try { fs.appendFileSync(logFile, new Date().toISOString() + " [broker " + pid + "] watchdog: " + msg + "\\n"); } catch {}
};
let lastTick = Date.now();
let stopSent = false;
setInterval(() => {
  const now = Date.now();
  const slept = now - lastTick > every * 5;
  lastTick = now;
  if (slept || Atomics.load(beat, 1) !== 0n) return;
  const silent = now - Number(Atomics.load(beat, 0));
  if (silent < stopAfterMs) { stopSent = false; return; }
  if (!stopSent) {
    stopSent = true;
    note("the event loop has been blocked for " + silent + " ms; stopping the code that blocks it");
    Atomics.store(beat, 2, 1n);
    try {
      const session = new inspector.Session();
      session.connectToMainThread();
      session.post("Runtime.terminateExecution", () => session.disconnect());
    } catch (e) { note("could not stop it: " + e.message); }
    return; // never stop and kill in one tick: the stop needs a chance to land
  }
  if (silent < timeoutMs) return;
  note("the event loop has been blocked for " + silent + " ms (limit " + timeoutMs + " ms); killing the broker so the shims start a fresh one");
  process.kill(pid, "SIGKILL");
}, every);
`;

/** Start the watchdog; returns stop(). */
function startWatchdog({ timeoutMs, logFile = null, heartbeatMs = 1000, onStopped = null }, log) {
  const { Worker } = require("node:worker_threads");
  const inspector = require("node:inspector");
  const sab = new SharedArrayBuffer(24);
  const beat = new BigInt64Array(sab);
  const tick = () => {
    Atomics.store(beat, 1, inspector.url() ? 1n : 0n);
    Atomics.store(beat, 0, BigInt(Date.now()));
    if (onStopped && Atomics.exchange(beat, 2, 0n) !== 0n) onStopped();
  };
  tick();
  const hb = setInterval(tick, heartbeatMs);
  hb.unref();
  const worker = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { sab, timeoutMs, logFile, pid: process.pid } });
  worker.unref();
  worker.on("error", (e) => log(`watchdog failed: ${e.message}`));
  return () => {
    clearInterval(hb);
    worker.terminate().catch(() => {});
  };
}

const TAB_ID_SCHEMA = Object.freeze({
  type: "string",
  // W2D's wording for its routed tools: short, since every page tool carries it
  description: "Tab from tabs_new; omit for your main tab.",
});

// What every session is told about using the browser. Claude Code keeps the
// first 2,048 characters (4,096 from v2.1.296). test/upstream-contract.test.js
// checks every tool and argument named here against upstream.
const SERVER_INSTRUCTIONS = [
  "Start with navigation_go-to: it returns the page as an accessibility tree in `output`, where each element carries [ref=eN]. " +
    "Pass a ref as the `selector` of interaction_* tools and content_take-screenshot (\"e12\" or \"@e12\"); any other tool's `selector` is CSS. " +
    "Refs last until the next snapshot or navigation, so take a new snapshot (a11y_take-aria-snapshot) after the page changes. " +
    "The separate `refs` map is left out of results: every ref is in the tree.",
  "Big pages: pass includeSnapshot:false or snapshotOptions:{interactiveOnly:true} to navigation tools, then a11y_take-aria-snapshot " +
    "with a `selector` for the part you need. A result over about 30,000 characters is cut and the full text is saved to a file " +
    "named in the result; Read that file with offset/limit or Grep it.",
  "content_take-screenshot saves an image file and returns its path: Read the path to see it. For checks at several widths, run " +
    "interaction_resize-viewport then content_take-screenshot per width (e.g. 1920, 1440, 1024, 390) inside one `execute` call.",
  "`execute` batches steps in one call: `await callTool(name, input)` runs a tool and returns its output to the script; `page` is the Playwright page. " +
    "Return only what you need from the script.",
  "Parallel subagents share this session's browser tab: each should call tabs_new, pass the returned tabId on every call, and call tabs_close when done.",
  "Debug / React / scenario / trace tools are hidden to save context. If a task clearly needs one, ask the user, then call the `toolsets` tool.",
].join("\n");

// Tools that need a rendering window: a minimized one stalls rAF and
// screenshots for 3-5 s, so it is restored first.
const NEEDS_RENDERING_RE =
  /^(?:content_take-screenshot|content_start-recording|content_save-as-pdf|a11y_take-|interaction_|navigation_|execute$|scenario-run$|o11y_get-web-vitals$|form_fill$|file_upload$|download_capture$)/;

const DEFAULT_DEPS = {
  createSupervisor: ({ profileDir, env, log, poolConfig }) => {
    const { BraveSupervisor } = require("./brave-supervisor.js");
    // as in legacy mode (index.js): env, then the pool wrapper's, then auto-detect
    const pool = poolConfig();
    return new BraveSupervisor({
      profileDir,
      executablePath: pool.bravePath || undefined,
      extensionPath: env.BROWSER_LOAD_EXTENSIONS || null,
      proxyUrl: env.BROWSER_RELAY_PROXY_URL || pool.proxyUrl || null,
      headless: env.BROWSER_HEADLESS_ENABLE === "true",
      ignoreHttpsErrors: env.BROWSER_RELAY_IGNORE_HTTPS_ERRORS === "true",
      log: (m) => log(`supervisor: ${m}`),
    });
  },
  poolConfig: () => require("../pool-shared.js").CONFIG,
  upstreamModule: () => require("./upstream-inproc.js"),
  windowPages: () => require("./window-pages.js"),
  ownTools: () => require("../own-tools/index.js").tools,
  // W2D: the one place an own-tool call is routed to a tab
  toolContext: () => require("../own-tools/_tool-context.js"),
  loadCatalog: ({ env }) => require("../tool-catalog.js").loadUpstreamCatalog({ env }),
  // W2F: cookies from the owner's Chrome (the cookie bridge), applied to Brave
  // over a CDP connection the broker hands it: W2G's CdpProxy URL (with its
  // secret, in-process only; Brave has no debugging port). Managed keys
  // persist next to the key.
  cookieBridge: ({ supervisor, cdpUrl, log, stateDir, profileDir, allow }) => {
    const { CookieImporter, stateFileFor } = require("../cookie-bridge/importer.js");
    const openCdp = () => require("../cookie-bridge/cdp-client.js").openBrowserCdp(cdpUrl);
    return new CookieImporter({ supervisor, log, openCdp, allow, stateFile: stateFileFor(stateDir, profileDir) });
  },
};

/**
 * Two timers:
 *   - exit: no connections for exitIdleMs → onExitIdle (armed by start() and
 *     whenever the last connection closes; any connection disarms it);
 *   - browser: no tool call for browserIdleMs → onBrowserIdle (armed when the
 *     last in-flight call ends; any call disarms it), sessions connected or not.
 */
class IdlePolicy {
  constructor({ exitIdleMs, browserIdleMs, onExitIdle, onBrowserIdle }) {
    this.exitIdleMs = exitIdleMs;
    this.browserIdleMs = browserIdleMs;
    this.onExitIdle = onExitIdle;
    this.onBrowserIdle = onBrowserIdle;
    this.connections = 0;
    this.calls = 0;
    this._exit = null;
    this._exitAt = null; // when the armed exit timer fires (W2F notASession keeps it)
    this._browser = null;
    this._stopped = false;
    this.lastActivity = Date.now();
  }

  start() { this._armExit(); }

  connectionOpened() {
    this.connections++;
    // W2F: no countdown running (someone is connected): notASession must not
    // revive an old deadline
    if (!this._exit) this._exitAt = null;
    this._clear("_exit");
  }

  connectionClosed() {
    this.connections = Math.max(0, this.connections - 1);
    if (this.connections === 0) this._armExit();
  }

  /**
   * W2F: the connection just opened turned out not to be a session (the
   * cookie bridge): undo connectionOpened, keeping the exit deadline that
   * was running, so a bridge (re)connecting never keeps the broker alive.
   */
  notASession() {
    this.connections = Math.max(0, this.connections - 1);
    if (this.connections === 0) this._armExit(this._exitAt);
  }

  callStarted() {
    this.calls++;
    this.lastActivity = Date.now();
    this._clear("_browser");
  }

  callEnded() {
    this.calls = Math.max(0, this.calls - 1);
    this.lastActivity = Date.now();
    if (this.calls > 0 || this._stopped) return;
    this._clear("_browser");
    this._browser = setTimeout(() => { this._browser = null; this.onBrowserIdle(); }, this.browserIdleMs);
  }

  /** Final: the shutdown destroying sockets must not re-arm anything. */
  stop() {
    this._stopped = true;
    this._clear("_exit");
    this._clear("_browser");
  }

  _armExit(at = null) {
    if (this._stopped) return;
    this._clear("_exit");
    const ms = at === null ? this.exitIdleMs : Math.max(0, at - Date.now());
    this._exitAt = Date.now() + ms;
    this._exit = setTimeout(() => { this._exit = null; this.onExitIdle(); }, ms);
  }

  _clear(which) {
    if (this[which]) clearTimeout(this[which]);
    this[which] = null;
  }
}

/** tabId argument → registry tab key (same rules as W2D's toolContext). */
function tabKeyOf(tabId) {
  const { MAIN_TAB } = require("./sessions.js");
  const tabKey = tabId ?? MAIN_TAB;
  if (typeof tabKey !== "string" || tabKey === "") {
    throw new Error(`tabId must be a non-empty string (got ${JSON.stringify(tabId)})`);
  }
  return tabKey;
}

const unknownTabMessage = (tabKey) => `unknown tabId ${JSON.stringify(tabKey)}; call tabs_new or tabs_list`;

// Playwright colours its error text for a terminal; in a tool result the codes are noise.
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, "");

const errorResult = (text) => ({ content: [{ type: "text", text: stripAnsi(text) }], isError: true });

/**
 * A tools/call result with the CDP secret taken out, wherever it sits
 * (Playwright's call log and upstream's "[CDP connect]" errors print the
 * whole URL). Through JSON, so it doesn't depend on the result's shape: JSON
 * escaping never splits a hex secret. Results without it come back as they are.
 */
function redactResult(result) {
  const { redact } = require("./cdp-proxy.js");
  if (result === undefined) return result;
  const json = JSON.stringify(result);
  const clean = redact(json);
  return clean === json ? result : JSON.parse(clean);
}

const ORPHANED_CALL_MESSAGE =
  "[browser-mcp-relay] This call never answered after the broker's watchdog stopped code that was freezing it " +
  "(a script that never yields?). It may be the call that was stopped: check the page, then retry.";

const SETTINGS_DIFFER_WARNING =
  "this session's browser settings (BROWSER_*, telemetry, upstream tool options) differ from the ones the running broker " +
  "started with, and it keeps its own: run `npm run broker:stop`, and the next tool call starts a broker with the calling session's settings";

// BrowserContext members that are sync (or event APIs): not forwardable lazily
const SYNC_CONTEXT_MEMBERS = new Set(["pages", "browser", "on", "once", "off", "addListener", "removeListener", "request", "tracing", "clock", "backgroundPages", "serviceWorkers"]);

/**
 * Upstream's executor result → CallToolResult, as upstream's own stdio server
 * builds it (dist/index.js _toResponse): the image leaves the JSON and
 * becomes image content (SVG as text), "_"-prefixed keys are dropped, the
 * rest is pretty-printed JSON text. No structuredContent: W1B serves no
 * outputSchema, so it would only repeat the text.
 *
 * Two things differ from upstream's server. A snapshot's `refs` map is left
 * out: it lists each [ref=eN] of the tree text beside it again, with the
 * role, name and selector upstream finds it by, and a caller passes only the
 * ref. It was two thirds of the result (measured: 27 of 42 thousand
 * characters on a dashboard). And execute's error text and the lines its
 * script logged lose Playwright's colour codes; what the script returns is
 * left as it is (it can be page content).
 */
function toCallToolResult(response) {
  const res = response && typeof response === "object" ? response : { result: response };
  let image;
  const img = res.image;
  if (img && typeof img === "object" && Buffer.isBuffer(img.data) && typeof img.mimeType === "string") {
    image = img;
    delete res.image;
  }
  for (const key of Object.keys(res)) if (key.startsWith("_")) delete res[key];
  dropRefs(res);
  if (Array.isArray(res.toolOutputs)) for (const t of res.toolOutputs) dropRefs(t && t.output); // execute, scenario-run
  if (typeof res.error === "string") res.error = stripAnsi(res.error);
  if (res.failedTool && typeof res.failedTool.error === "string") res.failedTool = { ...res.failedTool, error: stripAnsi(res.failedTool.error) };
  if (Array.isArray(res.logs)) res.logs = res.logs.map((l) => (l && typeof l.message === "string" ? { ...l, message: stripAnsi(l.message) } : l)); // a caught error the script logged
  const content = [{ type: "text", text: JSON.stringify(res, null, 2) }];
  if (image) {
    content.push(image.mimeType === "image/svg+xml"
      ? { type: "text", text: image.data.toString(), mimeType: image.mimeType }
      : { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
  }
  return { content, isError: false };
}

/** Removes the `refs` map of a snapshot result: one with the tree text in `output` beside it. */
function dropRefs(o) {
  if (o && typeof o === "object" && typeof o.output === "string" && o.refs && typeof o.refs === "object") delete o.refs;
}

function withNotice(result, notice) {
  if (!notice) return result;
  return { ...result, content: [{ type: "text", text: notice }, ...((result && result.content) || [])] };
}

// Upstream's navigation tools default to no timeout: a page whose load event
// never fires holds the call open for good, and with it Brave's idle close.
const NAV_TOOLS = new Set(["navigation_go-to", "navigation_reload", "navigation_go-back-or-forward"]);
const NAV_DEFAULT_TIMEOUT_MS = 60_000;
// Upstream names output files <name>-<time to the second> and overwrites, so
// two sessions saving in the same second got one path and read each other's page.
const OUTPUT_FILE_TOOLS = new Set(["content_take-screenshot", "content_save-as-pdf", "content_start-recording"]);

/**
 * The arguments upstream gets: `data` (parsed, defaults filled in) with the
 * broker's navigation timeout and a per-call `tag` on output file names.
 * `raw` is what the session sent, to tell an explicit timeout from the default.
 */
function brokerCallArgs(tool, raw, data, tag) {
  const out = { ...data };
  const base = out.name ?? (tool === "content_start-recording" ? "recording" : undefined); // the one name with no schema default
  if (OUTPUT_FILE_TOOLS.has(tool) && base !== undefined) out.name = `${base}-${tag}`;
  if (NAV_TOOLS.has(tool)) {
    if (raw.timeout === undefined) out.timeout = NAV_DEFAULT_TIMEOUT_MS;
    if (out.includeScreenshot) {
      out.screenshotOptions = { ...out.screenshotOptions, name: `${(out.screenshotOptions && out.screenshotOptions.name) || "screenshot"}-${tag}` };
    }
  }
  return out;
}

/** tools/list shows the broker's navigation default instead of upstream's 0. */
function withNavTimeoutSchema(tool) {
  const timeout = NAV_TOOLS.has(tool.name) && tool.inputSchema && tool.inputSchema.properties && tool.inputSchema.properties.timeout;
  if (!timeout) return tool;
  const properties = { ...tool.inputSchema.properties, timeout: { ...timeout, default: NAV_DEFAULT_TIMEOUT_MS, description: `Max wait ms. Default ${NAV_DEFAULT_TIMEOUT_MS}; 0=no timeout.` } };
  return { ...tool, inputSchema: { ...tool.inputSchema, properties } };
}

// Upstream's descriptions that promise the `refs` map toCallToolResult leaves out.
const REFS_MAP_PROMISES = [
  ["returned in `output` and `refs`", "returned in `output`"], // navigation_go-to
  ["Returns a tree with refs (e1, e2, ...) and a refs map.", "Returns a tree with refs (e1, e2, ...)."], // a11y_take-aria-snapshot
];

/** tools/list describes the results the broker returns: a snapshot comes without the `refs` map. */
function withoutRefsMapPromise(tool) {
  if (typeof tool.description !== "string") return tool;
  const description = REFS_MAP_PROMISES.reduce((text, [from, to]) => text.replace(from, to), tool.description);
  return description === tool.description ? tool : { ...tool, description };
}

function withTabIdSchema(tool) {
  const schema = tool.inputSchema || { type: "object" };
  if (schema.properties && schema.properties.tabId) return tool;
  return { ...tool, inputSchema: { ...schema, type: "object", properties: { ...(schema.properties || {}), tabId: TAB_ID_SCHEMA } } };
}

const fmtMinutes = (ms) => (ms >= MINUTE ? `${Math.round(ms / MINUTE)} min` : `${ms} ms`);

/**
 * Claim the pipe and serve. Resolves null when another broker owns the pipe.
 *
 * @param {object} opts
 * @param {string} opts.pipe
 * @param {string} opts.profileDir — the Brave profile (W2C)
 * @param {object} [opts.env] — local-config-merged env
 * @param {(msg: string) => void} [opts.log]
 * @param {{exitMs?: number, browserMs?: number}} [opts.idle]
 * @param {(reason: string) => void} [opts.onExit] — the broker has shut down by itself (idle, recycle, broker:stop)
 * @param {string} [opts.keyFile] — this user's broker key (default: keyFileFor(env)); the shim passes its own
 * @param {{timeoutMs: number, logFile?: string}|null} [opts.watchdog] — stop code that blocks the event loop for a third of this; kill the process at all of it
 * @param {{rssBytes: number, checkMs: number}|null} [opts.recycle] — exit while idle when RSS exceeds rssBytes
 * @param {((opts: {profileDir: string, log: Function}) => Promise<unknown>)|null} [opts.seedProfile] — the
 *   profile's one-time seed (profile-seed.js), done before Brave first opens the profile
 * @param {{port: number}|null} [opts.relayInspector] — host the relay Inspector web UI on this port
 * @param {object} [opts.deps] — test seams: createSupervisor, upstreamModule, windowPages, ownTools, toolContext, loadCatalog, rss
 */
async function startBroker({ pipe, profileDir, env = process.env, log: rawLog = () => {}, idle = {}, onExit = () => {}, deps = {}, keyFile, watchdog = null, recycle = null, seedProfile = null, relayInspector = null }) {
  const { CdpProxy, redact } = require("./cdp-proxy.js");
  // Every line the broker logs goes through redact(): no log carries the CDP secret.
  const log = (m) => rawLog(redact(m));
  const keyPath = keyFile || keyFileFor(env);
  const key = loadOrCreateKey(keyPath);
  // Bound before the claim: from the claim to server.on("connection")
  // nothing may await, or an early connection can be accepted unheard.
  // An OS-assigned port is fine: the broker holds it for its whole life.
  const cdpProxy = new CdpProxy({ log });
  await cdpProxy.listen();
  const server = await claimPipe(pipe);
  if (!server) {
    await cdpProxy.close();
    let owner = await verifyPipeOwner(pipe, key);
    if (owner === "bad") {
      // our key may be the stale one (its file was recreated): read it again, once
      const fresh = loadOrCreateKey(keyPath);
      if (!fresh.equals(key)) owner = await verifyPipeOwner(pipe, fresh);
    }
    if (owner === "bad") log(`WARNING: ${pipe} is held by something that is not this user's broker (squatted?); sessions will refuse to talk to it. Exiting.`);
    else log(`${pipe} is owned by another broker${owner === "ok" ? "" : ` (not verified: ${owner})`}; exiting`);
    return null;
  }
  try {
    return serve({ server, cdpProxy, key, keyFile: keyPath, pipe, profileDir, env, log, idle, onExit, watchdog, recycle, seedProfile, relayInspector, d: { ...DEFAULT_DEPS, ...deps } });
  } catch (e) {
    server.close();
    cdpProxy.close();
    throw e;
  }
}

/** Synchronous on purpose (see startBroker). */
function serve({ server, cdpProxy, key, keyFile, pipe, profileDir, env, log, idle, onExit, watchdog, recycle, seedProfile, relayInspector, d }) {
  // Heavy requires only once we own the pipe: a losing broker exits fast.
  const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
  const { normalizeObjectSchema, safeParseAsync, getParseErrorMessage } = require("@modelcontextprotocol/sdk/server/zod-compat.js");
  const { RelayServer } = require("../relay-server.js");
  const { SessionRegistry, MAIN_TAB } = require("./sessions.js");
  const PKG = require("../../package.json");

  const { redact } = require("./cdp-proxy.js");
  const { limitResult } = require("./result-limit.js");
  const resultsDir = path.join(path.dirname(keyFile), "results"); // where the full text of a cut result goes
  // The only CDP endpoint, with its secret: for upstream and own-tools, never for display.
  const cdpUrl = cdpProxy.wsUrl;
  const startedAt = Date.now();
  // W2E: the relay Inspector's traffic feed (every session's calls), or null
  const traffic = relayInspector ? new (require("../relay-server.js").TrafficEmitter)() : null;
  let relayInspectorCtl = null;
  const supervisor = d.createSupervisor({ profileDir, env, log, poolConfig: d.poolConfig });
  // each launch's verified pipe is what the proxy serves (503 while Brave is down)
  if (typeof supervisor.on === "function") supervisor.on("pipe", (p) => cdpProxy.setPipe(p));
  const cookieBridge = d.cookieBridge({ supervisor, cdpUrl, log, stateDir: path.dirname(keyFile), profileDir, allow: bridgeAllowList(env, log) }); // W2F
  // W2F: cookies_export hides the values of the cookies the bridge manages (in-process: no new endpoint)
  const bridgeManagedMatcher = typeof cookieBridge.managedMatcher === "function" ? () => cookieBridge.managedMatcher() : null;
  const upstreamModule = d.upstreamModule();
  const sessionless = new Set(upstreamModule.SESSIONLESS_TOOLS || []);
  const placement = env.BROWSER_RELAY_BROKER_WINDOWS === "offscreen" ? "offscreen" : "cascade";
  let windowPages = null;
  const getWindowPages = () => windowPages || (windowPages = d.windowPages());
  let uninstallWindows = null;

  // Upstream in-process, once, bound to our fixed CDP URL. Needs no Brave:
  // upstream only connects inside a session context.
  let upstreamPromise = null;
  let outputSeq = 0; // numbers each call's output files and saved results
  // A tool called from inside execute or scenario-run gets its output files
  // named apart like a tools/call does. Its arguments are parsed already, so
  // upstream's own navigation timeout (none) stands: the script's timeoutMs
  // (30 s unless the caller sets it, 120 s at most) is what ends the call,
  // and with timeoutMs: 0 nothing does.
  const nestedArgs = (name, args) => brokerCallArgs(name, args, args, `x${++outputSeq}`);
  function getUpstream() {
    if (!upstreamPromise) {
      upstreamPromise = (async () => {
        const t0 = Date.now();
        let up;
        try {
          up = await upstreamModule.loadUpstream({ cdpUrl, env, nestedArgs });
        } finally {
          // Upstream read it at import (into a constant): no child process
          // or env dump of this one should see the secret.
          delete process.env.BROWSER_CDP_ENDPOINT_URL;
        }
        if (!uninstallWindows) uninstallWindows = getWindowPages().installWindowPerPage({ placement }) || (() => {});
        log(`upstream ${up.version} in-process: ${up.tools.length} tools in ${Date.now() - t0} ms`);
        return { up, byName: new Map(up.tools.map((e) => [e.name, e])) };
      })();
      upstreamPromise.catch(() => { upstreamPromise = null; }); // retry on the next call
    }
    return upstreamPromise;
  }

  // W2E: the profile's one-time seed starts now and finishes before Brave
  // first opens the profile; a failed seed means a fresh profile.
  const seeded = seedProfile
    ? Promise.resolve().then(() => seedProfile({ profileDir, log })).catch((e) => log(`profile seed failed (${e.message}); starting with a fresh profile`))
    : null;

  async function ensureBrave() {
    if (seeded) await seeded;
    const info = await supervisor.ensure();
    await cookieBridge.braveReady(info); // W2F: a new Brave gets the synced cookies first (never throws)
    return info;
  }

  const registry = new SessionRegistry({
    upstream: { createContext: async (sessionKey) => (await getUpstream()).up.createContext(sessionKey) },
    supervisor: {
      ensure: ensureBrave,
      on: (event, fn) => (typeof supervisor.on === "function" ? supervisor.on(event, fn) : undefined),
      checkAlive: () => supervisor.checkAlive(),
    },
    log,
  });

  // W1B's catalog, shared by every connection; a failed load is retried.
  let catalogPromise = null;
  function loadCatalog() {
    if (!catalogPromise) {
      // keyed with the env upstream really runs under (W2B forces some of it),
      // so cached names and schemas match the in-process tools
      catalogPromise = Promise.resolve().then(() => d.loadCatalog({ env: { ...env, ...(upstreamModule.FORCED_UPSTREAM_ENV || {}) } }));
      catalogPromise.catch(() => { catalogPromise = null; });
    }
    return catalogPromise;
  }
  loadCatalog().catch((e) => log(`catalog warm-up failed (tools/list retries): ${e.message}`));

  const ownTools = d.ownTools();
  const { toolContext } = d.toolContext();
  // own-tool schemas are W2D's (routed ones already carry tabId); upstream
  // page tools get it here, since W1B's catalog has none
  const ownNames = new Set(ownTools.map((t) => t.name));
  const takesTabId = (name) => !ownNames.has(name) && !sessionless.has(name);

  let warnedProxyCredentials = false;
  function checkProxyCredentials() {
    // TODO(broker): answer CDP Fetch.authRequired for authChallenge.source ===
    // "Proxy" only (never setHTTPCredentials: it answers every site's 401).
    if (warnedProxyCredentials || !supervisor.proxyCredentials) return;
    warnedProxyCredentials = true;
    log("WARNING: authenticated proxies are not yet supported in broker mode; Brave uses the proxy without its credentials");
  }

  /** Is this tab one the connection has (main always is)? Creates nothing. */
  const knownTab = (connId, tabKey) => tabKey === MAIN_TAB || registry.listTabs(connId).some((t) => t.tabKey === tabKey);

  /**
   * ctx.context for page-less own-tools (cookies_*): upstream's shared
   * BrowserContext, taken from an open session (any connection's), else from
   * the caller's main tab — opened only when the tool actually uses it, so
   * tabs_new / lighthouse_audit open nothing. Never a second Playwright
   * client: its own server side would auto-dismiss every dialog it sees and
   * repoint the context's downloads into its own temp dir.
   * Page-less tools use only async BrowserContext methods (cookies,
   * addCookies, ...), which is all this handle forwards; a sync member
   * fails loudly instead of quietly returning a Promise.
   */
  function lazySharedContext(connId) {
    let resolved = null;
    const resolve = () => (resolved ||= Promise.resolve().then(async () => {
      const open = registry.anyOpenCtx();
      return (open || (await registry.getCtx(connId, MAIN_TAB))).browserContext;
    }));
    return new Proxy({}, {
      get(_, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined; // not a thenable
        if (SYNC_CONTEXT_MEMBERS.has(prop)) {
          throw new Error(`ctx.context.${prop} is not available to page-less tools in broker mode (async BrowserContext methods only); make the tool routed to get a tab's context`);
        }
        return async (...args) => {
          const context = await resolve();
          return context[prop](...args);
        };
      },
    });
  }

  async function restoreWindow(page) {
    try {
      await getWindowPages().ensureNotMinimized(page);
    } catch (e) {
      log(`could not restore a minimized window (continuing): ${e.message}`);
    }
  }

  const parseSchemas = new WeakMap();
  async function parseArgs(entry, args) {
    if (!parseSchemas.has(entry)) parseSchemas.set(entry, normalizeObjectSchema(entry.inputShape) || null);
    const schema = parseSchemas.get(entry);
    if (!schema) return { success: true, data: {} }; // empty shape: no arguments
    return safeParseAsync(schema, args);
  }

  async function runUpstream(up, ctx, entry, args) {
    try {
      return toCallToolResult(await up.execute(ctx, entry.tool, args));
    } catch (e) {
      return errorResult(`Error: ${e.message}`);
    }
  }

  /** A forwarded (upstream) tools/call: the CDP secret taken out first, then cut to a size a session can read (the saved full text is the redacted one). */
  async function callUpstream(connId, name, rawArgs) {
    const result = redactResult(await callUpstreamRaw(connId, name, rawArgs));
    return limitResult(result, { dir: resultsDir, tool: name, tag: `${connId}-${++outputSeq}`, log });
  }

  // Calls in flight. Code the watchdog stopped never settles, and the stop can
  // also drop other continuations queued behind it: after a stop, a call that
  // still hasn't answered within the grace period gets an error instead of
  // hanging its session and holding off Brave's idle close for good.
  const inFlightCalls = new Set();
  const orphanGraceMs = ((watchdog && watchdog.timeoutMs) || DEFAULT_WATCHDOG_MS) * 2;
  function trackCall() {
    let timer = null;
    let answer;
    const orphaned = new Promise((resolve) => { answer = resolve; });
    const entry = {
      orphaned,
      arm() { timer = timer || setTimeout(() => answer(errorResult(ORPHANED_CALL_MESSAGE)), orphanGraceMs); },
      done() { clearTimeout(timer); inFlightCalls.delete(entry); },
    };
    inFlightCalls.add(entry);
    return entry;
  }

  async function callUpstreamRaw(connId, name, rawArgs) {
    try {
      const { tabId, ...args } = rawArgs || {};
      const tabKey = tabKeyOf(tabId);
      const { up, byName } = await getUpstream();
      const entry = byName.get(name);
      if (!entry) return errorResult(`MCP error -32602: Tool ${name} not found`);
      const parsed = await parseArgs(entry, args);
      if (!parsed.success) {
        return errorResult(`MCP error -32602: Input validation error: Invalid arguments for tool ${name}: ${getParseErrorMessage(parsed.error)}`);
      }
      // sessionless (scenario store): no context, no window, no Brave
      if (!entry.pageTool) return await runUpstream(up, null, entry, parsed.data);
      // only tabs_new opens tabs (W2D); main always exists
      if (!knownTab(connId, tabKey)) return errorResult(`Error: ${unknownTabMessage(tabKey)}`);
      const ctx = await registry.getCtx(connId, tabKey);
      checkProxyCredentials();
      const notice = registry.takeResetNotice(connId, tabKey);
      if (NEEDS_RENDERING_RE.test(name)) await restoreWindow(ctx.page);
      const callArgs = brokerCallArgs(name, args, parsed.data, `${connId}-${tabKey}-${++outputSeq}`);
      return withNotice(await runUpstream(up, ctx, entry, callArgs), notice);
    } catch (e) {
      return errorResult(`Error: ${e.message}`);
    }
  }

  /**
   * An own-tool, run with the ctx W2D's toolContext builds:
   *   routed           → { page, context, sessionKey, registry, connId, cdpUrl, relay } for args.tabId's tab
   *   needsPage:false  → { context (shared; lazy, see lazySharedContext), registry, connId, cdpUrl, relay }
   *   needsBrave:false → never launches Brave: that ctx while Brave runs, else just { relay }
   * relay is the connection's RelayServer (per-session toolsets, elicitation,
   * list_changed). Whatever RelayServer passes as the second argument is
   * ignored: its own (legacy) ctx building has no browser here.
   * cdpUrl carries the secret (the tool connects with it); its result and
   * error text are redacted before RelayServer (and the Inspector) sees them.
   */
  function brokerOwnTool(tool, connId, relay) {
    const routed = tool.needsBrave !== false && tool.needsPage !== false;
    async function run(args) {
      if (tool.needsBrave === false) {
        if (!supervisor.isUp()) return tool.handler(args, { relay });
        return tool.handler(args, await toolContext(registry, connId, tool, args, { context: null, cdpUrl, relay, bridgeManagedMatcher }));
      }
      if (!routed) {
        await ensureBrave(); // e.g. lighthouse_audit drives Brave over cdpUrl
        checkProxyCredentials();
        return tool.handler(args, await toolContext(registry, connId, tool, args, { context: lazySharedContext(connId), cdpUrl, relay, bridgeManagedMatcher }));
      }
      const ctx = await toolContext(registry, connId, tool, args, { context: null, cdpUrl, relay, bridgeManagedMatcher });
      checkProxyCredentials();
      const tabKey = tabKeyOf(args.tabId); // toolContext validated it
      const notice = registry.takeResetNotice(connId, tabKey);
      if (NEEDS_RENDERING_RE.test(tool.name)) await restoreWindow(ctx.page);
      try {
        return withNotice(await tool.handler(args, ctx), notice);
      } catch (e) {
        if (notice) e.message = `${notice}\n${e.message}`;
        throw e;
      }
    }
    return {
      ...tool,
      async handler(args) {
        try {
          return redactResult(await run(args));
        } catch (e) {
          // RelayServer turns it into its usual isError result from .message.
          // A new Error: the thrown one's message may not be writable.
          throw new Error(stripAnsi(redact(e && e.message !== undefined ? e.message : e)));
        }
      },
    };
  }

  /**
   * W2F: npm run bridge:uninstall -- --purge. Expires every bridge cookie in
   * Brave (launching it if needed) and deletes the bridge state. A Brave
   * launched only for this is closed gracefully again, which writes the
   * deletions to disk; a running one writes them within ~30 s.
   */
  async function bridgePurge() {
    if (typeof cookieBridge.purge !== "function") throw new Error("this broker has no cookie bridge");
    const st = cookieBridge.status();
    if (st.bridges) throw Object.assign(new Error("the cookie bridge extension is still connected, and would sync the cookies straight back: remove it in chrome://extensions (or turn on Pause sync on its review page), then purge again"), { code: "EBUSY" });
    const wasUp = supervisor.isUp();
    await ensureBrave();
    try {
      const r = await cookieBridge.purge();
      log(`cookie bridge purge: ${r.expired} cookie(s) expired${wasUp ? "" : "; closing the Brave started for it"}`);
      return { ...r, braveClosed: !wasUp };
    } finally {
      if (!wasUp) await supervisor.closeGracefully().catch((e) => log(`closing Brave after the purge failed: ${e.message}`));
    }
  }

  // ── connections ──
  const sockets = new Set();
  const bridgeSockets = new Set(); // W2F cookie-bridge connections: never sessions
  const sessions = new Map(); // connId → opened at (MCP sessions; not control connections)
  let connSeq = 0; // connIds: never reused within a broker (the registry remembers closed ones)
  let closing = null;
  let accepting = true; // false once a shutdown is committed

  const ownSettings = settingsHash(env, key);
  // What every session hears (its stderr + its first tool result): the
  // launcher's warning (de-elevation failed) and settings this mode ignores.
  const brokerWarnings = [
    env.BROWSER_RELAY_BROKER_LAUNCH_WARNING,
    require("../vault.js").vaultFilesExist(env) ? "credential-vault autofill isn't available in broker mode; set BROWSER_RELAY_MODE=legacy if you need it" : null,
  ].filter(Boolean);
  for (const w of brokerWarnings) log(`WARNING: ${w}`);
  // ...plus, for a session whose own settings differ, that it doesn't get them
  const helloWarning = (hello) => [
    ...brokerWarnings,
    ...(hello.settings && hello.settings !== ownSettings ? [SETTINGS_DIFFER_WARNING] : []),
  ].join(" | ") || null;
  let warnedSettings = false;

  function serveConnection(sock) {
    if (!accepting) { sock.destroy(); return; }
    const connId = `c${++connSeq}`;
    sockets.add(sock);
    policy.connectionOpened();
    log(`conn ${connId} open (${sockets.size} total)`);

    let mcp = null;
    let done = false;
    let bridgeDone = null; // W2F: set when this is a cookie-bridge connection
    const onClose = () => {
      if (done) return;
      done = true;
      if (bridgeDone) { bridgeDone(); return; }
      sockets.delete(sock);
      sessions.delete(connId);
      policy.connectionClosed();
      log(`conn ${connId} closed (${sockets.size} left)`);
      if (mcp) mcp.close().catch(() => {});
      registry.closeConn(connId).catch((e) => log(`conn ${connId}: closing tabs failed: ${e.message}`));
    };
    sock.on("close", onClose);
    sock.on("error", (e) => log(`conn ${connId}: socket ${e.code || e.message}`));

    // A shim opens with a hello: prove we hold this user's key (it talks to
    // nobody else), learn whether it lost an earlier broker and its settings.
    serverHello(sock, key, { warning: helloWarning }).then(({ hello, rest }) => {
      if (done) return undefined;
      if (hello && hello.bridge === true) {
        // W2F: the cookie bridge's native host. Not a session: it never keeps
        // the broker up. Its handlers exist only once it answered the challenge;
        // bridgeSockets is only so a shutdown closes it.
        sockets.delete(sock);
        bridgeSockets.add(sock);
        policy.notASession();
        let handlers = null;
        bridgeDone = () => { bridgeSockets.delete(sock); if (handlers) handlers.close(); };
        return require("./control.js").serveBridge(sock, hello, rest, key, () => (handlers = cookieBridge.handlers(connId)));
      }
      if (hello && hello.ctl) {
        // npm run broker:status / broker:stop (control.js): not a session
        require("./control.js").serveControl(sock, hello, key, { status, stop: () => closeAndExit("stop requested (npm run broker:stop)"), bridgePurge }, rest);
        return undefined;
      }
      sessions.set(connId, Date.now());
      if (hello) {
        if (hello.reconnect) registry.noteReset(connId, MAIN_TAB, "the browser broker restarted");
        if (hello.settings && hello.settings !== ownSettings && !warnedSettings) {
          warnedSettings = true;
          log(`WARNING: session ${connId} has browser settings (BROWSER_*, telemetry, upstream tool options) that differ from the ones this broker started with; the broker keeps its own until it restarts (10 min after its last session)`);
        }
      }
      if (rest.length) sock.unshift(rest);
      mcp = buildConnectionServer(connId);
      // The SDK closes the transport on a message over its 10 MB stdio limit
      // and only pauses the socket: drop it, so the shim answers the call and
      // reconnects instead of waiting forever. (A no-op after a normal close.)
      mcp.onclose = () => sock.destroy();
      return mcp.connect(new StdioServerTransport(sock, sock)).then(() => sock.resume());
    }).catch((e) => {
      log(`conn ${connId}: ${e.message}`);
      sock.destroy();
    });
  }

  function buildConnectionServer(connId) {
    const mcp = new Server(
      { name: "browser-mcp-relay", version: PKG.version },
      { capabilities: { tools: { listChanged: true } }, instructions: SERVER_INSTRUCTIONS },
    );
    const relay = new RelayServer({
      // upstream tools run in-process here, routed by tabId
      callUpstream: (name, args) => callUpstream(connId, name, args),
      loadUpstreamCatalog: loadCatalog,
      // Rejects "Not connected" once the connection is gone — nothing to tell then.
      notifyToolsChanged: () => mcp.sendToolListChanged().catch(() => {}),
      // MCP elicitation when the client supports form mode; null = ask in chat.
      elicit: async (params, opts = {}) => {
        const caps = mcp.getClientCapabilities();
        if (!caps || !caps.elicitation || !caps.elicitation.form) return null;
        return mcp.elicitInput(params, { signal: opts.signal });
      },
      // the relay Inspector's feed, shared by every session (none without it)
      recordTraffic: Boolean(traffic),
      trafficEmitter: traffic || undefined,
      trafficConn: connId,
      env,
    });
    for (const tool of ownTools) relay.registerOwnTool(brokerOwnTool(tool, connId, relay));
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      const list = await relay.handleToolsList();
      return { ...list, tools: list.tools.map((t) => withoutRefsMapPromise(takesTabId(t.name) ? withTabIdSchema(withNavTimeoutSchema(t)) : t)) };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      policy.callStarted();
      const call = trackCall();
      try {
        return await Promise.race([relay.handleToolsCall(req.params), call.orphaned]);
      } finally {
        call.done();
        policy.callEnded();
      }
    });
    mcp.onerror = (e) => log(`conn ${connId}: ${e.message}`);
    return mcp;
  }

  // ── lifecycle ──
  /**
   * Close Brave gracefully (while still owning the pipe, so a shim that
   * connects meanwhile reaches us, not a second broker racing for the same
   * profile), then release the pipe. With ifIdle, a connection that arrived
   * meanwhile calls the shutdown off. Resolves true when shut down.
   */
  function close(reason, { ifIdle = false } = {}) {
    // joining an idle attempt that gets called off (false) must still shut down
    if (closing) return ifIdle ? closing : closing.then((done) => done || close(reason));
    const attempt = (async () => {
      log(`shutting down: ${reason}`);
      if (!ifIdle) accepting = false;
      try {
        await supervisor.closeGracefully();
      } catch (e) {
        log(`closing Brave failed: ${e.message}`);
      }
      if (ifIdle && sockets.size > 0) {
        log("a session connected while Brave was closing; staying up");
        closing = null;
        return false;
      }
      accepting = false;
      policy.stop();
      stopWatchdog();
      clearInterval(rssTimer);
      clearInterval(keyTimer);
      for (const s of sockets) s.destroy();
      for (const s of bridgeSockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      await cdpProxy.close();
      if (relayInspectorCtl) await relayInspectorCtl.close().catch((e) => log(`closing the relay Inspector failed: ${e.message}`));
      if (uninstallWindows) uninstallWindows();
      log("bye");
      return true;
    })();
    closing = attempt;
    return attempt;
  }

  async function closeAndExit(reason, opts) {
    if (await close(reason, opts)) onExit(reason);
  }

  const exitMs = idle.exitMs || DEFAULT_EXIT_IDLE_MS;
  const browserMs = idle.browserMs || DEFAULT_BROWSER_IDLE_MS;
  const policy = new IdlePolicy({
    exitIdleMs: exitMs,
    browserIdleMs: browserMs,
    onExitIdle: () => closeAndExit(`no connections for ${fmtMinutes(exitMs)}`, { ifIdle: true }),
    onBrowserIdle: async () => {
      if (closing || !supervisor.isUp()) return;
      log(`no tool call for ${fmtMinutes(browserMs)}; closing Brave`);
      registry.invalidateAll(`the browser was closed after ${fmtMinutes(browserMs)} without tool calls`);
      try {
        await supervisor.closeGracefully();
      } catch (e) {
        log(`closing idle Brave failed: ${e.message}`);
      }
    },
  });

  const onStopped = () => { for (const call of inFlightCalls) call.arm(); };
  const stopWatchdog = watchdog && watchdog.timeoutMs ? startWatchdog({ ...watchdog, onStopped }, log) : () => {};
  // if our key file vanishes while we run, put it back, so new sessions still match us
  const keyTimer = setInterval(() => {
    try {
      if (restoreKeyFile(keyFile, key)) log(`restored the missing key file ${keyFile}`);
    } catch (e) {
      log(`could not restore the key file ${keyFile}: ${e.message}`);
    }
  }, KEY_CHECK_MS);
  keyTimer.unref();
  // recycle a broker whose memory grew past the limit, while it is idle
  let rssTimer = null;
  if (recycle && recycle.rssBytes) {
    const rss = d.rss || (() => process.memoryUsage().rss);
    rssTimer = setInterval(() => {
      if (closing || policy.calls > 0 || Date.now() - policy.lastActivity < recycle.checkMs) return;
      // a session with an open browser would lose its tabs: wait until none is connected or Brave idled out
      if (sockets.size > 0 && supervisor.isUp()) return;
      const bytes = rss();
      if (bytes > recycle.rssBytes) {
        const mb = (n) => Math.round(n / 1024 / 1024);
        closeAndExit(`memory: ${mb(bytes)} MB RSS is over the ${mb(recycle.rssBytes)} MB limit while idle; recycling the broker`);
      }
    }, recycle.checkMs);
    rssTimer.unref();
  }

  /** What broker:status and the relay Inspector's /api/broker show. */
  function status() {
    const { safeUrl } = require("../own-tools/_tabs.js");
    const up = supervisor.isUp();
    const inspector = relayInspectorCtl && relayInspectorCtl.handle;
    return {
      pid: process.pid,
      version: PKG.version,
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      pipe,
      profileDir,
      cdpUrl: redact(cdpUrl),
      brave: { up, pid: up ? supervisor.pid : null },
      connections: [...sessions].map(([id, openedAt]) => ({
        id,
        openedAt: new Date(openedAt).toISOString(),
        tabs: registry.listTabs(id).map((t) => ({ tabId: t.tabKey, state: t.state, url: safeUrl(t.page) })),
      })),
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      relayInspector: inspector ? `http://${inspector.bind}:${inspector.port}` : null,
      cookieBridge: cookieBridge.status(), // W2F: counts only, never values
    };
  }

  server.on("connection", serveConnection);
  server.on("error", (e) => log(`pipe server error: ${e.message}`));
  policy.start();
  log(`broker pid=${process.pid} serving ${pipe} (profile ${profileDir}, CDP ${cdpUrl})`);

  if (relayInspector) {
    // One Inspector for every session (in legacy mode each relay raced for
    // the port); W1E's Host/Origin gates and RelayServer's redaction apply.
    // After this tick, so the first sessions' initialize comes first.
    setImmediate(() => {
      if (closing) return;
      relayInspectorCtl = require("../inspector-launch.js").launchInspector({ port: relayInspector.port, env, log, trafficEmitter: traffic, brokerStatus: status });
    });
  }

  return {
    server,
    registry,
    supervisor,
    cdpUrl,
    connections: () => sockets.size,
    close: (reason = "closed") => close(reason),
  };
}

// ───────────────────────────── CLI ─────────────────────────────

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = { "--pipe": "pipe", "--profile-dir": "profileDir", "--log": "logFile", "--key-file": "keyFile" }[argv[i]];
    if (key && argv[i + 1] !== undefined) out[key] = argv[++i];
  }
  return out;
}

/**
 * The broker's own working dir. Upstream reads WORKING_DIR (project-scope
 * scenarios) at import, defaulting to the cwd, and relative output paths
 * resolve against the cwd. Both would otherwise be whichever project the
 * first session started the broker from, shared by every later session.
 */
function prepareWorkDir(env, { chdir = process.chdir, processEnv = process.env } = {}) {
  const dir = path.join(brokerHome(env), "work");
  fs.mkdirSync(dir, { recursive: true });
  processEnv.WORKING_DIR = dir;
  chdir(dir);
  return dir;
}

/** Append-only file log; rotated once at startup past 1 MB. Never throws. */
function fileLogger(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* logging is best-effort */ }
  return (msg) => {
    try { fs.appendFileSync(file, `${new Date().toISOString()} [broker ${process.pid}] ${msg}\n`); } catch { /* ignore */ }
  };
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** "0" turns a guard off; unset or invalid keeps the default. */
function limitSetting(raw, fallback) {
  const n = Number(raw);
  return raw !== undefined && raw !== "" && Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** Watchdog timeout from its env setting: 0 = off, else at least MIN_WATCHDOG_MS. */
function watchdogSetting(raw) {
  const ms = limitSetting(raw, DEFAULT_WATCHDOG_MS);
  return ms === 0 ? 0 : Math.max(ms, MIN_WATCHDOG_MS);
}

/**
 * W2F: the owner's always-allow list for the cookie bridge
 * (BROWSER_RELAY_BRIDGE_ALLOW, env or local-config.json; comma-separated).
 * It lifts the keyword guard for those domains; it never lifts a built-in
 * deny category (those need the extension's review page).
 */
function bridgeAllowList(env, log = () => {}) {
  const policy = require("../../extensions/cookie-bridge/policy.js");
  const { allow, invalid } = policy.parseAllowList(env.BROWSER_RELAY_BRIDGE_ALLOW);
  if (invalid.length) log(`cookie bridge: ignoring BROWSER_RELAY_BRIDGE_ALLOW entries that are not a domain of two or more labels or an IP: ${invalid.map((x) => JSON.stringify(x)).join(", ")}`);
  const denied = allow.filter((d) => policy.classify(d).decision === "deny");
  if (denied.length) log(`cookie bridge: BROWSER_RELAY_BRIDGE_ALLOW never lifts the built-in denylist (${denied.join(", ")}); re-allow those on the extension's review page`);
  return allow;
}

/**
 * The broker's env: process.env + local-config.json. Keys only in
 * local-config are also copied into processEnv, because the in-process
 * upstream (W2B) reads process.env only: the catalog (built from this env)
 * and the in-process tools must come from the same build and names.
 */
function brokerEnv(processEnv = process.env, applyLocalConfig = require("../local-config.js").applyLocalConfigToEnv) {
  const env = applyLocalConfig(processEnv);
  // "" counts as unset, as local-config.js treats it
  for (const [k, v] of Object.entries(env)) if (!processEnv[k] && v) processEnv[k] = v;
  return env;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const env = brokerEnv();
  const endpoint = resolveEndpoint(env);
  const pipe = args.pipe || endpoint.pipe;
  const profileDir = args.profileDir || endpoint.profileDir;
  const logFile = args.logFile || env.BROWSER_RELAY_BROKER_LOG || path.join(brokerHome(env), "broker.log");
  const log = fileLogger(logFile);
  try {
    prepareWorkDir(env);
  } catch (e) {
    log(`could not use the broker work dir (staying in ${process.cwd()}): ${e.message}`);
  }

  // One broker serves every session: a stray throw must not take them all down.
  const { redact } = require("./cdp-proxy.js");
  process.on("uncaughtException", (e) => log(redact(`uncaughtException (still serving): ${e.stack || e.message}`)));
  process.on("unhandledRejection", (e) => log(redact(`unhandledRejection (still serving): ${(e && e.stack) || e}`)));

  // the relay Inspector web UI (not Node's debugger), hosted by the broker
  const inspectorPort = require("../inspector-launch.js").inspectorPortFromEnv(env, log);
  const relayInspector = inspectorPort === null ? null : { port: inspectorPort };

  let handle;
  try {
    handle = await startBroker({
      seedProfile: (opts) => require("./profile-seed.js").seedOnFirstStart(opts),
      relayInspector,
      pipe,
      profileDir,
      env,
      log,
      idle: {
        exitMs: positiveInt(env.BROWSER_RELAY_BROKER_IDLE_EXIT_MS, DEFAULT_EXIT_IDLE_MS),
        browserMs: positiveInt(env.BROWSER_RELAY_BROKER_BROWSER_IDLE_MS, DEFAULT_BROWSER_IDLE_MS),
      },
      keyFile: args.keyFile,
      watchdog: { timeoutMs: watchdogSetting(env.BROWSER_RELAY_BROKER_WATCHDOG_MS), logFile },
      recycle: { rssBytes: limitSetting(env.BROWSER_RELAY_BROKER_RECYCLE_RSS_MB, DEFAULT_RECYCLE_RSS_MB) * 1024 * 1024, checkMs: RECYCLE_CHECK_MS },
      onExit: () => process.exit(0),
    });
  } catch (e) {
    log(redact(`fatal: ${e.stack || e.message}`));
    process.exit(1);
  }
  if (!handle) process.exit(0);
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
    process.on(sig, () => { handle.close(`signal ${sig}`).finally(() => process.exit(0)); });
  }
}

if (require.main === module) main();

module.exports = {
  startBroker,
  IdlePolicy,
  main,
  parseArgs,
  brokerEnv,
  bridgeAllowList,
  watchdogSetting,
  startWatchdog,
  prepareWorkDir,
  toCallToolResult,
  brokerCallArgs,
  withNavTimeoutSchema,
  withoutRefsMapPromise,
  REFS_MAP_PROMISES,
  tabKeyOf,
  TAB_ID_SCHEMA,
  SERVER_INSTRUCTIONS,
  NEEDS_RENDERING_RE,
  DEFAULT_EXIT_IDLE_MS,
  DEFAULT_BROWSER_IDLE_MS,
};
