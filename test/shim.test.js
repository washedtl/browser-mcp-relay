// shim.test.js — W2A: the stdio shim Claude Code launches per session. It
// connects to the broker's pipe (starting the broker through a detached
// launcher when nobody owns it), forwards newline-delimited JSON-RPC both
// ways, and survives a broker restart (initialize replay, in-flight errors).
//
// Unit tests drive a Shim in-process against a scripted fake broker; the
// process tests spawn real shims + the fixture broker (test/fixtures/).
// Pipe names are unique to the run, never a real broker's.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { PassThrough } = require("node:stream");
const { execFileSync } = require("node:child_process");

const { Shim, runLauncher, launchEnv, launcherArgs, resolveShimOptions, onLines, SHIM_FILE, BROKER_MAIN } = require("../src/shim.js");
const { resolveEndpoint, keyFileFor, loadOrCreateKey, helloMac, settingsHash } = require("../src/broker/pipe-server.js");
const { quoteArg, commandLine, isElevated } = require("../src/broker/deelevate.js");

// one key for the in-process tests (the fake broker below answers with it)
const KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-shim-key-"));
const KEY_FILE = path.join(KEY_DIR, "broker.key");
const KEY = loadOrCreateKey(KEY_FILE);
test.after(() => fs.rmSync(KEY_DIR, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 5000, what = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
// unix: a socket in a private (mkdtemp: 0700) dir, as the broker requires
const testPipe = (tag) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\bmr-test-${tag}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bmr-test-")), `${tag}.sock`);

// ───────────────────────── a scripted fake broker ─────────────────────────

function defaultReply(msg) {
  if (msg.method === "initialize") {
    return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } };
  }
  if (msg.method === "echo") return { jsonrpc: "2.0", id: msg.id, result: { echo: msg.params } };
  return null; // "slow" and notifications: no reply
}

/**
 * A scripted broker. It answers the shim's hello with KEY (or, as a
 * squatter, with garbage), records hellos apart from the JSON-RPC traffic.
 */
async function fakeBroker(t, pipe, { reply = defaultReply, squat = false, key = KEY, warning = null } = {}) {
  const conns = [];
  const received = [];
  const hellos = [];
  const server = net.createServer((sock) => {
    const conn = conns.push(sock) - 1;
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { received.push({ conn, raw: line }); continue; }
        if (msg.bmr === "hello") {
          hellos.push({ conn, msg });
          const mac = squat ? crypto.randomBytes(32).toString("hex") : helloMac(key, msg.nonce);
          sock.write(JSON.stringify({ bmr: "hello", v: 1, mac, ...(warning ? { warning } : {}) }) + "\n");
          continue;
        }
        received.push({ conn, msg });
        const out = reply(msg, conn, sock);
        if (out) sock.write(JSON.stringify(out) + "\n");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(pipe, resolve); });
  const fb = {
    server,
    conns,
    received,
    hellos,
    send: (conn, obj) => conns[conn].write(JSON.stringify(obj) + "\n"),
    dropAll: () => { for (const c of conns) c.destroy(); },
    close: () => new Promise((r) => { fb.dropAll(); server.close(() => r()); }),
  };
  t.after(() => fb.close());
  return fb;
}

function shimHarness(t, pipe, opts = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [];
  let buf = "";
  output.setEncoding("utf8");
  output.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      lines.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  });
  const exits = [];
  const logs = [];
  const launches = [];
  const shim = new Shim({
    pipe,
    keyFile: opts.keyFile || KEY_FILE,
    settingsEnv: opts.settingsEnv || null,
    brokerEntry: "fake-broker-entry.js",
    brokerArgs: ["--pipe", pipe],
    input,
    output,
    log: (m) => logs.push(m),
    exit: (code) => exits.push(code),
    spawnLauncher: (args) => { launches.push(args); if (opts.onLaunch) opts.onLaunch(launches.length); },
    connectTimeoutMs: opts.connectTimeoutMs || 5000,
    respawnAfterMs: opts.respawnAfterMs || 5000,
    ...(opts.pipeDirProblem ? { pipeDirProblem: opts.pipeDirProblem } : {}),
  });
  if (opts.staleKey) shim.key = opts.staleKey; // as if read before the key file was recreated
  shim.start();
  t.after(() => shim.close());
  const send = (obj) => input.write(JSON.stringify(obj) + "\n");
  const response = (id) => until(() => lines.find((l) => l.id === id && !l.method), 5000, `response ${id}`);
  return { shim, input, output, lines, exits, logs, launches, send, response };
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "c", version: "0" } } };
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

// ───────────────────────────── unit: framing ─────────────────────────────

test("forwards both ways on newline framing: split chunks, CRLF, UTF-8 split mid-character", async (t) => {
  const pipe = testPipe("frame");
  const fb = await fakeBroker(t, pipe);
  const h = shimHarness(t, pipe);
  const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "echo", params: { s: "é€😀" } }) + "\r\n");
  const cut = line.indexOf(Buffer.from("€")) + 1; // inside the 3-byte €
  h.input.write(line.subarray(0, cut));
  await sleep(20);
  h.input.write(line.subarray(cut));
  const r = await h.response(7);
  assert.deepStrictEqual(r.result, { echo: { s: "é€😀" } });
  assert.deepStrictEqual(fb.received[0].msg.params, { s: "é€😀" });
  // broker → client split across writes
  const note = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { t: "ü" } }) + "\n";
  fb.conns[0].write(note.slice(0, 10));
  await sleep(20);
  fb.conns[0].write(note.slice(10));
  await until(() => h.lines.find((l) => l.method === "notifications/message"), 3000, "notification");
});

test("lines sent before the broker connection exists are queued, in order", async (t) => {
  const pipe = testPipe("queue");
  let fb;
  const h = shimHarness(t, pipe, { onLaunch: () => { setTimeout(async () => { fb = await fakeBroker(t, pipe); }, 100); } });
  h.send(INIT);
  h.send(INITIALIZED);
  h.send({ jsonrpc: "2.0", id: 2, method: "echo", params: { n: 2 } });
  await h.response(2);
  assert.deepStrictEqual(fb.received.map((r) => r.msg.method), ["initialize", "notifications/initialized", "echo"]);
});

// ──────────────────────────── unit: auto-start ────────────────────────────

test("auto-start: a missing pipe spawns the launcher once, with the broker entry and args", async (t) => {
  const pipe = testPipe("auto");
  const h = shimHarness(t, pipe, { onLaunch: () => { setTimeout(() => fakeBroker(t, pipe), 150); } });
  h.send(INIT);
  await h.response(1);
  assert.strictEqual(h.launches.length, 1);
  assert.deepStrictEqual(h.launches[0], launcherArgs("fake-broker-entry.js", ["--pipe", pipe]));
  assert.deepStrictEqual(h.launches[0].slice(0, 3), [SHIM_FILE, "--launch", "fake-broker-entry.js"]);
});

test("auto-start: launches again if the pipe is still missing after respawnAfterMs", async (t) => {
  const pipe = testPipe("respawn");
  const h = shimHarness(t, pipe, {
    respawnAfterMs: 200,
    onLaunch: (n) => { if (n === 2) setTimeout(() => fakeBroker(t, pipe), 50); }, // the first broker never came up
  });
  h.send(INIT);
  await h.response(1);
  assert.strictEqual(h.launches.length, 2);
});

test("an existing broker is used as is: no launch", async (t) => {
  const pipe = testPipe("existing");
  await fakeBroker(t, pipe);
  const h = shimHarness(t, pipe);
  h.send(INIT);
  await h.response(1);
  assert.strictEqual(h.launches.length, 0);
});

test("broker unreachable past the deadline: queued requests get errors; the shim stays up and retries later", async (t) => {
  const pipe = testPipe("down");
  const h = shimHarness(t, pipe, { connectTimeoutMs: 300 });
  h.send(INIT);
  const err = await h.response(1);
  assert.strictEqual(err.error.code, -32603);
  assert.match(err.error.message, /broker/);
  assert.deepStrictEqual(h.exits, [], "a dead broker must not kill the session's MCP server");
  await fakeBroker(t, pipe);
  h.send({ ...INIT, id: 2 });
  assert.ok((await h.response(2)).result, "the next message reconnects");
});

// ─────────────────────── unit: broker restart recovery ───────────────────────

test("broker lost: in-flight requests fail with -32603, initialize is replayed, its reply swallowed", async (t) => {
  const pipe = testPipe("lost");
  const fb = await fakeBroker(t, pipe);
  const h = shimHarness(t, pipe);
  h.send(INIT);
  await h.response(1);
  h.send(INITIALIZED);
  h.send({ jsonrpc: "2.0", id: 2, method: "slow", params: {} });
  await until(() => fb.received.some((r) => r.msg.method === "slow"), 3000, "slow to reach the broker");
  fb.dropAll(); // broker died; the pipe still exists, so the shim reconnects at once

  const failed = await h.response(2);
  assert.deepStrictEqual(failed.error, { code: -32603, message: "browser broker restarted; please retry the call" });
  await until(() => fb.received.filter((r) => r.conn === 1).length >= 2, 3000, "the replay");
  const replay = fb.received.filter((r) => r.conn === 1).map((r) => r.msg);
  assert.strictEqual(replay[0].method, "initialize");
  assert.notStrictEqual(replay[0].id, 1, "replayed under the shim's own id");
  assert.deepStrictEqual(replay[0].params, INIT.params, "same client capabilities");
  assert.deepStrictEqual(replay[1], INITIALIZED);
  await until(() => h.lines.find((l) => l.method === "notifications/tools/list_changed"), 3000, "list_changed");
  h.send({ jsonrpc: "2.0", id: 3, method: "echo", params: { after: true } });
  assert.deepStrictEqual((await h.response(3)).result, { echo: { after: true } });
  assert.strictEqual(h.lines.filter((l) => l.result && l.result.serverInfo).length, 1, "the client saw one initialize result");
});

test("broker lost during initialize: initialize is re-sent under the client's id, not failed", async (t) => {
  const pipe = testPipe("initlost");
  const fb = await fakeBroker(t, pipe, {
    reply: (msg, conn, sock) => {
      if (msg.method === "initialize" && conn === 0) { sock.destroy(); return null; }
      return defaultReply(msg);
    },
  });
  const h = shimHarness(t, pipe);
  h.send(INIT);
  const r = await h.response(1);
  assert.ok(r.result && r.result.serverInfo, JSON.stringify(r));
  assert.deepStrictEqual(fb.received.map((x) => [x.conn, x.msg.id]), [[0, 1], [1, 1]]);
});

test("broker lost during initialize and none comes back: the client gets an error, not silence", async (t) => {
  const pipe = testPipe("initdead");
  let fb;
  fb = await fakeBroker(t, pipe, {
    reply: (msg, conn, sock) => {
      if (msg.method === "initialize") { sock.destroy(); fb.server.close(); return null; } // broker gone for good
      return defaultReply(msg);
    },
  });
  const h = shimHarness(t, pipe, { connectTimeoutMs: 300 });
  h.send(INIT);
  const r = await h.response(1);
  assert.strictEqual(r.error.code, -32603);
  assert.match(r.error.message, /broker unavailable/);
});

test("server→client requests and the client's answers pass through and are not 'in flight'", async (t) => {
  const pipe = testPipe("elicit");
  const fb = await fakeBroker(t, pipe);
  const h = shimHarness(t, pipe);
  h.send(INIT);
  await h.response(1);
  fb.send(0, { jsonrpc: "2.0", id: 99, method: "elicitation/create", params: { message: "ok?" } });
  await until(() => h.lines.find((l) => l.id === 99 && l.method), 3000, "elicitation request");
  h.send({ jsonrpc: "2.0", id: 99, result: { action: "accept" } });
  await until(() => fb.received.find((r) => r.msg.id === 99 && r.msg.result), 3000, "the answer at the broker");
  fb.dropAll();
  await until(() => fb.conns.length === 2, 3000, "reconnect");
  await sleep(50);
  assert.ok(!h.lines.some((l) => l.id === 99 && l.error), "no synthesized error for a server request");
});

test("non-JSON garbage from the client is forwarded untouched (the broker answers parse errors)", async (t) => {
  const pipe = testPipe("garbage");
  const fb = await fakeBroker(t, pipe, { reply: () => null });
  const h = shimHarness(t, pipe);
  h.input.write("not json\n");
  h.send({ jsonrpc: "2.0", id: 5, method: "echo", params: {} });
  await until(() => fb.received.length === 2, 3000, "both lines at the broker");
  assert.deepStrictEqual(fb.received[0], { conn: 0, raw: "not json" });
  assert.strictEqual(fb.received[1].msg.id, 5);
  assert.deepStrictEqual(h.exits, []);
});

test("a socket dir that is not private (unix): the shim refuses to connect or launch, and says why", async (t) => {
  const pipe = testPipe("squat");
  await fakeBroker(t, pipe); // someone else's socket at our name
  const h = shimHarness(t, pipe, { pipeDirProblem: () => "socket dir /tmp/x is owned by uid 0" });
  h.send(INIT);
  const r = await h.response(1);
  assert.match(r.error.message, /not private|owned by uid 0/);
  assert.strictEqual(h.launches.length, 0);
});

test("hello: the shim sends nothing of the session's to a pipe owner without this user's key", async (t) => {
  const pipe = testPipe("squatter");
  const fb = await fakeBroker(t, pipe, { squat: true });
  const h = shimHarness(t, pipe);
  h.send(INIT);
  const r = await h.response(1);
  assert.match(r.error.message, /failed authentication/);
  assert.match(r.error.message, /squatting/);
  assert.strictEqual(fb.hellos.length, 2, "it saw only hellos (a second try after re-reading the key file)");
  assert.deepStrictEqual(fb.received, [], "no JSON-RPC message reached the squatter");
  assert.strictEqual(h.launches.length, 0);
});

test("hello: carries the session's KEYED settings hash, and reconnect=true only after a broker was lost", async (t) => {
  const pipe = testPipe("hello");
  const fb = await fakeBroker(t, pipe);
  const settingsEnv = { BROWSER_RELAY_PROXY_URL: "http://user:pw@p:1" };
  const h = shimHarness(t, pipe, { settingsEnv });
  h.send(INIT);
  await h.response(1);
  assert.strictEqual(fb.hellos[0].msg.settings, settingsHash(settingsEnv, KEY));
  assert.notStrictEqual(fb.hellos[0].msg.settings, settingsHash(settingsEnv, Buffer.alloc(32, 1)), "keyed: useless without the key");
  assert.strictEqual(fb.hellos[0].msg.reconnect, false);
  assert.match(fb.hellos[0].msg.nonce, /^[0-9a-f]{32}$/);
  fb.dropAll();
  await until(() => fb.hellos.length === 2, 5000, "the reconnect hello");
  assert.strictEqual(fb.hellos[1].msg.reconnect, true, "the new broker marks this session's main tab reset");
  assert.notStrictEqual(fb.hellos[1].msg.nonce, fb.hellos[0].msg.nonce);
});

test("hello: a stale cached key is re-read from the key file once before the owner is called a squatter", async (t) => {
  const pipe = testPipe("stalekey");
  const fb = await fakeBroker(t, pipe); // answers with the key in KEY_FILE
  const h = shimHarness(t, pipe, { staleKey: Buffer.alloc(32, 9) });
  h.send(INIT);
  const r = await h.response(1);
  assert.ok(r.result, JSON.stringify(r));
  assert.strictEqual(fb.hellos.length, 2, "one failed try with the stale key, one with the re-read key");
});

test("broker warning (e.g. it runs elevated): on the shim's stderr and once in the session's first tool result", async (t) => {
  const pipe = testPipe("warn");
  const warning = "the browser broker runs elevated (as administrator), and so does its Brave: starting it de-elevated failed (x)";
  await fakeBroker(t, pipe, {
    warning,
    reply: (msg) => (msg.method === "tools/call" ? { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } } : defaultReply(msg)),
  });
  const h = shimHarness(t, pipe);
  h.send(INIT);
  const init = await h.response(1);
  assert.ok(!JSON.stringify(init).includes("WARNING"), "not in the initialize result");
  assert.ok(h.logs.some((l) => l === `WARNING: ${warning}`), h.logs.join("\n"));
  h.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "x", arguments: {} } });
  const first = await h.response(2);
  assert.deepStrictEqual(first.result.content[0], { type: "text", text: `[browser-mcp-relay] WARNING: ${warning}` });
  assert.deepStrictEqual(first.result.content[1], { type: "text", text: "ok" });
  h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x", arguments: {} } });
  const second = await h.response(3);
  assert.strictEqual(second.result.content.length, 1, "once per session");
});

test("reconnect backoff: a broker that drops every connection at once is not hammered", async (t) => {
  const pipe = testPipe("spin");
  let accepted = 0;
  const fb = await fakeBroker(t, pipe);
  fb.server.on("connection", () => { accepted++; });
  const h = shimHarness(t, pipe);
  h.send(INIT);
  await h.response(1);
  // from now on, drop every connection right after the hello (like a broker shutting down)
  fb.server.removeAllListeners("connection");
  fb.server.on("connection", (sock) => {
    accepted++;
    sock.setEncoding("utf8");
    sock.once("data", (d) => {
      const nonce = JSON.parse(d.split("\n")[0]).nonce;
      sock.end(JSON.stringify({ bmr: "hello", v: 1, mac: helloMac(KEY, nonce) }) + "\n");
    });
    sock.on("error", () => {});
  });
  fb.dropAll();
  const before = accepted;
  await sleep(1500);
  const cycles = accepted - before;
  assert.ok(cycles >= 2 && cycles <= 8, `expected a backed-off handful of reconnects in 1.5 s, got ${cycles}`);
});

test("line splitter: a 15 MB line in 8 KB chunks is split in linear time", () => {
  const stream = new PassThrough();
  const lines = [];
  onLines(stream, (l) => lines.push(l));
  const big = "x".repeat(15 * 1024 * 1024);
  const payload = `${big}\n{"small":1}\r\n`;
  const t0 = Date.now();
  for (let i = 0; i < payload.length; i += 8192) stream.write(payload.slice(i, i + 8192));
  const ms = Date.now() - t0;
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].length, big.length);
  assert.strictEqual(lines[1], '{"small":1}');
  assert.ok(ms < 1500, `took ${ms} ms (a rescanning splitter takes seconds)`);
});

test("stdin end: the broker connection is closed and the shim exits 0", async (t) => {
  const pipe = testPipe("eof");
  const fb = await fakeBroker(t, pipe);
  const h = shimHarness(t, pipe);
  h.send(INIT);
  await h.response(1);
  const ended = new Promise((r) => fb.conns[0].once("end", r));
  h.input.end();
  await ended;
  await until(() => h.exits.length === 1, 3000, "exit");
  assert.deepStrictEqual(h.exits, [0]);
});

test("stdin end before any broker connection exits 0 without launching", async (t) => {
  const pipe = testPipe("eof0");
  const h = shimHarness(t, pipe, { connectTimeoutMs: 60_000 });
  h.input.end();
  await until(() => h.exits.length === 1, 3000, "exit");
  assert.deepStrictEqual(h.exits, [0]);
});

// ─────────────────────────── unit: launcher + config ───────────────────────────

function launcherHarness({ elevated = false, deelevate = () => ({ pid: 1 }), env = {} } = {}) {
  const r = { spawns: [], exits: [], logs: [], deelevated: [], files: [] };
  runLauncher(["C:\\x\\broker.js", "--pipe", "P"], {
    env: { SystemRoot: "C:\\Windows", PATH: "C:\\bin", LOCALAPPDATA: "C:\\Users\\fakeuser\\AppData\\Local", ...env },
    spawnFn: (cmd, args, opts) => { r.spawns.push({ cmd, args, opts }); return { unref() {} }; },
    exit: (c) => r.exits.push(c),
    isElevated: () => elevated,
    launchDeelevated: (opts) => { r.deelevated.push(opts); return deelevate(opts); },
    log: (m) => r.logs.push(m),
  });
  return r;
}

test("launcher: a non-elevated launch spawns the broker with the allowlisted env only", () => {
  const r = launcherHarness({ env: { BROWSER_RELAY_PROXY_URL: "http://p:1", TELEMETRY_ENABLE: "false", GITHUB_TOKEN: "ghp_secret", ANTHROPIC_API_KEY: "sk-secret" } });
  assert.strictEqual(r.deelevated.length, 0);
  assert.strictEqual(r.spawns.length, 1);
  const env = r.spawns[0].opts.env;
  assert.strictEqual(env.BROWSER_RELAY_PROXY_URL, "http://p:1");
  assert.strictEqual(env.TELEMETRY_ENABLE, "false");
  assert.strictEqual(env.SystemRoot, "C:\\Windows");
  assert.strictEqual(env.GITHUB_TOKEN, undefined);
  assert.strictEqual(env.ANTHROPIC_API_KEY, undefined);
  assert.deepStrictEqual(r.exits, [0]);
});

test("launcher: elevated → the broker starts de-elevated with exactly the allowlisted env as its env block; no file, no spawn", (t) => {
  const lad = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-launch-lad-"));
  t.after(() => fs.rmSync(lad, { recursive: true, force: true }));
  const r = launcherHarness({ elevated: true, env: { LOCALAPPDATA: lad, BROWSER_RELAY_TEST_MARK: "m", SECRET_TOKEN: "x" } });
  assert.strictEqual(r.spawns.length, 0);
  assert.strictEqual(r.deelevated.length, 1);
  const { args, cwd, childEnv } = r.deelevated[0];
  assert.deepStrictEqual(args, ["C:\\x\\broker.js", "--pipe", "P"], "no --env-file");
  assert.ok(fs.statSync(cwd).isDirectory(), "its working dir exists");
  assert.strictEqual(childEnv.BROWSER_RELAY_TEST_MARK, "m");
  assert.strictEqual(childEnv.SECRET_TOKEN, undefined);
  assert.deepStrictEqual(fs.readdirSync(cwd).filter((n) => n.startsWith("launch-")), [], "no launch file");
  assert.deepStrictEqual(r.logs, []);
  assert.deepStrictEqual(r.exits, [0]);
});

test("launcher: when de-elevation fails it starts the broker elevated, warns in the log and hands the warning to the broker", (t) => {
  const lad = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-launch-lad-"));
  t.after(() => fs.rmSync(lad, { recursive: true, force: true }));
  const r = launcherHarness({ elevated: true, env: { LOCALAPPDATA: lad }, deelevate: () => { throw new Error("the desktop shell runs as another user"); } });
  assert.strictEqual(r.spawns.length, 1);
  assert.strictEqual(r.logs.length, 1);
  assert.match(r.logs[0], /^WARNING: the browser broker runs elevated \(as administrator\), and so does its Brave: starting it de-elevated failed \(the desktop shell runs as another user\)/);
  assert.strictEqual(r.spawns[0].opts.env.BROWSER_RELAY_BROKER_LAUNCH_WARNING, r.logs[0].replace(/^WARNING: /, ""), "every session will hear it");
  assert.deepStrictEqual(r.exits, [0]);
});

test("launcher: BROWSER_RELAY_BROKER_DEELEVATE=off keeps an elevated launch elevated, silently", () => {
  const r = launcherHarness({ elevated: true, env: { BROWSER_RELAY_BROKER_DEELEVATE: "off" } });
  assert.strictEqual(r.deelevated.length, 0);
  assert.strictEqual(r.spawns.length, 1);
  assert.deepStrictEqual(r.logs, []);
});

test("launchEnv: OS basics, BROWSER_*, telemetry and upstream catalog keys; case-insensitive", () => {
  const env = launchEnv({ Path: "p", windir: "w", browser_relay_x: "1", TOOL_NAME_PREFIX: "t", NODE_OPTIONS: "--inspect", AWS_SECRET_ACCESS_KEY: "s" });
  assert.deepStrictEqual(Object.keys(env).sort(), ["Path", "TOOL_NAME_PREFIX", "browser_relay_x", "windir"]);
});

test("quoteArg: a Windows command line node reads back exactly", { skip: process.platform !== "win32" && "Windows command lines" }, () => {
  const args = ["plain", "with space", 'quo"te', "trail\\", "C:\\Program Files\\x\\", "\\\\.\\pipe\\bmr", "", 'a\\"b', "x\\\\y"];
  const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))";
  // verbatim: the child gets exactly our command line (argv0 included)
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(process.execPath, ["-e", quoteArg(script), ...args.map(quoteArg)], {
    encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, argv0: quoteArg(process.execPath),
  });
  assert.deepStrictEqual(JSON.parse(r.stdout), args);
  assert.strictEqual(commandLine(["a b", "c"]), '"a b" c');
});

test("runLauncher: starts the broker detached, hidden, stdio ignored, then exits", () => {
  const calls = [];
  const exits = [];
  runLauncher(["C:\\x\\broker.js", "--pipe", "P"], {
    spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.push("unref"); } }; },
    exit: (c) => exits.push(c),
    isElevated: () => false,
  });
  assert.strictEqual(calls[0].cmd, process.execPath);
  assert.deepStrictEqual(calls[0].args, ["C:\\x\\broker.js", "--pipe", "P"]);
  assert.strictEqual(calls[0].opts.detached, true);
  assert.strictEqual(calls[0].opts.stdio, "ignore");
  assert.strictEqual(calls[0].opts.windowsHide, true);
  assert.strictEqual(calls[1], "unref");
  assert.deepStrictEqual(exits, [0]);
});

test("resolveShimOptions: the real broker entry, the same pipe + profile the broker derives, the key file and settings env", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\fakeuser\\AppData\\Local", BROWSER_RELAY_BROKER_PROFILE_DIR: "D:\\prof" };
  const o = resolveShimOptions(env);
  const ep = resolveEndpoint(env);
  assert.strictEqual(o.brokerEntry, BROKER_MAIN);
  assert.ok(fs.existsSync(o.brokerEntry));
  assert.strictEqual(o.pipe, ep.pipe);
  assert.strictEqual(o.keyFile, keyFileFor(env));
  assert.deepStrictEqual(o.brokerArgs, ["--pipe", ep.pipe, "--profile-dir", ep.profileDir, "--key-file", keyFileFor(env)]);
  assert.strictEqual(o.settingsEnv, env, "hashed with the key once the shim has it");
});

// ──────────────── processes: real shims, real fixture broker ────────────────

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const SHIM_ENTRY = path.join(__dirname, "fixtures", "shim-entry.js");

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function killTree(pid) {
  if (!pid || !pidAlive(pid)) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore" }); } catch { /* gone */ }
  } else {
    try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  }
}

/** A marker dir + pipe; after the test, kill every broker the run started and assert none survive. */
function processRun(t, tag) {
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), `bmr-shim-${tag}-`));
  const pipe = testPipe(tag);
  const brokerPids = (kind = "started") => fs.readdirSync(markerDir).filter((f) => f.startsWith(`${kind}-`)).map((f) => Number(f.split("-")[1]));
  const clients = [];
  t.after(async () => {
    // sessions first, as Claude Code would close them, then any broker left
    for (const c of clients) await c.close().catch(() => {});
    for (const pid of brokerPids()) killTree(pid);
    await until(() => brokerPids().every((p) => !pidAlive(p)), 5000, "test brokers to be gone");
    fs.rmSync(markerDir, { recursive: true, force: true });
  });
  return { markerDir, pipe, brokerPids, clients };
}

async function shimClient(t, run, { exitMs = 60_000, watchdogMs = 0, name = "c", env = {} } = {}) {
  const t0 = Date.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SHIM_ENTRY, run.pipe, run.markerDir, String(exitMs), String(watchdogMs)],
    // the real launcher starts the broker; de-elevation only where a test asks for it
    env: { ...process.env, BROWSER_RELAY_BROKER_DEELEVATE: "off", BROWSER_RELAY_BROKER_LOG: path.join(run.markerDir, "broker.log"), ...env },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "0" });
  await client.connect(transport);
  run.clients.push(client);
  const connectMs = Date.now() - t0;
  t.after(() => client.close().catch(() => {}));
  return { client, transport, connectMs, shimPid: transport.pid };
}
const callJson = async (c, name, args = {}) => JSON.parse((await c.client.callTool({ name, arguments: args })).content[0].text);

test("processes: 3 shims racing a cold start leave exactly one broker, and all three are served", async (t) => {
  const run = processRun(t, "race");
  const cs = await Promise.all(["A", "B", "C"].map((name) => shimClient(t, run, { name })));
  const pids = await Promise.all(cs.map((c) => callJson(c, "fixture_pid")));
  assert.strictEqual(new Set(pids.map((p) => p.pid)).size, 1, "every session talks to one broker");
  await until(() => run.brokerPids("started").every((p) => run.brokerPids("winner").includes(p) || run.brokerPids("loser").includes(p)), 5000, "every started broker to settle");
  assert.strictEqual(run.brokerPids("winner").length, 1);
  assert.deepStrictEqual(run.brokerPids("winner"), [pids[0].pid]);
  const alive = run.brokerPids("started").filter(pidAlive);
  assert.deepStrictEqual(alive, [pids[0].pid], "the losers exited");
  t.diagnostic(`cold connect ms (initialize answered): ${cs.map((c) => c.connectMs).join(", ")}; brokers started: ${run.brokerPids("started").length}`);
});

test("processes: broker hard-killed → the in-flight call fails 'restarted', the next call reaches a new broker", async (t) => {
  const run = processRun(t, "kill");
  const c = await shimClient(t, run);
  const { pid: first } = await callJson(c, "fixture_pid");
  const inflight = c.client.callTool({ name: "fixture_sleep", arguments: { ms: 30_000 } }).then(() => "resolved", (e) => e);
  await sleep(100);
  const tKill = Date.now();
  killTree(first);
  const err = await inflight;
  assert.ok(err instanceof Error, `in-flight call should fail, got ${err}`);
  assert.match(err.message, /browser broker restarted; please retry the call/);
  const { pid: second } = await callJson(c, "fixture_pid");
  const recoveryMs = Date.now() - tKill;
  assert.notStrictEqual(second, first);
  assert.ok(pidAlive(second));
  // the replayed handshake kept the session usable: tools/list still works
  assert.ok((await c.client.listTools()).tools.some((x) => x.name === "fixture_pid"));
  t.diagnostic(`broker kill → next successful call: ${recoveryMs} ms`);
});

test("processes: tree-killing a shim leaves the broker running (it is not in the shim's tree)", { skip: process.platform !== "win32" && "taskkill /T" }, async (t) => {
  const run = processRun(t, "treekill");
  const a = await shimClient(t, run, { name: "A" });
  const { pid } = await callJson(a, "fixture_pid");
  killTree(a.shimPid);
  await sleep(500);
  assert.ok(!pidAlive(a.shimPid), "the shim is gone");
  assert.ok(pidAlive(pid), "the broker survived");
  const b = await shimClient(t, run, { name: "B" });
  assert.strictEqual((await callJson(b, "fixture_pid")).pid, pid, "and still serves new sessions");
});

test("processes: a blocked event loop is caught by the watchdog: the broker is killed and the session recovers", async (t) => {
  const run = processRun(t, "watchdog");
  const c = await shimClient(t, run, { watchdogMs: 1500 });
  const { pid: first } = await callJson(c, "fixture_pid");
  await sleep(2500); // heartbeats flow while idle: no false kill
  assert.ok(pidAlive(first), "an idle broker is not killed");
  const t0 = Date.now();
  const spun = await c.client.callTool({ name: "fixture_spin", arguments: {} }).then(() => "resolved", (e) => e);
  assert.ok(spun instanceof Error && /browser broker restarted/.test(spun.message), String(spun));
  const killedAfter = Date.now() - t0;
  assert.ok(!pidAlive(first));
  const { pid: second } = await callJson(c, "fixture_pid");
  assert.notStrictEqual(second, first);
  assert.match(fs.readFileSync(path.join(run.markerDir, "broker.log"), "utf8"), /watchdog: the event loop has been blocked for \d+ ms/);
  t.diagnostic(`busy loop → broker killed and the call failed after ${killedAfter} ms (watchdog 1500 ms)`);
});

test("processes: the launched broker gets only the allowlisted env", async (t) => {
  const run = processRun(t, "allowlist");
  const c = await shimClient(t, run, { env: { BROWSER_RELAY_TEST_MARK: "m-1", NOT_ALLOWLISTED_SECRET: "s3cr3t" } });
  const who = await callJson(c, "fixture_whoami");
  assert.strictEqual(who.mark, "m-1");
  assert.strictEqual(who.secret, null);
});

const elevatedHere = process.platform === "win32" && isElevated();
test("processes: from an elevated session the broker runs de-elevated (medium integrity) with only the allowlisted env", { skip: !elevatedHere && "needs an elevated Windows session" }, async (t) => {
  const run = processRun(t, "deelevate");
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-lad-"));
  // the broker's working dir is in here; a just-killed broker may hold it a moment
  t.after(() => fs.rmSync(localAppData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const c = await shimClient(t, run, {
    env: { BROWSER_RELAY_BROKER_DEELEVATE: "auto", LOCALAPPDATA: localAppData, BROWSER_RELAY_TEST_MARK: "m-2", NOT_ALLOWLISTED_SECRET: "s3cr3t" },
  });
  const who = await callJson(c, "fixture_whoami");
  assert.strictEqual(who.integrity, "Medium", "the broker is not elevated");
  assert.strictEqual(who.mark, "m-2", "allowlisted settings arrive in its env block");
  assert.strictEqual(who.secret, null, "a session-only var outside the allowlist is absent");
  assert.deepStrictEqual(who.profileOnly, [], "vars that only the user-profile env sets (ALLUSERSPROFILE, PUBLIC) are absent too");
  const leftover = fs.readdirSync(path.join(localAppData, "browser-mcp-relay", "broker")).filter((n) => n.startsWith("launch-"));
  assert.deepStrictEqual(leftover, [], "no launch file");
  t.diagnostic(`broker pid ${who.pid}: ${who.integrity} integrity; connected in ${c.connectMs} ms`);
});

test("processes: the broker exits on its own after its last session leaves", async (t) => {
  const run = processRun(t, "idle");
  const c = await shimClient(t, run, { exitMs: 300 });
  const { pid } = await callJson(c, "fixture_pid");
  await c.client.close();
  const t0 = Date.now();
  await until(() => !pidAlive(pid), 8000, "the broker to exit");
  t.diagnostic(`broker gone ${Date.now() - t0} ms after the last session closed (idle 300 ms)`);
});
