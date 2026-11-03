// e2e-broker.test.js — W2E end to end: real shims (`node src/index.js`,
// broker mode) → the real broker they start → a real Brave.
//
// Isolated from any real setup: a temp LOCALAPPDATA (broker key, log, work
// dir), a profile under .tmp-profiles (it exists up front, so nothing is
// seeded from a pool), a unique test pipe, OS-assigned ports, headless Brave
// (BMR_TEST_HEADFUL=1 shows the windows). Only processes this test caused
// are killed, by the PIDs the broker reports; none may remain at the end.
// Skipped without Windows + Brave.
//
// Prints the measured numbers (cold start, recoveries, 3-session memory).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawnSync, execFileSync } = require("node:child_process");

const { braveAvailable, headfulRequested, makeProfileDir, removeProfile } = require("./fixtures/temp-brave.js");

const SKIP = !braveAvailable() && "needs Windows + Brave";
const ENTRY = path.resolve(__dirname, "..", "src", "index.js");
const IDLE_EXIT_MS = 4000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

async function until(cond, ms, what) {
  const t0 = Date.now();
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(100);
  }
}

/** [{pid, name, privateMB, wsMB, cmd}] for processes whose command line contains `needle` or whose pid is listed. */
function processes({ needle = null, pids = [] }) {
  const where = [];
  if (needle) where.push(`($_.CommandLine -and $_.CommandLine.Contains('${needle.replace(/'/g, "''")}'))`);
  if (pids.length) where.push(`(@(${pids.join(",")}) -contains $_.ProcessId)`);
  const ps = `Get-CimInstance Win32_Process | Where-Object { ${where.join(" -or ")} } | ` +
    "ForEach-Object { '' + $_.ProcessId + '|' + $_.Name + '|' + $_.PrivatePageCount + '|' + $_.WorkingSetSize + '|' + $_.CommandLine }";
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 30000 });
  return (r.stdout || "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, name, priv, ws, ...cmd] = line.split("|");
    return { pid: Number(pid), name, privateMB: Number(priv) / 1048576, wsMB: Number(ws) / 1048576, cmd: cmd.join("|") };
  }).filter((p) => p.pid !== process.pid && !p.cmd.includes("Get-CimInstance Win32_Process")); // not this query's own shell
}

function killTree(pid) {
  try { execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
}

/** A local site: cookies, per-page titles, a fetch the stub tests intercept, localStorage. */
function startSite() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const html = (body) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(`<!doctype html><html><body>${body}</body></html>`); };
    if (url.pathname === "/set") {
      res.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": `e2e=${url.searchParams.get("v")}; Path=/` });
      res.end("<!doctype html><body>cookie set</body>");
    } else if (url.pathname === "/show") html(`cookie header: ${req.headers.cookie || "(none)"}`);
    else if (url.pathname.startsWith("/page/")) html(`page ${url.pathname.slice(6)}`);
    else if (url.pathname === "/fetch") html("<div id=out>pending</div><script>fetch('/api/ping').then(r=>r.text()).then(t=>{document.getElementById('out').textContent='ping='+t})</script>");
    else if (url.pathname === "/api/ping") { res.writeHead(200, { "Content-Type": "text/plain" }); res.end("real"); }
    else if (url.pathname === "/ls") html("<script>localStorage.setItem('origin', location.origin)</script>ls set");
    else { res.writeHead(404); res.end(); }
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("e2e broker: 3 real shims → one real broker → one real Brave", { skip: SKIP, timeout: 600_000 }, async (t) => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const { keyFileFor, loadOrCreateKey, brokerHome } = require("../src/broker/pipe-server.js");
  const { requestControl } = require("../src/broker/control.js");

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-e2e-"));
  const profileDir = makeProfileDir("e2e-broker");
  const runId = `bmr-test-e2e-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const pipe = `\\\\.\\pipe\\${runId}`;
  const env = {
    ...process.env,
    BROWSER_RELAY_MODE: "broker",
    LOCALAPPDATA: home,
    BROWSER_RELAY_BROKER_PIPE: pipe,
    BROWSER_RELAY_BROKER_PROFILE_DIR: profileDir,
    BROWSER_RELAY_BROKER_IDLE_EXIT_MS: String(IDLE_EXIT_MS),
    BROWSER_HEADLESS_ENABLE: headfulRequested() ? "false" : "true",
    BROWSER_RELAY_INSPECTOR_PORT: "", // never the developer's inspector
  };
  const key = loadOrCreateKey(keyFileFor(env));
  const brokerLog = () => {
    try { return fs.readFileSync(path.join(brokerHome(env), "broker.log"), "utf8").split("\n").slice(-40).join("\n"); } catch { return "(no broker log)"; }
  };
  const status = async () => {
    const r = await requestControl({ pipe, key, cmd: "status" });
    assert.ok(r.ok, JSON.stringify(r));
    return r.status;
  };
  const site = await startSite();
  const base = `http://127.0.0.1:${site.address().port}`;
  const numbers = {};
  const sessions = [];
  const seenPids = new Set(); // brokers + Braves this run caused

  async function openSession(name) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY], env, stderr: "pipe" });
    let stderr = "";
    const client = new Client({ name, version: "0" });
    const t0 = Date.now();
    await client.connect(transport);
    transport.stderr.on("data", (d) => { stderr += d; });
    const s = { name, client, transport, pid: transport.pid, ms: Date.now() - t0, stderr: () => stderr };
    sessions.push(s);
    return s;
  }
  const call = (s, name, args = {}) => s.client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
  async function textOfPage(s, args, want) {
    let last = "";
    await until(async () => {
      last = textOf(await call(s, "content_get-as-text", args));
      return want.test(last);
    }, 10_000, `${want} in ${s.name}'s page (last: ${last.slice(0, 200)})`);
    return last;
  }

  t.after(async () => {
    for (const s of sessions) await s.client.close().catch(() => {});
    site.close();
    // nothing this run started may survive: the broker idles out; anything left is killed by PID
    let left = [];
    try {
      left = await until(async () => {
        const procs = [...processes({ needle: runId }), ...processes({ needle: path.basename(profileDir) })];
        return procs.length === 0 ? [] : null;
      }, IDLE_EXIT_MS + 20_000, "the broker and Brave to exit");
    } catch {
      left = [...processes({ needle: runId }), ...processes({ needle: path.basename(profileDir) })];
      for (const p of left) killTree(p.pid);
    }
    await removeProfile(profileDir).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
    t.diagnostic(`measured: ${JSON.stringify(numbers)}`);
    assert.deepStrictEqual(left.map((p) => `${p.pid} ${p.name}`), [], "processes left running after the test (killed now)");
  });

  await t.test("3 sessions racing a cold start share one broker; tools work", async () => {
    const t0 = Date.now();
    const [a, b, c] = await Promise.all(["A", "B", "C"].map(openSession));
    numbers.coldInitializeMs = Date.now() - t0;
    numbers.perSessionInitializeMs = [a.ms, b.ms, c.ms];
    const brokers = processes({ needle: runId }).filter((p) => /node/i.test(p.name) && /main\.js/.test(p.cmd));
    assert.strictEqual(brokers.length, 1, `exactly one broker: ${JSON.stringify(brokers.map((p) => p.cmd))}\n${brokerLog()}`);
    const tools = (await a.client.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes("navigation_go-to") && tools.includes("tabs_new") && tools.includes("browser_show"), tools.join(","));
    const t1 = Date.now();
    const r = await call(a, "navigation_go-to", { url: `${base}/page/first` });
    numbers.coldFirstCallMs = Date.now() - t1;
    assert.ok(!r.isError, `${textOf(r)}\n${brokerLog()}`);
    const st = await status();
    assert.strictEqual(st.connections.length, 3);
    assert.ok(st.brave.up && st.brave.pid);
    seenPids.add(st.pid).add(st.brave.pid);
  });

  const [A, B, C] = [0, 1, 2].map((i) => () => sessions[i]);

  await t.test("a cookie set in session A is visible in session B (one profile)", async () => {
    assert.ok(!(await call(A(), "navigation_go-to", { url: `${base}/set?v=fromA` })).isError);
    assert.ok(!(await call(B(), "navigation_go-to", { url: `${base}/show` })).isError);
    await textOfPage(B(), {}, /e2e=fromA/);
  });

  await t.test("2 tabIds in one session: own windows, no cross-talk, main untouched", async () => {
    await call(C(), "navigation_go-to", { url: `${base}/page/main-of-C` });
    const tabIds = [];
    for (const id of ["t1", "t2"]) {
      const r = await call(C(), "tabs_new", { url: `${base}/page/${id}` });
      assert.ok(!r.isError, textOf(r));
      tabIds.push(JSON.parse(textOf(r)).tabId);
    }
    assert.strictEqual(new Set(tabIds).size, 2);
    await Promise.all(tabIds.map((tabId, i) => call(C(), "navigation_go-to", { url: `${base}/page/x${i + 1}`, tabId })));
    await textOfPage(C(), { tabId: tabIds[0] }, /page x1/);
    await textOfPage(C(), { tabId: tabIds[1] }, /page x2/);
    await textOfPage(C(), {}, /page main-of-C/);
    const st = await status();
    const conn = st.connections.find((x) => x.tabs.length === 3);
    assert.ok(conn, JSON.stringify(st.connections));
  });

  await t.test("stubs are per session", async () => {
    const r = await call(A(), "stub_mock-http-response", { pattern: "**/api/ping", response: { body: "mockA" } });
    assert.ok(!r.isError, textOf(r));
    await call(A(), "navigation_go-to", { url: `${base}/fetch` });
    await textOfPage(A(), {}, /ping=mockA/);
    await call(B(), "navigation_go-to", { url: `${base}/fetch` });
    await textOfPage(B(), {}, /ping=real/);
    assert.deepStrictEqual(JSON.parse(textOf(await call(B(), "stub_list"))).stubs, []);
  });

  await t.test("memory with 3 sessions (broker + Brave + shims), after navigation + 4 screenshots each", async () => {
    for (const s of sessions) {
      for (let i = 0; i < 4; i++) assert.ok(!(await call(s, "content_take-screenshot", {})).isError);
    }
    const st = await status();
    const procs = processes({ pids: [st.pid, ...sessions.map((s) => s.pid)], needle: path.basename(profileDir) });
    const sum = (list, k) => Math.round(list.reduce((a, p) => a + p[k], 0));
    const broker = procs.filter((p) => p.pid === st.pid);
    const shims = procs.filter((p) => sessions.some((s) => s.pid === p.pid));
    const brave = procs.filter((p) => /brave/i.test(p.name));
    numbers.memoryMB = {
      broker: { private: sum(broker, "privateMB"), ws: sum(broker, "wsMB") },
      brave: { private: sum(brave, "privateMB"), ws: sum(brave, "wsMB"), processes: brave.length },
      shims: { private: sum(shims, "privateMB"), ws: sum(shims, "wsMB"), each: shims.map((p) => Math.round(p.privateMB)) },
    };
    numbers.memoryMB.totalPrivate = numbers.memoryMB.broker.private + numbers.memoryMB.brave.private + numbers.memoryMB.shims.private;
    assert.strictEqual(shims.length, 3);
    assert.ok(brave.length > 0 && broker.length === 1);
  });

  await t.test("Brave crash → the next call recovers (with a reset notice)", async () => {
    const before = await status();
    killTree(before.brave.pid);
    await until(() => !pidAlive(before.brave.pid), 10_000, "Brave to die");
    const t0 = Date.now();
    const r = await call(A(), "navigation_go-to", { url: `${base}/page/after-crash` });
    numbers.braveCrashRecoveryMs = Date.now() - t0;
    assert.ok(!r.isError, `${textOf(r)}\n${brokerLog()}`);
    assert.match(textOf(r), /This tab was reset because/);
    await textOfPage(A(), {}, /page after-crash/);
    const after = await status();
    assert.ok(after.brave.up && after.brave.pid !== before.brave.pid);
    seenPids.add(after.brave.pid);
  });

  await t.test("broker killed → the shims start a new one and the next call works", async () => {
    const before = await status();
    killTree(before.pid); // its Brave goes with it (job object)
    await until(() => !pidAlive(before.pid), 10_000, "the broker to die");
    const t0 = Date.now();
    // a request the shim sent before it saw the connection drop is answered
    // "browser broker restarted; please retry the call" (W2A): retry, as an agent would
    let r;
    numbers.brokerKillRetries = 0;
    await until(async () => {
      try {
        r = await call(B(), "navigation_go-to", { url: `${base}/page/after-broker-kill` });
        return r;
      } catch (e) {
        if (!/restarted; please retry|unavailable/.test(e.message)) throw e;
        numbers.brokerKillRetries++;
        return null;
      }
    }, 60_000, "a call to succeed on the new broker");
    numbers.brokerKillRecoveryMs = Date.now() - t0;
    assert.ok(!r.isError, `${textOf(r)}\n${brokerLog()}`);
    await textOfPage(B(), {}, /page after-broker-kill/);
    const after = await status();
    assert.notStrictEqual(after.pid, before.pid);
    seenPids.add(after.pid).add(after.brave.pid);
    await until(async () => (await status()).connections.length === 3, 15_000, "all 3 shims to reconnect");
    assert.ok(!pidAlive(before.brave.pid), "the old broker's Brave died with it");
  });

  await t.test("idle exit: the broker and its Brave go once the last session closes", async () => {
    const st = await status();
    for (const s of sessions) await s.client.close();
    const t0 = Date.now();
    await until(() => !pidAlive(st.pid) && !pidAlive(st.brave.pid), IDLE_EXIT_MS + 20_000, "the broker + Brave to exit");
    numbers.idleExitMs = Date.now() - t0;
    assert.match(brokerLog(), /no connections for 4000 ms/);
    assert.match(brokerLog(), /closed gracefully/);
  });
});

test("legacy mode smoke: navigation, storage_get-local, tabs_new + tabId", {
  skip: SKIP || (require("../src/pool-shared.js").hasPoolWrapper && "a pool wrapper sits next to this repo: legacy mode would snapshot its real cookie source"),
  timeout: 180_000,
}, async (t) => {
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
  const net = require("node:net");
  const site = await startSite();
  const port = site.address().port;
  const slotDir = makeProfileDir("e2e-legacy");
  // legacy derives the CDP port from the slot (9332 + slot): pick a free one
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const cdpPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY],
    env: {
      ...process.env,
      BROWSER_RELAY_MODE: "legacy",
      BROWSER_RELAY_POOL_DIR: slotDir,
      BROWSER_RELAY_POOL_SLOT: String(cdpPort - 9332),
      BROWSER_HEADLESS_ENABLE: headfulRequested() ? "false" : "true",
      BROWSER_RELAY_INSPECTOR_PORT: "",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "legacy-smoke", version: "0" });
  await client.connect(transport);
  t.after(async () => {
    await client.close().catch(() => {});
    site.close();
    await until(() => processes({ needle: path.basename(slotDir) }).length === 0, 20_000, "legacy Brave to exit").catch(() => {
      for (const p of processes({ needle: path.basename(slotDir) })) killTree(p.pid);
    });
    await removeProfile(slotDir).catch(() => {});
  });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    assert.ok(!r.isError, `${name}: ${textOf(r)}`);
    return textOf(r);
  };
  const x = `http://127.0.0.1:${port}`;
  const y = `http://localhost:${port}`;
  await call("navigation_go-to", { url: `${x}/ls` });
  assert.strictEqual(JSON.parse(await call("storage_get-local")).origin, x);
  const { tabId } = JSON.parse(await call("tabs_new", { url: `${y}/ls` }));
  assert.strictEqual(JSON.parse(await call("storage_get-local", { tabId })).origin, y);
  assert.strictEqual(JSON.parse(await call("storage_get-local")).origin, x, "main is untouched");
});
