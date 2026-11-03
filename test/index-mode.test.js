// index-mode.test.js — W2E: src/index.js picks the relay mode.
//
// BROWSER_RELAY_MODE=broker (the Windows default): index.js is the shim, so
// the `node …/src/index.js` entry in the MCP client config needs no change.
// BROWSER_RELAY_MODE=legacy: today's per-session relay.
//
// The broker here is a fake on a unique test pipe with a test key under a
// temp LOCALAPPDATA: nothing touches a real broker, pipe or profile.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const { relayMode } = require("../src/index.js");
const { keyFileFor, loadOrCreateKey, serverHello, claimPipe } = require("../src/broker/pipe-server.js");

const ENTRY = path.resolve(__dirname, "..", "src", "index.js");

test("relayMode: broker by default on Windows, legacy elsewhere (the broker's unix paths are unverified)", () => {
  assert.strictEqual(relayMode({}, { platform: "win32" }), "broker");
  assert.strictEqual(relayMode({}, { platform: "linux" }), "legacy");
  assert.strictEqual(relayMode({}, { platform: "darwin" }), "legacy");
});

test("relayMode: BROWSER_RELAY_MODE picks either mode on any platform (case and spaces ignored)", () => {
  assert.strictEqual(relayMode({ BROWSER_RELAY_MODE: "legacy" }, { platform: "win32" }), "legacy");
  assert.strictEqual(relayMode({ BROWSER_RELAY_MODE: " Broker " }, { platform: "linux" }), "broker");
});

test("relayMode: an unknown value warns once and falls back to the platform default", () => {
  const logs = [];
  assert.strictEqual(relayMode({ BROWSER_RELAY_MODE: "pool" }, { platform: "win32", log: (m) => logs.push(m) }), "broker");
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /BROWSER_RELAY_MODE="pool"/);
  assert.match(logs[0], /broker/);
});

const testPipe = () =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\bmr-test-mode-${process.pid}-${crypto.randomBytes(4).toString("hex")}`
    : path.join(fs.mkdtempSync(path.join(os.tmpdir(), "bmr-test-")), "mode.sock");

test("broker mode: `node src/index.js` is the shim — its stdio reaches the broker pipe, and it loads no relay or MCP SDK modules", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-mode-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // the env the shim derives its key file from (brokerHome under LOCALAPPDATA / XDG_STATE_HOME)
  const env = { ...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home, BROWSER_RELAY_MODE: "broker" };
  const key = loadOrCreateKey(keyFileFor(env));
  const pipe = testPipe();
  env.BROWSER_RELAY_BROKER_PIPE = pipe;

  // fake broker: answers the hello with the key, records the first MCP line
  const server = await claimPipe(pipe);
  const socks = new Set();
  const received = new Promise((resolve) => {
    server.on("connection", async (sock) => {
      socks.add(sock);
      sock.on("error", () => {});
      const { rest } = await serverHello(sock, key);
      let buf = rest.toString();
      const check = () => { if (buf.includes("\n")) resolve(buf.slice(0, buf.indexOf("\n"))); };
      check();
      sock.on("data", (d) => { buf += d; check(); });
      sock.resume();
    });
  });
  t.after(() => new Promise((r) => { for (const s of socks) s.destroy(); server.close(() => r()); }));

  // report what index.js loaded, at exit
  const probe = path.join(home, "probe.js");
  fs.writeFileSync(probe, `process.on("exit", () => process.stderr.write("LOADED " + JSON.stringify(Object.keys(require.cache)) + "\\n"));`);
  const child = spawn(process.execPath, ["-r", probe, ENTRY], { stdio: ["pipe", "pipe", "pipe"], env });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  t.after(() => { if (child.exitCode === null) child.kill(); });

  const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } };
  child.stdin.write(JSON.stringify(init) + "\n");
  const line = await Promise.race([
    received,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`the fake broker got nothing; stderr:\n${stderr}`)), 15000)),
  ]);
  assert.deepStrictEqual(JSON.parse(line), init, "the client's initialize reached the broker unchanged");

  child.stdin.end();
  assert.strictEqual(await exited, 0, stderr);
  const loaded = JSON.parse(stderr.match(/LOADED (.*)/)[1]).map((p) => p.split(path.sep).join("/"));
  const heavy = loaded.filter((p) => /node_modules\/@modelcontextprotocol|node_modules\/zod|\/src\/(?:pool-shared|relay-server|tool-catalog|vault|own-tools\/)/.test(p));
  assert.deepStrictEqual(heavy, [], "the shim must stay light (it runs once per Claude session)");
});
