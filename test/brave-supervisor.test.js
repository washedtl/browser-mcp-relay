// brave-supervisor.test.js — W2C broker Brave supervisor.
//
// Three layers:
//   A. pure helpers (flags, Memory Saver pref, proxy probe, env) — no browser
//   B. the supervisor state machine against test/fixtures/fake-brave.js, a
//      tiny node stand-in that speaks just enough CDP (/json/version, a
//      browser websocket, Browser.close, SystemInfo.getProcessInfo) to drive
//      the branches real Brave can't be made to hit on demand (ignores
//      Browser.close, lingers after a disconnect, hands off and exits)
//   C. real Brave on throwaway profiles (skips cleanly when Brave is absent):
//      crash → recovery, concurrent ensure() → one Brave, graceful close keeps
//      a fresh cookie (the spike's E7a), --load-extension, Memory Saver.
//
// Every profile lives under <repo>/.tmp-profiles/<run id>/ and every CDP
// port is OS-assigned. The after() hook kills only PIDs this file recorded,
// then asserts no process references the run dir.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const WebSocket = require("ws");
const { detectBravePath } = require("../src/detect-browser.js");

const {
  BraveSupervisor,
  buildBraveArgs,
  disableMemorySaver,
  resolveProxyServer,
  braveEnv,
} = require("../src/broker/brave-supervisor.js");

const RUN_ID = `bsup-${process.pid}-${Date.now()}`;
const TMP_ROOT = path.join(__dirname, "..", ".tmp-profiles", RUN_ID);
let profileSeq = 0;
function tmpProfile(name) {
  // "007-name": zero-padded prefix, so one profile's name is never a
  // substring of another's (process lookups match on it).
  const dir = path.join(TMP_ROOT, `${String(++profileSeq).padStart(3, "0")}-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

/** A port that nothing listens on (bound once by us, then released). */
async function deadPort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}

function collectLog() {
  const lines = [];
  const log = (m) => lines.push(m);
  log.lines = lines;
  return log;
}

// ─────────────── A. pure helpers ───────────────

test("buildBraveArgs: exactly the design §3 flag set, nothing else", () => {
  const args = buildBraveArgs({ port: 9555, profileDir: "C:\\p\\broker" });
  assert.deepStrictEqual(args, [
    "--remote-debugging-port=9555",
    "--user-data-dir=C:\\p\\broker",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--disable-features=AutoDeElevate,CalculateNativeWinOcclusion",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ]);
});

test("buildBraveArgs: never Playwright's --enable-automation / --use-mock-keychain, never a URL", () => {
  const args = buildBraveArgs({ port: 1, profileDir: "/p", extensionPath: "/ext", proxyServer: "http://127.0.0.1:8888" });
  assert.ok(!args.includes("--enable-automation"));
  assert.ok(!args.includes("--use-mock-keychain"));
  assert.ok(args.every((a) => a.startsWith("--")), "a positional URL would open a startup window");
});

test("buildBraveArgs: one --disable-features switch only (a second one silently drops AutoDeElevate)", () => {
  const args = buildBraveArgs({ port: 1, profileDir: "/p", extensionPath: "/ext", proxyServer: "http://h:1" });
  assert.strictEqual(args.filter((a) => a.startsWith("--disable-features=")).length, 1);
});

test("buildBraveArgs: --load-extension and --proxy-server only when given", () => {
  const plain = buildBraveArgs({ port: 1, profileDir: "/p" });
  assert.ok(!plain.some((a) => a.startsWith("--load-extension") || a.startsWith("--proxy-server")));
  const extra = buildBraveArgs({ port: 1, profileDir: "/p", extensionPath: "C:\\ext\\companion", proxyServer: "http://127.0.0.1:8888" });
  assert.ok(extra.includes("--load-extension=C:\\ext\\companion"));
  assert.ok(extra.includes("--proxy-server=http://127.0.0.1:8888"));
});

test("disableMemorySaver: fresh profile → Local State created with Memory Saver off", () => {
  const dir = tmpProfile("ms-fresh");
  assert.strictEqual(disableMemorySaver(dir), true);
  const state = JSON.parse(fs.readFileSync(path.join(dir, "Local State"), "utf8"));
  assert.strictEqual(state.performance_tuning.high_efficiency_mode.state, 0);
});

test("disableMemorySaver: Memory Saver on → off, every other Local State key preserved", () => {
  const dir = tmpProfile("ms-on");
  const before = {
    os_crypt: { encrypted_key: "RFBBUEkBAAAA" },
    performance_tuning: { high_efficiency_mode: { state: 2, aggressiveness: 1 }, battery_saver_mode: { state: 1 } },
    browser: { enabled_labs_experiments: [] },
  };
  fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify(before));
  assert.strictEqual(disableMemorySaver(dir), true);
  const after = JSON.parse(fs.readFileSync(path.join(dir, "Local State"), "utf8"));
  assert.strictEqual(after.performance_tuning.high_efficiency_mode.state, 0);
  assert.strictEqual(after.performance_tuning.high_efficiency_mode.aggressiveness, 1);
  assert.deepStrictEqual(after.performance_tuning.battery_saver_mode, { state: 1 });
  assert.deepStrictEqual(after.os_crypt, before.os_crypt, "the cookie key must survive the rewrite");
  assert.deepStrictEqual(after.browser, before.browser);
  assert.deepStrictEqual(fs.readdirSync(dir), ["Local State"], "no temp file left behind");
});

test("disableMemorySaver: already off → file left byte-for-byte untouched", () => {
  const dir = tmpProfile("ms-off");
  const raw = '{"os_crypt":{"encrypted_key":"x"},"performance_tuning":{"high_efficiency_mode":{"state":0}}}';
  fs.writeFileSync(path.join(dir, "Local State"), raw);
  assert.strictEqual(disableMemorySaver(dir), false);
  assert.strictEqual(fs.readFileSync(path.join(dir, "Local State"), "utf8"), raw);
});

test("disableMemorySaver: unparseable Local State is never clobbered (it holds the cookie key)", () => {
  const dir = tmpProfile("ms-bad");
  fs.writeFileSync(path.join(dir, "Local State"), "{not json");
  const log = collectLog();
  assert.strictEqual(disableMemorySaver(dir, log), false);
  assert.strictEqual(fs.readFileSync(path.join(dir, "Local State"), "utf8"), "{not json");
  assert.ok(log.lines.some((l) => /Local State/.test(l) && /Memory Saver/.test(l)), log.lines.join("\n"));
});

test("disableMemorySaver: a failed write warns, leaves Local State intact, never throws", () => {
  const dir = tmpProfile("ms-write-fail");
  const raw = JSON.stringify({ os_crypt: { encrypted_key: "k" }, performance_tuning: { high_efficiency_mode: { state: 2 } } });
  fs.writeFileSync(path.join(dir, "Local State"), raw);
  fs.mkdirSync(path.join(dir, `Local State.${process.pid}.tmp`)); // the temp path is a dir → write fails
  const log = collectLog();
  assert.strictEqual(disableMemorySaver(dir, log), false);
  assert.strictEqual(fs.readFileSync(path.join(dir, "Local State"), "utf8"), raw);
  assert.ok(log.lines.some((l) => /Memory Saver/.test(l)), log.lines.join("\n"));
});

test("disableMemorySaver: does NOT write Default/Preferences (measured: Brave 147 ignores the key there)", () => {
  const dir = tmpProfile("ms-prefs");
  disableMemorySaver(dir);
  assert.ok(!fs.existsSync(path.join(dir, "Default")));
});

test("resolveProxyServer: no proxy configured → null, no warning", async () => {
  const log = collectLog();
  assert.strictEqual(await resolveProxyServer(null, { log }), null);
  assert.strictEqual(await resolveProxyServer("", { log }), null);
  assert.deepStrictEqual(log.lines, []);
});

test("resolveProxyServer: proxy accepting TCP → its server string", async () => {
  const s = net.createServer((sock) => sock.destroy());
  const port = await listen(s);
  try {
    assert.strictEqual(await resolveProxyServer(`http://127.0.0.1:${port}`, { log: collectLog() }), `http://127.0.0.1:${port}`);
    assert.strictEqual(await resolveProxyServer(`127.0.0.1:${port}`, { log: collectLog() }), `http://127.0.0.1:${port}`, "bare host:port means http");
    assert.strictEqual(await resolveProxyServer(`socks5://127.0.0.1:${port}/`, { log: collectLog() }), `socks5://127.0.0.1:${port}`);
  } finally {
    s.close();
  }
});

test("resolveProxyServer: dead proxy → null + warning, decided within ~1.5 s", async () => {
  const port = await deadPort();
  const log = collectLog();
  const t0 = Date.now();
  assert.strictEqual(await resolveProxyServer(`http://127.0.0.1:${port}`, { log }), null);
  const ms = Date.now() - t0;
  assert.ok(ms < 2500, `probe took ${ms} ms`);
  assert.ok(log.lines.some((l) => /proxy/i.test(l) && /direct/i.test(l)), log.lines.join("\n"));
});

test("resolveProxyServer: a proxy that never answers the handshake is cut off at the timeout", async () => {
  // 10.255.255.1 is non-routable: connect() neither succeeds nor fails fast.
  const log = collectLog();
  const t0 = Date.now();
  assert.strictEqual(await resolveProxyServer("http://10.255.255.1:8888", { log, timeoutMs: 300 }), null);
  assert.ok(Date.now() - t0 < 1500);
});

test("resolveProxyServer: credentials in the URL are warned about (--proxy-server can't carry them)", async () => {
  const s = net.createServer((sock) => sock.destroy());
  const port = await listen(s);
  try {
    const log = collectLog();
    assert.strictEqual(await resolveProxyServer(`http://user:secret@127.0.0.1:${port}`, { log }), `http://127.0.0.1:${port}`);
    assert.ok(log.lines.some((l) => /credentials/i.test(l)), log.lines.join("\n"));
    assert.ok(!log.lines.some((l) => l.includes("secret")), "never log the password");
  } finally {
    s.close();
  }
});

test("resolveProxyServer: unusable URL → null + warning", async () => {
  for (const bad of ["ftp://127.0.0.1:21", "http://", "::::", "ftp://user:secret@127.0.0.1:21", "htp://user:secret@h:1"]) {
    const log = collectLog();
    assert.strictEqual(await resolveProxyServer(bad, { log }), null, bad);
    assert.ok(log.lines.length > 0, `no warning for ${bad}`);
    assert.ok(!log.lines.some((l) => l.includes("secret")), `password logged for ${bad}: ${log.lines}`);
  }
});

test("braveEnv: strips relay-internal and proxy env vars, keeps the rest", () => {
  const env = braveEnv({
    PATH: "/bin",
    LOCALAPPDATA: "C:\\L",
    BROWSER_RELAY_PROXY_URL: "http://x:1",
    BROWSER_RELAY_INSPECTOR_PORT: "9",
    HTTP_PROXY: "http://dead:1",
    https_proxy: "http://dead:1",
    ALL_PROXY: "socks5://dead:1",
  });
  assert.deepStrictEqual(env, { PATH: "/bin", LOCALAPPDATA: "C:\\L" });
});

// ─────────────── shared process bookkeeping ───────────────

const FAKE_BRAVE = path.join(__dirname, "fixtures", "fake-brave.js");
const spawnedChildren = []; // every process this file spawned (fake or real Brave)
const supervisors = [];

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!(await pred())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(25);
  }
}
function nextEvent(emitter, name) {
  return new Promise((resolve) => emitter.once(name, (...a) => resolve(a)));
}

/** Minimal CDP client on the browser endpoint behind `cdpUrl`. */
async function openCdp(cdpUrl) {
  const { webSocketDebuggerUrl } = await (await fetch(`${cdpUrl}/json/version`)).json();
  const ws = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let id = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const m = JSON.parse(data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
  });
  ws.on("close", () => { for (const p of pending.values()) p.reject(new Error("cdp closed")); pending.clear(); });
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    close: () => new Promise((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once("close", resolve);
      ws.close();
    }),
  };
}

/** A `_spawn` seam that records every child (so after() can account for it). */
function recordingSpawn({ exe = null, prefixArgs = [], onSpawn = null } = {}) {
  return (realExe, args, opts) => {
    if (onSpawn) onSpawn(args);
    const child = spawn(exe || realExe, [...prefixArgs, ...args], opts);
    spawnedChildren.push(child);
    return child;
  };
}

// ─────────────── B. supervisor state machine (fake Brave) ───────────────

function fakeSupervisor(profileDir, { mode = "", delay = 0, onSpawn = null, ...opts } = {}) {
  const log = collectLog();
  const sup = new BraveSupervisor({
    profileDir,
    executablePath: "fake-brave",
    log,
    _spawn: recordingSpawn({ exe: process.execPath, prefixArgs: [FAKE_BRAVE, `--fake-mode=${mode}`, `--fake-delay=${delay}`], onSpawn }),
    ...opts,
  });
  supervisors.push(sup);
  return { sup, log };
}
function launchesOf(profileDir) {
  const f = path.join(profileDir, "fake-launches.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("constructor: profileDir is required, port must be a valid TCP port", () => {
  assert.throws(() => new BraveSupervisor({}), /profileDir/);
  assert.throws(() => new BraveSupervisor({ profileDir: "/p", port: 70000 }), /port/);
  assert.throws(() => new BraveSupervisor({ profileDir: "/p", port: 1.5 }), /port/);
  assert.doesNotThrow(() => new BraveSupervisor({ profileDir: "/p", port: 0 }));
});

test("ensure(): launches with the exact flags on an OS-assigned port, returns {cdpUrl, pid}", async () => {
  const dir = tmpProfile("fake-ensure");
  const { sup } = fakeSupervisor(dir, { extensionPath: "C:\\ext\\companion" });
  assert.strictEqual(sup.isUp(), false);
  const info = await sup.ensure();
  assert.deepStrictEqual(Object.keys(info).sort(), ["cdpUrl", "pid"]);
  const port = Number(new URL(info.cdpUrl).port);
  assert.ok(port > 0);
  assert.strictEqual(info.cdpUrl, `http://127.0.0.1:${port}`);
  assert.ok(isAlive(info.pid));
  assert.strictEqual(sup.isUp(), true);
  const [launch] = launchesOf(dir);
  assert.strictEqual(launch.pid, info.pid, "pid is the spawned process");
  assert.deepStrictEqual(launch.args, buildBraveArgs({ port, profileDir: path.resolve(dir), extensionPath: "C:\\ext\\companion" }));
  const v = await (await fetch(`${info.cdpUrl}/json/version`)).json();
  assert.match(v.Browser, /FakeBrave/);
});

test("ensure(): when already up, returns the same Brave without relaunching", async () => {
  const dir = tmpProfile("fake-idem");
  const { sup } = fakeSupervisor(dir);
  const a = await sup.ensure();
  const b = await sup.ensure();
  assert.deepStrictEqual(a, b);
  assert.strictEqual(launchesOf(dir).length, 1);
});

test("ensure(): concurrent calls coalesce into ONE launch", async () => {
  const dir = tmpProfile("fake-coalesce");
  const { sup } = fakeSupervisor(dir, { delay: 300 });
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => sup.ensure()));
  assert.strictEqual(new Set(results.map((r) => r.pid)).size, 1);
  assert.strictEqual(launchesOf(dir).length, 1);
});

test("ensure(): the caller can choose the CDP port", async () => {
  const dir = tmpProfile("fake-port");
  const port = await deadPort();
  const { sup } = fakeSupervisor(dir, { port });
  const info = await sup.ensure();
  assert.strictEqual(info.cdpUrl, `http://127.0.0.1:${port}`);
});

test("ensure(): a caller-chosen port that is already taken fails before spawning", async () => {
  const dir = tmpProfile("fake-taken");
  const s = net.createServer();
  const port = await listen(s);
  try {
    const { sup } = fakeSupervisor(dir, { port });
    sup.on("fatal", () => assert.fail("a first launch is not a lost port: no 'fatal'"));
    await assert.rejects(sup.ensure(), /port .*in use/i);
    assert.strictEqual(launchesOf(dir).length, 0);
  } finally {
    s.close();
  }
});

test("ensure(): Memory Saver is switched off in Local State before Brave starts", async () => {
  const dir = tmpProfile("fake-memsaver");
  fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ performance_tuning: { high_efficiency_mode: { state: 2 } } }));
  let stateAtSpawn;
  const { sup } = fakeSupervisor(dir, {
    onSpawn: () => { stateAtSpawn = JSON.parse(fs.readFileSync(path.join(dir, "Local State"), "utf8")).performance_tuning.high_efficiency_mode.state; },
  });
  await sup.ensure();
  assert.strictEqual(stateAtSpawn, 0);
});

test("ensure(): dead proxy → launched direct with a warning; live proxy → --proxy-server", async () => {
  const deadDir = tmpProfile("fake-proxy-dead");
  const dead = await deadPort();
  const { sup: s1, log } = fakeSupervisor(deadDir, { proxyUrl: `http://127.0.0.1:${dead}` });
  await s1.ensure();
  assert.ok(!launchesOf(deadDir)[0].args.some((a) => a.startsWith("--proxy-server")));
  assert.ok(log.lines.some((l) => /proxy/i.test(l) && /direct/i.test(l)), log.lines.join("\n"));

  const proxy = net.createServer((sock) => sock.destroy());
  const live = await listen(proxy);
  try {
    const liveDir = tmpProfile("fake-proxy-live");
    const { sup: s2, log: log2 } = fakeSupervisor(liveDir, { proxyUrl: `http://127.0.0.1:${live}` });
    await s2.ensure();
    assert.ok(launchesOf(liveDir)[0].args.includes(`--proxy-server=http://127.0.0.1:${live}`));
    assert.ok(log2.lines.some((l) => l.includes(`proxy http://127.0.0.1:${live}`)), log2.lines.join("\n"));
  } finally {
    proxy.close();
  }
});

test("crash: 'down' fires once, next ensure() relaunches on the same port", async () => {
  const dir = tmpProfile("fake-crash");
  const { sup } = fakeSupervisor(dir);
  const first = await sup.ensure();
  const downs = [];
  sup.on("down", (reason) => downs.push(reason));
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  const [reason] = await down;
  assert.match(reason, /cdp disconnected|exited/);
  assert.strictEqual(sup.isUp(), false);
  const second = await sup.ensure();
  assert.notStrictEqual(second.pid, first.pid);
  assert.strictEqual(second.cdpUrl, first.cdpUrl, "auto port stays stable across relaunches");
  assert.ok(!isAlive(first.pid));
  await sleep(100);
  assert.strictEqual(downs.length, 1, `down fired ${downs.length}x: ${downs}`);
});

test("crash: a caller-chosen port is kept across relaunches too", async () => {
  const dir = tmpProfile("fake-port-kept");
  const port = await deadPort();
  const { sup } = fakeSupervisor(dir, { port });
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  await down;
  const second = await sup.ensure();
  assert.strictEqual(second.cdpUrl, `http://127.0.0.1:${port}`);
  assert.notStrictEqual(second.pid, first.pid);
});

test("crash: the port taken while Brave was down → ensure() fails loudly, never switches ports", async () => {
  // Upstream reads BROWSER_CDP_ENDPOINT_URL once per broker process, so a
  // relaunch on another port would leave every session pointing at nothing.
  const dir = tmpProfile("fake-port-stolen");
  const { sup } = fakeSupervisor(dir, { portFreeWaitMs: 300 });
  const first = await sup.ensure();
  const port = Number(new URL(first.cdpUrl).port);
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  await down;
  await waitFor(() => !isAlive(first.pid), 5000, "fake to die");
  const thief = net.createServer((sock) => sock.destroy()); // never leave a client hanging (close() waits for open sockets)
  await listen(thief, port);
  const fatals = [];
  sup.on("fatal", (reason) => fatals.push(reason));
  try {
    await assert.rejects(sup.ensure(), (e) => e.message.includes(`CDP port ${port}`) && /in use/.test(e.message) && /not switch/.test(e.message));
    assert.strictEqual(launchesOf(dir).length, 1, "must not spawn onto a taken port");
    // 'fatal' tells the broker to exit so the shims respawn one on a new port.
    assert.strictEqual(fatals.length, 1);
    assert.ok(fatals[0].includes(`CDP port ${port}`), fatals[0]);
  } finally {
    await new Promise((r) => thief.close(r));
  }
  const again = await sup.ensure();
  assert.strictEqual(again.cdpUrl, first.cdpUrl, "same port once it is free again");
});

test("'fatal': a throwing listener is logged, ensure() still rejects with the port error", async () => {
  const dir = tmpProfile("fake-fatal-listener");
  const { sup, log } = fakeSupervisor(dir, { portFreeWaitMs: 200 });
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  await down;
  await waitFor(() => !isAlive(first.pid), 5000, "fake to die");
  const thief = net.createServer((sock) => sock.destroy()); // never leave a client hanging (close() waits for open sockets)
  await listen(thief, Number(new URL(first.cdpUrl).port));
  sup.on("fatal", () => { throw new Error("fatal listener bug"); });
  try {
    await assert.rejects(sup.ensure(), /not switch/);
    assert.ok(log.lines.some((l) => l.includes("fatal listener bug")), log.lines.join("\n"));
  } finally {
    await new Promise((r) => thief.close(r));
  }
});

test("crash: relaunch waits for the port to free (up to portFreeWaitMs) instead of failing at once", async () => {
  const dir = tmpProfile("fake-port-wait");
  const { sup } = fakeSupervisor(dir, { portFreeWaitMs: 3000 });
  sup.on("fatal", () => assert.fail("a port that frees in time is not fatal"));
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  await down;
  await waitFor(() => !isAlive(first.pid), 5000, "fake to die");
  const holder = net.createServer((sock) => sock.destroy());
  await listen(holder, Number(new URL(first.cdpUrl).port));
  setTimeout(() => holder.close(), 500);
  const second = await sup.ensure();
  assert.strictEqual(second.cdpUrl, first.cdpUrl);
});

test("a 'down' listener that throws does not break close or relaunch", async () => {
  const dir = tmpProfile("fake-bad-listener");
  const { sup, log } = fakeSupervisor(dir);
  sup.on("down", () => { throw new Error("listener bug"); });
  const later = [];
  sup.on("down", (r) => later.push(r)); // e.g. SessionRegistry.invalidateAll, registered after a buggy one
  const first = await sup.ensure();
  const res = await sup.closeGracefully();
  assert.strictEqual(res.graceful, true);
  assert.deepStrictEqual(later, ["closed"], "a throwing listener must not starve the ones after it");
  const second = await sup.ensure();
  assert.notStrictEqual(second.pid, first.pid);
  assert.ok(log.lines.some((l) => l.includes("listener bug")), log.lines.join("\n"));
});

test("an auto port is only pinned once a launch came up: failed launches may move it, no 'fatal'", async () => {
  const dir = tmpProfile("fake-autopin");
  const { sup } = fakeSupervisor(dir, { mode: "exit-early", portFreeWaitMs: 200 });
  sup.on("fatal", () => assert.fail("nobody can have pinned a port that never served a Brave"));
  await assert.rejects(sup.ensure(), /exited during launch/);
  const usedPort = Number(launchesOf(dir)[0].args.find((a) => a.startsWith("--remote-debugging-port=")).split("=")[1]);
  const holder = net.createServer((sock) => sock.destroy());
  await listen(holder, usedPort);
  try {
    await assert.rejects(sup.ensure(), /exited during launch/, "should have re-picked a free port and launched");
    assert.strictEqual(launchesOf(dir).length, 2);
  } finally {
    holder.close();
  }
});

test("relaunch: the port is (re)checked right before spawn, so a port taken mid-launch fails loudly", async () => {
  // The proxy probe (non-routable address) holds the launch for ~800 ms between
  // the start of ensure() and the spawn; the port is stolen inside that window.
  const dir = tmpProfile("fake-toctou");
  const { sup } = fakeSupervisor(dir, { proxyUrl: "http://10.255.255.1:8888", proxyProbeTimeoutMs: 800, portFreeWaitMs: 200, launchTimeoutMs: 2000 });
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  await down;
  await waitFor(() => !isAlive(first.pid), 5000, "fake to die");
  const relaunch = sup.ensure();
  await sleep(200);
  const thief = net.createServer((sock) => sock.destroy()); // never leave a client hanging (close() waits for open sockets)
  await listen(thief, Number(new URL(first.cdpUrl).port));
  try {
    await assert.rejects(relaunch, /not switch/);
    assert.strictEqual(launchesOf(dir).length, 1, "must not spawn onto the stolen port");
  } finally {
    await new Promise((r) => thief.close(r));
  }
});

test("isUp() is false as soon as the PID is gone, even before any event arrives", async () => {
  const dir = tmpProfile("fake-isup");
  const { sup } = fakeSupervisor(dir);
  const { pid } = await sup.ensure();
  process.kill(pid);
  await waitFor(() => !isAlive(pid), 5000, "fake to die");
  assert.strictEqual(sup.isUp(), false);
});

test("disconnect: relaunch waits for the old PID to exit first (else Brave hands off and exits)", async () => {
  const dir = tmpProfile("fake-linger");
  let oldPid = null;
  let oldAliveAtSpawn = null;
  const { sup } = fakeSupervisor(dir, {
    mode: "linger",
    onSpawn: () => { if (oldPid) oldAliveAtSpawn = isAlive(oldPid); },
  });
  const first = await sup.ensure();
  oldPid = first.pid;
  const down = nextEvent(sup, "down");
  const cdp = await openCdp(first.cdpUrl);
  cdp.send("Fake.drop").catch(() => {});
  const [reason] = await down;
  assert.strictEqual(reason, "cdp disconnected");
  assert.ok(isAlive(oldPid), "fake lingers 1.5 s after the drop");
  const second = await sup.ensure();
  assert.strictEqual(oldAliveAtSpawn, false, "spawned while the old Brave was still running");
  assert.ok(isAlive(second.pid));
});

test("closeGracefully() on a Brave that dropped CDP but is still exiting lets it finish (no kill)", async () => {
  const dir = tmpProfile("fake-close-linger");
  const { sup, log } = fakeSupervisor(dir, { mode: "linger" });
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  const cdp = await openCdp(first.cdpUrl);
  cdp.send("Fake.drop").catch(() => {});
  await down;
  const res = await sup.closeGracefully();
  assert.strictEqual(res.graceful, true, log.lines.join("\n"));
  assert.ok(!isAlive(first.pid));
  assert.ok(!log.lines.some((l) => /kill/i.test(l)), log.lines.join("\n"));
});

test("disconnect: an old Brave that never exits is killed after exitWaitMs, then relaunched", async () => {
  const dir = tmpProfile("fake-hang");
  const { sup, log } = fakeSupervisor(dir, { mode: "hang", exitWaitMs: 300 });
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  const cdp = await openCdp(first.cdpUrl);
  cdp.send("Fake.drop").catch(() => {});
  await down;
  const second = await sup.ensure();
  assert.ok(!isAlive(first.pid), "hung Brave must be killed");
  assert.ok(isAlive(second.pid));
  assert.ok(log.lines.some((l) => /kill/i.test(l)), log.lines.join("\n"));
});

test("disconnect: the hung PID is reaped even if nobody calls ensure() again", async () => {
  const dir = tmpProfile("fake-reap");
  const { sup } = fakeSupervisor(dir, { mode: "hang", exitWaitMs: 300 });
  const first = await sup.ensure();
  const cdp = await openCdp(first.cdpUrl);
  cdp.send("Fake.drop").catch(() => {});
  await waitFor(() => !isAlive(first.pid), 5000, "hung fake to be reaped");
});

test("closeGracefully(): Browser.close, process exits, 'down'('closed'), next ensure() relaunches", async () => {
  const dir = tmpProfile("fake-close");
  const { sup } = fakeSupervisor(dir);
  const first = await sup.ensure();
  const downs = [];
  sup.on("down", (r) => downs.push(r));
  const res = await sup.closeGracefully();
  assert.strictEqual(res.graceful, true);
  assert.strictEqual(typeof res.ms, "number");
  assert.ok(!isAlive(first.pid));
  assert.strictEqual(sup.isUp(), false);
  assert.deepStrictEqual(downs, ["closed"]);
  const second = await sup.ensure();
  assert.notStrictEqual(second.pid, first.pid);
  assert.strictEqual(second.cdpUrl, first.cdpUrl, "idle close → relaunch keeps the port");
});

test("closeGracefully(): Brave ignoring Browser.close is killed after closeTimeoutMs", async () => {
  const dir = tmpProfile("fake-ignore-close");
  const { sup, log } = fakeSupervisor(dir, { mode: "ignore-close", closeTimeoutMs: 400 });
  const { pid } = await sup.ensure();
  const t0 = Date.now();
  const res = await sup.closeGracefully();
  assert.strictEqual(res.graceful, false);
  assert.ok(Date.now() - t0 >= 400);
  assert.ok(!isAlive(pid));
  assert.ok(log.lines.some((l) => /kill/i.test(l)), log.lines.join("\n"));
});

test("closeGracefully(): nothing running → null; concurrent calls share one close", async () => {
  const dir = tmpProfile("fake-close-idle");
  const { sup } = fakeSupervisor(dir);
  assert.strictEqual(await sup.closeGracefully(), null);
  await sup.ensure();
  const [a, b] = await Promise.all([sup.closeGracefully(), sup.closeGracefully()]);
  assert.strictEqual(a, b);
});

test("ensure() during closeGracefully() waits for the close, then relaunches", async () => {
  const dir = tmpProfile("fake-close-race");
  let oldPid = null;
  let oldAliveAtSpawn = null;
  const { sup } = fakeSupervisor(dir, { onSpawn: () => { if (oldPid) oldAliveAtSpawn = isAlive(oldPid); } });
  oldPid = (await sup.ensure()).pid;
  const closing = sup.closeGracefully();
  const next = await sup.ensure();
  await closing;
  assert.strictEqual(oldAliveAtSpawn, false);
  assert.notStrictEqual(next.pid, oldPid);
  assert.strictEqual(sup.isUp(), true);
});

test("launch failure: a Brave that exits during launch (profile handoff) rejects, and the next ensure() retries", async () => {
  const dir = tmpProfile("fake-exit-early");
  const { sup } = fakeSupervisor(dir, { mode: "exit-early" });
  sup.on("down", () => assert.fail("'down' must not fire for a launch that never came up"));
  await assert.rejects(sup.ensure(), (e) => /exited during launch/.test(e.message) && e.message.includes(path.resolve(dir)));
  await assert.rejects(sup.ensure(), /exited during launch/);
  assert.strictEqual(launchesOf(dir).length, 2);
  assert.strictEqual(sup.isUp(), false);
});

test("launch failure: a missing executable rejects with a clear error", async () => {
  const sup = new BraveSupervisor({ profileDir: tmpProfile("fake-enoent"), executablePath: path.join(TMP_ROOT, "no-such-brave.exe"), log: collectLog() });
  supervisors.push(sup);
  await assert.rejects(sup.ensure(), /could not start .*no-such-brave/);
  assert.strictEqual(sup.isUp(), false);
});

test("launch failure: CDP never comes up → rejects after launchTimeoutMs and kills the process", async () => {
  const dir = tmpProfile("fake-no-cdp");
  const { sup } = fakeSupervisor(dir, { mode: "no-cdp", launchTimeoutMs: 500 });
  sup.on("down", () => assert.fail("'down' must not fire for a launch that never came up"));
  await assert.rejects(sup.ensure(), /not ready/);
  const [{ pid }] = launchesOf(dir);
  await waitFor(() => !isAlive(pid), 5000, "no-cdp fake to be killed");
});

test("launch failure: CDP answered by a different browser process → rejects, ours is killed", async () => {
  const dir = tmpProfile("fake-foreign");
  const { sup } = fakeSupervisor(dir, { mode: "foreign-pid" });
  sup.on("down", () => assert.fail("'down' must not fire for a launch that never came up"));
  await assert.rejects(sup.ensure(), /pid/i);
  const [{ pid }] = launchesOf(dir);
  await waitFor(() => !isAlive(pid), 5000, "foreign-pid fake to be killed");
});

// ─────────────── C. real Brave (throwaway profiles) ───────────────

let SYSTEM_BRAVE = null;
try { SYSTEM_BRAVE = detectBravePath(); } catch { /* tests below skip */ }
const REAL = { skip: SYSTEM_BRAVE ? false : "Brave is not installed", timeout: 60000 };

/** Processes whose command line contains `needle`: [{pid, cmd}]. */
function processesMatching(needle) {
  let rows;
  if (process.platform === "win32") {
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('" +
      needle.replace(/'/g, "''") + "') } | ForEach-Object { '' + $_.ProcessId + '|' + $_.CommandLine }";
    rows = execFileSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 30000, maxBuffer: 16 << 20 });
  } else {
    rows = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).replace(/^\s*(\d+)\s+/gm, "$1|");
  }
  return rows.split(/\r?\n/).filter((l) => l.includes(needle)).map((l) => {
    const i = l.indexOf("|");
    return { pid: Number(l.slice(0, i)), cmd: l.slice(i + 1) };
  }).filter((r) => r.pid !== process.pid);
}
/** Brave's browser (main) processes for one profile: no --type=. */
function browserMains(profileDir) {
  return processesMatching(path.basename(profileDir)).filter((r) => r.cmd.includes(RUN_ID) && !/--type=/.test(r.cmd));
}
/** Root-only hard kill (TerminateProcess on Windows): Brave's children exit within ~300 ms on their own. */
function hardKill(pid) {
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

function realSupervisor(profileDir, { onSpawn = null, ...opts } = {}) {
  const log = collectLog();
  const sup = new BraveSupervisor({ profileDir, log, _spawn: recordingSpawn({ onSpawn }), ...opts });
  supervisors.push(sup);
  return { sup, log };
}

test("real Brave: the spawned PID is the browser and stays up (AutoDeElevate off), exact flags, dead proxy → direct", REAL, async (t) => {
  const dir = tmpProfile("real-launch");
  const { sup, log } = realSupervisor(dir, { proxyUrl: `http://127.0.0.1:${await deadPort()}` });
  const t0 = Date.now();
  const { cdpUrl, pid } = await sup.ensure();
  t.diagnostic(`cold launch → CDP ready + pid verified in ${Date.now() - t0} ms`);
  await sleep(1500); // the de-elevation handoff exits the spawned PID within ~150-750 ms
  assert.ok(isAlive(pid), "spawned PID exited: AutoDeElevate handoff?");
  assert.ok(sup.isUp());
  const mains = browserMains(dir);
  assert.deepStrictEqual(mains.map((m) => m.pid), [pid], "exactly one browser process, and it is ours");
  const port = Number(new URL(cdpUrl).port);
  for (const flag of buildBraveArgs({ port, profileDir: path.resolve(dir) })) {
    assert.ok(mains[0].cmd.includes(flag), `live command line lacks ${flag}`);
  }
  assert.ok(!mains[0].cmd.includes("--proxy-server"), "dead proxy must not be used");
  assert.ok(log.lines.some((l) => /direct/.test(l)));
  const v = await (await fetch(`${cdpUrl}/json/version`)).json();
  assert.match(v.Browser, /Chrome|Brave/);
});

test("real Brave: concurrent ensure() → one launch, one Brave on the profile", REAL, async () => {
  const dir = tmpProfile("real-coalesce");
  let spawns = 0;
  const { sup } = realSupervisor(dir, { onSpawn: () => spawns++ });
  const results = await Promise.all([1, 2, 3].map(() => sup.ensure()));
  assert.strictEqual(new Set(results.map((r) => r.pid)).size, 1);
  assert.strictEqual(spawns, 1);
  await sleep(1000);
  assert.deepStrictEqual(browserMains(dir).map((m) => m.pid), [results[0].pid]);
});

test("real Brave: crash → 'down' → next ensure() recovers on the same cdpUrl", REAL, async (t) => {
  const dir = tmpProfile("real-crash");
  const { sup } = realSupervisor(dir);
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  const t0 = Date.now();
  hardKill(first.pid);
  const [reason] = await down;
  const tDown = Date.now() - t0;
  const second = await sup.ensure();
  t.diagnostic(`crash (hard kill) → 'down'(${reason}) +${tDown} ms → ensure() recovered +${Date.now() - t0} ms`);
  assert.notStrictEqual(second.pid, first.pid);
  assert.strictEqual(second.cdpUrl, first.cdpUrl);
  assert.ok(!isAlive(first.pid));
  await sleep(1000);
  assert.ok(isAlive(second.pid), "relaunched Brave exited (handoff to the dying one?)");
  assert.deepStrictEqual(browserMains(dir).map((m) => m.pid), [second.pid]);
  const v = await (await fetch(`${second.cdpUrl}/json/version`)).json();
  assert.ok(v.webSocketDebuggerUrl);
});

test("real Brave: graceful close keeps a cookie set 2 s before close (spike E7a)", REAL, async (t) => {
  const dir = tmpProfile("real-cookie");
  const { sup } = realSupervisor(dir);
  const first = await sup.ensure();
  const cdp = await openCdp(first.cdpUrl);
  await cdp.send("Storage.setCookies", {
    cookies: [{ name: "w2c_e7a", value: "graceful-2s", domain: "bmr-w2c.example", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 }],
  });
  await cdp.close();
  await sleep(2000); // Chromium commits cookies to disk only every ~30 s: a hard kill here loses it
  const res = await sup.closeGracefully();
  t.diagnostic(`graceful close (Browser.close → exit) took ${res.ms} ms`);
  assert.strictEqual(res.graceful, true);
  const again = await sup.ensure();
  assert.strictEqual(again.cdpUrl, first.cdpUrl, "relaunch after an idle close keeps the port");
  const cdp2 = await openCdp(again.cdpUrl);
  const { cookies } = await cdp2.send("Storage.getCookies");
  await cdp2.close();
  assert.ok(cookies.some((c) => c.name === "w2c_e7a" && c.value === "graceful-2s"), `cookie lost; have: ${cookies.map((c) => c.name)}`);
});

test("real Brave: after a root-only hard kill, the immediate relaunch still reads the persisted cookies", REAL, async () => {
  // Kill is root-only; the old network-service child may outlive the root by
  // up to ~300 ms while the relaunch opens Default/Network/Cookies.
  const dir = tmpProfile("real-kill-cookies");
  const { sup } = realSupervisor(dir);
  const cdp = await openCdp((await sup.ensure()).cdpUrl);
  await cdp.send("Storage.setCookies", {
    cookies: [{ name: "w2c_kill", value: "persisted", domain: "bmr-w2c.example", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 }],
  });
  await cdp.close();
  assert.strictEqual((await sup.closeGracefully()).graceful, true); // now on disk
  const second = await sup.ensure();
  const down = nextEvent(sup, "down");
  hardKill(second.pid);
  await down;
  const cdp2 = await openCdp((await sup.ensure()).cdpUrl);
  const { cookies } = await cdp2.send("Storage.getCookies");
  await cdp2.close();
  assert.ok(cookies.some((c) => c.name === "w2c_kill" && c.value === "persisted"), `cookie store unreadable after relaunch; have: ${cookies.map((c) => c.name)}`);
});

test("real Brave: --load-extension loads an unpacked MV3 extension", REAL, async () => {
  const extDir = tmpProfile("real-ext-src");
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "bmr-w2c probe", version: "1.0", background: { service_worker: "bmr-w2c-probe-sw.js" },
  }));
  fs.writeFileSync(path.join(extDir, "bmr-w2c-probe-sw.js"), "self.addEventListener('install', () => {});\n");
  const { sup } = realSupervisor(tmpProfile("real-ext"), { extensionPath: extDir });
  const cdp = await openCdp((await sup.ensure()).cdpUrl);
  try {
    await waitFor(async () => {
      const { targetInfos } = await cdp.send("Target.getTargets");
      return targetInfos.some((x) => x.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/bmr-w2c-probe-sw\.js$/.test(x.url));
    }, 15000, "the probe extension's service worker");
  } finally {
    await cdp.close();
  }
});

test("real Brave: Memory Saver reads OFF in chrome://settings even when the profile had it ON", REAL, async () => {
  const dir = tmpProfile("real-memsaver");
  fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({ performance_tuning: { high_efficiency_mode: { state: 2 } } }));
  const { sup } = realSupervisor(dir);
  const cdp = await openCdp((await sup.ensure()).cdpUrl);
  try {
    // One background window (the only one these tests open).
    const { targetId } = await cdp.send("Target.createTarget", { url: "chrome://settings/performance", newWindow: true, background: true });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    let value;
    await waitFor(async () => {
      try {
        const r = await cdp.send("Runtime.evaluate", {
          expression: "typeof chrome !== 'undefined' && chrome.settingsPrivate ? new Promise((r) => chrome.settingsPrivate.getPref('performance_tuning.high_efficiency_mode.state', (p) => r(p ? p.value : 'missing'))) : null",
          awaitPromise: true,
          returnByValue: true,
        }, sessionId);
        value = r.result.value;
        return value !== null && value !== undefined;
      } catch {
        return false; // page still navigating
      }
    }, 15000, "chrome.settingsPrivate on chrome://settings");
    await cdp.send("Target.closeTarget", { targetId });
    assert.strictEqual(value, 0, `Memory Saver state as Brave reports it: ${value}`);
  } finally {
    await cdp.close();
  }
});

// ─────────────── no orphans ───────────────

async function shutDownEverything() {
  await Promise.all(supervisors.map((s) => s.closeGracefully().catch(() => {})));
  for (const child of spawnedChildren) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { hardKill(child.pid); } catch { /* already gone */ }
    }
  }
  await waitFor(() => spawnedChildren.every((c) => !c.pid || c.exitCode !== null || c.signalCode !== null), 15000, "recorded children to exit");
}

test("no Brave or fake-brave process outlives the tests", { timeout: 60000 }, async () => {
  await shutDownEverything();
  let left = [];
  await waitFor(() => (left = processesMatching(RUN_ID)).length === 0, 10000, "processes on the run's profiles to exit")
    .catch(() => {});
  assert.deepStrictEqual(left.map((r) => `${r.pid} ${r.cmd.slice(0, 160)}`), []);
});

test.after(async () => {
  // Safety net if a test failed mid-way. RUN_ID is unique to this run, so it
  // can only match processes this run started (Brave children included).
  await shutDownEverything().catch(() => {});
  for (const r of processesMatching(RUN_ID)) {
    try { hardKill(r.pid); } catch { /* already gone */ }
  }
  fs.rmSync(TMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  try { fs.rmdirSync(path.dirname(TMP_ROOT)); } catch { /* not empty: another run */ }
});
