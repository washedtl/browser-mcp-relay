#!/usr/bin/env node
/**
 * browser-mcp-relay entrypoint. BROWSER_RELAY_MODE picks what this process is
 * (see relayMode): `broker` (the default on Windows) runs the shim
 * (src/shim.js), which joins this session to the shared broker; `legacy`
 * runs the per-session relay below. Either way the MCP client config is
 * `node …/src/index.js`. Only light modules load before the mode is known:
 * the shim starts once per Claude session.
 *
 * Legacy lifecycle:
 *   1. Connect the MCP server on stdio right away. Nothing heavy happens at
 *      startup: no pool slot, no profile snapshot, no Brave, no upstream,
 *      no playwright-core. An idle session costs one small node process.
 *   2. On the first tools/call (see createLifecycle):
 *      - claim a pool slot (atomic lock), snapshot the cookie source into it,
 *        load the credential vault; the CDP port derives from the slot;
 *      - launch Brave on that slot via Playwright (cdp-bridge.js);
 *      - spawn upstream `browser-devtools-mcp` as a child with piped stdio,
 *        pointed at Brave's CDP port, wrapped in an UpstreamClient.
 *   3. A RelayServer dispatches tools/list and tools/call: own-tools run in
 *      process, everything else forwards to upstream.
 *   4. If Brave dies, the next call relaunches it and respawns upstream. If
 *      upstream dies, the next forwarded call respawns it. Neither exits the
 *      relay.
 *   5. On signal, stdin EOF (client went away) or exit: release the slot,
 *      kill upstream, close Brave.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile, execSync } = require("node:child_process");
const { applyLocalConfigToEnv } = require("./local-config.js");
const PKG = require("../package.json");
// Everything else is required where it's used: the MCP SDK, pool-shared,
// RelayServer, own-tools and friends cost ~250 ms and ~25 MB, which the
// broker-mode shim must not pay. cdp-bridge.js (playwright-core: 1-2s and
// ~32MB) loads only once Brave is actually needed.

// Layer local-config.json under env so resolveBdmcpEntry / launch flags see
// it transparently. pool-shared.js applies the same overlay independently.
const RELAY_ENV = applyLocalConfigToEnv(process.env);

const logStderr = (msg) => process.stderr.write(`${msg}\n`);

/**
 * Which relay this process runs (BROWSER_RELAY_MODE, env or local-config.json):
 *   broker  the shim: this session joins the shared broker (one Brave, one profile)
 *   legacy  this process is the whole relay: its own pool slot, Brave and upstream
 * Default: broker on Windows; legacy elsewhere, where the broker's unix-socket
 * paths have not been run yet.
 * @returns {"broker"|"legacy"}
 */
function relayMode(env, { platform = process.platform, log = logStderr } = {}) {
  const raw = String(env.BROWSER_RELAY_MODE || "").trim().toLowerCase();
  if (raw === "broker" || raw === "legacy") return raw;
  const fallback = platform === "win32" ? "broker" : "legacy";
  if (raw) log(`[mcp-relay] BROWSER_RELAY_MODE="${env.BROWSER_RELAY_MODE}" is neither broker nor legacy; using ${fallback}`);
  return fallback;
}

const SERVER_INSTRUCTIONS =
  "Debug / React / scenario / trace tools are hidden to save context. " +
  "If a task clearly needs one, ask the user, then call the `toolsets` tool.";

/**
 * V0-1/V0-2: ensure that if any post-launch step throws, the live Brave
 * context is closed before the error propagates. `launchBrave()` resolves
 * with a live BrowserContext that holds the user-data-dir lock; a throw
 * after that point (attachAutofill error, etc.) would leak the context
 * forever. Used by ensureBrave(). Module-level + exported so unit tests can
 * drive the contract directly.
 */
async function attachWithCleanupOnError(launched, fn) {
  try {
    return await fn(launched);
  } catch (e) {
    try { await launched.context.close(); } catch { /* best-effort */ }
    throw e;
  }
}

// Path to upstream `browser-devtools-mcp`. Resolution order:
//   1. BROWSER_RELAY_UPSTREAM_PATH env var (explicit override).
//   2. require.resolve("browser-devtools-mcp/dist/index.js") — works once the
//      package is installed as an npm dependency (the published-repo path).
//
// If both fail we throw with an actionable message before spawning anything.
// Shared with the catalog cache (tool-catalog.js) so the cached tool list and
// the live upstream always come from the same entry.
function resolveBdmcpEntry() {
  return require("./tool-catalog.js").resolveUpstreamEntry(RELAY_ENV);
}

/** Resolve the upstream entry and patch its bundle; returns the entry path. */
function prepareBdmcpEntry() {
  const bdmcpEntry = resolveBdmcpEntry();
  // F1-20 (2026-05-10): patch upstream's bundled HttpResourceType enum
  // before spawn. Upstream's enum is missing ping/prefetch/signedexchange/
  // cspviolationreport/preflight/fedcm — Playwright returns those (Amazon
  // affiliate links fire <a ping="..."> beacons → resourceType="ping" →
  // upstream's zod schema rejects → o11y_get-http-requests fails).
  //
  // We can't use Module._compile / --require because upstream is ESM and
  // those hooks are CJS-only. Patching the bundle on disk is reliable
  // across both module systems. Idempotent + safe — bails on bundler
  // shape changes rather than corrupting the file.
  try {
    const { applyPatch } = require("../scripts/patch-bdmcp-bundle.js");
    const result = applyPatch();
    if (!result.patched) {
      logStderr(`[mcp-relay] F1-20 patch skipped: ${result.reason} (o11y_get-http-requests may reject ping/prefetch/etc resourceTypes)`);
    }
  } catch (e) {
    logStderr(`[mcp-relay] F1-20 patch threw (continuing): ${e.message}`);
  }
  return bdmcpEntry;
}

// G0-3 (2026-05-10): cross-platform process-tree kill for the upstream
// child. Bare `child.kill()` on Windows only TerminateProcess's the node
// PID — its spawned BDMCP-launched children (Brave subtree if BDMCP fell
// back to standalone-launch) become reparented orphans. taskkill /F /T
// walks the tree.
//
// Async on purpose: recovery paths (Brave died, wedged client) run this
// while the relay is serving, and a sync taskkill freezes the event loop
// for 100-500 ms (up to its 5s timeout). Resolves when taskkill finishes;
// never rejects.
function killProcessTree(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try { child.kill("SIGTERM"); } catch {}
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}

/** Sync variant, only for process.on("exit") where async work never runs. */
function killProcessTreeSync(child) {
  if (!child.pid) return;
  if (process.platform !== "win32") {
    try { child.kill("SIGTERM"); } catch {}
    return;
  }
  try {
    execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: "ignore", windowsHide: true, timeout: 5000 });
  } catch { /* best-effort */ }
}

// G0-7 / G1-2: race awaitable shutdown steps against a per-step timeout
// and run them in parallel. closeBrave can hang on a wedged renderer;
// inspectorHandle.close can hang on idle keep-alive sockets. Without
// timeouts a single slow component blocks the whole shutdown. Never
// rejects; resolves true if the step timed out (and logs it).
function withTimeout(promise, ms, label, log = logStderr) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      log(`[mcp-relay] shutdown ${label} timed out — proceeding`);
      resolve(true);
    }, ms);
    const done = () => { clearTimeout(t); resolve(false); };
    Promise.resolve(promise).then(done, done);
  });
}

// Per-step cap for async shutdown. The MCP SDK's stdio client closes our
// stdin, waits ~2s, then sends SIGTERM — TerminateProcess on Windows, where
// no handler runs — so every step has to fit inside that window.
const SHUTDOWN_STEP_MS = 1500;

/**
 * The resources a relay owns — pool slot, Brave, upstream child — created
 * lazily on first use and torn down by shutdownAsync/shutdownSync.
 *
 *   ensureSlot()   claim a pool slot + snapshot the cookie source into it +
 *                  load the vault, once. Derives the CDP port.
 *   ensureBrave()  launch Brave on the slot; relaunches after Brave dies.
 *   peekBrave()    the running Brave's bridge, or null; never launches.
 *   getUpstream()  spawn upstream against the slot's CDP port; respawns
 *                  after upstream dies or Brave is relaunched.
 *
 * Dependencies are injectable so tests can drive the state machine with
 * fakes (no real slot, browser, or upstream).
 */
function createLifecycle({
  env = RELAY_ENV,
  pool = require("./pool-shared.js"),
  spawnChild = spawn,
  prepareUpstreamEntry = prepareBdmcpEntry,
  loadCdpBridge = () => require("./cdp-bridge.js"),
  loadVault = () => require("./vault.js").loadVaultFromEnv(),
  attachAutofill = (...args) => require("./autofill-injector.js").attachAutofill(...args),
  killTree = killProcessTree,
  killTreeSync = killProcessTreeSync,
  log = logStderr,
} = {}) {
  // -- Pool slot (claimed on first ensureBrave/getUpstream, not at startup) --
  let slot = null; // { dir, port }
  let releaseSlot = null;
  let vault = null;
  // Shutdown state (see shutdownAsync / shutdownSync below).
  let shutdownPromise = null;
  let shutdownDone = false;

  function ensureSlot() {
    // A claim after shutdown began would never be released.
    if (shutdownPromise || shutdownDone) throw new Error("[mcp-relay] relay is shutting down");
    if (slot) return slot;
    const { dir, role, release } = pool.claimSlot();
    try {
      slot = prepareSlot(dir, role);
    } catch (e) {
      // Don't leak the half-claimed slot (the next call would claim another).
      try { release(); } catch {}
      throw e;
    }
    releaseSlot = release;
    return slot;
  }

  /** Banner + profile snapshot + vault load for a freshly claimed slot. */
  function prepareSlot(dir, role) {
    // Slot index for the launch banner and the CDP port. Order of
    // preference: explicit BROWSER_RELAY_POOL_SLOT env override (parsed as a
    // positive integer), otherwise the position of the claimed dir in
    // CONFIG.poolDirs (1-based). The override exists so users running in
    // pool mode can pin a specific port even if their dir-list ordering
    // changes between runs.
    const computedSlotIdx = pool.CONFIG.poolDirs.indexOf(dir) + 1;
    const slotOverrideRaw = env.BROWSER_RELAY_POOL_SLOT;
    const slotOverride = slotOverrideRaw ? parseInt(slotOverrideRaw, 10) : NaN;
    const slotIdx = (Number.isFinite(slotOverride) && slotOverride > 0)
      ? slotOverride
      : computedSlotIdx;
    const totalSlots = pool.CONFIG.poolDirs.length;
    const src = pool.CONFIG.cookieSourceProfile;
    const cookiesPath = src ? pool.findCookiesFile(src) : null;
    const ageDays = cookiesPath ? pool.checkCookieAgeDays(cookiesPath) : null;
    const ageStr = ageDays === null ? "?" : `${ageDays.toFixed(1)}d`;
    log(
      `[mcp-relay] slot=${slotIdx}/${totalSlots} role=${role} pid=${process.pid} cookieAge=${ageStr} dir=${dir} mode=${pool.CONFIG.standalone ? "standalone" : "pool"}`,
    );
    const port = 9333 + slotIdx - 1; // 9333..9340 for slots 1-8

    // Profile snapshot from source (skipped in standalone mode — sourceProfile is null).
    if (src && fs.existsSync(src)) {
      if (ageDays !== null && ageDays > pool.CONFIG.cookieFreshnessWarnDays) {
        log(
          `[mcp-relay] WARNING: cookie source ${path.basename(src)} is ${ageDays.toFixed(1)} days old (threshold ${pool.CONFIG.cookieFreshnessWarnDays}d). Refresh by launching the dedicated cookie-source MCP and logging into the sites you need.`,
        );
      }
      const copied = pool.snapshotCookiesFrom(src, dir);
      log(`[mcp-relay] snapshotted ${copied}/${pool.SNAPSHOT_FILES.length} profile files from ${path.basename(src)}`);

      // Directory snapshots (Local Storage, Session Storage, optional IndexedDB).
      // Many SPAs store auth tokens in localStorage rather than cookies, so this
      // is what makes Discord/Slack/Linear/Notion/Mercury sessions work.
      const includeIndexedDB = env.BROWSER_RELAY_SNAPSHOT_INDEXEDDB === "true";
      const dirRes = pool.snapshotDirsFrom(src, dir, { includeIndexedDB });
      if (dirRes.total > 0) {
        log(
          `[mcp-relay] snapshotted ${dirRes.copied}/${dirRes.total} storage dirs ` +
          `(${(dirRes.bytes / 1024 / 1024).toFixed(1)}MB) in ${dirRes.elapsedMs}ms from ${path.basename(src)}`,
        );
      }
    } else if (src) {
      log(`[mcp-relay] cookie source ${src} missing — fresh login wall expected`);
    }
    // (In standalone mode, no cookie source is configured. The relay's
    // .browser-data dir is its own session — first-run will hit login walls.)

    // Credential vault. OFF by default; opt in via BROWSER_RELAY_VAULT_FILES.
    // Empty vault → autofill is a no-op. Logged with counts only, never values,
    // and only when at least one entry loaded.
    vault = loadVault();
    const vsum = vault.summary();
    if (vsum.totalEntries > 0) {
      log(
        `[mcp-relay] vault: ${vsum.totalEntries} entries across ${vsum.uniqueHosts} hosts; ` +
        `files=[${vsum.filesLoaded.map((f) => `${path.basename(f.path)}:${f.entries}`).join(", ")}]`,
      );
    }
    return { dir, port };
  }

  // -- Upstream lifecycle (spawned on first forwarded call) --
  let upstreamChild = null;
  let upstreamClient = null;
  let upstreamSpawnPromise = null;

  /** Forget the current upstream so the next getUpstream() respawns it. */
  function detachUpstream() {
    const child = upstreamChild;
    if (upstreamClient) upstreamClient.close();
    upstreamChild = null;
    upstreamClient = null;
    upstreamSpawnPromise = null;
    return child;
  }

  /** Relay-initiated teardown. The child's eventual "exit" is ignored
   *  because it is no longer the current child. Returns the (async) kill;
   *  recovery paths don't wait for it. */
  function teardownUpstream() {
    const child = detachUpstream();
    return child ? killTree(child) : Promise.resolve();
  }

  function spawnUpstream() {
    // Upstream needs the slot's CDP port, so this claims the slot (but does
    // not launch Brave).
    const { port } = ensureSlot();
    const bdmcpEntry = prepareUpstreamEntry();
    log(`[mcp-relay] spawning upstream child (entry=${bdmcpEntry})...`);
    // CDP env points at the slot's port. Upstream is lazy about its CDP
    // attach (only runs in newBrowserContext on first tool execution), so
    // it's safe to spawn before Brave is up.
    const upstreamEnv = { ...env };
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

    const child = spawnChild(process.execPath, [bdmcpEntry, "--cursor-mcp-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: upstreamEnv,
    });
    // Unexpected death (crash, spawn failure): forget the child so the next
    // forwarded call respawns it. The relay stays up — the MCP client still
    // owns our lifetime (signals / stdin EOF).
    const onDead = (why) => {
      if (upstreamChild !== child) return; // relay-initiated teardown, or stale
      log(`[mcp-relay] upstream child ${why}; respawning on next call`);
      detachUpstream();
    };
    child.on("exit", (code, signal) => onDead(`exited code=${code} signal=${signal}`));
    child.on("error", (e) => onDead(`failed: ${e.message}`));

    upstreamChild = child;
    const { UpstreamClient } = require("./upstream-client.js");
    upstreamClient = new UpstreamClient(child.stdout, child.stdin);
    return upstreamClient;
  }

  async function getUpstream() {
    // A client that closed under a live child (e.g. G1-5 line overflow) can
    // never answer again — replace the pair.
    if (upstreamClient && upstreamClient.closed) {
      log("[mcp-relay] upstream client closed; respawning upstream");
      teardownUpstream();
    }
    if (upstreamClient) return upstreamClient;
    if (!upstreamSpawnPromise) {
      // W1-5: wrap spawnUpstream in Promise.resolve().then so a synchronous
      // throw from spawnUpstream() (e.g. resolveBdmcpEntry throwing because
      // the upstream module isn't installed, or the pool being exhausted) is
      // captured by the .catch below. Without this, the assignment line
      // itself throws, the .catch never registers, and upstreamSpawnPromise
      // stays as the never-set undefined — every retry hits the same race
      // window.
      upstreamSpawnPromise = Promise.resolve().then(spawnUpstream).catch((e) => {
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
        const { dir, port } = ensureSlot();
        const { launchBrave } = loadCdpBridge();
        // Resolve bravePath now, not at module load — auto-detect, env override,
        // or wrapper hint. Throws a clear error if Brave isn't installed.
        let bravePath = pool.CONFIG.bravePath;
        if (!bravePath) {
          try {
            bravePath = require("./detect-browser.js").detectBravePath({ env });
          } catch (e) {
            // Fold the original detection failure context into the launch error.
            const original = pool.CONFIG.braveDetectError;
            if (original && original !== e) {
              e.message += `\n\nOriginal detection error at config-load time:\n${original.message}`;
            }
            throw e;
          }
        }
        log(`[mcp-relay] launching Brave (port=${port}, exe=${bravePath})...`);
        // F1-16 (2026-05-10): pre-launch reap of any orphan Brave squatting
        // on our user-data-dir. Closes the gap where:
        //   1. claimSlot() reaped at lock-acquire time, BUT no Brave was on
        //      `dir` then (lazy launch, etc.).
        //   2. Between claim and first ensureBrave() call, a different
        //      relay's Brave became orphaned on `dir` (parent died — Cursor
        //      hard-killed, blue screen, etc.).
        //   3. launchBrave's chromium.launchPersistentContext fails with
        //      "user data dir already in use" because the squatter is
        //      holding the dir's SingletonLock.
        // The reap is idempotent and cheap (one tasklist + targeted
        // taskkill /F /T per matching PID, capped at 10s in pool-shared).
        // Best-effort — failure here doesn't block the launch attempt; we
        // let Playwright surface the original "user data dir in use" error
        // so the user sees a real diagnostic, not a silent reap failure.
        try {
          const reaped = pool.reapOrphansFor(dir);
          if (reaped > 0) {
            log(`[mcp-relay] pre-launch reap removed ${reaped} squatter(s) on ${dir}`);
          }
        } catch (reapErr) {
          log(`[mcp-relay] pre-launch reap failed (continuing): ${reapErr.message}`);
        }
        const extensionPath = env.BROWSER_LOAD_EXTENSIONS || null;
        // V0-1/V0-2: launchBrave resolves with a live Brave subprocess +
        // open BrowserContext. If anything between here and the bridge
        // assignment throws (attachAutofill exception, an exception in the
        // logging code itself), the live context would leak with its
        // user-data-dir lock held forever. attachWithCleanupOnError closes
        // the context on any throw before rethrowing.
        // V1-1: proxyUrl resolution prefers env override, then bridges through
        // pool.CONFIG.proxyUrl (which itself reads from wrapper's
        // browser-mcp-config.json when the wrapper bridge is active). This
        // closes the gap where wrapper-spawned BDMCP routed through the
        // configured proxy but the relay's launched Brave didn't.
        const launched = await launchBrave({
          userDataDir: dir,
          port,
          headless: env.BROWSER_HEADLESS_ENABLE === "true",
          extensionPath,
          executablePath: bravePath,
          proxyUrl: env.BROWSER_RELAY_PROXY_URL || pool.CONFIG.proxyUrl || null,
        });
        return await attachWithCleanupOnError(launched, async (l) => {
          log(`[mcp-relay] Brave ready (cdpConnectUrl=${l.cdpConnectUrl})`);
          // Attach autofill listeners to the launched context. Pages BDMCP
          // creates via CDP attach share this context, so the framenavigated
          // event fires for them too — autofill works for both relay-driven
          // and BDMCP-driven navigations. No-op when the vault is empty.
          attachAutofill(l.context, vault, log);
          // Own-tools get { page, context, cdpUrl } built from this bridge by
          // RelayServer (own-tools/_legacy-context.js).
          bridge = l;
          // V1-5 (2026-06-01): invalidate the cached `bridge` when the
          // underlying Brave context/process dies. Without this listener, a
          // crashed/force-quit Brave leaves `bridge` pointing at a dead
          // Playwright BrowserContext. Every subsequent tool call then fails
          // with "browserContext.newPage: Target page, context or browser
          // has been closed" — a wedge that only recovers via full relay
          // restart. With this listener: next ensureBrave() call sees
          // bridge=null + braveLaunchPromise=null → relaunches Brave fresh
          // and the relay self-heals.
          //
          // Upstream must go too: it caches its CDP session for its whole
          // life and never notices the browser went away, so every forwarded
          // tool would keep failing against the dead one. Killing it here
          // makes the next forwarded call respawn it against the new Brave.
          const invalidateBridge = (reason) => {
            if (bridge !== l) return; // already moved on (e.g. external close)
            if (shutdownPromise || shutdownDone) return; // our own shutdown closed it
            log(
              `[mcp-relay] Brave context invalidated (${reason}); next call relaunches Brave and respawns upstream`,
            );
            bridge = null;
            braveLaunchPromise = null;
            teardownUpstream();
          };
          l.context.on("close", () => invalidateBridge("context closed"));
          try {
            // `browser()` may be null on some persistent-context launches; guard.
            const br = l.context.browser && l.context.browser();
            if (br && typeof br.on === "function") {
              br.on("disconnected", () => invalidateBridge("browser disconnected"));
            }
          } catch (e) {
            log(`[mcp-relay] could not attach browser.disconnected listener: ${e.message}`);
          }
          return bridge;
        });
      })().catch((e) => {
        braveLaunchPromise = null; // allow retry on next call
        throw e;
      });
    }
    return await braveLaunchPromise;
  }

  // -- Shutdown. Two paths:
  //    - shutdownSync: for process.on("exit"), which doesn't allow async work.
  //      Best-effort sync cleanup. closeBrave is fire-and-forget (Playwright's
  //      context.close is async; we lose the await here. Brave subprocesses
  //      may briefly orphan on abrupt exit — acceptable last-ditch path.)
  //    - shutdownAsync: for signals / stdin EOF, where we have a chance to
  //      await Brave teardown before process.exit.
  //
  // V0-4: shutdownAsync is memoized into `shutdownPromise` so concurrent
  // triggers all await one chain (a boolean flag only stopped the body from
  // re-running; the second caller then process.exit'ed mid-closeBrave and
  // orphaned Brave).

  /** Idempotent: a second release must not unlink a successor's lock. */
  function releasePool() {
    const release = releaseSlot;
    releaseSlot = null;
    if (release) release();
  }

  function shutdownSync() {
    if (shutdownDone) return;
    shutdownDone = true;
    try { releasePool(); } catch {}
    const child = detachUpstream();
    if (child) killTreeSync(child);
    if (bridge) { loadCdpBridge().closeBrave(bridge).catch(() => {}); }
  }

  function shutdownAsync() {
    if (shutdownPromise) return shutdownPromise;
    // Assigned before the body runs (it starts on the next microtask), so
    // anything the body triggers synchronously — a context "close" event,
    // a re-entrant ensureSlot — already sees shutdown as started.
    shutdownPromise = Promise.resolve().then(async () => {
      // G0-3 + G0-7/G1-2: kill the upstream tree (not just the parent PID)
      // and close Brave in PARALLEL, each capped by SHUTDOWN_STEP_MS.
      const tasks = [withTimeout(teardownUpstream(), SHUTDOWN_STEP_MS, "upstream kill", log)];
      if (bridge) {
        const { closeBrave } = loadCdpBridge();
        tasks.push(withTimeout(closeBrave(bridge), SHUTDOWN_STEP_MS, "closeBrave", log).then((timedOut) => {
          // A wedged Brave would outlive us: kill it by its user-data-dir.
          if (!timedOut) return;
          try { pool.reapOrphansFor(slot.dir); } catch (e) { log(`[mcp-relay] shutdown reap failed: ${e.message}`); }
        }));
      }
      await Promise.all(tasks);
      // Release the pool lock LAST, once our Brave no longer holds the dir —
      // releasing first let a successor relay claim it mid-close. If a
      // second signal exits us mid-await, shutdownSync (on "exit") still
      // releases, and stale / recycled-PID locks are reclaimable anyway.
      try { releasePool(); } catch {}
      shutdownDone = true;
    });
    return shutdownPromise;
  }

  // The running bridge, or null — never launches (tabs_list & co.).
  const peekBrave = () => bridge;

  return { ensureBrave, peekBrave, getUpstream, shutdownAsync, shutdownSync };
}

/**
 * The MCP server + RelayServer pair. `createRelay` is the RelayServer
 * factory (overridable so tests can observe the options it receives).
 */
function buildServer({ lifecycle, recordTraffic, createRelay = (opts) => new (require("./relay-server.js").RelayServer)(opts) }) {
  const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
  const { CallToolRequestSchema, ListToolsRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
  const server = new Server(
    { name: "browser-mcp-relay", version: PKG.version },
    {
      capabilities: { tools: { listChanged: true } },
      // Clients may load only tool names until a search, so state up front
      // that hidden groups exist and how an agent may get them.
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  const relay = createRelay({
    getUpstream: lifecycle.getUpstream,
    ensureBrave: lifecycle.ensureBrave,
    peekBrave: lifecycle.peekBrave,
    // Toolsets enabled/disabled at runtime change tools/list; the client is
    // told via notifications/tools/list_changed.
    // Rejects "Not connected" once the transport closes — nothing to tell then.
    notifyToolsChanged: () => server.sendToolListChanged().catch(() => {}),
    // Ask the user through MCP elicitation when the client supports form
    // mode (what elicitInput sends); null means "unsupported", so the caller
    // asks in chat instead. The caller's AbortSignal enforces its deadline.
    elicit: async (params, opts = {}) => {
      const caps = server.getClientCapabilities();
      if (!caps?.elicitation?.form) return null;
      return server.elicitInput(params, { signal: opts.signal });
    },
    // Only keep the traffic ring buffer when an in-process Inspector can show it.
    recordTraffic,
  });
  // Register own-tools. Each entry is { name, description, inputSchema, handler }.
  for (const tool of require("./own-tools/index.js").tools) {
    relay.registerOwnTool(tool);
  }
  server.setRequestHandler(ListToolsRequestSchema, async () => relay.handleToolsList());
  server.setRequestHandler(CallToolRequestSchema, async (req) => relay.handleToolsCall(req.params));
  return { server, relay };
}

async function main() {
  const lifecycle = createLifecycle();

  // Optional in-process Inspector. When BROWSER_RELAY_INSPECTOR_PORT is set
  // on the relay process, we boot the Inspector in this same Node process
  // and wire its WebSocket to the relay's trafficEmitter — so the /slot/N
  // Inspector page sees real MCP traffic as it happens. Standalone
  // `npm run inspector` runs separately and never gets here.
  const { inspectorPortFromEnv, launchInspector } = require("./inspector-launch.js");
  const inspectorPort = inspectorPortFromEnv(RELAY_ENV, logStderr);

  // MCP server first (NO slot, NO Brave, NO upstream yet — all lazy).
  const { server, relay } = buildServer({ lifecycle, recordTraffic: inspectorPort !== null });
  const ownToolNames = [...relay.ownTools.keys()];
  if (ownToolNames.length > 0) {
    logStderr(`[mcp-relay] registered ${ownToolNames.length} own-tools: ${ownToolNames.join(", ")}`);
  }
  const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
  await server.connect(new StdioServerTransport());

  const inspectorHandle = inspectorPort === null
    ? null
    : launchInspector({ port: inspectorPort, env: RELAY_ENV, log: logStderr, trafficEmitter: relay.trafficEmitter });

  // Lifecycle shutdown + inspector close, in PARALLEL with per-step
  // timeouts (G0-7 / G1-2). Memoized (V0-4) so every trigger awaits one chain.
  let shutdownPromise = null;
  function shutdownAsync() {
    if (shutdownPromise) return shutdownPromise;
    const tasks = [lifecycle.shutdownAsync()];
    if (inspectorHandle) {
      tasks.push(withTimeout(inspectorHandle.close(), SHUTDOWN_STEP_MS, "inspector"));
    }
    shutdownPromise = Promise.all(tasks);
    return shutdownPromise;
  }

  function shutdownSync() {
    lifecycle.shutdownSync();
    if (inspectorHandle) { inspectorHandle.close().catch(() => {}); }
  }

  // G0-4 (2026-05-10): catch otherwise-uncaught throws so the relay can
  // still run shutdown (release lock, close Brave, terminate upstream tree)
  // before exiting. Without these, an unhandled rejection from any async
  // path (autofill listener, inspector WS handler, capture-xhr body fetch)
  // crashes the relay and orphans Brave + lock.
  process.on("uncaughtException", async (e) => {
    logStderr(`[mcp-relay] uncaughtException: ${e?.stack || e}`);
    try { await shutdownAsync(); } catch {}
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    // Don't shut down on unhandled rejection — it's often non-fatal (a
    // background Promise like a body fetch that nobody awaited). Log loudly
    // so it shows up in inspector stderr and can be debugged.
    logStderr(`[mcp-relay] unhandledRejection: ${(reason && reason.stack) || reason}`);
  });

  process.on("exit", shutdownSync);
  process.on("SIGINT", async () => {
    try { await shutdownAsync(); } catch {}
    process.exit(130);
  });
  process.on("SIGTERM", async () => {
    try { await shutdownAsync(); } catch {}
    process.exit(143);
  });
  // The MCP client went away without signalling us (crashed, closed the
  // pipe): shut down instead of leaving relay + upstream + Brave running.
  const onStdinGone = async () => {
    try { await shutdownAsync(); } catch {}
    process.exit(0);
  };
  process.stdin.once("end", onStdinGone);
  process.stdin.once("close", onStdinGone);
  // The SDK closes the transport on a message over its 10 MB stdio limit and
  // only pauses stdin, so neither handler above fires: exit instead of going deaf.
  server.onclose = async () => {
    logStderr("[mcp-relay] MCP transport closed (a client message over the SDK's 10 MB stdio limit); shutting down");
    try { await shutdownAsync(); } catch {}
    process.exit(1);
  };
}

if (require.main === module) {
  if (relayMode(RELAY_ENV) === "broker") {
    require("./shim.js").main([]);
  } else {
    main().catch((e) => {
      logStderr(`[mcp-relay] fatal: ${e.stack || e.message}`);
      process.exit(1);
    });
  }
}

const { startInspectorWithRetry, INSPECTOR_RETRY_MS } = require("./inspector-launch.js");

module.exports = {
  main,
  relayMode,
  attachWithCleanupOnError,
  createLifecycle,
  buildServer,
  startInspectorWithRetry,
  killProcessTree,
  killProcessTreeSync,
  INSPECTOR_RETRY_MS,
};
