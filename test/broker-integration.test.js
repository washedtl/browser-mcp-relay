// broker-integration.test.js — W2E: what the integration wave adds to the
// broker (src/broker/main.js): the one-time profile seed before Brave's first
// launch, the control channel (broker:status / broker:stop), the status
// view, the relay Inspector hosted by the broker, BROWSER_HEADLESS_ENABLE.
//
// Fakes for Brave / upstream / windows (test/fixtures/broker-fakes.js); the
// pipe, the MCP servers, RelayServer and the Inspector are real. Pipes, keys
// and ports are per test run; nothing touches a real broker or profile.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { startBroker } = require("../src/broker/main.js");
const { keyFileFor, loadOrCreateKey } = require("../src/broker/pipe-server.js");
const { requestControl, ctlMac } = require("../src/broker/control.js");
const brokerCtl = require("../scripts/broker-ctl.js");
const fakes = require("./fixtures/broker-fakes.js");
const { sleep, until, freePort } = fakes;
const testPipe = () => fakes.testPipe("integ");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-integ-"));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
// broker-ctl derives pipe + key from env, as it does for a real broker
const ENV = { LOCALAPPDATA: HOME, XDG_STATE_HOME: HOME };
const KEY_FILE = keyFileFor(ENV);
const KEY = loadOrCreateKey(KEY_FILE);

async function startTestBroker(t, { seedProfile = null, relayInspector = null, supervisor = null, env = {}, deps = {} } = {}) {
  const pipe = testPipe();
  const logs = [];
  const exits = [];
  let sup = null;
  const handle = await startBroker({
    pipe,
    profileDir: path.join(HOME, "profile-unused"),
    env,
    keyFile: KEY_FILE,
    log: (m) => logs.push(m),
    idle: { exitMs: 60_000, browserMs: 60_000 },
    onExit: (why) => exits.push(why),
    seedProfile,
    relayInspector,
    deps: {
      createSupervisor: (opts) => (sup = supervisor ? supervisor(opts) : fakes.fakeSupervisor(opts)),
      upstreamModule: () => fakes.fakeUpstreamModule(),
      windowPages: () => fakes.fakeWindowPages(),
      ownTools: () => [fakes.probeOwnTool, fakes.tabsNewTool, fakes.toolsetsTool],
      toolContext: fakes.fakeToolContextModule,
      loadCatalog: async () => fakes.FAKE_CATALOG,
      ...deps,
    },
  });
  t.after(() => handle.close("test done"));
  return { pipe, handle, logs, exits, sup: () => sup };
}

async function connectClient(t, pipe) {
  const client = new Client({ name: "integ", version: "0" });
  await client.connect(new fakes.SocketClientTransport(pipe, { hello: { key: KEY } }));
  t.after(() => client.close().catch(() => {}));
  return client;
}

// ───────────────────────────── profile seed ─────────────────────────────

test("seed: the one-time profile seed finishes before Brave's first launch", async (t) => {
  const order = [];
  let finishSeed;
  const b = await startTestBroker(t, {
    seedProfile: async ({ profileDir }) => {
      order.push(`seed:start:${path.basename(profileDir)}`);
      await new Promise((r) => { finishSeed = r; });
      order.push("seed:done");
    },
    supervisor: (opts) => Object.assign(fakes.fakeSupervisor(opts), {
      async ensure() { order.push("brave:ensure"); return { cdpUrl: `http://127.0.0.1:${opts.port}`, pid: 4242 }; },
      isUp: () => true,
    }),
  });
  await until(() => finishSeed, 3000, "the seed to start");
  // the seed is still running: initialize and tools/list are not held up by it
  const c = await connectClient(t, b.pipe);
  assert.ok((await c.listTools()).tools.length > 0);
  const call = c.callTool({ name: "content_get-as-text", arguments: {} });
  await sleep(50);
  assert.deepStrictEqual(order, ["seed:start:profile-unused"], "no Brave while the profile is being seeded");
  finishSeed();
  assert.ok(!(await call).isError);
  assert.deepStrictEqual(order.slice(0, 3), ["seed:start:profile-unused", "seed:done", "brave:ensure"]);
});

test("seed: a seed that throws is logged and Brave still launches (fresh profile)", async (t) => {
  const b = await startTestBroker(t, { seedProfile: async () => { throw new Error("disk full"); } });
  const c = await connectClient(t, b.pipe);
  assert.ok(!(await c.callTool({ name: "content_get-as-text", arguments: {} })).isError);
  assert.ok(b.logs.some((l) => /seed.*disk full/i.test(l)), b.logs.join("\n"));
});

// ───────────────────────────── control channel ─────────────────────────────

test("control status: connections with their tabs, Brave up + pid, pipe, profile — and it is not an MCP session", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} }); // main tab, Brave up
  await c.callTool({ name: "tabs_new", arguments: { name: "sub1" } });
  const r = await requestControl({ pipe: b.pipe, key: KEY, cmd: "status" });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const s = r.status;
  assert.strictEqual(s.pid, process.pid);
  assert.strictEqual(s.pipe, b.pipe);
  assert.deepStrictEqual(s.brave, { up: true, pid: 4242 });
  assert.strictEqual(s.connections.length, 1, "the control connection itself is not listed");
  assert.deepStrictEqual(s.connections[0].tabs.map((x) => [x.tabId, x.state]), [["main", "open"], ["sub1", "open"]]);
  assert.match(s.connections[0].tabs[0].url, /^about:blank#c\d+:main$/);
  assert.ok(Number.isFinite(s.rssMB) && Number.isFinite(s.uptimeS));
});

test("control: a request without the key's MAC gets no status and is not served as MCP", async (t) => {
  const b = await startTestBroker(t);
  const wrongKey = Buffer.alloc(32, 9);
  await assert.rejects(requestControl({ pipe: b.pipe, key: wrongKey, cmd: "status" }), (e) => e.code === "EAUTH");
  // right hello, forged ctlMac
  const sock = net.connect(b.pipe);
  await new Promise((r) => sock.once("connect", r));
  const nonce = crypto.randomBytes(16).toString("hex");
  sock.write(JSON.stringify({ bmr: "hello", v: 1, nonce, ctl: "stop", ctlMac: ctlMac(wrongKey, "stop", nonce) }) + "\n");
  const lines = await new Promise((resolve) => {
    let buf = "";
    sock.on("data", (d) => { buf += d; });
    sock.on("close", () => resolve(buf.trim().split("\n")));
  });
  assert.strictEqual(JSON.parse(lines[1]).ok, false);
  assert.match(JSON.parse(lines[1]).error, /not authenticated/);
  await sleep(100);
  assert.deepStrictEqual(b.exits, [], "a forged stop does nothing");
});

test("control stop: Brave closes gracefully, the broker shuts down and releases the pipe", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  const r = await requestControl({ pipe: b.pipe, key: KEY, cmd: "stop" });
  assert.deepStrictEqual(r, { bmr: "ctl", ok: true, stopping: true, pid: process.pid });
  await until(() => b.exits.length === 1, 5000, "the broker to exit");
  assert.match(b.exits[0], /stop requested/);
  assert.strictEqual(b.sup().closes >= 1, true, "Brave closed through closeGracefully");
  await assert.rejects(requestControl({ pipe: b.pipe, key: KEY, cmd: "status" }), (e) => ["ENOENT", "ECONNREFUSED"].includes(e.code));
});

test("broker-ctl status / stop against a running broker; 'not running' when there is none", async (t) => {
  const b = await startTestBroker(t);
  const env = { ...ENV, BROWSER_RELAY_BROKER_PIPE: b.pipe };
  const out = [];
  assert.strictEqual(await brokerCtl.run({ argv: ["status"], env, out: (l) => out.push(l) }), 0);
  assert.strictEqual(JSON.parse(out.join("\n")).pipe, b.pipe);

  out.length = 0;
  const code = await brokerCtl.run({ argv: ["stop"], env, out: (l) => out.push(l), isPidAlive: () => b.exits.length === 0 });
  assert.strictEqual(code, 0, out.join("\n"));
  assert.match(out.join("\n"), /stopped/);

  out.length = 0;
  assert.strictEqual(await brokerCtl.run({ argv: ["status"], env, out: (l) => out.push(l) }), 0);
  assert.match(out.join("\n"), /not running/);
  out.length = 0;
  assert.strictEqual(await brokerCtl.run({ argv: ["restart"], env, out: (l) => out.push(l) }), 2);
  assert.match(out.join("\n"), /usage/i);
});

// ───────────────────────────── the relay Inspector, hosted by the broker ─────────────────────────────

function get(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: pathname, headers }, (res) => {
      let body = "";
      res.on("data", (d) => { body += d; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

test("relay Inspector: one per broker; /api/broker shows sessions + tabs; every session's calls land in /api/activity, redacted", async (t) => {
  const port = await freePort();
  const b = await startTestBroker(t, { relayInspector: { port } });
  await until(() => b.logs.some((l) => /inspector running at http:\/\/127\.0\.0\.1:\d+/.test(l)), 5000, "the inspector");
  const c1 = await connectClient(t, b.pipe);
  const c2 = await connectClient(t, b.pipe);
  await c1.callTool({ name: "navigation_go-to", arguments: { url: "https://a.example/" } });
  await c2.callTool({ name: "own_probe", arguments: { v: "x" } });

  const broker = JSON.parse((await get(port, "/api/broker")).body);
  assert.strictEqual(broker.connections.length, 2);
  assert.deepStrictEqual(broker.brave, { up: true, pid: 4242 });

  const { events } = JSON.parse((await get(port, "/api/activity")).body);
  const requests = events.filter((e) => e.method === "tools/call");
  assert.deepStrictEqual(requests.map((e) => [e.name, e.source]).sort(), [["navigation_go-to", "upstream"], ["own_probe", "own"]]);
  assert.strictEqual(new Set(requests.map((e) => e.conn)).size, 2, "events say which session made them");
  assert.ok(events.some((e) => e.status === "ok"), "responses recorded too");

  // hosted by the broker: no legacy pool to probe on /api/status
  const st = JSON.parse((await get(port, "/api/status")).body);
  assert.strictEqual(st.config.mode, "broker");
  assert.deepStrictEqual(st.slots, []);

  // W1E's DNS-rebinding gate still applies
  assert.strictEqual((await get(port, "/api/broker", { Host: "evil.example" })).status, 403);
});

test("relay Inspector: off unless asked; RelayServers then record nothing", async (t) => {
  const b = await startTestBroker(t);
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "navigation_go-to", arguments: { url: "https://a.example/" } });
  assert.ok(!b.logs.some((l) => /inspector/i.test(l)));
  const r = await requestControl({ pipe: b.pipe, key: KEY, cmd: "status" });
  assert.strictEqual(r.status.relayInspector, null);
});

// ───────────────────────────── BROWSER_HEADLESS_ENABLE ─────────────────────────────

test("BROWSER_HEADLESS_ENABLE / BROWSER_RELAY_IGNORE_HTTPS_ERRORS (broker env) reach the real supervisor, as legacy mode honours them; both off by default", async (t) => {
  const real = {};
  for (const [label, env] of [["on", { BROWSER_HEADLESS_ENABLE: "true", BROWSER_RELAY_IGNORE_HTTPS_ERRORS: "true" }], ["off", {}]]) {
    const pipe = testPipe();
    const handle = await startBroker({
      pipe, profileDir: path.join(HOME, "profile-headless"), env,
      keyFile: KEY_FILE, log: () => {},
      deps: { upstreamModule: () => fakes.fakeUpstreamModule(), loadCatalog: async () => fakes.FAKE_CATALOG, ownTools: () => [], toolContext: fakes.fakeToolContextModule },
    });
    real[label] = [handle.supervisor._headless, handle.supervisor._ignoreHttpsErrors];
    await handle.close("test done");
  }
  assert.deepStrictEqual(real, { on: [true, true], off: [false, false] });
});

test("control: a status bigger than a handshake line (4 KB cap) still arrives whole", async (t) => {
  const { claimPipe, serverHello } = require("../src/broker/pipe-server.js");
  const { serveControl } = require("../src/broker/control.js");
  const pipe = testPipe();
  const server = await claimPipe(pipe);
  t.after(() => new Promise((r) => server.close(() => r())));
  const big = { connections: Array.from({ length: 200 }, (_, i) => ({ id: `c${i}`, url: `https://example.com/${"x".repeat(200)}` })) };
  server.on("connection", async (sock) => {
    const { hello } = await serverHello(sock, KEY);
    serveControl(sock, hello, KEY, { status: () => big, stop: () => {} });
  });
  const r = await requestControl({ pipe, key: KEY, cmd: "status" });
  assert.ok(JSON.stringify(r).length > 40_000);
  assert.deepStrictEqual(r.status, big);
});

test("A8: the broker loads upstream with its own merged env (one env writer: brokerEnv)", async (t) => {
  const env = { BROWSER_RELAY_UPSTREAM_PATH: "C:\custom\dist\index.js", TOOL_NAME_PREFIX: "x_" };
  let seen = null;
  const upstream = fakes.fakeUpstreamModule();
  const orig = upstream.loadUpstream;
  upstream.loadUpstream = (opts) => { seen = opts; return orig.call(upstream, opts); };
  const b = await startTestBroker(t, { env, deps: { upstreamModule: () => upstream } });
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  assert.strictEqual(seen.env, env);
  assert.match(seen.cdpUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
});

// ── the CDP port: random, outside the OS ephemeral ranges ──

test("chooseCdpPort: a free port in 10000-32000 (below Windows' 49152+ and Linux's 32768+ ephemeral ranges)", async () => {
  const { chooseCdpPort, CDP_PORT_RANGE } = require("../src/broker/main.js");
  assert.deepStrictEqual(CDP_PORT_RANGE, { min: 10000, max: 32000 });
  for (let i = 0; i < 20; i++) {
    const port = await chooseCdpPort();
    assert.ok(Number.isInteger(port) && port >= 10000 && port <= 32000, `got ${port}`);
  }
});

test("chooseCdpPort: a taken candidate is skipped (real bind test); all taken → a clear error", async (t) => {
  const { chooseCdpPort, CDP_PORT_RANGE } = require("../src/broker/main.js");
  const toRandom = (port) => (port - CDP_PORT_RANGE.min) / (CDP_PORT_RANGE.max - CDP_PORT_RANGE.min + 1);
  // hold a port in the range, then make it the first candidate
  let held = null;
  let taken = 0;
  for (let p = 20000; p < 20100 && !held; p++) {
    const s = net.createServer();
    if (await new Promise((r) => { s.once("error", () => r(false)); s.listen({ port: p, host: "127.0.0.1", exclusive: true }, () => r(true)); })) { held = s; taken = p; }
  }
  assert.ok(held, "could not hold a test port");
  t.after(() => held.close());
  const picks = [toRandom(taken), toRandom(taken + 500)];
  const port = await chooseCdpPort({ random: () => picks.shift() });
  assert.strictEqual(port, taken + 500, "the held candidate was skipped");
  await assert.rejects(chooseCdpPort({ random: () => toRandom(taken) }), /no free CDP port in 10000-32000 after 20 tries/);
});
