// Behavioral tests for the relay's lifecycle (src/index.js createLifecycle),
// MCP server wiring (buildServer), the inspector bind-retry loop
// (startInspectorWithRetry), and one end-to-end spawn of the real entrypoint.
//
// The lifecycle tests drive the real state machine with fakes for the pool,
// Brave (cdp-bridge) and the upstream child, so nothing here claims a real
// slot, launches a browser, or spawns browser-devtools-mcp.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

const {
  createLifecycle,
  buildServer,
  startInspectorWithRetry,
  killProcessTree,
  killProcessTreeSync,
  INSPECTOR_RETRY_MS,
} = require("../src/index.js");
const { RelayServer } = require("../src/relay-server.js");
const PKG = require("../package.json");

const ENTRY = path.resolve(__dirname, "..", "src", "index.js");

// ─────────────────────────── fakes ───────────────────────────

let nextPid = 70000;

/** Child-process stand-in: real streams so UpstreamClient works on it. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.pid = nextPid++;
  child.die = (code = 1, signal = null) => {
    child.emit("exit", code, signal);
    child.stdout.destroy();
  };
  return child;
}

/** BrowserContext stand-in: emits "close"; browser() emits "disconnected". */
function fakeContext() {
  const ctx = new EventEmitter();
  const browser = new EventEmitter();
  ctx.browser = () => browser;
  ctx.close = async () => { ctx.emit("close"); };
  ctx.crash = () => browser.emit("disconnected");
  return ctx;
}

function makeHarness(overrides = {}) {
  const calls = { claim: 0, release: 0, launch: [], loadBridge: 0, closeBrave: 0, killTree: [], killTreeSync: [], reap: [], order: [] };
  const logs = [];
  const children = [];
  const contexts = [];
  const pool = {
    CONFIG: {
      poolDirs: ["/fake/pool-1", "/fake/pool-2"],
      bravePath: "/fake/brave.exe",
      cookieSourceProfile: null,
      cookieFreshnessWarnDays: 7,
      standalone: false,
    },
    SNAPSHOT_FILES: [],
    claimSlot() {
      calls.claim++;
      return { dir: "/fake/pool-2", role: "default", release() { calls.release++; calls.order.push("release"); } };
    },
    reapOrphansFor(dir) { calls.reap.push(dir); calls.order.push("reap"); return 0; },
    findCookiesFile() { return null; },
    checkCookieAgeDays() { return null; },
    snapshotCookiesFrom() { return 0; },
    snapshotDirsFrom() { return { copied: 0, total: 0, bytes: 0, elapsedMs: 0 }; },
  };
  const deps = {
    env: {},
    pool,
    spawnChild(exe, args, opts) {
      const c = fakeChild();
      c.spawnArgs = { exe, args, opts };
      children.push(c);
      return c;
    },
    prepareUpstreamEntry: () => "/fake/bdmcp/dist/index.js",
    loadCdpBridge() {
      calls.loadBridge++;
      return {
        async launchBrave(opts) {
          calls.launch.push(opts);
          calls.order.push("launch");
          const ctx = fakeContext();
          contexts.push(ctx);
          return { context: ctx, cdpConnectUrl: `http://127.0.0.1:${opts.port}` };
        },
        async closeBrave(handle) {
          calls.closeBrave++;
          calls.order.push("closeBrave");
          await handle.context.close();
        },
      };
    },
    loadVault: () => ({ summary: () => ({ totalEntries: 0, uniqueHosts: 0, filesLoaded: [] }) }),
    attachAutofill() {},
    killTree(child) {
      calls.killTree.push(child.pid);
      // Real taskkill: the child's "exit" lands asynchronously, later.
      setImmediate(() => child.die(null, "SIGTERM"));
      return Promise.resolve();
    },
    killTreeSync(child) {
      calls.killTreeSync.push(child.pid);
    },
    log: (m) => logs.push(m),
    ...overrides,
  };
  return { deps, calls, logs, children, contexts, pool };
}

const tick = () => new Promise((r) => setImmediate(r));

async function waitFor(pred, ms = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error("waitFor: condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ─────────────────────── lazy slot claim (item 2) ───────────────────────

test("lazy: creating the lifecycle claims no slot, loads no cdp-bridge, spawns nothing", () => {
  const h = makeHarness();
  createLifecycle(h.deps);
  assert.strictEqual(h.calls.claim, 0, "no slot claim at startup");
  assert.strictEqual(h.calls.loadBridge, 0, "cdp-bridge (playwright-core) not loaded at startup");
  assert.strictEqual(h.children.length, 0, "no upstream spawned at startup");
});

test("lazy: first ensureBrave claims the slot once and derives the CDP port from it", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  const [a, b] = await Promise.all([lc.ensureBrave(), lc.ensureBrave()]);
  assert.strictEqual(a, b, "concurrent callers share one launch");
  assert.strictEqual(h.calls.claim, 1);
  assert.strictEqual(h.calls.launch.length, 1);
  // Claimed dir is poolDirs[1] → slot 2 → port 9333 + 2 - 1.
  assert.strictEqual(h.calls.launch[0].port, 9334);
  assert.strictEqual(h.calls.launch[0].userDataDir, "/fake/pool-2");
  // W2D: own-tools get { context, cdpUrl } from this bridge (relay ctx); no globals.
  assert.strictEqual(a.cdpConnectUrl, "http://127.0.0.1:9334");
  assert.strictEqual(a.context, h.contexts[0]);
  assert.strictEqual(globalThis.__relayBridge, undefined);
  assert.ok(h.logs.some((l) => /slot=2\/2/.test(l)), "banner logged at claim time");
});

// W2D: tabs_list / tabs_select / tabs_close look at the running Brave only.
test("W2D: peekBrave returns the running bridge (null before launch / after Brave dies) and never launches", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  assert.strictEqual(lc.peekBrave(), null);
  assert.strictEqual(h.calls.claim, 0);
  assert.strictEqual(h.calls.launch.length, 0);
  const bridge = await lc.ensureBrave();
  assert.strictEqual(lc.peekBrave(), bridge);
  h.contexts[0].emit("close");
  assert.strictEqual(lc.peekBrave(), null);
  assert.strictEqual(h.calls.launch.length, 1);
});

test("lazy: BROWSER_RELAY_POOL_SLOT override sets the port at claim time", async () => {
  const h = makeHarness();
  const lc = createLifecycle({ ...h.deps, env: { BROWSER_RELAY_POOL_SLOT: "4" } });
  await lc.ensureBrave();
  assert.strictEqual(h.calls.launch[0].port, 9336);
});

test("lazy: getUpstream claims the slot for the CDP port but does not launch Brave", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  await lc.getUpstream();
  assert.strictEqual(h.calls.claim, 1);
  assert.strictEqual(h.calls.launch.length, 0, "Brave not launched");
  assert.strictEqual(h.calls.loadBridge, 0, "cdp-bridge not loaded");
  const env = h.children[0].spawnArgs.opts.env;
  assert.strictEqual(env.BROWSER_CDP_ENDPOINT_URL, "http://127.0.0.1:9334");
  // Second call reuses the slot + client.
  await lc.getUpstream();
  assert.strictEqual(h.calls.claim, 1);
  assert.strictEqual(h.children.length, 1);
});

test("lazy: a failed claim (pool exhausted) surfaces on the call and is retried next time", async () => {
  const h = makeHarness();
  const realClaim = h.pool.claimSlot;
  let first = true;
  h.pool.claimSlot = () => {
    if (first) { first = false; throw new Error("[mcp-relay] pool exhausted for role=\"any\""); }
    return realClaim();
  };
  const lc = createLifecycle(h.deps);
  await assert.rejects(lc.ensureBrave(), /pool exhausted/);
  await lc.ensureBrave();
  assert.strictEqual(h.calls.launch.length, 1, "second call claims + launches");
});

test("F1-16: ensureBrave reaps orphans on the claimed dir before launching", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  await lc.ensureBrave();
  assert.deepStrictEqual(h.calls.reap, ["/fake/pool-2"]);
  assert.deepStrictEqual(h.calls.order, ["reap", "launch"]);
});

// ──────────────── upstream recovery after Brave death (item 1) ────────────────

for (const [label, kill] of [
  ["context close", (ctx) => ctx.emit("close")],
  ["browser disconnected", (ctx) => ctx.crash()],
]) {
  test(`recovery (${label}): Brave death tears down upstream; next calls relaunch Brave + respawn upstream`, async (t) => {
    t.mock.method(process, "exit", () => {});
    const h = makeHarness();
    const lc = createLifecycle(h.deps);
    const bridge1 = await lc.ensureBrave();
    const client1 = await lc.getUpstream();
    const child1 = h.children[0];

    kill(h.contexts[0]);

    assert.deepStrictEqual(h.calls.killTree, [child1.pid], "stale upstream killed (it caches the dead CDP session)");
    assert.strictEqual(client1.closed, true, "stale client closed");

    const bridge2 = await lc.ensureBrave();
    const client2 = await lc.getUpstream();
    assert.strictEqual(h.calls.launch.length, 2, "Brave relaunched");
    assert.notStrictEqual(bridge2, bridge1, "own-tools get the relaunched Brave, not the dead one");
    assert.notStrictEqual(client2, client1, "fresh upstream client");
    assert.strictEqual(h.children.length, 2);
    assert.strictEqual(h.calls.claim, 1, "same slot reused");

    // The killed child's exit lands late — it must not clobber the new one.
    await tick(); await tick();
    assert.strictEqual(await lc.getUpstream(), client2);
    assert.strictEqual(h.children.length, 2);
    assert.strictEqual(process.exit.mock.callCount(), 0, "relay-initiated teardown must not exit the relay");
  });
}

test("recovery: unexpected upstream exit is logged, relay stays up, next call respawns", async (t) => {
  t.mock.method(process, "exit", () => {});
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  const client1 = await lc.getUpstream();
  h.children[0].die(1, null);
  await tick();
  assert.strictEqual(process.exit.mock.callCount(), 0, "relay must not exit when upstream dies");
  assert.ok(h.logs.some((l) => /upstream child exited code=1/.test(l)), "exit is logged");
  const client2 = await lc.getUpstream();
  assert.notStrictEqual(client2, client1);
  assert.strictEqual(h.children.length, 2);
  assert.deepStrictEqual(h.calls.killTree, [], "already-dead child is not tree-killed");
});

test("recovery: upstream spawn 'error' is non-fatal and respawns lazily", async (t) => {
  t.mock.method(process, "exit", () => {});
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  await lc.getUpstream();
  h.children[0].emit("error", new Error("spawn EMFILE"));
  assert.ok(h.logs.some((l) => /EMFILE/.test(l)));
  await lc.getUpstream();
  assert.strictEqual(h.children.length, 2);
  assert.strictEqual(process.exit.mock.callCount(), 0);
});

test("recovery: a closed upstream client (e.g. line overflow) is replaced on next getUpstream", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  const client1 = await lc.getUpstream();
  client1._onError(new Error("upstream line size exceeded"));
  const client2 = await lc.getUpstream();
  assert.notStrictEqual(client2, client1);
  assert.deepStrictEqual(h.calls.killTree, [h.children[0].pid], "wedged child is killed, not leaked");
});

// ─────────────────────────────── shutdown ───────────────────────────────

test("shutdown before anything was claimed: no release, no kill, no throw", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  await lc.shutdownAsync();
  lc.shutdownSync();
  assert.strictEqual(h.calls.release, 0);
  assert.strictEqual(h.calls.killTree.length, 0);
  assert.strictEqual(h.calls.loadBridge, 0, "shutdown with no Brave doesn't load cdp-bridge");
});

test("shutdown: memoized, kills upstream, releases the slot LAST (after Brave is closed)", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  await lc.ensureBrave();
  await lc.getUpstream();
  const p1 = lc.shutdownAsync();
  const p2 = lc.shutdownAsync();
  assert.strictEqual(p1, p2, "concurrent callers await one chain");
  await p1;
  assert.strictEqual(h.calls.closeBrave, 1);
  assert.deepStrictEqual(h.calls.killTree, [h.children[0].pid]);
  // Releasing first let a successor relay claim the dir while our Brave
  // still held it. A mid-shutdown exit still releases via shutdownSync.
  const order = h.calls.order.filter((s) => s === "release" || s === "closeBrave");
  assert.deepStrictEqual(order, ["closeBrave", "release"]);
  assert.strictEqual(h.calls.release, 1);
});

test("shutdown: closeBrave is capped at ~1.5s; on timeout Brave is reaped by user-data-dir, then the lock released", async () => {
  // The SDK client gives a stdio server ~2s after closing stdin before
  // SIGTERM (TerminateProcess on Windows: no handlers run).
  const h = makeHarness();
  const bridgeDeps = h.deps.loadCdpBridge;
  h.deps.loadCdpBridge = () => ({
    ...bridgeDeps(),
    closeBrave: async () => { h.calls.order.push("closeBrave"); return new Promise(() => {}); }, // wedged
  });
  const lc = createLifecycle(h.deps);
  await lc.ensureBrave();
  const t0 = Date.now();
  await lc.shutdownAsync();
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1400 && elapsed < 2000, `shutdown took ${elapsed}ms (cap ~1.5s)`);
  assert.deepStrictEqual(h.calls.reap, ["/fake/pool-2", "/fake/pool-2"], "pre-launch reap + timeout fallback reap");
  assert.deepStrictEqual(h.calls.order.slice(-3), ["closeBrave", "reap", "release"]);
  assert.ok(h.logs.some((l) => /closeBrave timed out/.test(l)));
});

test("shutdown: Brave closing during a clean shutdown doesn't log the relaunch message", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  await lc.ensureBrave();
  await lc.shutdownAsync();
  assert.ok(!h.logs.some((l) => /relaunches Brave/.test(l)), JSON.stringify(h.logs));
});

test("ensureSlot: a throw after the claim (snapshot / vault) releases it; the next call claims fresh", async () => {
  const h = makeHarness();
  let failVault = true;
  h.deps.loadVault = () => {
    if (failVault) { failVault = false; throw new Error("vault exploded"); }
    return { summary: () => ({ totalEntries: 0, uniqueHosts: 0, filesLoaded: [] }) };
  };
  const lc = createLifecycle(h.deps);
  await assert.rejects(lc.ensureBrave(), /vault exploded/);
  assert.strictEqual(h.calls.claim, 1);
  assert.strictEqual(h.calls.release, 1, "half-claimed slot released, not leaked");
  assert.strictEqual(h.calls.launch.length, 0);
  await lc.ensureBrave();
  assert.strictEqual(h.calls.claim, 2, "fresh claim");
  assert.strictEqual(h.calls.launch.length, 1);
  await lc.shutdownAsync();
  assert.strictEqual(h.calls.release, 2, "the second claim is the one released at shutdown");
});

test("shutdown: process 'exit' mid-shutdownAsync releases the slot only once", async () => {
  // Exit can land while shutdownAsync is still awaiting closeBrave (e.g. a
  // second signal). A second release() would unlink the lock file by path —
  // possibly a successor relay's fresh lock on the same dir.
  let finishClose;
  const h = makeHarness();
  const bridgeDeps = h.deps.loadCdpBridge;
  h.deps.loadCdpBridge = () => ({
    ...bridgeDeps(),
    // Only the first (awaited) close is resolvable; shutdownSync's own
    // fire-and-forget close is left pending.
    closeBrave: () => new Promise((r) => { if (!finishClose) finishClose = r; }),
  });
  const lc = createLifecycle(h.deps);
  await lc.ensureBrave();
  const p = lc.shutdownAsync();
  await waitFor(() => typeof finishClose === "function");
  lc.shutdownSync(); // process "exit" while the async chain is mid-await
  finishClose();
  await p;
  assert.strictEqual(h.calls.release, 1, "release is idempotent");
});

test("shutdown: once started, no new slot claim / Brave launch / upstream spawn", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  const p = lc.shutdownAsync();
  await assert.rejects(lc.ensureBrave(), /shutting down/);
  await assert.rejects(lc.getUpstream(), /shutting down/);
  await p;
  assert.strictEqual(h.calls.claim, 0);
  assert.strictEqual(h.children.length, 0);
});

test("shutdownSync (process 'exit' path) releases + kills with the SYNC tree-kill", async () => {
  const h = makeHarness();
  const lc = createLifecycle(h.deps);
  await lc.ensureBrave();
  await lc.getUpstream();
  lc.shutdownSync();
  assert.strictEqual(h.calls.release, 1);
  assert.deepStrictEqual(h.calls.killTreeSync, [h.children[0].pid], "exit handler can't run async work");
  assert.deepStrictEqual(h.calls.killTree, [], "async kill would never run inside process 'exit'");
  assert.strictEqual(h.calls.closeBrave, 1, "closeBrave fired (not awaited)");
});

test("shutdownAsync starts the upstream kill and closeBrave in parallel (neither waits for the other)", async () => {
  const h = makeHarness();
  let finishKill;
  h.deps.killTree = (child) => {
    h.calls.killTree.push(child.pid);
    return new Promise((r) => { finishKill = r; });
  };
  const lc = createLifecycle(h.deps);
  await lc.ensureBrave();
  await lc.getUpstream();
  let settled = false;
  const p = lc.shutdownAsync().then(() => { settled = true; });
  await Promise.resolve(); // the shutdown body starts on the next microtask
  assert.strictEqual(h.calls.killTree.length, 1, "kill started");
  assert.strictEqual(h.calls.closeBrave, 1, "closeBrave started while the kill is still running");
  await tick(); await tick();
  assert.strictEqual(settled, false, "shutdown waits for the (capped) kill");
  finishKill();
  await p;
  assert.strictEqual(settled, true);
});

// timeout: a regression here (awaiting the never-finishing kill) would hang.
test("recovery paths don't wait for the tree-kill (async, fire-and-forget)", { timeout: 5000 }, async () => {
  const h = makeHarness();
  h.deps.killTree = (child) => {
    h.calls.killTree.push(child.pid);
    return new Promise(() => {}); // taskkill that never finishes
  };
  const lc = createLifecycle(h.deps);
  await lc.ensureBrave();
  const client1 = await lc.getUpstream();
  h.contexts[0].crash(); // Brave died → teardown
  await lc.ensureBrave();
  const client2 = await lc.getUpstream();
  assert.notStrictEqual(client2, client1, "respawned without waiting on the kill");
  client2._onError(new Error("overflow")); // wedged client → teardown
  const client3 = await lc.getUpstream();
  assert.notStrictEqual(client3, client2);
  assert.strictEqual(h.calls.killTree.length, 2);
});

test("killProcessTree is async and kills a real child; killProcessTreeSync kills synchronously", async () => {
  const mock = path.join(__dirname, "fixtures", "mock-upstream.js");
  const spawnMock = () => {
    const c = spawn(process.execPath, [mock, "--no-reply"], { stdio: ["pipe", "pipe", "ignore"] });
    return { c, exited: new Promise((r) => c.on("exit", () => r(true))) };
  };
  const a = spawnMock();
  try {
    const ret = killProcessTree(a.c);
    assert.ok(ret instanceof Promise, "returns a promise (does not block the event loop)");
    await ret;
    assert.strictEqual(await Promise.race([a.exited, new Promise((r) => setTimeout(() => r(false), 5000))]), true);
  } finally {
    if (a.c.exitCode === null) a.c.kill();
  }
  const b = spawnMock();
  try {
    assert.strictEqual(killProcessTreeSync(b.c), undefined);
    assert.strictEqual(await Promise.race([b.exited, new Promise((r) => setTimeout(() => r(false), 5000))]), true);
  } finally {
    if (b.c.exitCode === null) b.c.kill();
  }
  // A child that never spawned (no pid) is a no-op, not a throw.
  await killProcessTree({ pid: undefined });
  killProcessTreeSync({ pid: undefined });
});

// ─────────────────────── lazy requires (item 3) ───────────────────────

test("requiring src/index.js does not load playwright-core or cdp-bridge", () => {
  const probe = `
    require(${JSON.stringify(ENTRY)});
    const keys = Object.keys(require.cache);
    console.log(JSON.stringify({
      playwright: keys.some((k) => k.includes("playwright-core")),
      cdpBridge: keys.some((k) => k.endsWith("cdp-bridge.js")),
    }));
  `;
  const r = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.deepStrictEqual(out, { playwright: false, cdpBridge: false });
});

// ─────────────── MCP server wiring (items 5 + 6, W1B contract) ───────────────

async function connectClient(server) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await server.connect(serverT);
  return { client, connect: () => client.connect(clientT) };
}

test("MCP server: version comes from package.json and tools.listChanged is declared", async () => {
  const lifecycle = { getUpstream: async () => {}, ensureBrave: async () => {}, peekBrave: () => null };
  const { server } = buildServer({ lifecycle, recordTraffic: false });
  const { client, connect } = await connectClient(server);
  await connect();
  try {
    assert.strictEqual(client.getServerVersion().version, PKG.version);
    assert.strictEqual(client.getServerVersion().name, "browser-mcp-relay");
    assert.deepStrictEqual(client.getServerCapabilities().tools, { listChanged: true });
  } finally {
    await client.close();
  }
});

test("RelayServer receives lifecycle hooks, recordTraffic, and a notifyToolsChanged that emits tools/list_changed", async () => {
  const { ToolListChangedNotificationSchema } = require("@modelcontextprotocol/sdk/types.js");
  const lifecycle = { getUpstream: async () => {}, ensureBrave: async () => {}, peekBrave: () => null };
  for (const recordTraffic of [true, false]) {
    let opts = null;
    const { server, relay } = buildServer({
      lifecycle,
      recordTraffic,
      createRelay: (o) => { opts = o; return new RelayServer(o); },
    });
    assert.ok(relay instanceof RelayServer);
    assert.strictEqual(opts.recordTraffic, recordTraffic);
    assert.strictEqual(opts.getUpstream, lifecycle.getUpstream);
    assert.strictEqual(opts.ensureBrave, lifecycle.ensureBrave);
    assert.strictEqual(opts.peekBrave, lifecycle.peekBrave);
    assert.ok(relay.ownTools.size > 0, "own-tools registered");

    const { client, connect } = await connectClient(server);
    const changed = new Promise((resolve) => {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => resolve(true));
    });
    await connect();
    try {
      await opts.notifyToolsChanged();
      assert.strictEqual(await changed, true);
    } finally {
      await client.close();
    }
  }
});

test("MCP server instructions tell agents hidden toolsets exist and to ask the user before `toolsets`", async () => {
  const lifecycle = { getUpstream: async () => {}, ensureBrave: async () => {}, peekBrave: () => null };
  const { server } = buildServer({ lifecycle, recordTraffic: false });
  const { client, connect } = await connectClient(server);
  await connect();
  try {
    const text = client.getInstructions();
    assert.ok(typeof text === "string" && text.length > 0, "instructions sent at initialize");
    assert.match(text, /hidden to save context/);
    assert.match(text, /Debug \/ React \/ scenario \/ trace/);
    assert.match(text, /ask the user/);
    assert.match(text, /`toolsets`/);
  } finally {
    await client.close();
  }
});

test("elicit: null when the client doesn't support elicitation (or before initialize)", async () => {
  const lifecycle = { getUpstream: async () => {}, ensureBrave: async () => {}, peekBrave: () => null };
  let opts = null;
  const { server } = buildServer({
    lifecycle, recordTraffic: false,
    createRelay: (o) => { opts = o; return new RelayServer(o); },
  });
  const params = { message: "Enable the debug toolset?", requestedSchema: { type: "object", properties: {} } };
  assert.strictEqual(await opts.elicit(params), null, "no client yet");
  const { client, connect } = await connectClient(server); // no elicitation capability
  await connect();
  try {
    assert.strictEqual(await opts.elicit(params), null);
  } finally {
    await client.close();
  }
});

async function connectWithCaps(server, capabilities, onElicit) {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const { ElicitRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities });
  if (onElicit) client.setRequestHandler(ElicitRequestSchema, onElicit);
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

function buildWithOpts() {
  const lifecycle = { getUpstream: async () => {}, ensureBrave: async () => {}, peekBrave: () => null };
  let opts = null;
  const { server } = buildServer({
    lifecycle, recordTraffic: false,
    createRelay: (o) => { opts = o; return new RelayServer(o); },
  });
  return { server, opts: () => opts };
}

const ELICIT_PARAMS = {
  message: "Enable the debug toolset?",
  requestedSchema: { type: "object", properties: { enable: { type: "boolean" } } },
};

test("elicit: null for a url-only client (SDK elicitInput needs form mode)", async () => {
  const { server, opts } = buildWithOpts();
  const client = await connectWithCaps(server, { elicitation: { url: {} } });
  try {
    assert.strictEqual(await opts().elicit(ELICIT_PARAMS), null);
  } finally {
    await client.close();
  }
});

test("elicit: passes the caller's AbortSignal through (caller aborts at its deadline)", { timeout: 5000 }, async () => {
  const { server, opts } = buildWithOpts();
  const client = await connectWithCaps(server, { elicitation: {} }, () => new Promise(() => {})); // user never answers
  try {
    const ac = new AbortController();
    const pending = opts().elicit(ELICIT_PARAMS, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    await assert.rejects(pending);
  } finally {
    await client.close();
  }
});

test("notifyToolsChanged after the client disconnected resolves instead of rejecting", async () => {
  const { server, opts } = buildWithOpts();
  const client = await connectWithCaps(server, {});
  await client.close();
  await opts().notifyToolsChanged(); // must not reject ("Not connected")
});

test("elicit: forwards to the client as elicitation/create when supported", async () => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
  const { ElicitRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
  const lifecycle = { getUpstream: async () => {}, ensureBrave: async () => {}, peekBrave: () => null };
  let opts = null;
  const { server } = buildServer({
    lifecycle, recordTraffic: false,
    createRelay: (o) => { opts = o; return new RelayServer(o); },
  });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" }, { capabilities: { elicitation: {} } });
  let asked = null;
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    asked = req.params;
    return { action: "accept", content: { enable: true } };
  });
  await server.connect(serverT);
  await client.connect(clientT);
  try {
    const result = await opts.elicit({
      message: "Enable the debug toolset?",
      requestedSchema: { type: "object", properties: { enable: { type: "boolean" } } },
    });
    assert.strictEqual(asked.message, "Enable the debug toolset?");
    assert.deepStrictEqual(result, { action: "accept", content: { enable: true } });
  } finally {
    await client.close();
  }
});

// ─────────────────── inspector bind conflicts (item 7) ───────────────────

function eaddrinuse(port) {
  const e = new Error(`listen EADDRINUSE: address already in use 127.0.0.1:${port}`);
  e.code = "EADDRINUSE";
  return e;
}

test("inspector: retry interval default is 30s", () => {
  assert.strictEqual(INSPECTOR_RETRY_MS, 30_000);
});

test("inspector: EADDRINUSE logs ONE line (no stack, no 'set PORT' hint) and retries until the port frees", async () => {
  const logs = [];
  let attempts = 0;
  const handle = { port: 9090, close: async () => {} };
  const ctl = startInspectorWithRetry({
    start: async () => { if (++attempts < 4) throw eaddrinuse(9090); return handle; },
    port: 9090,
    bind: "127.0.0.1",
    retryMs: 5,
    log: (m) => logs.push(m),
  });
  await waitFor(() => ctl.handle === handle);
  assert.strictEqual(attempts, 4);
  const busy = logs.filter((l) => /9090/.test(l) && /in use/i.test(l));
  assert.strictEqual(busy.length, 1, `one busy line across 3 failures, got: ${JSON.stringify(logs)}`);
  assert.ok(!/BROWSER_RELAY_INSPECTOR_PORT/.test(logs.join("\n")), "no misleading 'set PORT' hint");
  assert.ok(!/\n\s+at /.test(logs.join("\n")), "no stack trace");
  assert.ok(logs.some((l) => /inspector running at http:\/\/127\.0\.0\.1:9090/.test(l)));
  await ctl.close();
});

test("inspector: close() stops the retry loop", async () => {
  let attempts = 0;
  const ctl = startInspectorWithRetry({
    start: async () => { attempts++; throw eaddrinuse(9090); },
    port: 9090, bind: "127.0.0.1", retryMs: 5, log: () => {},
  });
  await waitFor(() => attempts >= 2);
  await ctl.close();
  const seen = attempts;
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(attempts, seen, "no attempts after close()");
  assert.strictEqual(ctl.handle, null);
});

test("inspector: close() during an in-flight attempt closes the server it just bound", async () => {
  let release;
  let closed = 0;
  const ctl = startInspectorWithRetry({
    start: () => new Promise((r) => { release = () => r({ port: 1, close: async () => { closed++; } }); }),
    port: 1, bind: "127.0.0.1", retryMs: 5, log: () => {},
  });
  await waitFor(() => typeof release === "function");
  const closing = ctl.close();
  release();
  await closing;
  await waitFor(() => closed === 1);
  assert.strictEqual(ctl.handle, null);
});

test("inspector: a non-EADDRINUSE failure is logged once and not retried", async () => {
  const logs = [];
  let attempts = 0;
  const ctl = startInspectorWithRetry({
    start: async () => { attempts++; throw Object.assign(new Error("listen EACCES"), { code: "EACCES" }); },
    port: 80, bind: "127.0.0.1", retryMs: 5, log: (m) => logs.push(m),
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(attempts, 1);
  assert.ok(logs.some((l) => /inspector failed to start/.test(l) && /EACCES/.test(l)));
  await ctl.close();
});

test("inspector (real server): a relay waiting on a busy port takes over once the owner exits", async () => {
  const { startInspector } = require("../src/inspector-server.js");
  // Occupy a free port the way another relay's inspector would.
  const owner = net.createServer();
  await new Promise((r) => owner.listen(0, "127.0.0.1", r));
  const port = owner.address().port;
  const logs = [];
  let ctl = null;
  try {
    ctl = startInspectorWithRetry({
      start: () => startInspector({ port, bind: "127.0.0.1" }),
      port, bind: "127.0.0.1", retryMs: 20, log: (m) => logs.push(m),
    });
    await waitFor(() => logs.some((l) => /in use/i.test(l)));
    assert.strictEqual(ctl.handle, null);
    await new Promise((r) => owner.close(r));
    await waitFor(() => ctl.handle !== null, 5000);
    assert.strictEqual(ctl.handle.port, port);
    const res = await fetch(`http://127.0.0.1:${port}/`).catch((e) => e);
    assert.ok(!(res instanceof Error), `inspector answers after takeover: ${res && res.message}`);
    assert.strictEqual(res.status, 200);
  } finally {
    if (owner.listening) await new Promise((r) => owner.close(r));
    if (ctl) await ctl.close();
  }
});

// ───────────── end to end: the real entrypoint (items 2 + 4 + 5) ─────────────

test("relay process: answers initialize without claiming a slot, exits 0 when stdin closes", async () => {
  const { LATEST_PROTOCOL_VERSION } = require("@modelcontextprotocol/sdk/types.js");
  const poolDir = path.join(os.tmpdir(), `bmr-lazy-claim-${process.pid}-${Date.now()}`);
  // A live in-process inspector keeps the event loop busy the way upstream +
  // Brave do in real use — without the stdin-EOF handler the relay would
  // linger instead of exiting.
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const inspectorPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const env = {
    ...process.env,
    // this test is about the legacy relay (broker mode: test/index-mode.test.js)
    BROWSER_RELAY_MODE: "legacy",
    BROWSER_RELAY_POOL_DIR: poolDir,
    BROWSER_RELAY_INSPECTOR_PORT: String(inspectorPort),
    BROWSER_RELAY_INSPECTOR_BIND: "127.0.0.1",
  };
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  try {
    const response = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`no initialize response; stderr:\n${stderr}`)), 20000);
      child.stdout.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.id === 1) { clearTimeout(timer); resolve(msg); }
        }
      });
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "test", version: "0" } },
      }) + "\n");
    });
    assert.strictEqual(response.result.serverInfo.version, PKG.version);
    assert.strictEqual(fs.existsSync(poolDir), false, "no slot claimed (pool dir untouched) for an idle session");
    await waitFor(() => /inspector running at/.test(stderr), 10000);

    child.stdin.end();
    const code = await Promise.race([
      exited,
      new Promise((r) => setTimeout(() => r("timeout"), 15000)),
    ]);
    assert.strictEqual(code, 0, `relay should exit 0 after stdin EOF; stderr:\n${stderr}`);
  } finally {
    if (child.exitCode === null) child.kill();
    fs.rmSync(poolDir, { recursive: true, force: true });
  }
});
