#!/usr/bin/env node
/**
 * browser-mcp-relay entrypoint.
 *
 * Lifecycle:
 *   1. Claim a pool slot via shared helpers (atomic lock, cookie snapshot).
 *   2. Spawn upstream `browser-devtools-mcp` as a child with piped stdio.
 *   3. Wrap that child in an UpstreamClient (JSON-RPC over stdio).
 *   4. Run a RelayServer that:
 *      - reads MCP messages from process.stdin (Cursor → relay)
 *      - dispatches: tools/list and tools/call use the relay logic;
 *        all other messages forward to upstream verbatim.
 *      - writes responses to process.stdout (relay → Cursor).
 *   5. On signal/exit, close upstream cleanly + release pool lock.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
// MCP SDK imports — the standard `@modelcontextprotocol/sdk/server/index.js`
// form resolves under CJS because the package's "exports" map points at
// dist/cjs/server/index.js for the require condition. Verified at
// task-A.5 import check.
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const pool = require("./pool-shared.js");
const { UpstreamClient } = require("./upstream-client.js");
const { RelayServer } = require("./relay-server.js");
const { launchBrave, closeBrave } = require("./cdp-bridge.js");
const { tools: ownTools } = require("./own-tools/index.js");

// Path to upstream — same constant as the v2 wrapper.
const BDMCP_ENTRY =
  "C:\\Users\\tlip9\\.cursor\\extensions\\serkan-ozal.browser-devtools-mcp-vscode-0.6.3-universal\\node_modules\\browser-devtools-mcp\\dist\\index.js";

const COOKIE_FILES = [
  "Local State",
  "Default/Network/Cookies",
  "Default/Network/Cookies-journal",
  "Default/Cookies",
  "Default/Cookies-journal",
];

async function main() {
  // 1. Claim slot.
  const { dir, lock, role, release: releasePool } = pool.claimSlot();
  const slotIdx = pool.CONFIG.poolDirs.indexOf(dir) + 1;
  const cookiesPath = pool.findCookiesFile(pool.CONFIG.cookieSourceProfile);
  const ageDays = cookiesPath ? pool.checkCookieAgeDays(cookiesPath) : null;
  const ageStr = ageDays === null ? "?" : `${ageDays.toFixed(1)}d`;
  process.stderr.write(
    `[mcp-relay] slot=${slotIdx}/${pool.CONFIG.poolDirs.length} role=${role} pid=${process.pid} cookieAge=${ageStr} dir=${dir}\n`,
  );

  // 2. Cookie snapshot from source. Mirrors v2 wrapper's snapshotCookiesFrom semantics.
  const src = pool.CONFIG.cookieSourceProfile;
  if (fs.existsSync(src)) {
    if (ageDays !== null && ageDays > pool.CONFIG.cookieFreshnessWarnDays) {
      process.stderr.write(
        `[mcp-relay] WARNING: cookie source ${path.basename(src)} is ${ageDays.toFixed(1)} days old (threshold ${pool.CONFIG.cookieFreshnessWarnDays}d). Refresh by launching the 'browser-devtools-mcp-2' MCP and logging into the sites you need.\n`,
      );
    }
    let copied = 0;
    for (const rel of COOKIE_FILES) {
      const s = path.join(src, rel);
      const d = path.join(dir, rel);
      try {
        if (fs.existsSync(s)) {
          fs.mkdirSync(path.dirname(d), { recursive: true });
          fs.copyFileSync(s, d);
          copied++;
        }
      } catch (e) {
        process.stderr.write(`[mcp-relay] cookie copy ${rel} failed: ${e.code || e.message}\n`);
      }
    }
    process.stderr.write(`[mcp-relay] snapshotted ${copied}/${COOKIE_FILES.length} cookie files from ${path.basename(src)}\n`);
  } else {
    process.stderr.write(`[mcp-relay] cookie source ${src} missing — fresh login wall expected\n`);
  }

  // 3. SPLIT lazy init: upstream and Brave init separately.
  //    - tools/list (Cursor calls this immediately at MCP connect) only needs
  //      upstream spawned. Upstream's tools/list returns its static catalog
  //      without any browser involvement.
  //    - tools/call needs BOTH upstream AND Brave (own-tools read
  //      globalThis.__relayBridge; forwarded tools have upstream try to
  //      attach via CDP, which requires Brave running).
  //    This split eliminates idle-Brave: a session that connects but never
  //    calls a tool stays at ~50MB total (1 relay node + 1 upstream node,
  //    no Brave).
  const port = 9333 + slotIdx - 1; // 9333..9340 for slots 1-8

  // -- Upstream lifecycle (spawned on first tools/list or tools/call) --
  let upstreamChild = null;
  let upstreamClient = null;
  let upstreamSpawnPromise = null;

  async function spawnUpstream() {
    process.stderr.write(`[mcp-relay] spawning upstream child (no Brave yet)...\n`);
    // CDP env points at the port we'll launch Brave on. Upstream is lazy
    // about its CDP attach (only runs in newBrowserContext on first tool
    // execution), so it's safe to set this before Brave is up.
    const upstreamEnv = { ...process.env };
    delete upstreamEnv.BROWSER_PERSISTENT_USER_DATA_DIR;
    delete upstreamEnv.BROWSER_PERSISTENT_ENABLE;
    upstreamEnv.BROWSER_CDP_CONNECT_URL = `http://127.0.0.1:${port}`;
    upstreamEnv.BROWSER_CDP_ENDPOINT_EXPLICIT = "true";

    upstreamChild = spawn(process.execPath, [BDMCP_ENTRY, "--cursor-mcp-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: upstreamEnv,
    });
    upstreamChild.on("exit", async (code, signal) => {
      process.stderr.write(`[mcp-relay] upstream child exited code=${code} signal=${signal}\n`);
      await shutdownAsync();
      if (signal) process.kill(process.pid, signal);
      else process.exit(code ?? 0);
    });

    upstreamClient = new UpstreamClient(upstreamChild.stdout, upstreamChild.stdin);
    return upstreamClient;
  }

  async function getUpstream() {
    if (upstreamClient) return upstreamClient;
    if (!upstreamSpawnPromise) {
      upstreamSpawnPromise = spawnUpstream().catch((e) => {
        upstreamSpawnPromise = null; // allow retry
        throw e;
      });
    }
    return await upstreamSpawnPromise;
  }

  // -- Brave lifecycle (launched ONLY on first tools/call, NOT on tools/list) --
  let bridge = null;
  let braveLaunchPromise = null;

  async function ensureBrave() {
    if (bridge) return bridge;
    if (!braveLaunchPromise) {
      braveLaunchPromise = (async () => {
        process.stderr.write(`[mcp-relay] launching Brave (port=${port})...\n`);
        const extensionPath = process.env.BROWSER_LOAD_EXTENSIONS || null;
        const launched = await launchBrave({
          userDataDir: dir,
          port,
          headless: process.env.BROWSER_HEADLESS_ENABLE === "true",
          extensionPath,
          executablePath: pool.CONFIG.bravePath,
        });
        process.stderr.write(`[mcp-relay] Brave ready (cdpConnectUrl=${launched.cdpConnectUrl})\n`);
        // Make the bridge available to own-tool handlers via globalThis.
        // Shape: { context, cdpConnectUrl, port } — Phase C tool handlers
        // read globalThis.__relayBridge to drive CDP operations.
        globalThis.__relayBridge = { ...launched, port };
        bridge = launched;
        return bridge;
      })().catch((e) => {
        braveLaunchPromise = null; // allow retry on next call
        throw e;
      });
    }
    return await braveLaunchPromise;
  }

  // 4. Run MCP server (NO Brave, NO upstream yet — both spawn lazily).
  const relay = new RelayServer({ getUpstream, ensureBrave });
  // Register Phase C own-tools. Each entry in ownTools is
  // { name, description, inputSchema, handler }.
  for (const tool of ownTools) {
    relay.registerOwnTool(tool);
  }
  if (ownTools.length > 0) {
    process.stderr.write(`[mcp-relay] registered ${ownTools.length} own-tools: ${ownTools.map(t => t.name).join(", ")}\n`);
  }

  const server = new Server(
    { name: "browser-mcp-relay", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => relay.handleToolsList());
  server.setRequestHandler(CallToolRequestSchema, async (req) => relay.handleToolsCall(req.params));

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 5. Lifecycle. Two paths:
  //    - shutdownSync: for process.on("exit"), which doesn't allow async work.
  //      Best-effort sync cleanup. closeBrave is fire-and-forget (Playwright's
  //      context.close is async; we lose the await here. Brave subprocesses
  //      may briefly orphan on abrupt exit — acceptable last-ditch path.)
  //    - shutdownAsync: for SIGINT/SIGTERM/upstream-child-exit, where we have
  //      a chance to await Brave teardown before process.exit. Eliminates
  //      the orphan-Brave race in the common graceful-exit cases.
  //    Both paths share the `shutdownStarted` flag for idempotency.
  let shutdownStarted = false;

  function shutdownSync() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (upstreamClient) { try { upstreamClient.close(); } catch {} }
    if (upstreamChild) { try { upstreamChild.kill(); } catch {} }
    if (bridge) { closeBrave(bridge).catch(() => {}); }
    try { releasePool(); } catch {}
  }

  async function shutdownAsync() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (upstreamClient) { try { upstreamClient.close(); } catch {} }
    if (upstreamChild) { try { upstreamChild.kill(); } catch {} }
    if (bridge) { try { await closeBrave(bridge); } catch {} }
    try { releasePool(); } catch {}
  }

  process.on("exit", shutdownSync);
  process.on("SIGINT", async () => { await shutdownAsync(); process.exit(130); });
  process.on("SIGTERM", async () => { await shutdownAsync(); process.exit(143); });
}

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[mcp-relay] fatal: ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { main };
