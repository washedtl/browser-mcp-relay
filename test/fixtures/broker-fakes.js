// broker-fakes.js — stand-ins for the broker's sibling waves, shared by the
// broker tests and the fixture broker process (broker-entry.js):
//   W2C BraveSupervisor   → fakeSupervisor()
//   W2B upstream-inproc   → fakeUpstreamModule() (real upstream zod v3 shapes)
//   W2B window-pages      → fakeWindowPages()
//   W1B cached catalog    → FAKE_CATALOG
// plus an MCP client transport over a pipe socket.

"use strict";

const net = require("node:net");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { ReadBuffer, serializeMessage } = require("@modelcontextprotocol/sdk/shared/stdio.js");

// upstream's own zod (v3), so parse/transform behave as they will in production
const z = createRequire(require.resolve("browser-devtools-mcp/package.json"))("zod");

/** The served (JSON Schema) catalog, as W1B's tool-catalog.js returns it. */
const FAKE_CATALOG = [
  {
    name: "content_take-screenshot",
    description: "Take a screenshot",
    inputSchema: { type: "object", properties: { type: { type: "string", enum: ["PNG", "JPEG"] } } },
  },
  {
    name: "navigation_go-to",
    description: "Navigate",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  { name: "scenario-list", description: "List scenarios", inputSchema: { type: "object", properties: {} } },
  { name: "debug_status", description: "Debugger status", inputSchema: { type: "object", properties: {} } },
  { name: "content_get-as-text", description: "Page text", inputSchema: { type: "object", properties: {} } },
  // in the catalog but not in-process (version drift): must fail cleanly
  { name: "ghost_tool", description: "Only in the catalog", inputSchema: { type: "object", properties: {} } },
];

function fakeSupervisor(opts = {}) {
  const sup = new EventEmitter();
  Object.assign(sup, {
    opts,
    up: false,
    ensures: 0,
    closes: 0,
    launches: 0,
    fail: null,
    async ensure() {
      sup.ensures++;
      if (sup.fail) throw sup.fail;
      if (!sup.up) { sup.up = true; sup.launches++; }
      return { cdpUrl: `http://127.0.0.1:${opts.port}`, pid: 4242 };
    },
    isUp() { return sup.up; },
    async closeGracefully() {
      sup.closes++;
      if (!sup.up) return null;
      sup.up = false;
      sup.emit("down", "closed");
      return { graceful: true, ms: 1 };
    },
    crash(reason = "cdp disconnected") {
      sup.up = false;
      sup.emit("down", reason);
    },
  });
  return sup;
}

function fakeCtx(sessionKey) {
  const browser = { isConnected: () => true };
  return {
    sessionKey,
    closed: 0,
    page: { url: () => `about:blank#${sessionKey}`, sessionKey },
    // like W2B's page-scoped proxy: cookies() etc. reach the shared context
    browserContext: { browser: () => browser, sessionKey, async cookies() { return [{ name: "smoke", via: sessionKey }]; } },
    opens: 0,
    async ensureSessionPageOpen() { this.opens++; },
    async close() { this.closed++; },
  };
}

/**
 * W2B's module surface: SESSIONLESS_TOOLS + loadUpstream({cdpUrl}) →
 * {version, tools:[{name, description, inputShape, tool, pageTool}], createContext, execute}.
 * `execute` runs `tool.run(ctx, args)`, recording each call in `state.executed`.
 */
function fakeUpstreamModule() {
  const state = { loads: [], contexts: [], executed: [], order: [] };
  const tabId = z.string().optional();
  const tool = (name, run) => ({ name: () => name, run });
  const tools = [
    {
      name: "content_take-screenshot",
      description: "Take a screenshot",
      // like upstream: an enum that transforms its value, plus a default
      inputShape: { type: z.enum(["PNG", "JPEG"]).transform((s) => s.toLowerCase()).default("PNG"), tabId },
      pageTool: true,
      tool: tool("content_take-screenshot", async (ctx, args) => ({
        format: args.type,
        url: ctx.page.url(),
        _internal: "stripped",
        image: { data: Buffer.from("PNGDATA"), mimeType: "image/png" },
      })),
    },
    {
      name: "navigation_go-to",
      description: "Navigate",
      inputShape: { url: z.string(), tabId },
      pageTool: true,
      tool: tool("navigation_go-to", async (ctx, args) => {
        if (args.url === "boom://") throw new Error("net::ERR_NAME_NOT_RESOLVED");
        return { navigated: args.url, session: ctx.sessionKey };
      }),
    },
    {
      name: "content_get-as-text",
      description: "Page text",
      inputShape: { tabId },
      pageTool: true,
      tool: tool("content_get-as-text", async (ctx) => ({ text: `text of ${ctx.sessionKey}` })),
    },
    {
      name: "scenario-list",
      description: "List scenarios",
      inputShape: {},
      pageTool: false,
      tool: tool("scenario-list", async (ctx) => ({ scenarios: [], hadCtx: ctx !== null })),
    },
    {
      name: "debug_status",
      description: "Debugger status",
      inputShape: { tabId },
      pageTool: true,
      tool: tool("debug_status", async () => ({ enabled: false })),
    },
  ];
  const mod = {
    state,
    SESSIONLESS_TOOLS: ["scenario-list"],
    FORCED_UPSTREAM_ENV: { TELEMETRY_ENABLE: "false", BROWSER_CDP_OPEN_INSPECT: "false", TOOL_OUTPUT_SCHEMA_DISABLE: "true" },
    async loadUpstream({ cdpUrl }) {
      state.loads.push(cdpUrl);
      state.order.push("loadUpstream");
      return {
        version: "0.6.12-fake",
        tools,
        async createContext(sessionKey) {
          state.order.push(`createContext:${sessionKey}`);
          const ctx = fakeCtx(sessionKey);
          state.contexts.push(ctx);
          return ctx;
        },
        async execute(ctx, t, args) {
          // ctx is null for sessionless tools (pageTool:false)
          state.executed.push({ name: t.name(), sessionKey: ctx ? ctx.sessionKey : null, args });
          return t.run(ctx, args);
        },
      };
    },
  };
  return mod;
}

function fakeWindowPages() {
  const state = { installs: [], restored: [], uninstalls: 0 };
  return {
    state,
    installWindowPerPage({ placement }) {
      state.installs.push(placement);
      return () => { state.uninstalls++; };
    },
    async ensureNotMinimized(page) { state.restored.push(page.sessionKey); },
  };
}

/**
 * MCP client transport over a broker pipe connection (newline-delimited
 * JSON). With hello: { key, reconnect, settings } it first runs the shim's
 * authenticated hello (pipe-server.clientHello).
 */
class SocketClientTransport {
  constructor(pipe, { hello = null } = {}) {
    this.pipe = pipe;
    this.hello = hello;
    this._buf = new ReadBuffer();
  }
  async start() {
    const sock = net.connect(this.pipe);
    this.sock = sock;
    await new Promise((resolve, reject) => {
      sock.once("connect", () => { sock.removeListener("error", reject); resolve(); });
      sock.once("error", reject);
    });
    if (this.hello) {
      const { clientHello } = require("../../src/broker/pipe-server.js");
      const rest = await clientHello(sock, this.hello.key, this.hello);
      if (rest.length) sock.unshift(rest);
    }
    sock.on("data", (chunk) => {
      this._buf.append(chunk);
      for (let msg; (msg = this._buf.readMessage()) !== null;) this.onmessage && this.onmessage(msg);
    });
    sock.on("close", () => this.onclose && this.onclose());
    sock.on("error", (e) => this.onerror && this.onerror(e));
    sock.resume();
  }
  async send(message) { this.sock.write(serializeMessage(message)); }
  async close() { this.sock.end(); this.sock.destroy(); }
}

// ── W2D stand-ins: toolContext and own-tools written to W2D's ctx contract ──

/**
 * W2D's toolContext (src/own-tools/_tool-context.js at origin/w2d 0d78174),
 * same contract: routed tools get their tab (unknown tabId rejects; only
 * tabs_new opens tabs); others get { context, registry, connId, cdpUrl, relay }.
 */
async function fakeToolContext(registry, connId, tool, args, { context, cdpUrl, relay }) {
  const ctx = { context, registry, connId, cdpUrl, relay };
  if (tool.needsBrave === false || tool.needsPage === false) return ctx;
  const tabKey = args.tabId ?? "main";
  if (typeof tabKey !== "string" || tabKey === "") throw new Error(`tabId must be a non-empty string (got ${JSON.stringify(args.tabId)})`);
  if (tabKey !== "main" && !(await registry.listTabs(connId)).some((t) => t.tabKey === tabKey)) {
    throw new Error(`unknown tabId ${JSON.stringify(tabKey)}; call tabs_new or tabs_list`);
  }
  const session = await registry.getCtx(connId, tabKey);
  return { ...ctx, page: session.page, context: session.browserContext, sessionKey: `${connId}:${tabKey}` };
}
const fakeToolContextModule = () => ({ toolContext: fakeToolContext });

const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const TAB_ID = { type: "string", description: "Tab from tabs_new; omit for your main tab." };

/** A routed own-tool (W2D schema: carries tabId) that reports its ctx. */
const probeOwnTool = {
  name: "own_probe",
  description: "Reports its broker context",
  inputSchema: { type: "object", properties: { v: { type: "string" }, tabId: TAB_ID } },
  async handler(args, ctx) {
    return text({
      args,
      sessionKey: ctx.sessionKey,
      connId: ctx.connId,
      url: ctx.page.url(),
      contextSession: ctx.context.sessionKey,
      cdpUrl: ctx.cdpUrl,
      hasRelay: Boolean(ctx.relay && ctx.relay.enabledToolsets),
      hasRegistry: typeof ctx.registry.listTabs === "function",
    });
  },
};

/** Like W2D's tabs_new: needsPage:false, opens the tab through the registry. */
const tabsNewTool = {
  name: "tabs_new",
  description: "Open a tab",
  inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  needsPage: false,
  async handler(args, ctx) {
    await ctx.registry.getCtx(ctx.connId, args.name);
    return text({ tabId: args.name });
  },
};

/** Like W2D's cookies_*: needsPage:false, calls an async method on ctx.context. */
const cookiesTool = {
  name: "own_cookies",
  description: "Shared cookie jar",
  inputSchema: { type: "object", properties: {} },
  needsPage: false,
  async handler(args, ctx) {
    return text({ cookies: await ctx.context.cookies(), hasPage: "page" in ctx, cdpUrl: ctx.cdpUrl });
  },
};

/** Like W2D's lighthouse_audit: needsPage:false, uses only cdpUrl (never ctx.context). */
const cdpOnlyTool = {
  name: "own_cdp",
  description: "Uses the CDP endpoint only",
  inputSchema: { type: "object", properties: {} },
  needsPage: false,
  async handler(args, ctx) {
    return text({ cdpUrl: ctx.cdpUrl });
  },
};

/** Like W2D's tabs_list: needsBrave:false. */
const tabsListTool = {
  name: "tabs_list",
  description: "List tabs",
  inputSchema: { type: "object", properties: {} },
  needsBrave: false,
  async handler(args, ctx) {
    return text({ keys: Object.keys(ctx).sort(), tabs: ctx.registry ? ctx.registry.listTabs(ctx.connId).map((t) => t.tabKey) : null });
  },
};

/**
 * The real toolsets tool, called the W2D way. Before W2D merges, its handler
 * still takes the RelayServer itself; W2D's takes (args, { relay }).
 */
const toolsetsTool = (() => {
  const t = require("../../src/own-tools/toolsets.js").tool;
  const w2dMerged = require("node:fs").existsSync(require("node:path").join(__dirname, "../../src/own-tools/_tool-context.js"));
  return w2dMerged ? t : { ...t, handler: (args, ctx) => t.handler(args, ctx.relay) };
})();

module.exports = {
  z,
  FAKE_CATALOG,
  fakeSupervisor,
  fakeUpstreamModule,
  fakeWindowPages,
  fakeCtx,
  fakeToolContextModule,
  SocketClientTransport,
  probeOwnTool,
  tabsNewTool,
  cookiesTool,
  cdpOnlyTool,
  tabsListTool,
  toolsetsTool,
};
