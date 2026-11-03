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

const { Shim, runLauncher, launcherArgs, resolveShimOptions, SHIM_FILE, BROKER_MAIN } = require("../src/shim.js");
const { resolveEndpoint } = require("../src/broker/pipe-server.js");

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
const testPipe = (tag) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\bmr-test-${tag}-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
    : path.join(os.tmpdir(), `bmr-test-${tag}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.sock`);

// ───────────────────────── a scripted fake broker ─────────────────────────

function defaultReply(msg) {
  if (msg.method === "initialize") {
    return { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } } };
  }
  if (msg.method === "echo") return { jsonrpc: "2.0", id: msg.id, result: { echo: msg.params } };
  return null; // "slow" and notifications: no reply
}

async function fakeBroker(t, pipe, { reply = defaultReply } = {}) {
  const conns = [];
  const received = [];
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
    brokerEntry: "fake-broker-entry.js",
    brokerArgs: ["--pipe", pipe],
    input,
    output,
    log: (m) => logs.push(m),
    exit: (code) => exits.push(code),
    spawnLauncher: (args) => { launches.push(args); if (opts.onLaunch) opts.onLaunch(launches.length); },
    connectTimeoutMs: opts.connectTimeoutMs || 5000,
    respawnAfterMs: opts.respawnAfterMs || 5000,
  });
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

test("runLauncher: starts the broker detached, hidden, stdio ignored, then exits", () => {
  const calls = [];
  const exits = [];
  runLauncher(["C:\\x\\broker.js", "--pipe", "P"], {
    spawnFn: (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { unref() { calls.push("unref"); } }; },
    exit: (c) => exits.push(c),
  });
  assert.strictEqual(calls[0].cmd, process.execPath);
  assert.deepStrictEqual(calls[0].args, ["C:\\x\\broker.js", "--pipe", "P"]);
  assert.strictEqual(calls[0].opts.detached, true);
  assert.strictEqual(calls[0].opts.stdio, "ignore");
  assert.strictEqual(calls[0].opts.windowsHide, true);
  assert.strictEqual(calls[1], "unref");
  assert.deepStrictEqual(exits, [0]);
});

test("resolveShimOptions: the real broker entry, and the same pipe + profile the broker derives", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\fakeuser\\AppData\\Local", BROWSER_RELAY_BROKER_PROFILE_DIR: "D:\\prof" };
  const o = resolveShimOptions(env);
  const ep = resolveEndpoint(env);
  assert.strictEqual(o.brokerEntry, BROKER_MAIN);
  assert.ok(fs.existsSync(o.brokerEntry));
  assert.strictEqual(o.pipe, ep.pipe);
  assert.deepStrictEqual(o.brokerArgs, ["--pipe", ep.pipe, "--profile-dir", ep.profileDir]);
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
  t.after(async () => {
    for (const pid of brokerPids()) killTree(pid);
    await until(() => brokerPids().every((p) => !pidAlive(p)), 5000, "test brokers to be gone");
    fs.rmSync(markerDir, { recursive: true, force: true });
  });
  return { markerDir, pipe, brokerPids };
}

async function shimClient(t, run, { exitMs = 60_000, name = "c" } = {}) {
  const t0 = Date.now();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SHIM_ENTRY, run.pipe, run.markerDir, String(exitMs)],
    stderr: "pipe",
  });
  const client = new Client({ name, version: "0" });
  await client.connect(transport);
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

test("processes: the broker exits on its own after its last session leaves", async (t) => {
  const run = processRun(t, "idle");
  const c = await shimClient(t, run, { exitMs: 300 });
  const { pid } = await callJson(c, "fixture_pid");
  await c.client.close();
  const t0 = Date.now();
  await until(() => !pidAlive(pid), 8000, "the broker to exit");
  t.diagnostic(`broker gone ${Date.now() - t0} ms after the last session closed (idle 300 ms)`);
});
