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

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-integ-"));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
// broker-ctl derives pipe + key from env, as it does for a real broker
const ENV = { LOCALAPPDATA: HOME, XDG_STATE_HOME: HOME };
const KEY_FILE = keyFileFor(ENV);
const KEY = loadOrCreateKey(KEY_FILE);

const testPipe = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\bmr-test-integ-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bmr-test-")), "integ.sock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 3000, what = "condition") {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

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
  const c = await connectClient(t, b.pipe);
  const call = c.callTool({ name: "content_get-as-text", arguments: {} });
  await until(() => order.length === 1 && finishSeed, 3000, "the seed to start");
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

test("BROWSER_HEADLESS_ENABLE=true reaches the real supervisor (legacy mode honours it too)", async (t) => {
  const real = {};
  for (const headless of ["true", undefined]) {
    const pipe = testPipe();
    const handle = await startBroker({
      pipe, profileDir: path.join(HOME, "profile-headless"), env: headless ? { BROWSER_HEADLESS_ENABLE: headless } : {},
      keyFile: KEY_FILE, log: () => {},
      deps: { upstreamModule: () => fakes.fakeUpstreamModule(), loadCatalog: async () => fakes.FAKE_CATALOG, ownTools: () => [], toolContext: fakes.fakeToolContextModule },
    });
    real[String(headless)] = handle.supervisor._headless;
    await handle.close("test done");
  }
  assert.deepStrictEqual(real, { true: true, undefined: false });
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
