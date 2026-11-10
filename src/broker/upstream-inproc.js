// upstream-inproc.js — browser-devtools-mcp (BDMCP) in-process, for the v0.4
// broker. Replaces the per-session upstream child: the broker owns the
// session map and calls upstream's tool executor directly, so own-tools and
// upstream tools act on the SAME page object.
//
// No new bundle patch. Upstream ships hashed ESM chunks (core-XXXX.js); we
// find the ones we need by the names in their trailing `export{...}`
// statement, which survives hash renames, and import() them on the first
// loadUpstream(). The one existing on-disk fix, F1-20
// (scripts/patch-bdmcp-bundle.js, idempotent), is applied first, exactly as
// legacy mode does before spawning upstream.
// Requiring this module is cheap: no fs work, no upstream import, env untouched.
//
// Env: FORCED_UPSTREAM_ENV + BROWSER_CDP_ENDPOINT_URL are forced and
// BROWSER_PERSISTENT_* is stripped. The other catalog-shaping vars
// (TOOL_NAME_PREFIX, AVAILABLE_TOOL_DOMAINS, TOOL_INPUT_METADATA_ENABLE,
// FIGMA_ACCESS_TOKEN) are honoured, as in legacy mode. They are part of the
// W1B catalog key, so the catalog served for tools/list must be built from
// the same env with FORCED_UPSTREAM_ENV applied (PLATFORM and
// TOOL_OUTPUT_SCHEMA_DISABLE are in that key too), or the cached names and
// these in-process tools can disagree.
//
// Contract we depend on (pinned to 0.6.12; test/upstream-contract.test.js
// asserts every item against the installed dist):
//   core chunk    platformInfo{toolsInfo{tools, createToolSessionContext,
//                 createToolExecutor, executeDescription,
//                 executeImportantDescription}}, augmentToolInputSchema,
//                 isToolEnabled, ToolRegistry, ScenarioRun
//   config chunk  normalizeToolName, applyNormalizedToolNamesInText,
//                 AVAILABLE_TOOL_DOMAINS + the import-time env constants
//   execute chunk Execute
//   session ctx   writable `browserContext` field, `page` getter, close()
//                 (CDP attach: closes only the page), ensureSessionPageOpen(),
//                 _safeReadResponseBody(res), _attachPageListeners(page),
//                 numOfInFlightRequests()
//   tool registry addTool(tool) reads tool.outputSchema() once and parses a
//                 nested call's result strictly against it
//   zod v3        nested at browser-devtools-mcp/node_modules/zod
//   playwright    its client emits "navigated" on frame._eventEmitter with
//                 {newDocument: {request: channel}, error}; channel._object
//                 is the Request (trackInFlightRequests); page.screenshot()
//                 drops an `element` option, elementHandle.screenshot() is
//                 the element's image (screenshotTheElement)
//
// One upstream per process: BDMCP reads BROWSER_CDP_ENDPOINT_URL once, at
// import, and caches its CDP connection per endpoint. The broker gives it the
// one URL its CDP proxy serves for the broker's whole life (W2G:
// ws://127.0.0.1:<port>/<secret>/devtools/browser; Brave itself has no port),
// and deletes the variable again once upstream is imported. loadUpstream()
// refuses a second, different cdpUrl. Its errors print a CDP URL only
// without the secret (redactCdpUrl).

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const { applyLocalConfigToEnv } = require("../local-config.js");
const { redactCdpUrl } = require("./cdp-proxy.js");

// Forced in code so a user's env can't turn telemetry, the
// "open chrome://inspect in your real Chrome" fallback, or output schemas on.
// PLATFORM is a generic name some machines set system-wide; upstream would
// load its Node.js tool platform for PLATFORM=node.
const FORCED_UPSTREAM_ENV = Object.freeze({
  TELEMETRY_ENABLE: "false",
  BROWSER_CDP_OPEN_INSPECT: "false",
  TOOL_OUTPUT_SCHEMA_DISABLE: "true",
  PLATFORM: "browser",
});

// Upstream reads the response body of every non-static request, whether or
// not anyone asks for it, into the one heap all sessions share, and Playwright
// then caches each body it read for as long as the page lives (measured: 8 tabs
// fetching 360 MB of JSON per round grew the broker ~780 MB a round, without
// end). So the size limit has to stop the read, not trim its result: a body
// declared over the limit is never fetched, and a tab stops reading bodies
// altogether once it has read READ_BUDGET_CHARS.
const KEPT_BODY_CHARS = 64 * 1024;
const READ_BUDGET_CHARS = 32 * 1024 * 1024;
const NOT_KEPT_ADVICE = "capture_xhr can save response bodies to a file";

/** Bounds what one session context reads and keeps of response bodies. */
function capResponseBodies(ctx) {
  const read = ctx._safeReadResponseBody;
  if (typeof read !== "function") return;
  let charsRead = 0;
  ctx._safeReadResponseBody = async function cappedResponseBody(res) {
    const declared = Number(res.headers()["content-length"]);
    if (declared > KEPT_BODY_CHARS) return `[response body not kept: ${declared} bytes; ${NOT_KEPT_ADVICE}]`;
    if (charsRead >= READ_BUDGET_CHARS) return `[response body not kept: this tab has already read ${charsRead} characters of bodies; ${NOT_KEPT_ADVICE}]`;
    const body = await read.call(this, res);
    if (typeof body !== "string") return body;
    charsRead += body.length;
    if (body.length <= KEPT_BODY_CHARS) return body;
    // through a Buffer: a plain slice is a view that keeps the whole string alive
    const kept = Buffer.from(body.slice(0, KEPT_BODY_CHARS), "utf8").toString("utf8");
    return `${kept}\n[response body cut at ${KEPT_BODY_CHARS} of ${body.length} characters; ${NOT_KEPT_ADVICE}]`;
  };
}

/**
 * Replaces a session context's count of requests in flight, which upstream's
 * waits for a quiet network read. Upstream adds one per `request` and takes
 * one off per `requestfinished` / `requestfailed`, but Playwright reports
 * neither for a request cut off when its document is replaced, and an
 * EventSource stream has no end: the count only grew, so every navigation
 * waited out upstream's 5 s limit and sync_wait-for-network-idle timed out
 * (measured: go-to took 5.3-6.3 s on pages that load in 0.2 s).
 *
 * Here a request is forgotten when its frame commits a new document or is
 * detached, and EventSource requests are not counted. A fetch stream or long
 * poll that stays open still counts, as it does upstream.
 *
 * Playwright's public `framenavigated` does not say whether a new document
 * came: it fires for pushState and #hash too, and a data: URL, about:blank
 * or an error page commits with no request before it. The event its client
 * emits on each frame does (`newDocument`, with the request that brought the
 * document, if one did), so that is what this listens to. It also fires,
 * with `error`, for a navigation that brought nothing (204, a download, a
 * refused connection); the page keeps its document then.
 */
function trackInFlightRequests(ctx) {
  const attach = ctx._attachPageListeners;
  if (typeof attach !== "function" || typeof ctx.numOfInFlightRequests !== "function") return;
  let open = new Set();
  const watch = (page) => {
    const mine = new Set();
    open = mine; // a page upstream re-creates starts from nothing
    const frameOf = (req) => { try { return req.frame(); } catch { return null; } }; // a service worker's request has no frame
    const dropFrame = (frame, keep) => { for (const r of mine) if (r !== keep && frameOf(r) === frame) mine.delete(r); };
    const watchFrame = (frame) => frame._eventEmitter.on("navigated", (e) => {
      if (e.newDocument && !e.error) dropFrame(frame, e.newDocument.request?._object);
    });
    // upstream leaves its telemetry posts (otelEnable) out of its count too
    const counted = (req) => req.resourceType() !== "eventsource" && !ctx.otelController?.isOTELRequest?.(req);
    page.on("request", (req) => { if (counted(req)) mine.add(req); });
    page.on("requestfinished", (req) => mine.delete(req));
    page.on("requestfailed", (req) => mine.delete(req));
    page.frames().forEach(watchFrame);
    page.on("frameattached", watchFrame);
    page.on("framedetached", (frame) => dropFrame(frame));
  };
  ctx._attachPageListeners = function attachAndTrack(page) {
    watch(page);
    return attach.call(this, page);
  };
  ctx.numOfInFlightRequests = () => open.size;
  if (ctx.page) watch(ctx.page); // upstream's init() attached its own listeners to the first page already
}

/**
 * Makes content_take-screenshot with a `selector` return that element.
 * Upstream finds the element, then hands it to page.screenshot() as
 * `element`, an option Playwright does not have and drops: the image was the
 * whole viewport (measured: a heading 37 px high came back 491 px high, the
 * viewport's height). Upstream's annotation boxes are already relative to
 * the element. Here a page.screenshot() call that carries `element` is taken
 * from the element; any other call goes through as it came.
 *
 * An element's screenshot waits until the element is visible, 30 s by
 * default, and upstream found the element without asking for that. So the
 * wait is done here with its own limit: an element that is hidden or has no
 * size fails after VISIBLE_WAIT_MS, and the capture keeps its 30 s.
 */
const VISIBLE_WAIT_MS = 5_000;
function screenshotTheElement(ctx) {
  const attach = ctx._attachPageListeners;
  if (typeof attach !== "function") return;
  const patch = (page) => {
    const ofPage = page.screenshot;
    page.screenshot = async function screenshot(options) {
      if (!options?.element) return ofPage.call(this, options);
      const { element, fullPage, ...rest } = options; // an element has no fullPage
      await element.waitForElementState("visible", { timeout: VISIBLE_WAIT_MS });
      return element.screenshot(rest);
    };
  };
  ctx._attachPageListeners = function attachAndPatch(page) {
    patch(page);
    return attach.call(this, page);
  };
  if (ctx.page) patch(ctx.page); // the first page is open already
}

/**
 * The tool as execute's and scenario-run's `callTool` reaches it. Upstream's
 * registry parses a nested result strictly against the tool's output schema,
 * and content_take-screenshot and the navigation tools return `_artifacts`
 * without declaring it, so those calls failed ("Unrecognized key(s) in
 * object: '_artifacts'"). A nested call also missed what the broker does to
 * the arguments of a tools/call; `nestedArgs(name, args)` supplies that.
 *
 * @param {object} tool  upstream's tool
 * @param {string} name  the name sessions call it by
 * @param {(name: string, args: object) => object} [nestedArgs]  given the parsed arguments
 */
function nestedTool(tool, name, nestedArgs) {
  const declared = tool.outputSchema(); // the registry builds its schema from this once, when the tool is added
  return {
    name: () => tool.name(),
    inputSchema: () => tool.inputSchema(),
    outputSchema: () => declared,
    async handle(ctx, args) {
      const out = await tool.handle(ctx, nestedArgs ? nestedArgs(name, args) : args);
      if (!out || typeof out !== "object") return out;
      return Object.fromEntries(Object.entries(out).filter(([k]) => Object.hasOwn(declared, k)));
    },
  };
}

// Export names that identify each chunk. A chunk matches when its trailing
// export statement names all of them.
const CHUNK_SIGNATURES = Object.freeze({
  core: ["platformInfo", "augmentToolInputSchema", "isToolEnabled", "ToolRegistry", "ScenarioRun"],
  config: ["normalizeToolName", "applyNormalizedToolNamesInText", "AVAILABLE_TOOL_DOMAINS", "BROWSER_CDP_CONNECT_URL",
    "BROWSER_CDP_OPEN_INSPECT", "TOOL_OUTPUT_SCHEMA_DISABLE", "BROWSER_PERSISTENT_ENABLE"],
  execute: ["Execute"],
});

// Scenario store CRUD: the only upstream tools that never touch the session
// (no page, buffers, stubs or probes), so they get no tabId.
const SESSIONLESS_TOOLS = Object.freeze(["scenario-add", "scenario-update", "scenario-delete", "scenario-list", "scenario-search"]);

const TAB_ID_DESCRIPTION =
  "Optional tab handle. Parallel subagents in one session should call tabs_new and pass the returned tabId on every call " +
  "to get their own browser window; without it, calls share this session's main tab.";

/** Names exported by the file's trailing `export{...}` statement (`a as b` → b). */
function parseExportNames(src) {
  const m = /export\s*\{([^}]*)\}\s*;?\s*$/.exec(src);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const as = /\s+as\s+(\S+)$/.exec(s);
    return as ? as[1] : s;
  });
}

/** The one top-level `*.js` in distDir whose exports include every name in `required`. */
function findChunkByExports(distDir, required) {
  const hits = [];
  for (const f of fs.readdirSync(distDir)) {
    if (!f.endsWith(".js")) continue;
    const full = path.join(distDir, f);
    if (!fs.statSync(full).isFile()) continue;
    const names = parseExportNames(fs.readFileSync(full, "utf8"));
    if (required.every((n) => names.includes(n))) hits.push(full);
  }
  const sig = `{${required.join(", ")}}`;
  if (hits.length === 0) throw new Error(`[broker] no upstream chunk exports ${sig} in ${distDir} — browser-devtools-mcp changed shape; pin it back or update src/broker/upstream-inproc.js`);
  if (hits.length > 1) throw new Error(`[broker] ${hits.length} upstream chunks export ${sig} in ${distDir}: ${hits.map((h) => path.basename(h)).join(", ")}`);
  return hits[0];
}

function locateUpstreamChunks(distDir) {
  const out = {};
  for (const [role, required] of Object.entries(CHUNK_SIGNATURES)) out[role] = findChunkByExports(distDir, required);
  return out;
}

/**
 * Where browser-devtools-mcp lives. Same override, read the same way (env
 * over local-config.json), as src/index.js and the W1B catalog
 * (BROWSER_RELAY_UPSTREAM_PATH = <pkg>/dist/index.js), so the cached catalog
 * and the in-process tools always come from one build.
 */
function resolveUpstreamPackage(env = applyLocalConfigToEnv(process.env)) {
  let pkgJson;
  const override = env.BROWSER_RELAY_UPSTREAM_PATH;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`[broker] BROWSER_RELAY_UPSTREAM_PATH="${override}" but no file at that path. Fix or unset.`);
    pkgJson = path.join(path.dirname(path.dirname(path.resolve(override))), "package.json");
  } else {
    pkgJson = require.resolve("browser-devtools-mcp/package.json");
  }
  const pkgDir = path.dirname(pkgJson);
  return { pkgDir, distDir: path.join(pkgDir, "dist"), require: createRequire(pkgJson) };
}

function forceUpstreamEnv(cdpUrl, env = process.env) {
  Object.assign(env, FORCED_UPSTREAM_ENV, { BROWSER_CDP_ENDPOINT_URL: cdpUrl });
  for (const k of Object.keys(env)) if (k.startsWith("BROWSER_PERSISTENT_")) delete env[k];
}

function assertContract(cond, what) {
  if (!cond) throw new Error(`[broker] upstream contract broken: ${what} — browser-devtools-mcp changed shape; run test/upstream-contract.test.js`);
}

const SCOPED = Symbol("browser-mcp-relay.routesScopedToPage");

/**
 * Point `ctx.browserContext.route/unroute` at the session's page.
 *
 * Upstream's stub_* tools call `context.browserContext.route()` — the one CDP
 * default context every session shares — so A's mock would be served to B.
 * Here `browserContext` becomes an accessor returning a Proxy whose
 * route/unroute go to `ctx.page`; everything else reaches the real context,
 * methods bound to it. (page.route doesn't see popup or service-worker
 * requests, which context.route did.)
 *
 * The Proxy is per page. Upstream keys two stores by `context.browserContext`
 * (WeakMaps): stubs, and the debug_* probe store, which binds to the page it
 * was enabled on. Keyed by the shared context, B would see A's stubs and
 * probes and B's tracepoints would land on A's page; keyed by this Proxy,
 * both are per session. When ensureSessionPageOpen() swaps in a new page the
 * next access yields a fresh object, i.e. fresh stores (stubs not yet
 * installed, probes not enabled) for the new page, instead of stores still
 * pointing at the dead one.
 *
 * Idempotent. Assigning ctx.browserContext replaces the real context.
 */
function scopeRoutesToPage(ctx) {
  if (ctx[SCOPED]) return ctx;
  const desc = Object.getOwnPropertyDescriptor(ctx, "browserContext");
  assertContract(desc && desc.writable && desc.configurable, "BrowserToolSessionContext.browserContext is no longer a writable field");
  let real = desc.value;
  let boundPage;
  let proxy;
  const makeProxy = () => new Proxy(real, {
    get(target, prop) {
      if (prop === "route") return (...a) => ctx.page.route(...a);
      if (prop === "unroute") return (...a) => ctx.page.unroute(...a);
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  Object.defineProperty(ctx, "browserContext", {
    configurable: true,
    enumerable: true,
    get() {
      const page = ctx.page;
      if (!proxy || page !== boundPage) {
        boundPage = page;
        proxy = makeProxy();
      }
      return proxy;
    },
    set(v) {
      real = v;
      proxy = undefined;
    },
  });
  Object.defineProperty(ctx, SCOPED, { value: true });
  return ctx;
}

let loaded = null; // { cdpUrl, promise }

/**
 * Import upstream (once per process) bound to `cdpUrl`.
 *
 * @param {{cdpUrl: string, env?: object, nestedArgs?: Function}} opts  cdpUrl: the broker's CDP
 *   proxy URL (ws://…, a secret in its path), or http(s)://host:port; env: the local-config-merged
 *   env (the broker's), for BROWSER_RELAY_UPSTREAM_PATH; nestedArgs: see nestedTool (used by the
 *   first load only: upstream is imported once per process).
 *   Upstream itself reads its settings from process.env at import: the broker's brokerEnv() puts
 *   local-config.json's keys there before anything loads.
 * @returns {Promise<{version: string,
 *   tools: Array<{name: string, description: string, inputShape: object, tool: object, pageTool: boolean}>,
 *   createContext: (sessionKey: string) => Promise<object>,
 *   execute: (ctx: object, tool: object, args: object) => Promise<object>,
 *   Execute: Function, ScenarioRun: Function}>}
 */
function loadUpstream({ cdpUrl, env = applyLocalConfigToEnv(process.env), nestedArgs } = {}) {
  if (typeof cdpUrl !== "string" || !/^(https?|wss?):\/\/[^/]+/.test(cdpUrl)) {
    return Promise.reject(new Error(`[broker] loadUpstream needs cdpUrl as http(s)://host:port or ws(s)://…, got ${JSON.stringify(typeof cdpUrl === "string" ? redactCdpUrl(cdpUrl) : cdpUrl)}`));
  }
  if (loaded) {
    if (loaded.cdpUrl !== cdpUrl) {
      return Promise.reject(new Error(`[broker] upstream is already bound to ${redactCdpUrl(loaded.cdpUrl)}; it reads BROWSER_CDP_ENDPOINT_URL once per process, so the broker must keep one CDP URL (asked for ${redactCdpUrl(cdpUrl)})`));
    }
    return loaded.promise;
  }
  const promise = doLoad(cdpUrl, env, nestedArgs);
  loaded = { cdpUrl, promise };
  // never cache a failed load: the next call retries from scratch
  promise.catch(() => { if (loaded && loaded.promise === promise) loaded = null; });
  return promise;
}

function applyBundleFixes(distDir) {
  // F1-20: upstream's HttpResourceType enum lacks ping/prefetch/... so
  // o11y_get-http-requests rejects them. Must run before the first import():
  // ESM caches the module as first read. Idempotent; a no-op when patched.
  try {
    const { applyPatch } = require("../../scripts/patch-bdmcp-bundle.js");
    const result = applyPatch({ distDir });
    if (!result.patched) process.stderr.write(`[mcp-relay] F1-20 patch skipped: ${result.reason} (o11y_get-http-requests may reject ping/prefetch/etc resourceTypes)\n`);
  } catch (e) {
    process.stderr.write(`[mcp-relay] F1-20 patch threw (continuing): ${e.message}\n`);
  }
}

async function doLoad(cdpUrl, env, nestedArgs) {
  const pkg = resolveUpstreamPackage(env);
  applyBundleFixes(pkg.distDir);
  const chunks = locateUpstreamChunks(pkg.distDir);
  forceUpstreamEnv(cdpUrl);
  const core = await import(pathToFileURL(chunks.core).href);
  const cfg = await import(pathToFileURL(chunks.config).href);
  const { Execute } = await import(pathToFileURL(chunks.execute).href);
  const { platformInfo, augmentToolInputSchema, isToolEnabled, ToolRegistry, ScenarioRun } = core;
  const toolsInfo = platformInfo && platformInfo.toolsInfo;

  assertContract(toolsInfo && Array.isArray(toolsInfo.tools), "platformInfo.toolsInfo.tools");
  for (const fn of ["createToolSessionContext", "createToolExecutor"]) assertContract(typeof toolsInfo[fn] === "function", `platformInfo.toolsInfo.${fn}()`);
  for (const s of ["executeDescription", "executeImportantDescription"]) assertContract(typeof toolsInfo[s] === "string", `platformInfo.toolsInfo.${s}`);
  for (const [n, v] of Object.entries({ augmentToolInputSchema, isToolEnabled, ToolRegistry, ScenarioRun, Execute,
    normalizeToolName: cfg.normalizeToolName, applyNormalizedToolNamesInText: cfg.applyNormalizedToolNamesInText })) {
    assertContract(typeof v === "function", `export ${n}`);
  }
  // The env is read at import. If something imported these chunks earlier
  // in this process with other env, the constants are stale: fail loudly.
  assertContract(cfg.BROWSER_CDP_CONNECT_URL === cdpUrl, `BROWSER_CDP_CONNECT_URL is ${redactCdpUrl(cfg.BROWSER_CDP_CONNECT_URL)}, expected ${redactCdpUrl(cdpUrl)} (upstream imported before loadUpstream?)`);
  assertContract(cfg.BROWSER_CDP_OPEN_INSPECT === false && cfg.TOOL_OUTPUT_SCHEMA_DISABLE === true && cfg.BROWSER_PERSISTENT_ENABLE === false,
    "forced env did not reach upstream's config constants (upstream imported before loadUpstream?)");

  const executor = toolsInfo.createToolExecutor();
  assertContract(executor && typeof executor.executeTool === "function", "executor.executeTool()");
  const z = pkg.require("zod");
  assertContract(z && typeof z.string === "function" && z.string()._zod === undefined, "zod v3 nested under browser-devtools-mcp");
  const tabIdShape = { tabId: z.string().optional().describe(TAB_ID_DESCRIPTION) };

  // Same registration rules as upstream's own MCP server (dist/index.js
  // _createServer), so names, descriptions and schemas match the W1B
  // catalog served for tools/list.
  const canonicalNames = [...toolsInfo.tools.map((t) => t.name()), "execute"];
  const mcpText = (s) => (s ? cfg.applyNormalizedToolNamesInText(s, canonicalNames) : s);
  const allowedDomains = cfg.AVAILABLE_TOOL_DOMAINS;
  const registry = new ToolRegistry();
  const upstreamTools = [];
  for (const t of toolsInfo.tools) {
    if (!isToolEnabled(t)) continue;
    const domain = t.name().split("_")[0]?.toLowerCase() ?? "";
    if (allowedDomains && !allowedDomains.has(domain)) continue;
    registry.addTool(nestedTool(t, cfg.normalizeToolName(t.name()), nestedArgs)); // what callTool runs
    upstreamTools.push(t); // what a tools/call runs
  }
  const executeTool = new Execute(registry, mcpText(toolsInfo.executeImportantDescription), mcpText(toolsInfo.executeDescription));
  registry.addTool(executeTool);
  const scenarioRunTool = new ScenarioRun(registry);

  const tools = [...upstreamTools, executeTool, scenarioRunTool].map((t) => {
    const shape = augmentToolInputSchema(t.inputSchema());
    assertContract(!Object.hasOwn(shape, "tabId"), `${t.name()} now declares its own tabId; the broker's tabId would shadow it`);
    const pageTool = !SESSIONLESS_TOOLS.includes(t.name());
    return {
      name: cfg.normalizeToolName(t.name()),
      description: mcpText(t.description()),
      inputShape: pageTool ? { ...shape, ...tabIdShape } : shape,
      tool: t,
      pageTool,
    };
  });

  // Upstream caches its CDP connection check-then-set, so concurrent first
  // calls each open their own connection to the one Brave. Serialize
  // context creation until a connected browser is known (again after Brave
  // dies); after that, sessions are created in parallel.
  let knownBrowser = null;
  let queue = Promise.resolve();
  const create = async (sessionKey) => {
    const ctx = await toolsInfo.createToolSessionContext(() => sessionKey);
    scopeRoutesToPage(ctx);
    capResponseBodies(ctx);
    trackInFlightRequests(ctx);
    screenshotTheElement(ctx);
    const b = ctx.browserContext.browser();
    if (b) knownBrowser = b;
    return ctx;
  };
  const createContext = (sessionKey) => {
    if (knownBrowser && knownBrowser.isConnected()) return create(sessionKey);
    const p = queue.then(() => create(sessionKey));
    queue = p.then(() => {}, () => {});
    return p;
  };

  // `args` reach the handler as given, so they must already be parsed against
  // the tool's inputShape: McpServer.registerTool does that; a low-level
  // Server must parse with z.object(inputShape) first or defaults are lost.
  //
  // Session-less tools (entries with pageTool:false: the scenario store) run
  // without a session. Pass ctx = null and never create a context for them;
  // upstream's executor would open (and so launch) a page first.
  const execute = async (ctx, tool, args) => {
    const upstreamArgs = { ...args };
    delete upstreamArgs.tabId; // the broker's routing key, not an upstream argument
    if (SESSIONLESS_TOOLS.includes(tool.name())) return tool.handle(ctx, upstreamArgs);
    return executor.executeTool(ctx, tool, upstreamArgs);
  };

  const version = JSON.parse(fs.readFileSync(path.join(pkg.pkgDir, "package.json"), "utf8")).version;
  return { version, tools, createContext, execute, Execute, ScenarioRun };
}

module.exports = {
  loadUpstream,
  scopeRoutesToPage,
  capResponseBodies,
  trackInFlightRequests,
  screenshotTheElement,
  nestedTool,
  KEPT_BODY_CHARS,
  READ_BUDGET_CHARS,
  VISIBLE_WAIT_MS,
  // exported for tests and sibling broker modules
  CHUNK_SIGNATURES,
  FORCED_UPSTREAM_ENV,
  SESSIONLESS_TOOLS,
  parseExportNames,
  findChunkByExports,
  locateUpstreamChunks,
  resolveUpstreamPackage,
};
