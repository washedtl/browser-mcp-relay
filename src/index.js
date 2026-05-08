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
const { applyLocalConfigToEnv } = require("./local-config.js");
const { loadVaultFromEnv } = require("./vault.js");
const { attachAutofill } = require("./autofill-injector.js");

// Layer local-config.json under env so resolveBdmcpEntry / launch flags see
// it transparently. pool-shared.js applies the same overlay independently.
const RELAY_ENV = applyLocalConfigToEnv(process.env);

// Path to upstream `browser-devtools-mcp`. Resolution order:
//   1. BROWSER_RELAY_UPSTREAM_PATH env var (explicit override).
//   2. require.resolve("browser-devtools-mcp/dist/index.js") — works once the
//      package is installed as an npm dependency (the published-repo path).
//
// We resolve once at module load; if both fail we throw with an actionable
// message before any side effects fire.
function resolveBdmcpEntry() {
  const override = RELAY_ENV.BROWSER_RELAY_UPSTREAM_PATH;
  if (override && override.length > 0) {
    if (fs.existsSync(override)) return override;
    throw new Error(
      `[mcp-relay] BROWSER_RELAY_UPSTREAM_PATH="${override}" but no file at that path. Fix or unset.`,
    );
  }
  try {
    return require.resolve("browser-devtools-mcp/dist/index.js");
  } catch {
    throw new Error(
      `[mcp-relay] Could not locate browser-devtools-mcp upstream entry. ` +
      `Run \`npm install\` (so require.resolve finds it) or set ` +
      `BROWSER_RELAY_UPSTREAM_PATH=/abs/path/to/browser-devtools-mcp/dist/index.js.`,
    );
  }
}

async function main() {
  // 1. Claim slot.
  const { dir, lock, role, release: releasePool } = pool.claimSlot();
  // Slot index for the launch banner (and for the CDP port calc below).
  // Order of preference: explicit BROWSER_RELAY_POOL_SLOT env override
  // (parsed as a positive integer), otherwise the position of the claimed
  // dir in CONFIG.poolDirs (1-based). The override exists so users running
  // in pool mode can pin a specific port even if their dir-list ordering
  // changes between runs.
  const computedSlotIdx = pool.CONFIG.poolDirs.indexOf(dir) + 1;
  const slotOverrideRaw = RELAY_ENV.BROWSER_RELAY_POOL_SLOT;
  const slotOverride = slotOverrideRaw ? parseInt(slotOverrideRaw, 10) : NaN;
  const slotIdx = (Number.isFinite(slotOverride) && slotOverride > 0)
    ? slotOverride
    : computedSlotIdx;
  const totalSlots = pool.CONFIG.poolDirs.length;
  const src = pool.CONFIG.cookieSourceProfile;
  const cookiesPath = src ? pool.findCookiesFile(src) : null;
  const ageDays = cookiesPath ? pool.checkCookieAgeDays(cookiesPath) : null;
  const ageStr = ageDays === null ? "?" : `${ageDays.toFixed(1)}d`;
  process.stderr.write(
    `[mcp-relay] slot=${slotIdx}/${totalSlots} role=${role} pid=${process.pid} cookieAge=${ageStr} dir=${dir} mode=${pool.CONFIG.standalone ? "standalone" : "pool"}\n`,
  );

  // 2. Profile snapshot from source (skipped in standalone mode — sourceProfile is null).
  if (src && fs.existsSync(src)) {
    if (ageDays !== null && ageDays > pool.CONFIG.cookieFreshnessWarnDays) {
      process.stderr.write(
        `[mcp-relay] WARNING: cookie source ${path.basename(src)} is ${ageDays.toFixed(1)} days old (threshold ${pool.CONFIG.cookieFreshnessWarnDays}d). Refresh by launching the dedicated cookie-source MCP and logging into the sites you need.\n`,
      );
    }
    const copied = pool.snapshotCookiesFrom(src, dir);
    process.stderr.write(`[mcp-relay] snapshotted ${copied}/${pool.SNAPSHOT_FILES.length} profile files from ${path.basename(src)}\n`);

    // Directory snapshots (Local Storage, Session Storage, optional IndexedDB).
    // Many SPAs store auth tokens in localStorage rather than cookies, so this
    // is what makes Discord/Slack/Linear/Notion/Mercury sessions work.
    const includeIndexedDB = RELAY_ENV.BROWSER_RELAY_SNAPSHOT_INDEXEDDB === "true";
    const dirRes = pool.snapshotDirsFrom(src, dir, { includeIndexedDB });
    if (dirRes.total > 0) {
      process.stderr.write(
        `[mcp-relay] snapshotted ${dirRes.copied}/${dirRes.total} storage dirs ` +
        `(${(dirRes.bytes / 1024 / 1024).toFixed(1)}MB) in ${dirRes.elapsedMs}ms from ${path.basename(src)}\n`,
      );
    }
  } else if (src) {
    process.stderr.write(`[mcp-relay] cookie source ${src} missing — fresh login wall expected\n`);
  }
  // (In standalone mode, no cookie source is configured. The relay's
  // .browser-data dir is its own session — first-run will hit login walls.)

  // 2c. Load credential vault. OFF by default; opt in via BROWSER_RELAY_VAULT_FILES.
  // Empty vault → autofill is a no-op. Logged with counts only, never values.
  // Only emits a stderr line when at least one entry loaded, to keep startup
  // quiet for the common (vault-disabled) case.
  const vault = loadVaultFromEnv();
  const vsum = vault.summary();
  if (vsum.totalEntries > 0) {
    process.stderr.write(
      `[mcp-relay] vault: ${vsum.totalEntries} entries across ${vsum.uniqueHosts} hosts; ` +
      `files=[${vsum.filesLoaded.map((f) => `${path.basename(f.path)}:${f.entries}`).join(", ")}]\n`,
    );
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
    const bdmcpEntry = resolveBdmcpEntry();
    process.stderr.write(`[mcp-relay] spawning upstream child (no Brave yet, entry=${bdmcpEntry})...\n`);
    // CDP env points at the port we'll launch Brave on. Upstream is lazy
    // about its CDP attach (only runs in newBrowserContext on first tool
    // execution), so it's safe to set this before Brave is up.
    const upstreamEnv = { ...RELAY_ENV };
    delete upstreamEnv.BROWSER_PERSISTENT_USER_DATA_DIR;
    delete upstreamEnv.BROWSER_PERSISTENT_ENABLE;
    // BDMCP reads `BROWSER_CDP_ENDPOINT_URL` from process.env and assigns it
    // internally to its exported constant `BROWSER_CDP_CONNECT_URL`. The
    // env var must use the *_ENDPOINT_URL name; the *_CONNECT_URL constant
    // is never read from env, so setting it would silently send BDMCP into
    // its standalone-launch path (spawning a fresh temp-profile Brave next
    // to the relay's launched Brave). Don't set ENDPOINT_EXPLICIT — BDMCP
    // derives it internally from `!!_BROWSER_CDP_ENDPOINT`.
    upstreamEnv.BROWSER_CDP_ENDPOINT_URL = `http://127.0.0.1:${port}`;

    upstreamChild = spawn(process.execPath, [bdmcpEntry, "--cursor-mcp-server"], {
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
        // Resolve bravePath now, not at module load — auto-detect, env override,
        // or wrapper hint. Throws a clear error if Brave isn't installed.
        let bravePath = pool.CONFIG.bravePath;
        if (!bravePath) {
          try {
            bravePath = require("./detect-browser.js").detectBravePath({ env: RELAY_ENV });
          } catch (e) {
            // Fold the original detection failure context into the launch error.
            const original = pool.CONFIG.braveDetectError;
            if (original && original !== e) {
              e.message += `\n\nOriginal detection error at config-load time:\n${original.message}`;
            }
            throw e;
          }
        }
        process.stderr.write(`[mcp-relay] launching Brave (port=${port}, exe=${bravePath})...\n`);
        const extensionPath = RELAY_ENV.BROWSER_LOAD_EXTENSIONS || null;
        const launched = await launchBrave({
          userDataDir: dir,
          port,
          headless: RELAY_ENV.BROWSER_HEADLESS_ENABLE === "true",
          extensionPath,
          executablePath: bravePath,
          proxyUrl: RELAY_ENV.BROWSER_RELAY_PROXY_URL || null,
        });
        process.stderr.write(`[mcp-relay] Brave ready (cdpConnectUrl=${launched.cdpConnectUrl})\n`);
        // Attach autofill listeners to the launched context. Pages BDMCP
        // creates via CDP attach share this context, so the framenavigated
        // event fires for them too — autofill works for both relay-driven
        // and BDMCP-driven navigations. No-op when the vault is empty.
        attachAutofill(launched.context, vault, (msg) => process.stderr.write(msg + "\n"));
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

  // Expose getUpstream to own-tool handlers via globalThis. The tabs_new /
  // tabs_select handlers use this to call upstream's `navigation_go-to` so
  // upstream's tracked `_page` follows our intended active tab. Upstream's
  // session captures one specific Playwright Page reference at CDP-attach
  // time and never re-evaluates it from CDP `Target.*` events; calls like
  // `bringToFront` or creating new Playwright pages do NOT update that
  // reference. The only externally observable lever is to navigate
  // upstream's existing page via its own forwarded tools.
  globalThis.__relayUpstream = getUpstream;

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

  // 4b. Optional in-process Inspector. When BROWSER_RELAY_INSPECTOR_PORT is
  // set on the relay process, we boot the Inspector in this same Node
  // process and wire its WebSocket to the relay's trafficEmitter — so the
  // /slot/N Inspector page sees real MCP traffic as it happens. Standalone
  // `npm run inspector` runs separately and never gets here.
  let inspectorHandle = null;
  const inspectorPortRaw = RELAY_ENV.BROWSER_RELAY_INSPECTOR_PORT;
  if (inspectorPortRaw) {
    const parsed = parseInt(inspectorPortRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
      process.stderr.write(`[mcp-relay] WARNING: BROWSER_RELAY_INSPECTOR_PORT="${inspectorPortRaw}" is not a valid port; skipping in-process inspector\n`);
    } else {
      try {
        const { startInspector } = require("./inspector-server.js");
        const inspectorBind = RELAY_ENV.BROWSER_RELAY_INSPECTOR_BIND || "127.0.0.1";
        if (inspectorBind !== "127.0.0.1" && inspectorBind !== "localhost") {
          process.stderr.write(
            `[mcp-relay] WARNING: inspector binding to ${inspectorBind} (not 127.0.0.1). ` +
            `No auth — anyone reaching this address can read pool state.\n`,
          );
        }
        inspectorHandle = await startInspector({
          port: parsed,
          bind: inspectorBind,
          uiRoot: path.resolve(__dirname, "..", "scripts", "inspector-ui"),
          trafficEmitter: relay.trafficEmitter,
        });
        process.stderr.write(
          `[mcp-relay] inspector running at http://${inspectorBind}:${inspectorHandle.port}\n`,
        );
      } catch (e) {
        process.stderr.write(`[mcp-relay] inspector failed to start: ${e.stack || e.message}\n`);
      }
    }
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
    if (inspectorHandle) { inspectorHandle.close().catch(() => {}); }
    try { releasePool(); } catch {}
  }

  async function shutdownAsync() {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (upstreamClient) { try { upstreamClient.close(); } catch {} }
    if (upstreamChild) { try { upstreamChild.kill(); } catch {} }
    if (bridge) { try { await closeBrave(bridge); } catch {} }
    if (inspectorHandle) { try { await inspectorHandle.close(); } catch {} }
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
