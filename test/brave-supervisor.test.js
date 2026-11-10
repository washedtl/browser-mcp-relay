// brave-supervisor.test.js — W2C broker Brave supervisor.
//
// Three layers:
//   A. pure helpers (flags, Memory Saver pref, proxy probe, env) — no browser
//   B. the supervisor state machine against test/fixtures/fake-brave.js, a
//      tiny node stand-in that speaks just enough CDP over the fd 3/4 pipe
//      (Browser.getVersion, Browser.close, SystemInfo.getProcessInfo) to drive
//      the branches real Brave can't be made to hit on demand (ignores
//      Browser.close, lingers after a disconnect, hands off and exits)
//   C. real Brave on throwaway profiles (skips cleanly when Brave is absent):
//      crash → recovery, concurrent ensure() → one Brave, graceful close keeps
//      a fresh cookie (the spike's E7a), --load-extension, Memory Saver.
//
// Every profile lives under <repo>/.tmp-profiles/<run id>/; Brave runs on a
// pipe (no port), real-Brave clients connect through a CdpProxy on an
// OS-assigned port. The after() hook kills only PIDs this file recorded,
// then asserts no process references the run dir.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const WebSocket = require("ws");
const { detectBravePath } = require("../src/detect-browser.js");
const { removeDir } = require("./fixtures/remove-dir.js");

const {
  BraveSupervisor,
  buildBraveArgs,
  disableMemorySaver,
  resolveProxy,
  isLoopbackHost,
  braveEnv,
  profileLockHeld,
} = require("../src/broker/brave-supervisor.js");
const { CdpProxy } = require("../src/broker/cdp-proxy.js");

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

test("buildBraveArgs: exactly the broker's flag set, nothing else", () => {
  const args = buildBraveArgs({ profileDir: "C:\\p\\broker" });
  assert.deepStrictEqual(args, [
    "--remote-debugging-pipe",
    "--user-data-dir=C:\\p\\broker",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-startup-window",
    "--do-not-de-elevate",
    "--disable-features=AutoDeElevate,CalculateNativeWinOcclusion",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
  ]);
});

test("W2G buildBraveArgs: CDP over a pipe, never a TCP debugging port (any local process could drive Brave through one)", () => {
  for (const args of [buildBraveArgs({ profileDir: "/p" }), buildBraveArgs({ profileDir: "/p", extensionPath: "/e", proxyServer: "http://h:1", headless: true })]) {
    assert.ok(args.includes("--remote-debugging-pipe"), args.join(" "));
    assert.ok(!args.some((a) => /^--remote-debugging-(port|address)/.test(a)), args.join(" "));
    // elevated parent: without it Brave relaunches de-elevated and the pipe is gone (measured: exit 0 at 393 ms)
    assert.ok(args.includes("--do-not-de-elevate"), "the switch Brave 157 still honours");
    assert.ok(args.some((a) => /^--disable-features=.*\bAutoDeElevate\b/.test(a)), "and the feature older builds use");
  }
});

test("buildBraveArgs: never Playwright's --enable-automation / --use-mock-keychain, never a URL", () => {
  const args = buildBraveArgs({ profileDir: "/p", extensionPath: "/ext", proxyServer: "http://127.0.0.1:8888" });
  assert.ok(!args.includes("--enable-automation"));
  assert.ok(!args.includes("--use-mock-keychain"));
  assert.ok(args.every((a) => a.startsWith("--")), "a positional URL would open a startup window");
});

test("buildBraveArgs: one --disable-features switch only (a second one silently drops AutoDeElevate)", () => {
  const args = buildBraveArgs({ profileDir: "/p", extensionPath: "/ext", proxyServer: "http://h:1" });
  assert.strictEqual(args.filter((a) => a.startsWith("--disable-features=")).length, 1);
});

test("buildBraveArgs: --load-extension and --proxy-server only when given", () => {
  const plain = buildBraveArgs({ profileDir: "/p" });
  assert.ok(!plain.some((a) => a.startsWith("--load-extension") || a.startsWith("--proxy-server")));
  const extra = buildBraveArgs({ profileDir: "/p", extensionPath: "C:\\ext\\companion", proxyServer: "http://127.0.0.1:8888" });
  assert.ok(extra.includes("--load-extension=C:\\ext\\companion"));
  assert.ok(extra.includes("--proxy-server=http://127.0.0.1:8888"));
});

// ── W2E: TLS secure by default; opt-in or a proxy in use turns certificate checks off ──

function cdpCallsOf(profileDir, method) {
  const f = path.join(profileDir, "fake-cdp.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((c) => c.method === method);
}
const IGNORE_CERTS = "Security.setIgnoreCertificateErrors";

test("W2E TLS: by default (no proxy, no opt-in) certificates stay verified (set explicitly per launch)", async () => {
  const dir = tmpProfile("fake-tls-default");
  const { sup, log } = fakeSupervisor(dir);
  await sup.ensure();
  assert.deepStrictEqual(cdpCallsOf(dir, IGNORE_CERTS).map((c) => c.params), [{ ignore: false }]);
  assert.ok(!log.lines.some((l) => /certificate/i.test(l)), log.lines.join("\n"));
});

test("W2E TLS: ignoreHttpsErrors (BROWSER_RELAY_IGNORE_HTTPS_ERRORS) → ignored after every launch, relaunches too; logged once", async () => {
  const dir = tmpProfile("fake-tls-optin");
  const { sup, log } = fakeSupervisor(dir, { ignoreHttpsErrors: true });
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  await down;
  const second = await sup.ensure();
  assert.notStrictEqual(second.pid, first.pid);
  assert.deepStrictEqual(cdpCallsOf(dir, IGNORE_CERTS).map((c) => [c.pid, c.params]), [[first.pid, { ignore: true }], [second.pid, { ignore: true }]]);
  assert.strictEqual(log.lines.filter((l) => /certificate errors are ignored/.test(l)).length, 1, log.lines.join("\n"));
  assert.ok(log.lines.some((l) => /BROWSER_RELAY_IGNORE_HTTPS_ERRORS/.test(l)));
});

test("W2E TLS: a REMOTE proxy (kept while unreachable, or reachable) never turns checks off: verified", async () => {
  const dir = tmpProfile("fake-tls-proxy-remote");
  const { sup, log } = fakeSupervisor(dir, { proxyUrl: "http://10.255.255.1:8080", proxyProbeTimeoutMs: 300 });
  await sup.ensure();
  assert.ok(launchesOf(dir)[0].args.includes("--proxy-server=http://10.255.255.1:8080"), "the remote proxy is in use");
  assert.deepStrictEqual(cdpCallsOf(dir, IGNORE_CERTS).map((c) => c.params), [{ ignore: false }]);
  assert.ok(!log.lines.some((l) => /certificate errors are ignored/.test(l)));
});

test("W2E TLS: a relaunch re-sets the checks: a loopback proxy that went down → launched direct, checks back on", async () => {
  const dir = tmpProfile("fake-tls-relaunch");
  const proxy = net.createServer((sock) => sock.destroy());
  const live = await listen(proxy);
  const { sup } = fakeSupervisor(dir, { proxyUrl: `http://127.0.0.1:${live}` });
  const first = await sup.ensure();
  await new Promise((r) => proxy.close(r));
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  await down;
  const second = await sup.ensure();
  assert.deepStrictEqual(cdpCallsOf(dir, IGNORE_CERTS).map((c) => [c.pid, c.params]), [[first.pid, { ignore: true }], [second.pid, { ignore: false }]]);
});

test("W2E TLS: a LOOPBACK proxy in use → ignored (its MITM certificate works); a dead loopback proxy (launched direct) → verified", async () => {
  const deadDir = tmpProfile("fake-tls-proxy-dead");
  const { sup: s1 } = fakeSupervisor(deadDir, { proxyUrl: `http://127.0.0.1:${await deadPort()}` });
  await s1.ensure();
  assert.deepStrictEqual(cdpCallsOf(deadDir, IGNORE_CERTS).map((c) => c.params), [{ ignore: false }]);

  const proxy = net.createServer((sock) => sock.destroy());
  const live = await listen(proxy);
  try {
    const liveDir = tmpProfile("fake-tls-proxy-live");
    const { sup: s2, log } = fakeSupervisor(liveDir, { proxyUrl: `http://127.0.0.1:${live}` });
    await s2.ensure();
    assert.deepStrictEqual(cdpCallsOf(liveDir, IGNORE_CERTS).map((c) => c.params), [{ ignore: true }]);
    assert.ok(log.lines.some((l) => /certificate errors are ignored/.test(l) && l.includes(`127.0.0.1:${live}`)), log.lines.join("\n"));
  } finally {
    proxy.close();
  }
});

test("W2E buildBraveArgs: --headless=new only when asked (BROWSER_HEADLESS_ENABLE, as in legacy mode)", () => {
  assert.ok(!buildBraveArgs({ profileDir: "/p" }).some((a) => a.startsWith("--headless")));
  const args = buildBraveArgs({ profileDir: "/p", headless: true });
  assert.deepStrictEqual(args.filter((a) => a.startsWith("--headless")), ["--headless=new"]);
});

test("W2E ensure(): the headless option reaches the launch", async () => {
  const dir = tmpProfile("fake-headless");
  const { sup } = fakeSupervisor(dir, { headless: true });
  await sup.ensure();
  assert.deepStrictEqual(launchesOf(dir)[0].args, buildBraveArgs({ profileDir: path.resolve(dir), headless: true }));
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

test("isLoopbackHost: 127.0.0.0/8, localhost (+ subdomains, trailing dot), ::1 — nothing else (W1E policy)", () => {
  for (const h of ["127.0.0.1", "127.5.6.7", "localhost", "LOCALHOST.", "proxy.localhost", "::1"]) assert.ok(isLoopbackHost(h), h);
  for (const h of ["10.255.255.1", "128.0.0.1", "0.0.0.0", "example.com", "127.example.com", "::2", "192.168.1.5"]) assert.ok(!isLoopbackHost(h), h);
});

test("resolveProxy: no proxy configured → null, no warning", async () => {
  const log = collectLog();
  assert.strictEqual(await resolveProxy(null, { log }), null);
  assert.strictEqual(await resolveProxy("", { log }), null);
  assert.deepStrictEqual(log.lines, []);
});

test("resolveProxy: proxy accepting TCP → its server string", async () => {
  const s = net.createServer((sock) => sock.destroy());
  const port = await listen(s);
  try {
    const noCreds = { server: `http://127.0.0.1:${port}`, credentials: null };
    assert.deepStrictEqual(await resolveProxy(`http://127.0.0.1:${port}`, { log: collectLog() }), noCreds);
    assert.deepStrictEqual(await resolveProxy(`127.0.0.1:${port}`, { log: collectLog() }), noCreds, "bare host:port means http");
    assert.deepStrictEqual(await resolveProxy(`socks5://127.0.0.1:${port}/`, { log: collectLog() }), { server: `socks5://127.0.0.1:${port}`, credentials: null });
  } finally {
    s.close();
  }
});

test("resolveProxy: LOOPBACK proxy not listening → direct (null) + warning, decided within ~1.5 s", async () => {
  const port = await deadPort();
  for (const url of [`http://127.0.0.1:${port}`, `http://localhost:${port}`]) {
    const log = collectLog();
    const t0 = Date.now();
    assert.strictEqual(await resolveProxy(url, { log }), null, url);
    const ms = Date.now() - t0;
    assert.ok(ms < 2500, `probe took ${ms} ms`);
    assert.ok(log.lines.some((l) => /proxy/i.test(l) && /direct/i.test(l)), log.lines.join("\n"));
  }
});

test("resolveProxy: REMOTE proxy unreachable or slow → KEPT (never silently direct) + loud warning", async () => {
  // 10.255.255.1 is non-routable: connect() neither succeeds nor fails fast.
  // Going direct here would expose the real IP (e.g. to PX-protected sites).
  const log = collectLog();
  const t0 = Date.now();
  const res = await resolveProxy("http://10.255.255.1:8080", { log, timeoutMs: 300 });
  assert.ok(Date.now() - t0 < 1500, "probe must still be cut off at the timeout");
  assert.deepStrictEqual(res, { server: "http://10.255.255.1:8080", credentials: null });
  assert.ok(log.lines.some((l) => /WARNING/.test(l) && /NOT reachable/.test(l) && /keeping/i.test(l)), log.lines.join("\n"));
  assert.ok(!log.lines.some((l) => /launching Brave direct/i.test(l)), log.lines.join("\n"));
});

test("resolveProxy: credentials are split off (decoded) and no log line carries them", async () => {
  const s = net.createServer((sock) => sock.destroy());
  const port = await listen(s);
  const dead = await deadPort();
  try {
    let log = collectLog();
    assert.deepStrictEqual(
      await resolveProxy(`http://us%40er:p%3Asecret@127.0.0.1:${port}`, { log }),
      { server: `http://127.0.0.1:${port}`, credentials: { username: "us@er", password: "p:secret" } },
    );
    // Every logging branch: reachable, loopback-dead, remote-unreachable.
    for (const url of [`http://user:secret@127.0.0.1:${port}`, `http://user:secret@127.0.0.1:${dead}`, "http://user:secret@10.255.255.1:8080"]) {
      log = collectLog();
      await resolveProxy(url, { log, timeoutMs: 300 });
      assert.ok(!log.lines.some((l) => l.includes("secret") || l.includes("user:")), `${url} → ${log.lines}`);
    }
  } finally {
    s.close();
  }
});

test("resolveProxy: unusable URL → throws (W1E policy: never guess direct), message never echoes it", async () => {
  for (const bad of ["ftp://127.0.0.1:21", "http://", "::::", "ftp://user:secret@127.0.0.1:21", "htp://user:secret@h:1", "http://us%zzer:secret@h:1"]) {
    const log = collectLog();
    await assert.rejects(resolveProxy(bad, { log }), (e) => {
      assert.ok(/proxy/i.test(e.message), e.message);
      assert.ok(!e.message.includes("secret") && !e.message.includes("user:secret"), `echoed: ${e.message}`);
      return true;
    }, bad);
    assert.ok(!log.lines.some((l) => l.includes("secret")), `password logged for ${bad}: ${log.lines}`);
  }
});

test("braveEnv: strips relay-internal, proxy and CDP-endpoint env vars (the broker's secret URL), keeps the rest", () => {
  const env = braveEnv({
    PATH: "/bin",
    LOCALAPPDATA: "C:\\L",
    BROWSER_RELAY_PROXY_URL: "http://x:1",
    BROWSER_RELAY_INSPECTOR_PORT: "9",
    BROWSER_CDP_ENDPOINT_URL: `ws://127.0.0.1:1/${"a".repeat(64)}/devtools/browser`,
    browser_cdp_endpoint_url: "ws://127.0.0.1:1/x", // Windows env names ignore case
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
const proxies = [];

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

/** Minimal CDP client on a browser websocket (the broker's proxy URL: there is no /json/version). */
async function openCdp(wsUrl) {
  const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
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
    if (onSpawn) onSpawn(args, opts);
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
  const pipes = []; // every 'pipe' the supervisor handed out (one per launch that came up)
  sup.on("pipe", (p) => pipes.push(p));
  return { sup, log, pipes };
}
/** A CDP disconnect while the process stays up (fake-brave's Fake.drop), on the latest launch's pipe. */
function dropCdp(pipes) {
  pipes[pipes.length - 1].call("Fake.drop", null, { timeoutMs: 500 });
}
function launchesOf(profileDir) {
  const f = path.join(profileDir, "fake-launches.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

test("constructor: profileDir is required", () => {
  assert.throws(() => new BraveSupervisor({}), /profileDir/);
  assert.doesNotThrow(() => new BraveSupervisor({ profileDir: "/p" }));
});

test("W2G ensure(): launches with the exact flags, CDP on fd 3/4 pipes, returns {pid}; the verified pipe is handed out first", async () => {
  const dir = tmpProfile("fake-ensure");
  let spawnOpts = null;
  const { sup, pipes } = fakeSupervisor(dir, { extensionPath: "C:\\ext\\companion", onSpawn: (_args, opts) => { spawnOpts = opts; } });
  assert.strictEqual(sup.isUp(), false);
  let pipesAtResolve = null;
  const info = await sup.ensure().then((i) => { pipesAtResolve = pipes.length; return i; });
  assert.deepStrictEqual(Object.keys(info), ["pid"], "no cdpUrl: there is no port");
  assert.ok(isAlive(info.pid));
  assert.strictEqual(sup.isUp(), true);
  const [launch] = launchesOf(dir);
  assert.strictEqual(launch.pid, info.pid, "pid is the spawned process");
  assert.deepStrictEqual(launch.args, buildBraveArgs({ profileDir: path.resolve(dir), extensionPath: "C:\\ext\\companion" }));
  // fd 3: Brave reads (we write), fd 4: Brave writes; stderr ignored (an unread pipe would stall Brave)
  assert.deepStrictEqual(spawnOpts.stdio, ["ignore", "ignore", "ignore", "pipe", "pipe"]);
  assert.strictEqual(pipesAtResolve, 1, "'pipe' fires before ensure() resolves (the proxy serves it from then on)");
  const v = await pipes[0].call("Browser.getVersion");
  assert.match(v.result.product, /FakeBrave/);
  // readiness, the PID check and the certificate policy all ran on the pipe's root session
  assert.deepStrictEqual(cdpCallsOf(dir, "SystemInfo.getProcessInfo").length, 1);
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

test("W2G ensure(): a call while a launch is finishing (CDP up, certificate policy pending) joins it and resolves only after 'pipe'", async () => {
  // isUp() is already true in that window, but the proxy has no pipe yet: a
  // caller handed a Brave then would get 503 from the proxy.
  const dir = tmpProfile("fake-slow-certs");
  const { sup, pipes } = fakeSupervisor(dir, { mode: "slow-certs" });
  const first = sup.ensure();
  await waitFor(() => cdpCallsOf(dir, IGNORE_CERTS).length === 1, 10000, "the certificate call to be in flight");
  let pipesWhenSecondResolved = null;
  const second = await sup.ensure().then((info) => { pipesWhenSecondResolved = pipes.length; return info; });
  assert.strictEqual(pipesWhenSecondResolved, 1, "resolved before the launch handed its pipe out");
  assert.strictEqual(second.pid, (await first).pid);
  assert.strictEqual(launchesOf(dir).length, 1);
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

test("ensure(): unreachable REMOTE proxy is kept on the command line; credentials never are, but are exposed", async () => {
  const dir = tmpProfile("fake-proxy-remote");
  const { sup, log } = fakeSupervisor(dir, { proxyUrl: "http://bob:hunter2@10.255.255.1:8080", proxyProbeTimeoutMs: 300 });
  assert.strictEqual(sup.proxyCredentials, null, "nothing before a launch");
  await sup.ensure();
  const { args } = launchesOf(dir)[0];
  assert.ok(args.includes("--proxy-server=http://10.255.255.1:8080"), args.join(" "));
  assert.ok(!args.some((a) => a.includes("hunter2") || a.includes("bob")), "credentials on Brave's command line");
  assert.deepStrictEqual(sup.proxyCredentials, { username: "bob", password: "hunter2" });
  assert.ok(!log.lines.some((l) => l.includes("hunter2") || l.includes("bob")), log.lines.join("\n"));
  assert.ok(log.lines.some((l) => /NOT reachable/.test(l)), log.lines.join("\n"));
});

test("ensure(): proxyCredentials is null without a proxy, and when a dead loopback proxy sent Brave direct", async () => {
  const { sup: plain } = fakeSupervisor(tmpProfile("fake-nocreds"));
  await plain.ensure();
  assert.strictEqual(plain.proxyCredentials, null);
  const { sup: direct } = fakeSupervisor(tmpProfile("fake-creds-direct"), { proxyUrl: `http://u:p@127.0.0.1:${await deadPort()}` });
  await direct.ensure();
  assert.strictEqual(direct.proxyCredentials, null);
});

test("ensure(): an unusable proxy URL fails the launch (no guessing direct), nothing spawned", async () => {
  const dir = tmpProfile("fake-proxy-bad");
  const { sup } = fakeSupervisor(dir, { proxyUrl: "ftp://user:secret@127.0.0.1:21" });
  await assert.rejects(sup.ensure(), (e) => /proxy/i.test(e.message) && !e.message.includes("secret"));
  assert.strictEqual(launchesOf(dir).length, 0);
});

test("ensure() that joined a launch closeGracefully() then tears down → relaunches, returns a live Brave", async () => {
  const dir = tmpProfile("fake-join-close");
  const { sup } = fakeSupervisor(dir, { delay: 300 });
  const joined = sup.ensure(); // launch in flight
  const closing = sup.closeGracefully(); // queued behind that launch, then closes it
  const info = await joined;
  await closing;
  const launches = launchesOf(dir);
  assert.strictEqual(launches.length, 2, "the torn-down launch plus a relaunch");
  assert.strictEqual(info.pid, launches[1].pid, "must return the relaunched Brave");
  assert.ok(isAlive(info.pid));
  assert.ok(sup.isUp());
});

test("crash: 'down' fires once, the dead launch's pipe is closed, next ensure() relaunches and hands out a new pipe", async () => {
  const dir = tmpProfile("fake-crash");
  const { sup, pipes } = fakeSupervisor(dir);
  const first = await sup.ensure();
  const downs = [];
  sup.on("down", (reason) => downs.push(reason));
  const down = nextEvent(sup, "down");
  process.kill(first.pid);
  const [reason] = await down;
  assert.match(reason, /cdp disconnected|exited/);
  assert.strictEqual(sup.isUp(), false);
  assert.strictEqual(pipes[0].closed, true);
  const second = await sup.ensure();
  assert.notStrictEqual(second.pid, first.pid);
  assert.strictEqual(pipes.length, 2);
  assert.match((await pipes[1].call("Browser.getVersion")).result.product, /FakeBrave/);
  assert.ok(!isAlive(first.pid));
  await sleep(100);
  assert.strictEqual(downs.length, 1, `down fired ${downs.length}x: ${downs}`);
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

test("isUp() is false as soon as the PID is gone, even before any event arrives", async () => {
  const dir = tmpProfile("fake-isup");
  const { sup } = fakeSupervisor(dir);
  const { pid } = await sup.ensure();
  process.kill(pid);
  await waitFor(() => !isAlive(pid), 5000, "fake to die");
  assert.strictEqual(sup.isUp(), false);
});

test("W2E checkAlive(): a PID gone before its exit/disconnect is processed → 'down' at once, exactly once", async () => {
  const dir = tmpProfile("fake-checkalive");
  const { sup, log } = fakeSupervisor(dir);
  const { pid } = await sup.ensure();
  assert.strictEqual(sup.checkAlive(), true, "a live Brave: nothing happens");
  assert.strictEqual(sup.pid, pid);
  const downs = [];
  sup.on("down", (r) => downs.push(r));
  // kill and wait for the PID to die synchronously: no event can be processed in between
  process.kill(pid, "SIGKILL");
  for (const until = Date.now() + 5000; isAlive(pid) && Date.now() < until;) { /* spin */ }
  assert.strictEqual(isAlive(pid), false);
  assert.strictEqual(sup.checkAlive(), false);
  assert.strictEqual(sup.pid, null);
  assert.deepStrictEqual(downs, ["exited (pid gone)"], "'down' fired synchronously");
  await sleep(500); // the exit and the CDP close arrive now: no second 'down'
  assert.deepStrictEqual(downs, ["exited (pid gone)"]);
  assert.strictEqual(log.lines.filter((l) => / down: /.test(l)).length, 1, "one log line");
  const again = await sup.ensure();
  assert.notStrictEqual(again.pid, pid, "the next ensure() relaunches");
});

test("disconnect: relaunch waits for the old PID to exit first (else Brave hands off and exits)", async () => {
  const dir = tmpProfile("fake-linger");
  let oldPid = null;
  let oldAliveAtSpawn = null;
  const { sup, pipes } = fakeSupervisor(dir, {
    mode: "linger",
    onSpawn: () => { if (oldPid) oldAliveAtSpawn = isAlive(oldPid); },
  });
  const first = await sup.ensure();
  oldPid = first.pid;
  const down = nextEvent(sup, "down");
  dropCdp(pipes);
  const [reason] = await down;
  assert.strictEqual(reason, "cdp disconnected");
  assert.ok(isAlive(oldPid), "fake lingers 1.5 s after the drop");
  const second = await sup.ensure();
  assert.strictEqual(oldAliveAtSpawn, false, "spawned while the old Brave was still running");
  assert.ok(isAlive(second.pid));
});

test("closeGracefully() on a Brave that dropped CDP but is still exiting lets it finish (no kill)", async () => {
  const dir = tmpProfile("fake-close-linger");
  const { sup, log, pipes } = fakeSupervisor(dir, { mode: "linger" });
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  dropCdp(pipes);
  await down;
  const res = await sup.closeGracefully();
  assert.strictEqual(res.graceful, true, log.lines.join("\n"));
  assert.ok(!isAlive(first.pid));
  assert.ok(!log.lines.some((l) => /kill/i.test(l)), log.lines.join("\n"));
});

test("disconnect: an old Brave that never exits is killed after exitWaitMs, then relaunched", async () => {
  const dir = tmpProfile("fake-hang");
  const { sup, log, pipes } = fakeSupervisor(dir, { mode: "hang", exitWaitMs: 300 });
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  dropCdp(pipes);
  await down;
  const second = await sup.ensure();
  assert.ok(!isAlive(first.pid), "hung Brave must be killed");
  assert.ok(isAlive(second.pid));
  assert.ok(log.lines.some((l) => /kill/i.test(l)), log.lines.join("\n"));
});

test("disconnect: the hung PID is reaped even if nobody calls ensure() again", async () => {
  const dir = tmpProfile("fake-reap");
  const { sup, pipes } = fakeSupervisor(dir, { mode: "hang", exitWaitMs: 300 });
  const first = await sup.ensure();
  dropCdp(pipes);
  await waitFor(() => !isAlive(first.pid), 5000, "hung fake to be reaped");
});

test("closeGracefully(): Browser.close on the root pipe, process exits, 'down'('closed'), next ensure() relaunches", async () => {
  const dir = tmpProfile("fake-close");
  const { sup, pipes } = fakeSupervisor(dir);
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
  assert.deepStrictEqual(cdpCallsOf(dir, "Browser.close").map((c) => c.pid), [first.pid]);
  assert.strictEqual(pipes.length, 2, "the relaunch hands out its own pipe");
});

test("closeGracefully(): Brave ignoring Browser.close (CDP still open) is killed after closeTimeoutMs, no shutdown grace", async () => {
  const dir = tmpProfile("fake-ignore-close");
  const { sup, log } = fakeSupervisor(dir, { mode: "ignore-close", closeTimeoutMs: 400, shutdownGraceMs: 30000 });
  const { pid } = await sup.ensure();
  const t0 = Date.now();
  const res = await sup.closeGracefully();
  assert.strictEqual(res.graceful, false);
  assert.ok(Date.now() - t0 >= 400);
  assert.ok(Date.now() - t0 < 15000, `took ${Date.now() - t0} ms: the grace is only for a Brave that accepted the close`);
  assert.ok(!isAlive(pid));
  assert.ok(log.lines.some((l) => /kill/i.test(l)), log.lines.join("\n"));
  assert.ok(!log.lines.some((l) => /accepted the close/.test(l)), log.lines.join("\n"));
});

test("W2P closeGracefully(): a Brave that accepted the close (dropped CDP) but shuts down slowly gets shutdownGraceMs, not a kill", async () => {
  const dir = tmpProfile("fake-slow-close");
  const { sup, log } = fakeSupervisor(dir, { mode: "slow-close", closeTimeoutMs: 300, shutdownGraceMs: 15000 });
  const { pid } = await sup.ensure();
  const res = await sup.closeGracefully();
  assert.strictEqual(res.graceful, true, log.lines.join("\n"));
  assert.ok(res.ms >= 1000, `closed in ${res.ms} ms, before the fake's 1200 ms shutdown`);
  assert.ok(!isAlive(pid));
  assert.ok(log.lines.some((l) => /accepted the close but is still shutting down after 300 ms/.test(l)), log.lines.join("\n"));
  assert.ok(!log.lines.some((l) => /killing it/.test(l)), log.lines.join("\n"));
});

test("W2P closeGracefully(): a Brave that accepted the close but never exits is killed after closeTimeoutMs + shutdownGraceMs", async () => {
  const dir = tmpProfile("fake-close-hang");
  const { sup, log } = fakeSupervisor(dir, { mode: "close-hang", closeTimeoutMs: 300, shutdownGraceMs: 400 });
  const { pid } = await sup.ensure();
  const res = await sup.closeGracefully();
  assert.strictEqual(res.graceful, false);
  assert.ok(res.ms >= 700, `killed after ${res.ms} ms`);
  assert.ok(!isAlive(pid));
  assert.ok(log.lines.some((l) => /still running \d+ ms after close was requested; killing it/.test(l)), log.lines.join("\n"));
});

// ── W2P: a Brave this supervisor did not start, on its profile ──

test("W2P stray Brave: profile lock not held → no process listing, launch as usual", async () => {
  const dir = tmpProfile("fake-no-stray");
  let listed = 0;
  const { sup } = fakeSupervisor(dir, { _strays: { lockHeld: () => false, find: async () => { listed++; return []; } } });
  await sup.ensure();
  assert.strictEqual(listed, 0);
  assert.strictEqual(sup.isUp(), true);
});

test("W2P stray Brave on our profile: only the PIDs on it are killed, and the launch waits for its lock to free", async () => {
  const dir = tmpProfile("fake-stray");
  const killed = [];
  const lookups = [];
  let held = true;
  let heldAtSpawn = null;
  const { sup, log } = fakeSupervisor(dir, {
    onSpawn: () => { heldAtSpawn = held; },
    _strays: {
      lockHeld: () => held,
      find: async (profileDir, exeName) => { lookups.push({ profileDir, exeName }); return [101, 102]; },
      kill: (pid) => {
        killed.push(pid);
        if (pid === 102) throw Object.assign(new Error("gone"), { code: "ESRCH" }); // exited meanwhile: fine
        setTimeout(() => { held = false; }, 300);
      },
    },
  });
  await sup.ensure();
  assert.deepStrictEqual(killed, [101, 102]);
  assert.deepStrictEqual(lookups, [{ profileDir: path.resolve(dir), exeName: "fake-brave" }]);
  assert.strictEqual(heldAtSpawn, false, "launched only once the stray's lock was gone");
  assert.ok(log.lines.some((l) => /is in use by Brave pid\(s\) 101, 102, not started by this broker; killing them/.test(l)), log.lines.join("\n"));
  assert.ok(!log.lines.some((l) => /could not kill/.test(l)), log.lines.join("\n"));
});

test("W2P stray Brave: a profile still locked after the reap fails the launch clearly; nothing is spawned", async () => {
  const dir = tmpProfile("fake-stray-stuck");
  let spawned = 0;
  let lookups = 0;
  const { sup } = fakeSupervisor(dir, {
    strayExitWaitMs: 300,
    launchRetryMs: 1,
    onSpawn: () => spawned++,
    _strays: { lockHeld: () => true, find: async () => { lookups++; return []; }, kill: () => assert.fail("nothing matched, so nothing is killed") },
  });
  await assert.rejects(sup.ensure(), /still locked by another browser \(and no process has exactly this --user-data-dir\); not launching on it/);
  assert.strictEqual(spawned, 0);
  assert.strictEqual(lookups, 1, "a locked profile is not retried");
});

test("W2P profileLockHeld (Windows rule): no lockfile, or one no process holds open, is not a lock", () => {
  const dir = tmpProfile("lock-win");
  assert.strictEqual(profileLockHeld(dir, "win32"), false);
  fs.writeFileSync(path.join(dir, "lockfile"), "");
  assert.strictEqual(profileLockHeld(dir, "win32"), false);
  assert.strictEqual(profileLockHeld(path.join(dir, "missing"), "win32"), false);
});

test("W2P profileLockHeld (POSIX rule): SingletonLock → <this host>-<live pid> is held; a dead pid or another host is stale", (t) => {
  const dir = tmpProfile("lock-posix");
  const link = path.join(dir, "SingletonLock");
  const point = (target) => {
    try { fs.unlinkSync(link); } catch { /* none yet */ }
    fs.symlinkSync(target, link);
  };
  try {
    point(`${os.hostname()}-${process.pid}`);
  } catch (e) {
    t.skip(`symlinks can't be created here (${e.code})`);
    return;
  }
  assert.strictEqual(profileLockHeld(dir, "linux"), true);
  point(`${os.hostname()}-2147483646`);
  assert.strictEqual(profileLockHeld(dir, "linux"), false, "dead pid: a crash left it");
  point(`another-host-${process.pid}`);
  assert.strictEqual(profileLockHeld(dir, "linux"), false, "another host's lock (shared home dir)");
  fs.unlinkSync(link);
  assert.strictEqual(profileLockHeld(dir, "linux"), false);
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

test("heartbeat: a Brave that stops answering (hung; pid and pipe alive) is killed, and the next ensure() relaunches it", async () => {
  const dir = tmpProfile("fake-silent");
  const { sup, log, pipes } = fakeSupervisor(dir, { heartbeatEveryMs: 20, heartbeatTimeoutMs: 40 });
  const { pid } = await sup.ensure();
  const down = nextEvent(sup, "down");
  pipes[0].call("Fake.silent", null, { timeoutMs: 100 });
  await down;
  await waitFor(() => !isAlive(pid), 5000, "the hung fake to be killed");
  assert.ok(log.lines.some((l) => new RegExp(`brave pid=${pid} has not answered CDP .*killing it`).test(l)), log.lines.join("\n"));
  assert.notStrictEqual((await sup.ensure()).pid, pid);
});

test("heartbeat: a Brave that answers is left alone, and pings stop with a close", async () => {
  const dir = tmpProfile("fake-heartbeat-ok");
  const { sup, log } = fakeSupervisor(dir, { heartbeatEveryMs: 20, heartbeatTimeoutMs: 200 });
  const { pid } = await sup.ensure();
  const pingsOf = () => cdpCallsOf(dir, "Browser.getVersion").length;
  await waitFor(() => pingsOf() >= 4, 5000, "a few pings");
  assert.strictEqual(sup.pid, pid);
  assert.ok(!log.lines.some((l) => /has not answered/.test(l)), log.lines.join("\n"));
  await sup.closeGracefully();
  const atClose = pingsOf();
  await sleep(150);
  assert.strictEqual(pingsOf(), atClose);
});

test("heartbeat: a ping in flight during a close isn't mistaken for a hung Brave", async () => {
  const dir = tmpProfile("fake-heartbeat-close");
  const { sup, log } = fakeSupervisor(dir, { heartbeatEveryMs: 1, heartbeatTimeoutMs: 200 });
  await sup.ensure();
  await sleep(50); // pings back to back, so one is on the wire when the close lands
  await sup.closeGracefully();
  await sleep(100);
  assert.ok(!log.lines.some((l) => /has not answered/.test(l)), log.lines.join("\n"));
});

test("launch failure: a Brave that keeps exiting during launch rejects after 3 attempts, and the next ensure() tries again", async () => {
  const dir = tmpProfile("fake-exit-early");
  const { sup, log } = fakeSupervisor(dir, { mode: "exit-early", launchRetryMs: 1 });
  let downs = 0; // counted: a listener that throws is caught by _emitSafe
  sup.on("down", () => downs++);
  await assert.rejects(sup.ensure(), (e) => /exited during launch/.test(e.message) && e.message.includes(`Nothing holds ${path.resolve(dir)} now`));
  assert.strictEqual(launchesOf(dir).length, 3);
  await assert.rejects(sup.ensure(), /exited during launch/);
  assert.strictEqual(launchesOf(dir).length, 6);
  assert.strictEqual(sup.isUp(), false);
  assert.strictEqual(downs, 0, "'down' must not fire for a launch that never came up");
  assert.strictEqual(log.lines.filter((l) => /launch attempt \d of 3 failed: .*exited during launch \(code=0\)/.test(l)).length, 6, log.lines.join("\n"));
});

test("launch retry: a Brave that exits during launch is relaunched, and the caller just gets the Brave", async () => {
  const dir = tmpProfile("fake-exit-once");
  const { sup, log, pipes } = fakeSupervisor(dir, { mode: "exit-early-once", launchRetryMs: 1 });
  let downs = 0;
  sup.on("down", () => downs++);
  const { pid } = await sup.ensure();
  assert.strictEqual(sup.isUp(), true);
  assert.strictEqual(downs, 0, "'down' must not fire for a launch that never came up");
  assert.deepStrictEqual(launchesOf(dir).map((l) => l.pid).slice(1), [pid]);
  assert.strictEqual(pipes.length, 1, "only the launch that came up goes to the proxy");
  assert.ok(log.lines.some((l) => /launch attempt 1 of 3 failed: .*exited during launch \(code=0\)/.test(l)), log.lines.join("\n"));
});

test("launch retry: a Brave that closes its CDP pipe during launch but keeps running is killed and relaunched", async () => {
  const dir = tmpProfile("fake-pipe-close-once");
  const { sup, log, pipes } = fakeSupervisor(dir, { mode: "pipe-close-once", launchRetryMs: 1 });
  let downs = 0;
  sup.on("down", () => downs++);
  const { pid } = await sup.ensure();
  assert.strictEqual(downs, 0, "'down' must not fire for a launch that never came up");
  const [first, second] = launchesOf(dir);
  assert.strictEqual(second.pid, pid);
  assert.strictEqual(pipes.length, 1, "only the launch that came up goes to the proxy");
  await waitFor(() => !isAlive(first.pid), 5000, "the pipe-closed fake to be killed");
  assert.ok(log.lines.some((l) => /launch attempt 1 of 3 failed: .*closed its CDP pipe during launch/.test(l)), log.lines.join("\n"));
});

test("launch retry: a Brave that goes away at the PID check is relaunched", async () => {
  const dir = tmpProfile("fake-exit-pid-check");
  const { sup, log, pipes } = fakeSupervisor(dir, { mode: "exit-at-pid-check-once", launchRetryMs: 1 });
  let downs = 0;
  sup.on("down", () => downs++);
  const { pid } = await sup.ensure();
  assert.strictEqual(downs, 0, "'down' must not fire for a launch that never came up");
  assert.strictEqual(launchesOf(dir)[1].pid, pid);
  assert.strictEqual(pipes.length, 1, "only the launch that came up goes to the proxy");
  assert.ok(log.lines.some((l) => /launch attempt 1 of 3 failed: .*went away during launch/.test(l)), log.lines.join("\n"));
});

test("launch retry: a Brave holding the profile after the early exit is named in the log and reaped before the relaunch", async () => {
  const dir = tmpProfile("fake-exit-stray");
  const kills = [];
  let held = false;
  const { sup, log } = fakeSupervisor(dir, {
    mode: "exit-early-once",
    launchRetryMs: 1,
    onSpawn: () => { if (!kills.length) held = true; },
    _strays: { lockHeld: () => held, find: async () => [4242], kill: (pid) => { kills.push(pid); held = false; } },
  });
  await sup.ensure();
  assert.deepStrictEqual(kills, [4242]);
  assert.strictEqual(launchesOf(dir).length, 2);
  assert.ok(log.lines.some((l) => l.includes(`${path.resolve(dir)} was still locked when it exited`)), log.lines.join("\n"));
});

test("launch failure: a missing executable rejects with a clear error, once (a relaunch can't fix it) and logged", async () => {
  const log = collectLog();
  const sup = new BraveSupervisor({ profileDir: tmpProfile("fake-enoent"), executablePath: path.join(TMP_ROOT, "no-such-brave.exe"), log, launchRetryMs: 1 });
  supervisors.push(sup);
  await assert.rejects(sup.ensure(), /could not start .*no-such-brave/);
  assert.strictEqual(sup.isUp(), false);
  const attempts = log.lines.filter((l) => /launch attempt/.test(l));
  assert.strictEqual(attempts.length, 1, attempts.join("\n"));
  assert.match(attempts[0], /^launch attempt 1 of 3 failed: .*could not start/);
});

test("launch failure: CDP never comes up → rejects after launchTimeoutMs and kills the process", async () => {
  const dir = tmpProfile("fake-no-cdp");
  const before = spawnedChildren.length;
  const { sup } = fakeSupervisor(dir, { mode: "no-cdp", launchTimeoutMs: 500, launchRetryMs: 1 });
  sup.on("down", () => assert.fail("'down' must not fire for a launch that never came up"));
  await assert.rejects(sup.ensure(), /not ready/);
  // The spawn we recorded, not the fake's own launch record: on a loaded
  // machine the fake can be killed at 500 ms before it has written one.
  const [child, retried] = spawnedChildren.slice(before);
  assert.strictEqual(retried, undefined, "a Brave that hung (it did not go away) is not relaunched");
  await waitFor(() => child.exitCode !== null || child.signalCode !== null, 5000, "no-cdp fake to be killed");
});

test("launch failure: CDP answered by a different browser process → rejects, ours is killed", async () => {
  const dir = tmpProfile("fake-foreign");
  const { sup, pipes } = fakeSupervisor(dir, { mode: "foreign-pid" });
  sup.on("down", () => assert.fail("'down' must not fire for a launch that never came up"));
  await assert.rejects(sup.ensure(), /pid/i);
  assert.strictEqual(pipes.length, 0, "a browser that is not ours is never handed to the proxy");
  assert.strictEqual(launchesOf(dir).length, 1, "a PID mismatch is not retried");
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

/** A real-Brave supervisor wired to a CdpProxy, as the broker wires them: CDP clients use proxy.wsUrl. */
async function realSupervisor(profileDir, { onSpawn = null, ...opts } = {}) {
  const log = collectLog();
  const sup = new BraveSupervisor({ profileDir, log, _spawn: recordingSpawn({ onSpawn }), ...opts });
  supervisors.push(sup);
  const proxy = new CdpProxy({ log });
  await proxy.listen();
  proxies.push(proxy);
  sup.on("pipe", (pipe) => proxy.setPipe(pipe));
  return { sup, log, proxy };
}
async function browserVersion(wsUrl) {
  const cdp = await openCdp(wsUrl);
  try {
    return await cdp.send("Browser.getVersion");
  } finally {
    await cdp.close();
  }
}

test("real Brave: the spawned PID is the browser and stays up (AutoDeElevate off), exact flags, dead proxy → direct", REAL, async (t) => {
  const dir = tmpProfile("real-launch");
  const { sup, log, proxy } = await realSupervisor(dir, { proxyUrl: `http://127.0.0.1:${await deadPort()}` });
  const t0 = Date.now();
  const { pid } = await sup.ensure();
  t.diagnostic(`cold launch → CDP ready + pid verified in ${Date.now() - t0} ms`);
  await sleep(1500); // the de-elevation handoff exits the spawned PID within ~150-750 ms
  assert.ok(isAlive(pid), "spawned PID exited: AutoDeElevate handoff?");
  assert.ok(sup.isUp());
  const mains = browserMains(dir);
  assert.deepStrictEqual(mains.map((m) => m.pid), [pid], "exactly one browser process, and it is ours");
  for (const flag of buildBraveArgs({ profileDir: path.resolve(dir) })) {
    assert.ok(mains[0].cmd.includes(flag), `live command line lacks ${flag}`);
  }
  assert.ok(!mains[0].cmd.includes("--proxy-server"), "dead proxy must not be used");
  assert.ok(log.lines.some((l) => /direct/.test(l)));
  const v = await browserVersion(proxy.wsUrl);
  assert.match(v.product, /Chrome|Brave/);
});

test("W2E real Brave: a self-signed HTTPS page fails by default and loads with certificate errors ignored", REAL, async () => {
  const https = require("node:https");
  const { chromium } = require("playwright-core");
  const tls = { key: fs.readFileSync(path.join(__dirname, "fixtures", "tls-localhost.key")), cert: fs.readFileSync(path.join(__dirname, "fixtures", "tls-localhost.crt")) };
  const server = https.createServer(tls, (req, res) => { res.setHeader("Content-Type", "text/html"); res.end("<title>tls-ok</title>tls-ok"); });
  const port = await listen(server);
  try {
    for (const ignoreHttpsErrors of [false, true]) {
      const dir = tmpProfile(`real-tls-${ignoreHttpsErrors}`);
      const { sup, proxy } = await realSupervisor(dir, { ignoreHttpsErrors, headless: true });
      await sup.ensure();
      const browser = await chromium.connectOverCDP(proxy.wsUrl);
      try {
        const page = await browser.contexts()[0].newPage();
        const outcome = await page.goto(`https://127.0.0.1:${port}/`, { timeout: 15000 }).then(() => page.title(), (e) => e.message);
        if (ignoreHttpsErrors) assert.strictEqual(outcome, "tls-ok");
        else assert.match(outcome, /ERR_CERT/);
      } finally {
        await browser.close().catch(() => {});
        await sup.closeGracefully();
      }
    }
  } finally {
    server.close();
  }
});

test("real Brave: concurrent ensure() → one launch, one Brave on the profile", REAL, async () => {
  const dir = tmpProfile("real-coalesce");
  let spawns = 0;
  const { sup } = await realSupervisor(dir, { onSpawn: () => spawns++ });
  const results = await Promise.all([1, 2, 3].map(() => sup.ensure()));
  assert.strictEqual(new Set(results.map((r) => r.pid)).size, 1);
  assert.strictEqual(spawns, 1);
  await sleep(1000);
  assert.deepStrictEqual(browserMains(dir).map((m) => m.pid), [results[0].pid]);
});

test("real Brave: crash → 'down' → next ensure() recovers, served behind the same proxy URL", REAL, async (t) => {
  const dir = tmpProfile("real-crash");
  const { sup, proxy } = await realSupervisor(dir);
  const first = await sup.ensure();
  const down = nextEvent(sup, "down");
  const t0 = Date.now();
  hardKill(first.pid);
  const [reason] = await down;
  const tDown = Date.now() - t0;
  const second = await sup.ensure();
  t.diagnostic(`crash (hard kill) → 'down'(${reason}) +${tDown} ms → ensure() recovered +${Date.now() - t0} ms`);
  assert.notStrictEqual(second.pid, first.pid);
  assert.ok(!isAlive(first.pid));
  await sleep(1000);
  assert.ok(isAlive(second.pid), "relaunched Brave exited (handoff to the dying one?)");
  assert.deepStrictEqual(browserMains(dir).map((m) => m.pid), [second.pid]);
  assert.match((await browserVersion(proxy.wsUrl)).product, /Chrome|Brave/);
});

test("real Brave: graceful close keeps a cookie set 2 s before close (spike E7a)", REAL, async (t) => {
  const dir = tmpProfile("real-cookie");
  const { sup, proxy } = await realSupervisor(dir);
  await sup.ensure();
  const cdp = await openCdp(proxy.wsUrl);
  await cdp.send("Storage.setCookies", {
    cookies: [{ name: "w2c_e7a", value: "graceful-2s", domain: "bmr-w2c.example", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 }],
  });
  await cdp.close();
  await sleep(2000); // Chromium commits cookies to disk only every ~30 s: a hard kill here loses it
  const res = await sup.closeGracefully();
  t.diagnostic(`graceful close (Browser.close → exit) took ${res.ms} ms`);
  assert.strictEqual(res.graceful, true);
  await sup.ensure();
  const cdp2 = await openCdp(proxy.wsUrl); // same URL after the relaunch
  const { cookies } = await cdp2.send("Storage.getCookies");
  await cdp2.close();
  assert.ok(cookies.some((c) => c.name === "w2c_e7a" && c.value === "graceful-2s"), `cookie lost; have: ${cookies.map((c) => c.name)}`);
});

test("real Brave: after a root-only hard kill, the immediate relaunch still reads the persisted cookies", REAL, async () => {
  // Kill is root-only; the old network-service child may outlive the root by
  // up to ~300 ms while the relaunch opens Default/Network/Cookies.
  const dir = tmpProfile("real-kill-cookies");
  const { sup, proxy } = await realSupervisor(dir);
  await sup.ensure();
  const cdp = await openCdp(proxy.wsUrl);
  await cdp.send("Storage.setCookies", {
    cookies: [{ name: "w2c_kill", value: "persisted", domain: "bmr-w2c.example", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 }],
  });
  await cdp.close();
  assert.strictEqual((await sup.closeGracefully()).graceful, true); // now on disk
  const second = await sup.ensure();
  const down = nextEvent(sup, "down");
  hardKill(second.pid);
  await down;
  await sup.ensure();
  const cdp2 = await openCdp(proxy.wsUrl);
  const { cookies } = await cdp2.send("Storage.getCookies");
  await cdp2.close();
  assert.ok(cookies.some((c) => c.name === "w2c_kill" && c.value === "persisted"), `cookie store unreadable after relaunch; have: ${cookies.map((c) => c.name)}`);
});

test("W2P real Brave: a Brave left on our profile is reaped before launch; one on a look-alike profile is not", REAL, async (t) => {
  const dir = tmpProfile("real-stray");
  const lookalike = `${dir}-2`; // our path is a prefix of its path: the matcher must be exact
  fs.mkdirSync(lookalike);
  const launchStray = async (profileDir) => {
    const child = recordingSpawn()(SYSTEM_BRAVE, buildBraveArgs({ profileDir, headless: true }), { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
    await waitFor(() => profileLockHeld(profileDir), 20000, `a Brave to hold ${profileDir}'s lockfile`);
    return child;
  };
  const stray = await launchStray(dir);
  const bystander = await launchStray(lookalike);
  t.after(() => hardKill(bystander.pid));
  const { sup, log } = await realSupervisor(dir, { headless: true });
  const info = await sup.ensure();
  assert.ok(log.lines.some((l) => /not started by this broker; killing them/.test(l)), log.lines.join("\n"));
  assert.ok(!isAlive(stray.pid), "the stray is gone");
  assert.notStrictEqual(info.pid, stray.pid);
  await sleep(1000);
  assert.ok(isAlive(info.pid), "our Brave exited (handed off to a stray?)");
  assert.ok(isAlive(bystander.pid), "a Brave on another profile was killed");
});

test("real Brave: --load-extension loads an unpacked MV3 extension", REAL, async () => {
  const extDir = tmpProfile("real-ext-src");
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "bmr-w2c probe", version: "1.0", background: { service_worker: "bmr-w2c-probe-sw.js" },
  }));
  fs.writeFileSync(path.join(extDir, "bmr-w2c-probe-sw.js"), "self.addEventListener('install', () => {});\n");
  const { sup, proxy } = await realSupervisor(tmpProfile("real-ext"), { extensionPath: extDir });
  await sup.ensure();
  const cdp = await openCdp(proxy.wsUrl);
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
  const { sup, proxy } = await realSupervisor(dir);
  await sup.ensure();
  const cdp = await openCdp(proxy.wsUrl);
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
  await Promise.all(proxies.map((p) => p.close().catch(() => {})));
  for (const child of spawnedChildren) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { hardKill(child.pid); } catch { /* already gone */ }
    }
  }
  await waitFor(() => spawnedChildren.every((c) => !c.pid || c.exitCode !== null || c.signalCode !== null), 15000, "recorded children to exit");
}

test("no Brave or fake-brave process outlives the tests", { timeout: 120000 }, async () => {
  await shutDownEverything();
  let left = [];
  // Brave's helpers exit on their own after the browser; on a loaded machine that took several seconds
  await waitFor(() => (left = processesMatching(RUN_ID)).length === 0, 30000, "processes on the run's profiles to exit")
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
  await removeDir(TMP_ROOT);
  try { fs.rmdirSync(path.dirname(TMP_ROOT)); } catch { /* not empty: another run */ }
});
