// core-host.test.js — W2F: the cookie bridge's native-messaging host
// (src/cookie-bridge/host.js): Chrome framing on stdio, broker polling +
// the HMAC bridge hello, acks, resync on (re)connect, drops while the broker
// is down. Unit tests drive NativeHost with a fake broker channel; the
// end-to-end tests spawn the real host process against a test broker on a
// private pipe (temp LOCALAPPDATA: no real broker, key or log is touched).

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { spawn, execFileSync } = require("node:child_process");

const { NativeHost } = require("../../src/cookie-bridge/host.js");
const { encodeMessage, MessageReader } = require("../../src/cookie-bridge/framing.js");
const { startBroker } = require("../../src/broker/main.js");
const { keyFileFor, loadOrCreateKey } = require("../../src/broker/pipe-server.js");
const { openBridge } = require("../../src/broker/control.js");
const fakes = require("../fixtures/broker-fakes.js");
const { sleep, until } = fakes;

const HOST_SCRIPT = path.join(__dirname, "..", "..", "src", "cookie-bridge", "host.js");
const SECRET = "SENTINEL-host-VALUE-77aa";
const ck = (over = {}) => ({
  name: "sid", value: SECRET, domain: ".example.com", hostOnly: false, path: "/", secure: true, httpOnly: true,
  sameSite: "lax", session: false, expirationDate: 1893456000, storeId: "0", ...over,
});

/** Chrome's side of the stdio pipes. */
function chromeSide() {
  const input = new PassThrough(); // Chrome → host (host stdin)
  const output = new PassThrough(); // host → Chrome (host stdout)
  const got = [];
  const reader = new MessageReader({ onMessage: (m) => got.push(m) });
  output.on("data", (c) => reader.push(c));
  return { input, output, got, send: (m) => input.write(encodeMessage(m)) };
}

/** A broker channel the test controls. */
function fakeBroker() {
  const state = { attempts: 0, up: false, requests: [], channel: null, reply: (req) => ({ ok: true, applied: (req.cookies || req.changes || []).length, rejected: [] }), hold: false };
  const connectBroker = async () => {
    state.attempts++;
    if (!state.up) throw Object.assign(new Error("no broker"), { code: "ENOENT" });
    const ch = new EventEmitter();
    ch.closed = false;
    ch.pending = [];
    ch.request = (req) => {
      state.requests.push(req);
      if (state.hold) return new Promise((resolve, reject) => ch.pending.push({ resolve, reject }));
      return Promise.resolve({ bmr: "ctl", id: state.requests.length, ...state.reply(req) });
    };
    ch.close = () => {
      if (ch.closed) return;
      ch.closed = true;
      for (const p of ch.pending) p.reject(Object.assign(new Error("closed"), { code: "ECONNRESET" }));
      ch.emit("close");
    };
    state.channel = ch;
    return ch;
  };
  return { state, connectBroker };
}

function startHost(t, broker, opts = {}) {
  const chrome = chromeSide();
  const logs = [];
  const exits = [];
  const host = new NativeHost({ input: chrome.input, output: chrome.output, connectBroker: broker.connectBroker, pollMs: 50, log: (m) => logs.push(m), exit: (c) => exits.push(c), ...opts });
  host.start();
  t.after(() => host.stop());
  return { host, chrome, logs, exits };
}

const ofType = (got, t) => got.filter((m) => m.t === t);

test("host: hello → status; broker down → 'down'", async (t) => {
  const b = fakeBroker();
  const { chrome } = startHost(t, b);
  chrome.send({ t: "hello", v: 1 });
  await until(() => ofType(chrome.got, "status").length, 2000, "a status");
  assert.deepStrictEqual(ofType(chrome.got, "status").at(-1), { t: "status", broker: "down" });
});

test("host: polls until the broker is up, then reports 'up' and asks the extension for a resync", async (t) => {
  const b = fakeBroker();
  const { chrome } = startHost(t, b);
  chrome.send({ t: "hello", v: 1 });
  await until(() => b.state.attempts >= 3, 2000, "a few polls");
  b.state.up = true;
  await until(() => ofType(chrome.got, "resync").length === 1, 2000, "a resync");
  const statuses = ofType(chrome.got, "status").map((m) => m.broker);
  assert.strictEqual(statuses.at(-1), "up");
  const attempts = b.state.attempts;
  await sleep(200);
  assert.strictEqual(b.state.attempts, attempts, "no polling while connected");
});

test("host: full / delta are forwarded as cookies.full / cookies.delta and acked with seq, applied, rejected", async (t) => {
  const b = fakeBroker();
  b.state.up = true;
  b.state.reply = (req) => ({ ok: true, applied: 1, rejected: [{ domain: "chase.com", reason: "deny:finance", count: 1 }] });
  const { chrome } = startHost(t, b);
  await until(() => ofType(chrome.got, "resync").length, 2000, "connect");
  chrome.send({ t: "full", seq: 7, cookies: [ck(), ck({ domain: ".chase.com" })], last: false });
  chrome.send({ t: "delta", seq: 8, changes: [{ removed: true, cause: "explicit", cookie: ck() }] });
  await until(() => ofType(chrome.got, "ack").length === 2, 2000, "two acks");
  assert.deepStrictEqual(b.state.requests.map((r) => [r.ctl, r.last]), [["cookies.full", false], ["cookies.delta", undefined]]);
  assert.strictEqual(b.state.requests[0].cookies.length, 2);
  assert.strictEqual(b.state.requests[1].changes.length, 1);
  assert.deepStrictEqual(ofType(chrome.got, "ack"), [
    { t: "ack", seq: 7, applied: 1, rejected: [{ domain: "chase.com", reason: "deny:finance", count: 1 }] },
    { t: "ack", seq: 8, applied: 1, rejected: [{ domain: "chase.com", reason: "deny:finance", count: 1 }] },
  ]);
});

test("host: while the broker is down, changes are dropped (acked dropped:true); the next resync covers them", async (t) => {
  const b = fakeBroker();
  const { chrome } = startHost(t, b);
  chrome.send({ t: "delta", seq: 1, changes: [{ removed: false, cookie: ck() }] });
  await until(() => ofType(chrome.got, "ack").length, 2000, "an ack");
  assert.deepStrictEqual(ofType(chrome.got, "ack")[0], { t: "ack", seq: 1, applied: 0, rejected: [], dropped: true });
  assert.strictEqual(b.state.requests.length, 0);
});

test("host: the broker going away → 'down', in-flight requests acked dropped, then reconnect + resync", async (t) => {
  const b = fakeBroker();
  b.state.up = true;
  const { chrome } = startHost(t, b);
  await until(() => ofType(chrome.got, "resync").length === 1, 2000, "connect");
  b.state.hold = true;
  chrome.send({ t: "full", seq: 3, cookies: [ck()], last: true });
  await until(() => b.state.requests.length === 1, 2000, "the request");
  b.state.hold = false;
  b.state.channel.close();
  await until(() => ofType(chrome.got, "ack").length === 1, 2000, "the dropped ack");
  assert.strictEqual(ofType(chrome.got, "ack")[0].dropped, true);
  assert.ok(ofType(chrome.got, "status").some((m) => m.broker === "down"));
  await until(() => ofType(chrome.got, "resync").length === 2, 2000, "a second resync after reconnecting");
  assert.strictEqual(ofType(chrome.got, "status").at(-1).broker, "up");
});

test("host: a broker error reply becomes an ack with the error and nothing applied", async (t) => {
  const b = fakeBroker();
  b.state.up = true;
  b.state.reply = () => ({ ok: false, error: "cookies must be an array" });
  const { chrome } = startHost(t, b);
  await until(() => ofType(chrome.got, "resync").length, 2000, "connect");
  chrome.send({ t: "full", seq: 1, cookies: [], last: true });
  await until(() => ofType(chrome.got, "ack").length, 2000, "an ack");
  assert.deepStrictEqual(ofType(chrome.got, "ack")[0], { t: "ack", seq: 1, applied: 0, rejected: [], error: "cookies must be an array" });
});

test("host: a huge rejected list is capped so the ack stays under Chrome's 1 MB", async (t) => {
  const b = fakeBroker();
  b.state.up = true;
  b.state.reply = () => ({ ok: true, applied: 0, rejected: Array.from({ length: 5000 }, (_, i) => ({ domain: `d${i}.${"x".repeat(200)}.example`, reason: "hold:keyword", count: 1 })) });
  const { chrome } = startHost(t, b);
  await until(() => ofType(chrome.got, "resync").length, 2000, "connect");
  chrome.send({ t: "full", seq: 1, cookies: [], last: true });
  await until(() => ofType(chrome.got, "ack").length, 2000, "an ack");
  const ack = ofType(chrome.got, "ack")[0];
  assert.strictEqual(ack.rejected.length, 500);
  assert.strictEqual(ack.rejectedTruncated, 4500);
});

test("host: a malformed frame is logged by size only; unknown types are ignored; the host keeps going", async (t) => {
  const b = fakeBroker();
  const { chrome, logs } = startHost(t, b);
  const body = Buffer.from(`{"value":"${SECRET}`, "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  chrome.input.write(Buffer.concat([head, body]));
  chrome.send({ t: "mystery", value: SECRET });
  chrome.send({ t: "hello", v: 1 });
  await until(() => ofType(chrome.got, "status").length, 2000, "a status");
  assert.ok(logs.some((l) => /malformed/.test(l) && l.includes(String(body.length))), logs.join("\n"));
  assert.ok(!logs.join("\n").includes(SECRET));
});

test("host: Chrome closing stdin stops the host: the bridge closes and it exits 0", async (t) => {
  const b = fakeBroker();
  b.state.up = true;
  const { chrome, exits } = startHost(t, b);
  await until(() => b.state.channel, 2000, "connect");
  chrome.input.end();
  await until(() => exits.length, 2000, "exit");
  assert.deepStrictEqual(exits, [0]);
  assert.strictEqual(b.state.channel.closed, true);
  const attempts = b.state.attempts;
  await sleep(200);
  assert.strictEqual(b.state.attempts, attempts, "no polling after stop");
});

test("host: cookie values never reach the log or Chrome-bound messages", async (t) => {
  const b = fakeBroker();
  b.state.up = true;
  const { chrome, logs } = startHost(t, b);
  await until(() => ofType(chrome.got, "resync").length, 2000, "connect");
  chrome.send({ t: "full", seq: 1, cookies: [ck()], last: true });
  chrome.send({ t: "delta", seq: 2, changes: [{ removed: false, cookie: ck() }] });
  await until(() => ofType(chrome.got, "ack").length === 2, 2000, "acks");
  assert.ok(!JSON.stringify(chrome.got).includes(SECRET));
  assert.ok(!logs.join("\n").includes(SECRET));
});

// ───────────── against a real test broker (in-process) ─────────────

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-w2f-host-"));
test.after(() => fs.rmSync(HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
const ENV = { LOCALAPPDATA: HOME, XDG_STATE_HOME: HOME };
const KEY_FILE = keyFileFor(ENV);
const KEY = loadOrCreateKey(KEY_FILE);

async function testBroker(t, pipe) {
  const logs = [];
  const handle = await startBroker({
    pipe,
    profileDir: path.join(HOME, "profile-unused"),
    env: {},
    keyFile: KEY_FILE,
    log: (m) => logs.push(m),
    idle: { exitMs: 60_000, browserMs: 60_000 },
    onExit: () => {},
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
  return { handle, logs };
}

test("host + real broker pipe: HMAC bridge hello, full sync applied to the snapshot, acked", async (t) => {
  const pipe = fakes.testPipe("w2f-host");
  await testBroker(t, pipe);
  const { chrome } = startHost(t, { connectBroker: () => openBridge({ pipe, key: KEY }) });
  await until(() => ofType(chrome.got, "resync").length, 5000, "connect + resync");
  chrome.send({ t: "full", seq: 1, cookies: [ck(), ck({ domain: ".venmo.com" })], last: true });
  await until(() => ofType(chrome.got, "ack").length, 5000, "an ack");
  assert.deepStrictEqual(ofType(chrome.got, "ack")[0], { t: "ack", seq: 1, applied: 1, rejected: [{ domain: "venmo.com", reason: "deny:finance", count: 1 }] });
});

// ───────────── the real host process, as Chrome runs it ─────────────

function spawnHost(t, env) {
  const child = spawn(process.execPath, [HOST_SCRIPT, "chrome-extension://abcdefghijklmnopabcdefghijklmnop/", "--parent-window=0"], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const got = [];
  const raw = [];
  const reader = new MessageReader({ onMessage: (m) => got.push(m), onMalformed: (n) => raw.push(`malformed:${n}`) });
  child.stdout.on("data", (c) => { raw.push(c); reader.push(c); });
  const stderr = [];
  child.stderr.on("data", (c) => stderr.push(String(c)));
  return { child, got, raw, stderr, send: (m) => child.stdin.write(encodeMessage(m)) };
}

test("host process: finds the broker from env, authenticates, forwards; stdout carries only framed messages", { timeout: 30_000 }, async (t) => {
  const pipe = fakes.testPipe("w2f-hostproc");
  await testBroker(t, pipe);
  const h = spawnHost(t, { ...ENV, BROWSER_RELAY_BROKER_PIPE: pipe });
  h.send({ t: "hello", v: 1 });
  await until(() => ofType(h.got, "resync").length, 15_000, `connect + resync (stderr: ${h.stderr.join("")})`);
  h.send({ t: "full", seq: 4, cookies: [ck()], last: true });
  await until(() => ofType(h.got, "ack").length, 10_000, "an ack");
  assert.deepStrictEqual(ofType(h.got, "ack")[0], { t: "ack", seq: 4, applied: 1, rejected: [] });
  assert.ok(!h.raw.some((x) => typeof x === "string" && x.startsWith("malformed")), "stdout had non-frame bytes");
  const logFile = path.join(path.dirname(KEY_FILE), "cookie-bridge.log");
  await until(() => fs.existsSync(logFile), 3000, "the host log in the (temp) broker home");
  assert.ok(!fs.readFileSync(logFile, "utf8").includes(SECRET));
  if (process.platform === "win32") {
    // the host never opens a TCP port
    const listening = execFileSync("powershell", ["-NoProfile", "-Command",
      `@(Get-NetTCPConnection -State Listen -OwningProcess ${h.child.pid} -ErrorAction SilentlyContinue).Count`], { encoding: "utf8", windowsHide: true }).trim();
    assert.strictEqual(listening, "0", "the host process listens on a TCP port");
  }
  h.child.stdin.end(); // Chrome disconnects
  const code = await new Promise((resolve) => h.child.once("exit", resolve));
  assert.strictEqual(code, 0);
});

test("host process: no broker key yet → 'down', and it keeps running", { timeout: 30_000 }, async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-w2f-nokey-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const h = spawnHost(t, { LOCALAPPDATA: empty, XDG_STATE_HOME: empty, BROWSER_RELAY_BROKER_PIPE: fakes.testPipe("w2f-none") });
  h.send({ t: "hello", v: 1 });
  await until(() => ofType(h.got, "status").length, 10_000, "a status");
  assert.strictEqual(ofType(h.got, "status")[0].broker, "down");
  assert.ok(!fs.existsSync(keyFileFor({ LOCALAPPDATA: empty, XDG_STATE_HOME: empty })), "the host must never create a broker key");
  await sleep(500);
  assert.strictEqual(h.child.exitCode, null);
});

test("host source: no TCP listener anywhere in the host's code path", () => {
  for (const f of ["host.js", "framing.js", "line-channel.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "src", "cookie-bridge", f), "utf8");
    assert.ok(!/createServer|\.listen\(|require\("node:(?:http|https|dgram)"\)/.test(src), `${f} opens a server`);
  }
});
