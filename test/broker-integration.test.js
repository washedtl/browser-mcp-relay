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

/** The secret in a test broker's CDP URL (handle.cdpUrl is in-process only). */
const secretOf = (b) => /\/([0-9a-f]{64})\//.exec(b.handle.cdpUrl)[1];

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
      async ensure() { order.push("brave:ensure"); return { pid: 4242 }; },
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
  // W2G: broker:status shows where CDP is served, never the secret that opens it
  assert.match(s.cdpUrl, /^ws:\/\/127\.0\.0\.1:\d+\/<redacted>\/devtools\/browser$/);
  assert.ok(!JSON.stringify(r).includes(secretOf(b)), "status carries the secret");
  assert.strictEqual(s.connections.length, 1, "the control connection itself is not listed");
  assert.deepStrictEqual(s.connections[0].tabs.map((x) => [x.tabId, x.state]), [["main", "open"], ["sub1", "open"]]);
  assert.match(s.connections[0].tabs[0].url, /^about:blank#c\d+:main$/);
  assert.ok(Number.isFinite(s.rssMB) && Number.isFinite(s.uptimeS));
});

/** A raw control exchange: hello{ctl} → [hello reply, challenge] → answer(mac(challenge)) → reply. */
async function rawControl(pipe, cmd, macFor) {
  const sock = net.connect(pipe);
  await new Promise((r) => sock.once("connect", r));
  const lines = [];
  let buf = "";
  const waitLines = (n) => until(() => lines.length >= n, 3000, `${n} lines`);
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  sock.write(JSON.stringify({ bmr: "hello", v: 1, nonce: crypto.randomBytes(16).toString("hex"), ctl: cmd }) + "\n");
  await waitLines(2);
  const challenge = lines[1].challenge;
  sock.write(JSON.stringify({ bmr: "ctl", mac: macFor(challenge) }) + "\n");
  await waitLines(3);
  sock.destroy();
  return { challenge, answer: lines[2] };
}

test("control: a request without the key's MAC gets no status and is not served as MCP", async (t) => {
  const b = await startTestBroker(t);
  const wrongKey = Buffer.alloc(32, 9);
  await assert.rejects(requestControl({ pipe: b.pipe, key: wrongKey, cmd: "status" }), (e) => e.code === "EAUTH");
  const { answer } = await rawControl(b.pipe, "stop", (challenge) => ctlMac(wrongKey, "stop", challenge));
  assert.strictEqual(answer.ok, false);
  assert.match(answer.error, /not authenticated/);
  await sleep(100);
  assert.deepStrictEqual(b.exits, [], "a forged stop does nothing");
});

test("V2-e: the broker issues the challenge — a recorded control MAC can't be replayed", async (t) => {
  const b = await startTestBroker(t);
  const first = await rawControl(b.pipe, "stop", (challenge) => ctlMac(KEY, "status", challenge)); // valid for status, not stop
  assert.strictEqual(first.answer.ok, false, "a MAC is bound to its command");
  const recorded = await rawControl(b.pipe, "status", (challenge) => ctlMac(KEY, "status", challenge));
  assert.strictEqual(recorded.answer.ok, true);
  const replay = await rawControl(b.pipe, "status", () => ctlMac(KEY, "status", recorded.challenge));
  assert.notStrictEqual(replay.challenge, recorded.challenge, "a fresh challenge per request");
  assert.strictEqual(replay.answer.ok, false);
  assert.match(replay.answer.error, /not authenticated/);
  assert.deepStrictEqual(b.exits, []);
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
  await c2.callTool({ name: "own_probe", arguments: { v: "x" } }); // its result carries ctx.cdpUrl
  await c1.callTool({ name: "navigation_go-to", arguments: { url: "leak-error://" } }); // an error carrying it

  const brokerRaw = (await get(port, "/api/broker")).body;
  const broker = JSON.parse(brokerRaw);
  // W2G: neither the status nor the traffic feed carries the CDP secret
  assert.match(broker.cdpUrl, /\/<redacted>\/devtools\/browser$/);
  const activityRaw = (await get(port, "/api/activity")).body;
  for (const raw of [brokerRaw, activityRaw]) assert.ok(!raw.includes(secretOf(b)), raw.slice(0, 500));
  assert.ok(activityRaw.includes("<redacted>"), "the leaking calls were recorded, redacted");
  assert.strictEqual(broker.connections.length, 2);
  assert.deepStrictEqual(broker.brave, { up: true, pid: 4242 });
  // V2-d: the inspector's rules — no absolute paths, URLs without query / fragment
  assert.strictEqual(broker.profileDir, "profile-unused");
  const urls = broker.connections.flatMap((c) => c.tabs.map((x) => x.url));
  assert.ok(urls.length > 0 && urls.every((u) => u === "about:blank"), JSON.stringify(urls)); // the fakes' about:blank#<session> loses its fragment

  const { events } = JSON.parse((await get(port, "/api/activity")).body);
  const requests = events.filter((e) => e.method === "tools/call");
  assert.deepStrictEqual(requests.map((e) => [e.name, e.source]).sort(), [["navigation_go-to", "upstream"], ["navigation_go-to", "upstream"], ["own_probe", "own"]]);
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

test("V1-4a: Brave's path and the proxy come from pool-shared's config, as in legacy mode (env, then the pool wrapper's)", async () => {
  const run = async (env, poolConfig) => {
    const handle = await startBroker({
      pipe: testPipe(), profileDir: path.join(HOME, "profile-parity"), env, keyFile: KEY_FILE, log: () => {},
      deps: { poolConfig: () => poolConfig, upstreamModule: () => fakes.fakeUpstreamModule(), loadCatalog: async () => fakes.FAKE_CATALOG, ownTools: () => [], toolContext: fakes.fakeToolContextModule },
    });
    const r = [handle.supervisor._proxyUrl, handle.supervisor._executablePath];
    await handle.close("test done");
    return r;
  };
  const wrapper = { proxyUrl: "http://127.0.0.1:8888", bravePath: "C:\\wrapper\\brave.exe" };
  assert.deepStrictEqual(await run({}, wrapper), ["http://127.0.0.1:8888", "C:\\wrapper\\brave.exe"], "the pool wrapper's proxy and Brave");
  assert.strictEqual((await run({ BROWSER_RELAY_PROXY_URL: "http://127.0.0.1:9999" }, wrapper))[0], "http://127.0.0.1:9999", "the env var wins");
  assert.deepStrictEqual(await run({}, { proxyUrl: null, bravePath: null }), [null, null], "none: direct, Brave auto-detected at launch");
});

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
    // each verified launch's pipe goes to the CDP proxy; the cookie bridge (W2F) re-applies its snapshot on it
    assert.strictEqual(handle.supervisor.listenerCount("pipe"), 2, "the CDP proxy's and the cookie bridge's listeners");
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
  assert.match(seen.cdpUrl, /^ws:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/devtools\/browser$/);
  assert.strictEqual(seen.cdpUrl, b.handle.cdpUrl);
});

// ── warnings a session hears (hello reply → its stderr + first tool result) ──

async function helloWarning(pipe, settingsEnv) {
  const { connectPipe, clientHello, settingsHash } = require("../src/broker/pipe-server.js");
  const sock = await connectPipe(pipe);
  try {
    return (await clientHello(sock, KEY, { settings: settingsEnv ? settingsHash(settingsEnv, KEY) : null })).warning;
  } finally {
    sock.destroy();
  }
}

test("V2-c: a session whose settings differ from the broker's is told so, in ITS hello; a matching one hears nothing", async (t) => {
  const env = { BROWSER_RELAY_PROXY_URL: "http://127.0.0.1:1" };
  const b = await startTestBroker(t, { env });
  assert.strictEqual(await helloWarning(b.pipe, env), null);
  assert.strictEqual(await helloWarning(b.pipe, null), null, "a session that sent no settings");
  const w = await helloWarning(b.pipe, { BROWSER_RELAY_PROXY_URL: "http://127.0.0.1:2" });
  assert.match(w, /this session's browser settings .* differ .*npm run broker:stop/);
  assert.strictEqual(b.logs.filter((l) => /WARNING: session c\d+ has browser settings/.test(l)).length, 1, "and once in the broker log");
});

test("V1-4b: BROWSER_RELAY_VAULT_FILES set in broker mode: every session hears that autofill isn't available here", async (t) => {
  const b = await startTestBroker(t, { env: { BROWSER_RELAY_VAULT_FILES: "C:\\x\\pw.csv" } });
  for (let i = 0; i < 2; i++) assert.match(await helloWarning(b.pipe, null), /credential-vault autofill isn't available in broker mode; set BROWSER_RELAY_MODE=legacy if you need it/);
  assert.strictEqual(b.logs.filter((l) => /WARNING: credential-vault autofill/.test(l)).length, 1, "logged once");
  const quiet = await startTestBroker(t);
  assert.strictEqual(await helloWarning(quiet.pipe, null), null);
});
