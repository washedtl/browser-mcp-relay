// core-broker.test.js — W2F: the broker's cookie-bridge hooks
// (src/broker/control.js serveBridge/openBridge, src/broker/main.js):
// an authenticated bridge connection, cookies.full / cookies.delta, the
// snapshot applied before a tool runs on a (re)launched Brave, and bridge
// connections never keeping the broker alive.
//
// Fakes for Brave / upstream / windows / CDP (test/fixtures/broker-fakes.js);
// the pipe, the MCP servers and the CookieImporter are real. Per-run pipes
// and keys; nothing touches a real broker, profile or Chrome.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { startBroker, IdlePolicy } = require("../../src/broker/main.js");
const { keyFileFor, loadOrCreateKey, clientHello, connectPipe, readLine, serverHello } = require("../../src/broker/pipe-server.js");
const { requestControl, openBridge, bridgeMac } = require("../../src/broker/control.js");
const { CookieImporter } = require("../../src/cookie-bridge/importer.js");
const fakes = require("../fixtures/broker-fakes.js");
const { sleep, until } = fakes;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-w2f-broker-"));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
const KEY_FILE = keyFileFor({ LOCALAPPDATA: HOME, XDG_STATE_HOME: HOME });
const KEY = loadOrCreateKey(KEY_FILE);
const SECRET = "SENTINEL-bridge-VALUE-41c7";

const ck = (over = {}) => ({
  name: "sid", value: SECRET, domain: ".example.com", hostOnly: false, path: "/", secure: true, httpOnly: true,
  sameSite: "lax", session: false, expirationDate: 1893456000, storeId: "0", ...over,
});

/** A fake browser-level CDP for the importer, recording into `order`. */
function recordingCdp(order) {
  const set = [];
  return {
    set,
    openCdp: async () => ({
      closed: false,
      async send(method, params) {
        order.push(`cdp:${method}`);
        set.push(...params.cookies.map((c) => ({ ...c })));
        return {};
      },
      close() {},
    }),
  };
}

async function startTestBroker(t, { idle = { exitMs: 60_000, browserMs: 60_000 } } = {}) {
  const pipe = fakes.testPipe("w2f");
  const logs = [];
  const exits = [];
  const up = fakes.fakeUpstreamModule();
  const cdp = recordingCdp(up.state.order);
  let sup = null;
  const handle = await startBroker({
    pipe,
    profileDir: path.join(HOME, "profile-unused"),
    env: {},
    keyFile: KEY_FILE,
    log: (m) => logs.push(m),
    idle,
    onExit: (why) => exits.push(why),
    deps: {
      createSupervisor: (opts) => (sup = fakes.fakeSupervisor(opts)),
      upstreamModule: () => up,
      windowPages: () => fakes.fakeWindowPages(),
      ownTools: () => [fakes.probeOwnTool, fakes.tabsNewTool, fakes.toolsetsTool],
      toolContext: fakes.fakeToolContextModule,
      loadCatalog: async () => fakes.FAKE_CATALOG,
      cookieBridge: ({ supervisor, log }) => new CookieImporter({ supervisor, log, openCdp: cdp.openCdp }),
    },
  });
  t.after(() => handle.close("test done"));
  return { pipe, handle, logs, exits, up, cdp, sup: () => sup };
}

async function connectClient(t, pipe) {
  const client = new Client({ name: "w2f", version: "0" });
  await client.connect(new fakes.SocketClientTransport(pipe, { hello: { key: KEY } }));
  t.after(() => client.close().catch(() => {}));
  return client;
}

async function bridge(t, pipe) {
  const b = await openBridge({ pipe, key: KEY });
  t.after(() => b.close());
  return b;
}

test("bridge: authenticated cookies.full → {ok, applied, rejected}, with the request id echoed", async (t) => {
  const b = await startTestBroker(t);
  const br = await bridge(t, b.pipe);
  const r = await br.request({ ctl: "cookies.full", cookies: [ck(), ck({ domain: ".chase.com" })], last: true });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.applied, 1);
  assert.deepStrictEqual(r.rejected, [{ domain: "chase.com", reason: "deny:finance", count: 1 }]);
  assert.strictEqual(typeof r.id, "number");
  const d = await br.request({ ctl: "cookies.delta", changes: [{ removed: false, cause: "explicit", cookie: ck({ name: "two" }) }] });
  assert.deepStrictEqual([d.ok, d.applied], [true, 1]);
});

/** Hello {bridge:true} → the broker's hello reply → its challenge; returns {sock, nonce, challenge}. */
async function bridgeHandshake(t, pipe) {
  const sock = await connectPipe(pipe);
  t.after(() => sock.destroy());
  let nonce = null;
  const { rest } = await clientHello(sock, KEY, { fields: (n) => { nonce = n; return { bridge: true }; } });
  if (rest.length) sock.unshift(rest);
  const next = readLine(sock);
  sock.resume();
  const { line, rest: after } = await next;
  if (after.length) sock.unshift(after);
  const msg = JSON.parse(line);
  assert.match(msg.challenge, /^[0-9a-f]{32}$/);
  return { sock, nonce, challenge: msg.challenge };
}

async function answer(sock, obj) {
  sock.write(`${JSON.stringify(obj)}\n`);
  const next = readLine(sock);
  sock.resume();
  return JSON.parse((await next).line);
}

test("bridge: a wrong answer to the broker's challenge is refused, the socket fully closed, nothing imported", async (t) => {
  const b = await startTestBroker(t);
  const { sock } = await bridgeHandshake(t, b.pipe);
  let closed = false;
  sock.on("close", () => { closed = true; });
  const reply = await answer(sock, { bmr: "ctl", mac: "0".repeat(64) });
  assert.deepStrictEqual([reply.ok, reply.bridge], [false, undefined]);
  assert.match(reply.error, /not authenticated/);
  await until(() => closed, 3000, "the broker to close the refused socket");
  const s = await requestControl({ pipe: b.pipe, key: KEY, cmd: "status" });
  assert.deepStrictEqual([s.status.cookieBridge.cookies, s.status.cookieBridge.bridges], [0, 0]);
});

test("bridge: a recorded challenge answer can't be replayed (the broker picks a fresh challenge each time)", async (t) => {
  const b = await startTestBroker(t);
  const first = await bridgeHandshake(t, b.pipe);
  const mac = bridgeMac(KEY, first.nonce, first.challenge);
  assert.strictEqual((await answer(first.sock, { bmr: "ctl", mac })).bridge, "ready");
  first.sock.destroy();
  await until(async () => (await requestControl({ pipe: b.pipe, key: KEY, cmd: "status" })).status.cookieBridge.bridges === 0, 3000, "the first bridge to go");
  // replay: same client nonce, the old MAC, against a new challenge
  const sock = await connectPipe(b.pipe);
  t.after(() => sock.destroy());
  sock.write(`${JSON.stringify({ bmr: "hello", v: 1, nonce: first.nonce, settings: null, reconnect: false, bridge: true })}\n`);
  const hello = readLine(sock);
  sock.resume();
  const { line, rest } = await hello;
  if (rest.length) sock.unshift(rest);
  assert.strictEqual(JSON.parse(line).bmr, "hello");
  const next = readLine(sock);
  sock.resume();
  const { line: chLine, rest: r2 } = await next;
  if (r2.length) sock.unshift(r2);
  assert.notStrictEqual(JSON.parse(chLine).challenge, first.challenge);
  const reply = await answer(sock, { bmr: "ctl", mac });
  assert.strictEqual(reply.ok, false);
});

test("bridge: the bridge MAC is never sent to a pipe owner that fails the broker's authentication", async (t) => {
  // a squatter on the pipe name: wrong hello MAC, then a challenge anyway
  const pipe = fakes.testPipe("w2f-squat");
  const got = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => { /* the client hangs up on us: expected */ });
    sock.on("data", (c) => {
      got.push(String(c));
      if (got.length === 1) {
        sock.write(`${JSON.stringify({ bmr: "hello", v: 1, mac: "f".repeat(64) })}\n`);
        sock.write(`${JSON.stringify({ bmr: "ctl", challenge: "a".repeat(32) })}\n`);
      }
    });
  });
  await new Promise((r) => server.listen(pipe, r));
  t.after(() => server.close());
  await assert.rejects(openBridge({ pipe, key: KEY }), (e) => e.code === "EAUTH");
  await sleep(200);
  const all = got.join("");
  assert.strictEqual(all.trim().split("\n").length, 1, `the client sent more than its hello: ${all}`);
  const hello = JSON.parse(all.trim());
  assert.strictEqual(hello.bridge, true);
  assert.ok(!("mac" in hello) && !("bridgeMac" in hello), all);
});

test("bridge: openBridge refuses a pipe owner that doesn't know the key (EAUTH)", async (t) => {
  const b = await startTestBroker(t);
  await assert.rejects(openBridge({ pipe: b.pipe, key: Buffer.alloc(32, 7) }), (e) => e.code === "EAUTH");
});

test("bridge: one bridge at a time — a second concurrent one is refused with EBUSY and a clear error; it can connect once the first closes", async (t) => {
  const b = await startTestBroker(t);
  const first = await bridge(t, b.pipe);
  await assert.rejects(openBridge({ pipe: b.pipe, key: KEY }), (e) => e.code === "EBUSY" && /already connected/.test(e.message));
  first.close();
  await until(async () => (await requestControl({ pipe: b.pipe, key: KEY, cmd: "status" })).status.cookieBridge.bridges === 0, 3000, "the first bridge to go");
  const second = await bridge(t, b.pipe);
  assert.strictEqual((await second.request({ ctl: "cookies.full", cookies: [ck()], last: true })).ok, true);
});

test("bridge: unknown commands and malformed lines get an error reply; the connection stays usable", async (t) => {
  const b = await startTestBroker(t);
  const br = await bridge(t, b.pipe);
  const r = await br.request({ ctl: "stop" });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unknown bridge command/);
  const bad = await br.request({ ctl: "cookies.full", cookies: "x" });
  assert.deepStrictEqual([bad.ok, bad.error], [false, "cookies must be an array"]);
  const ok = await br.request({ ctl: "cookies.full", cookies: [ck()], last: true });
  assert.strictEqual(ok.ok, true);
});

test("bridge: a bridge connection is not a session (not in status), and status shows the bridge's counts", async (t) => {
  const b = await startTestBroker(t);
  const br = await bridge(t, b.pipe);
  await br.request({ ctl: "cookies.full", cookies: [ck(), ck({ name: "x", domain: ".other.example" })], last: true });
  const s = (await requestControl({ pipe: b.pipe, key: KEY, cmd: "status" })).status;
  assert.deepStrictEqual(s.connections, []);
  assert.deepStrictEqual([s.cookieBridge.bridges, s.cookieBridge.cookies, s.cookieBridge.domains], [1, 2, 2]);
  assert.ok(!JSON.stringify(s).includes(SECRET));
});

test("bridge: the broker idles out and exits while a bridge stays connected; the bridge sees the close", async (t) => {
  const b = await startTestBroker(t, { idle: { exitMs: 300, browserMs: 60_000 } });
  const br = await bridge(t, b.pipe);
  let closed = false;
  br.on("close", () => { closed = true; });
  await until(() => b.exits.length > 0, 5000, "the broker to exit while only a bridge is connected");
  assert.match(b.exits[0], /no connections/);
  await until(() => closed, 2000, "the bridge connection to close");
});

test("bridge: a bridge connecting doesn't restart the broker's idle countdown", async (t) => {
  const b = await startTestBroker(t, { idle: { exitMs: 1500, browserMs: 60_000 } });
  const t0 = Date.now();
  await sleep(900);
  const br = await bridge(t, b.pipe);
  await br.request({ ctl: "cookies.full", cookies: [ck()], last: true });
  await until(() => b.exits.length > 0, 5000, "the broker to exit");
  const after = Date.now() - t0;
  assert.ok(after < 2300, `exited ${after} ms after start: the bridge restarted the 1500 ms countdown`);
});

test("bridge: a session still keeps the broker alive while a bridge comes and goes", async (t) => {
  const b = await startTestBroker(t, { idle: { exitMs: 300, browserMs: 60_000 } });
  await connectClient(t, b.pipe);
  const br = await bridge(t, b.pipe);
  br.close();
  await sleep(700);
  assert.deepStrictEqual(b.exits, []);
});

test("bridge: cookies synced while Brave is down are applied before the first tool runs on the launched Brave", async (t) => {
  const b = await startTestBroker(t);
  const br = await bridge(t, b.pipe);
  await br.request({ ctl: "cookies.full", cookies: [ck()], last: true });
  assert.deepStrictEqual(b.cdp.set, [], "Brave is down: nothing sent, Brave not launched");
  assert.strictEqual(b.sup().launches, 0);
  const c = await connectClient(t, b.pipe);
  assert.ok(!(await c.callTool({ name: "content_get-as-text", arguments: {} })).isError);
  const order = b.up.state.order;
  const applied = order.indexOf("cdp:Storage.setCookies");
  assert.ok(applied >= 0, order.join(","));
  assert.ok(applied < order.findIndex((o) => o.startsWith("createContext:")), order.join(","));
  assert.deepStrictEqual(b.cdp.set.map((x) => [x.name, x.domain, x.sameSite]), [["sid", ".example.com", "Lax"]]);
});

test("bridge: after Brave goes down and relaunches, the snapshot is applied again", async (t) => {
  const b = await startTestBroker(t);
  const br = await bridge(t, b.pipe);
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} }); // Brave up (empty snapshot)
  await br.request({ ctl: "cookies.full", cookies: [ck()], last: true }); // applied at once
  assert.strictEqual(b.cdp.set.length, 1);
  b.sup().crash();
  await c.callTool({ name: "content_get-as-text", arguments: {} }); // relaunch
  assert.strictEqual(b.cdp.set.length, 2);
  assert.strictEqual(b.sup().launches, 2);
});

test("bridge: cookie values never reach the broker log", async (t) => {
  const b = await startTestBroker(t);
  const br = await bridge(t, b.pipe);
  await br.request({ ctl: "cookies.full", cookies: [ck(), ck({ domain: ".chase.com" }), ck({ path: "bad" })], last: true });
  await br.request({ ctl: "cookies.delta", changes: [{ removed: true, cookie: ck() }] });
  const c = await connectClient(t, b.pipe);
  await c.callTool({ name: "content_get-as-text", arguments: {} });
  assert.ok(b.logs.some((l) => /cookie bridge/.test(l)), b.logs.join("\n"));
  assert.ok(!b.logs.join("\n").includes(SECRET));
});

test("IdlePolicy.notASession: undoing a connection keeps the running exit deadline", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let exited = 0;
  const p = new IdlePolicy({ exitIdleMs: 1000, browserIdleMs: 60_000, onExitIdle: () => { exited++; }, onBrowserIdle: () => {} });
  p.start();
  t.mock.timers.tick(700);
  p.connectionOpened();
  t.mock.timers.tick(100);
  p.notASession();
  t.mock.timers.tick(199);
  assert.strictEqual(exited, 0);
  t.mock.timers.tick(2);
  assert.strictEqual(exited, 1, "fired at the original deadline (1000 ms), not 1000 ms after the bridge connected");
  p.stop();
});

test("IdlePolicy.notASession: with a session connected nothing is armed; the session's close arms a full countdown", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let exited = 0;
  const p = new IdlePolicy({ exitIdleMs: 1000, browserIdleMs: 60_000, onExitIdle: () => { exited++; }, onBrowserIdle: () => {} });
  p.start();
  p.connectionOpened(); // a session
  p.connectionOpened(); // a bridge
  p.notASession();
  t.mock.timers.tick(5000);
  assert.strictEqual(exited, 0);
  p.connectionClosed();
  t.mock.timers.tick(999);
  assert.strictEqual(exited, 0);
  t.mock.timers.tick(2);
  assert.strictEqual(exited, 1);
  p.stop();
});

test("IdlePolicy: a session closing while a bridge hello is in flight leaves a full countdown (no instant exit)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let exited = 0;
  const p = new IdlePolicy({ exitIdleMs: 1000, browserIdleMs: 60_000, onExitIdle: () => { exited++; }, onBrowserIdle: () => {} });
  p.start();
  p.connectionOpened(); // a session, at t=0
  t.mock.timers.tick(5000); // it stays a while: the startup deadline is long past
  p.connectionOpened(); // a bridge's hello starts
  p.connectionClosed(); // the session leaves meanwhile
  p.notASession(); // the hello turns out to be the bridge
  t.mock.timers.tick(999);
  assert.strictEqual(exited, 0, "exited instantly on a stale deadline");
  t.mock.timers.tick(2);
  assert.strictEqual(exited, 1);
  p.stop();
});

test("bridgeMac: HMAC over 'bridge:<clientNonce>:<challenge>', distinct from the control MAC", () => {
  const { ctlMac } = require("../../src/broker/control.js");
  assert.match(bridgeMac(KEY, "n1", "c1"), /^[0-9a-f]{64}$/);
  assert.notStrictEqual(bridgeMac(KEY, "n1", "c1"), bridgeMac(KEY, "n1", "c2"));
  assert.notStrictEqual(bridgeMac(KEY, "n1", "c1"), bridgeMac(KEY, "n2", "c1"));
  assert.notStrictEqual(bridgeMac(KEY, "n1", "c1"), ctlMac(KEY, "bridge", "c1"));
});

test("bridge: the broker reads no further request while one is being handled (backpressure), and answers in order", async (t) => {
  const { serveBridge } = require("../../src/broker/control.js");
  const pipe = fakes.testPipe("w2f-bp");
  let release;
  const gate = new Promise((r) => { release = r; });
  let serverSock = null;
  const handled = [];
  const server = net.createServer(async (sock) => {
    serverSock = sock;
    const { hello, rest } = await serverHello(sock, KEY);
    serveBridge(sock, hello, rest, KEY, () => ({
      "cookies.full": async (msg) => { handled.push(msg.n); if (msg.n === 1) await gate; return { applied: msg.n, rejected: [] }; },
      "cookies.delta": async () => ({ applied: 0, rejected: [] }),
      close: () => {},
    }));
  });
  await new Promise((r) => server.listen(pipe, r));
  t.after(() => server.close());
  const br = await openBridge({ pipe, key: KEY });
  t.after(() => br.close());
  const r1 = br.request({ ctl: "cookies.full", cookies: [], n: 1 });
  const r2 = br.request({ ctl: "cookies.full", cookies: [], n: 2 });
  await until(() => handled.length === 1, 2000, "the first request");
  await sleep(100);
  assert.strictEqual(serverSock.isPaused(), true, "the socket is paused while a request runs");
  assert.deepStrictEqual(handled, [1]);
  release();
  assert.deepStrictEqual([(await r1).applied, (await r2).applied], [1, 2]);
  assert.strictEqual(serverSock.isPaused(), false);
});

test("bridge: the bridge's state file lives next to the broker key (per profile), and holds no cookie value", async (t) => {
  const pipe = fakes.testPipe("w2f-state");
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-w2f-statekey-"));
  t.after(() => fs.rmSync(keyDir, { recursive: true, force: true }));
  const keyFile = path.join(keyDir, "broker.key");
  const key = loadOrCreateKey(keyFile);
  const handle = await startBroker({
    pipe, profileDir: path.join(keyDir, "profile"), env: {}, keyFile, log: () => {}, idle: { exitMs: 60_000, browserMs: 60_000 }, onExit: () => {},
    deps: {
      createSupervisor: (opts) => fakes.fakeSupervisor(opts),
      upstreamModule: () => fakes.fakeUpstreamModule(),
      windowPages: () => fakes.fakeWindowPages(),
      ownTools: () => [],
      toolContext: fakes.fakeToolContextModule,
      loadCatalog: async () => fakes.FAKE_CATALOG,
    },
  });
  t.after(() => handle.close("test done"));
  const br = await openBridge({ pipe, key });
  t.after(() => br.close());
  assert.strictEqual((await br.request({ ctl: "cookies.full", cookies: [ck()], last: true })).ok, true);
  const { stateFileFor } = require("../../src/cookie-bridge/importer.js");
  const file = stateFileFor(keyDir, path.join(keyDir, "profile"));
  assert.ok(fs.existsSync(file), fs.readdirSync(keyDir).join(","));
  assert.ok(!fs.readFileSync(file, "utf8").includes(SECRET));
});

test("bridge: a line over the size limit closes the bridge connection (no unbounded buffering)", async (t) => {
  const { readLines } = require("../../src/cookie-bridge/line-channel.js");
  const server = net.createServer();
  const pipe = fakes.testPipe("w2f-lines");
  await new Promise((r) => server.listen(pipe, r));
  t.after(() => server.close());
  const got = [];
  let overflow = 0;
  server.on("connection", (sock) => readLines(sock, Buffer.alloc(0), { maxBytes: 64, onLine: (m) => got.push(m), onMalformed: () => {}, onOverflow: () => { overflow++; } }));
  const c = await connectPipe(pipe);
  c.write('{"a":1}\n{"a":2}\nnot json\n' + "x".repeat(200));
  await until(() => overflow === 1, 2000, "the overflow");
  assert.deepStrictEqual(got, [{ a: 1 }, { a: 2 }]);
  await until(() => c.destroyed || c.readableEnded, 2000, "the socket to close");
  c.destroy();
});
