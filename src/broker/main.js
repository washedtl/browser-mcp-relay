#!/usr/bin/env node
// broker/main.js — the shared browser broker (v0.4).
//
// One broker per user and Brave profile, started on demand by a shim
// (src/shim.js) and reached over a named pipe (pipe-server.js). Each pipe
// connection is one Claude session and gets its own MCP Server + RelayServer,
// so hidden toolsets, elicitation and tools/list_changed work per session
// exactly as in the stdio relay. Underneath, all sessions share:
//
//   - ONE Brave (W2C BraveSupervisor) on a CDP port chosen here, up front:
//     upstream reads its CDP URL once per process, so the port never changes;
//   - upstream browser-devtools-mcp IN-PROCESS (W2B upstream-inproc), loaded
//     lazily on the first tools/call;
//   - a SessionRegistry: (connection, tabId) → upstream session context, one
//     window per tab (W2B window-pages).
//
// tools/list comes from W1B's cached catalog (plus an optional tabId on page
// tools), so a session that never calls a tool costs no upstream import and
// no Brave. Upstream tools run in-process with their args parsed by
// upstream's own zod shapes; own-tools (W2D) run with the ctx W2D's
// toolContext builds; only tabs_new opens tabs. Idle policy (design §3): Brave closes after 20 min without a
// tool call; the broker exits after 10 min without connections. Both close
// Brave gracefully (Browser.close flushes cookies; a kill loses ~30 s).
//
// CLI: node src/broker/main.js [--pipe <name>] [--profile-dir <dir>] [--log <file>]
// (the shim passes --pipe and --profile-dir so both sides agree).

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { claimPipe, resolveEndpoint, brokerHome } = require("./pipe-server.js");

const MINUTE = 60_000;
const DEFAULT_EXIT_IDLE_MS = 10 * MINUTE;
const DEFAULT_BROWSER_IDLE_MS = 20 * MINUTE;
const LOG_ROTATE_BYTES = 1024 * 1024;

const TAB_ID_SCHEMA = Object.freeze({
  type: "string",
  // W2D's wording for its routed tools: short, since every page tool carries it
  description: "Tab from tabs_new; omit for your main tab.",
});

const SERVER_INSTRUCTIONS =
  "Debug / React / scenario / trace tools are hidden to save context. " +
  "If a task clearly needs one, ask the user, then call the `toolsets` tool. " +
  "Parallel subagents share this session's browser tab: each should call tabs_new and pass the returned tabId on every call.";

// Tools that need a rendering window: a minimized one stalls rAF and
// screenshots for 3-5 s, so it is restored first.
const NEEDS_RENDERING_RE =
  /^(?:content_take-screenshot|content_start-recording|content_save-as-pdf|a11y_take-|interaction_|navigation_|execute$|scenario-run$|o11y_get-web-vitals$|form_fill$|file_upload$)/;

const DEFAULT_DEPS = {
  createSupervisor: ({ profileDir, port, env, log }) => {
    const { BraveSupervisor } = require("./brave-supervisor.js");
    return new BraveSupervisor({
      profileDir,
      port,
      executablePath: env.BROWSER_RELAY_BRAVE_PATH || undefined,
      extensionPath: env.BROWSER_LOAD_EXTENSIONS || null,
      proxyUrl: env.BROWSER_RELAY_PROXY_URL || null,
      log: (m) => log(`supervisor: ${m}`),
    });
  },
  upstreamModule: () => require("./upstream-inproc.js"),
  windowPages: () => require("./window-pages.js"),
  ownTools: () => require("../own-tools/index.js").tools,
  // W2D: the one place an own-tool call is routed to a tab
  toolContext: () => require("../own-tools/_tool-context.js"),
  // page-less own-tools (cookies_*, lighthouse) get the shared BrowserContext
  // through a connection of our own, so no tab is opened for them
  connectOverCDP: (cdpUrl) => require("playwright-core").chromium.connectOverCDP(cdpUrl),
  loadCatalog: ({ env }) => require("../tool-catalog.js").loadUpstreamCatalog({ env }),
};

/**
 * Two timers (design §3):
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
    this._browser = null;
  }

  start() { this._armExit(); }

  connectionOpened() {
    this.connections++;
    this._clear("_exit");
  }

  connectionClosed() {
    this.connections = Math.max(0, this.connections - 1);
    if (this.connections === 0) this._armExit();
  }

  callStarted() {
    this.calls++;
    this._clear("_browser");
  }

  callEnded() {
    this.calls = Math.max(0, this.calls - 1);
    if (this.calls > 0) return;
    this._clear("_browser");
    this._browser = setTimeout(() => { this._browser = null; this.onBrowserIdle(); }, this.browserIdleMs);
  }

  stop() {
    this._clear("_exit");
    this._clear("_browser");
  }

  _armExit() {
    this._clear("_exit");
    this._exit = setTimeout(() => { this._exit = null; this.onExitIdle(); }, this.exitIdleMs);
  }

  _clear(which) {
    if (this[which]) clearTimeout(this[which]);
    this[which] = null;
  }
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

const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });

/**
 * Upstream's executor result → CallToolResult, as upstream's own stdio server
 * builds it (dist/index.js _toResponse): the image leaves the JSON and
 * becomes image content (SVG as text), "_"-prefixed keys are dropped, the
 * rest is pretty-printed JSON text. No structuredContent: W1B serves no
 * outputSchema, so it would only repeat the text.
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
  const content = [{ type: "text", text: JSON.stringify(res, null, 2) }];
  if (image) {
    content.push(image.mimeType === "image/svg+xml"
      ? { type: "text", text: image.data.toString(), mimeType: image.mimeType }
      : { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType });
  }
  return { content, isError: false };
}

function withNotice(result, notice) {
  if (!notice) return result;
  return { ...result, content: [{ type: "text", text: notice }, ...((result && result.content) || [])] };
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
 * @param {(reason: string) => void} [opts.onExit] — the broker has shut down by itself (idle, fatal)
 * @param {object} [opts.deps] — test seams: createSupervisor, upstreamModule, windowPages, ownTools, loadCatalog
 */
async function startBroker({ pipe, profileDir, env = process.env, log = () => {}, idle = {}, onExit = () => {}, deps = {} }) {
  const server = await claimPipe(pipe);
  if (!server) {
    log(`${pipe} is owned by another broker; exiting`);
    return null;
  }
  try {
    return await serve({ server, pipe, profileDir, env, log, idle, onExit, d: { ...DEFAULT_DEPS, ...deps } });
  } catch (e) {
    server.close();
    throw e;
  }
}

async function serve({ server, pipe, profileDir, env, log, idle, onExit, d }) {
  // Heavy requires only once we own the pipe: a losing broker exits fast.
  const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
  const { normalizeObjectSchema, safeParseAsync, getParseErrorMessage } = require("@modelcontextprotocol/sdk/server/zod-compat.js");
  const { RelayServer } = require("../relay-server.js");
  const { SessionRegistry, MAIN_TAB } = require("./sessions.js");
  const PKG = require("../../package.json");

  const port = await pickFreePort();
  const cdpUrl = `http://127.0.0.1:${port}`;
  const supervisor = d.createSupervisor({ profileDir, port, env, log });
  const upstreamModule = d.upstreamModule();
  const sessionless = new Set(upstreamModule.SESSIONLESS_TOOLS || []);
  const placement = env.BROWSER_RELAY_BROKER_WINDOWS === "offscreen" ? "offscreen" : "cascade";
  let windowPages = null;
  const getWindowPages = () => windowPages || (windowPages = d.windowPages());
  let uninstallWindows = null;

  // Upstream in-process, once, bound to our fixed CDP URL. Needs no Brave:
  // upstream only connects inside a session context.
  let upstreamPromise = null;
  function getUpstream() {
    if (!upstreamPromise) {
      upstreamPromise = (async () => {
        const t0 = Date.now();
        const up = await upstreamModule.loadUpstream({ cdpUrl });
        if (!uninstallWindows) uninstallWindows = getWindowPages().installWindowPerPage({ placement }) || (() => {});
        log(`upstream ${up.version} in-process: ${up.tools.length} tools in ${Date.now() - t0} ms`);
        return { up, byName: new Map(up.tools.map((e) => [e.name, e])) };
      })();
      upstreamPromise.catch(() => { upstreamPromise = null; }); // retry on the next call
    }
    return upstreamPromise;
  }

  const registry = new SessionRegistry({
    upstream: { createContext: async (sessionKey) => (await getUpstream()).up.createContext(sessionKey) },
    supervisor,
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

  // The shared BrowserContext for page-less own-tools, over our own CDP
  // connection: upstream only exposes contexts bound to a session page.
  let ownBrowser = null;
  function dropOwnBrowser() {
    const b = ownBrowser;
    ownBrowser = null;
    if (b) b.then((br) => br.close()).catch(() => {});
  }
  async function sharedContext() {
    await supervisor.ensure();
    checkProxyCredentials();
    if (ownBrowser) {
      const br = await ownBrowser.catch(() => null);
      if (br && br.isConnected()) return br.contexts()[0];
      dropOwnBrowser();
    }
    const p = Promise.resolve().then(() => d.connectOverCDP(cdpUrl));
    ownBrowser = p;
    p.catch(() => { if (ownBrowser === p) ownBrowser = null; });
    return (await p).contexts()[0];
  }
  if (typeof supervisor.on === "function") supervisor.on("down", dropOwnBrowser);

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

  /** A forwarded (upstream) tools/call, as upstream's own server would answer it. */
  async function callUpstream(connId, name, rawArgs) {
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
      return withNotice(await runUpstream(up, ctx, entry, parsed.data), notice);
    } catch (e) {
      return errorResult(`Error: ${e.message}`);
    }
  }

  /**
   * An own-tool, run with the ctx W2D's toolContext builds:
   *   routed           → { page, context, sessionKey, registry, connId, cdpUrl, relay } for args.tabId's tab
   *   needsPage:false  → { context (shared, no tab opened), registry, connId, cdpUrl, relay }
   *   needsBrave:false → never launches Brave: that ctx while Brave runs, else just { relay }
   * relay is the connection's RelayServer (per-session toolsets, elicitation,
   * list_changed). Whatever RelayServer passes as the second argument is
   * ignored: its own (legacy) ctx building has no browser here.
   */
  function brokerOwnTool(tool, connId, relay) {
    const routed = tool.needsBrave !== false && tool.needsPage !== false;
    return {
      ...tool,
      async handler(args) {
        if (tool.needsBrave === false) {
          if (!supervisor.isUp()) return tool.handler(args, { relay });
          return tool.handler(args, await toolContext(registry, connId, tool, args, { context: null, cdpUrl, relay }));
        }
        const context = routed ? null : await sharedContext();
        const ctx = await toolContext(registry, connId, tool, args, { context, cdpUrl, relay });
        if (!routed) return tool.handler(args, ctx);
        checkProxyCredentials();
        const tabKey = tabKeyOf(args.tabId); // toolContext validated it
        const notice = registry.takeResetNotice(connId, tabKey);
        if (NEEDS_RENDERING_RE.test(tool.name)) await restoreWindow(ctx.page);
        try {
          return withNotice(await tool.handler(args, ctx), notice);
        } catch (e) {
          if (notice) e.message = `${notice}\n${e.message}`;
          throw e; // RelayServer turns it into its usual isError result
        }
      },
    };
  }

  // ── connections ──
  const sockets = new Set();
  let closing = null;
  let accepting = true; // false once a shutdown is committed

  function serveConnection(sock) {
    if (!accepting) { sock.destroy(); return; }
    const connId = crypto.randomBytes(4).toString("hex");
    sockets.add(sock);
    policy.connectionOpened();
    log(`conn ${connId} open (${sockets.size} total)`);

    const mcp = new Server(
      { name: "browser-mcp-relay", version: PKG.version },
      { capabilities: { tools: { listChanged: true } }, instructions: SERVER_INSTRUCTIONS },
    );
    const relay = new RelayServer({
      // upstream calls never reach RelayServer here (see the tools/call handler)
      getUpstream: async () => { throw new Error("[broker] upstream tools are called in-process, not through RelayServer"); },
      loadUpstreamCatalog: loadCatalog,
      // Rejects "Not connected" once the connection is gone — nothing to tell then.
      notifyToolsChanged: () => mcp.sendToolListChanged().catch(() => {}),
      // MCP elicitation when the client supports form mode; null = ask in chat.
      elicit: async (params, opts = {}) => {
        const caps = mcp.getClientCapabilities();
        if (!caps || !caps.elicitation || !caps.elicitation.form) return null;
        return mcp.elicitInput(params, { signal: opts.signal });
      },
      recordTraffic: false,
      env,
    });
    for (const tool of ownTools) relay.registerOwnTool(brokerOwnTool(tool, connId, relay));
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      const list = await relay.handleToolsList();
      return { ...list, tools: list.tools.map((t) => (takesTabId(t.name) ? withTabIdSchema(t) : t)) };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
      policy.callStarted();
      try {
        const { name } = req.params;
        // Upstream tools go straight to the in-process path (tabId routing is
        // ours); RelayServer keeps own-tools and the hidden-toolset gate.
        if (!relay.ownTools.has(name) && !relay.hiddenToolsetFor(name)) return await callUpstream(connId, name, req.params.arguments);
        return await relay.handleToolsCall(req.params);
      } finally {
        policy.callEnded();
      }
    });
    mcp.onerror = (e) => log(`conn ${connId}: ${e.message}`);
    mcp.connect(new StdioServerTransport(sock, sock)).catch((e) => log(`conn ${connId}: connect failed: ${e.message}`));

    let done = false;
    const onClose = () => {
      if (done) return;
      done = true;
      sockets.delete(sock);
      policy.connectionClosed();
      log(`conn ${connId} closed (${sockets.size} left)`);
      mcp.close().catch(() => {});
      registry.closeConn(connId).catch((e) => log(`conn ${connId}: closing tabs failed: ${e.message}`));
    };
    sock.on("close", onClose);
    sock.on("error", (e) => log(`conn ${connId}: socket ${e.code || e.message}`));
  }

  // ── lifecycle ──
  /**
   * Close Brave gracefully (while still owning the pipe, so a shim that
   * connects meanwhile reaches us, not a second broker racing for the same
   * profile), then release the pipe. With ifIdle, a connection that arrived
   * meanwhile calls the shutdown off. Resolves true when shut down.
   */
  function close(reason, { ifIdle = false } = {}) {
    if (closing) return closing;
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
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
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

  // W2C: Brave can't come back (e.g. our fixed CDP port is taken). Exit so
  // the shims start a fresh broker on a new port.
  if (typeof supervisor.on === "function") {
    supervisor.on("fatal", (why) => {
      log(`supervisor fatal: ${why}`);
      closeAndExit(`supervisor fatal: ${why}`);
    });
  }

  server.on("connection", serveConnection);
  server.on("error", (e) => log(`pipe server error: ${e.message}`));
  policy.start();
  log(`broker pid=${process.pid} serving ${pipe} (profile ${profileDir}, CDP ${cdpUrl})`);

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
    const key = { "--pipe": "pipe", "--profile-dir": "profileDir", "--log": "logFile" }[argv[i]];
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

async function main(argv = process.argv.slice(2)) {
  const { applyLocalConfigToEnv } = require("../local-config.js");
  const env = applyLocalConfigToEnv(process.env);
  const args = parseArgs(argv);
  const endpoint = resolveEndpoint(env);
  const pipe = args.pipe || endpoint.pipe;
  const profileDir = args.profileDir || endpoint.profileDir;
  const log = fileLogger(args.logFile || env.BROWSER_RELAY_BROKER_LOG || path.join(brokerHome(env), "broker.log"));
  try {
    prepareWorkDir(env);
  } catch (e) {
    log(`could not use the broker work dir (staying in ${process.cwd()}): ${e.message}`);
  }

  // One broker serves every session: a stray throw must not take them all down.
  process.on("uncaughtException", (e) => log(`uncaughtException (still serving): ${e.stack || e.message}`));
  process.on("unhandledRejection", (e) => log(`unhandledRejection (still serving): ${(e && e.stack) || e}`));

  let handle;
  try {
    handle = await startBroker({
      pipe,
      profileDir,
      env,
      log,
      idle: {
        exitMs: positiveInt(env.BROWSER_RELAY_BROKER_IDLE_EXIT_MS, DEFAULT_EXIT_IDLE_MS),
        browserMs: positiveInt(env.BROWSER_RELAY_BROKER_BROWSER_IDLE_MS, DEFAULT_BROWSER_IDLE_MS),
      },
      onExit: () => process.exit(0),
    });
  } catch (e) {
    log(`fatal: ${e.stack || e.message}`);
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
  prepareWorkDir,
  toCallToolResult,
  tabKeyOf,
  TAB_ID_SCHEMA,
  NEEDS_RENDERING_RE,
  DEFAULT_EXIT_IDLE_MS,
  DEFAULT_BROWSER_IDLE_MS,
};
