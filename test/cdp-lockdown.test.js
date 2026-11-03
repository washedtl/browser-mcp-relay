// cdp-lockdown.test.js — W2G, on a real Brave: the broker's logged-in browser
// exposes NO unauthenticated debugging port.
//
// BraveSupervisor launches Brave with --remote-debugging-pipe and hands each
// verified launch's pipe to a CdpProxy, as src/broker/main.js wires them.
// Proven here:
//   - none of the profile's brave.exe processes has a TCP LISTEN socket, and
//     there is no DevToolsActivePort file; the only listener is the proxy, in
//     this node process;
//   - a raw-websocket cookie read without the secret (Storage.getCookies)
//     and every /json/* discovery request are refused;
//   - Playwright connectOverCDP, upstream browser-devtools-mcp in-process and
//     the real lighthouse_audit tool all work through the proxy URL;
//   - a client can't Browser.close the shared Brave;
//   - Playwright's connect error carries the secret, and redact() removes it;
//   - after a crash, the relaunch is behind the same URL, still portless.
//
// A throwaway profile under .tmp-profiles, headless unless BMR_TEST_HEADFUL=1.
// Only the Brave this file launched is killed (by its PID, or by its unique
// profile dir). Windows + Brave only (Get-NetTCPConnection).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const WebSocket = require("ws");

const { braveAvailable, headfulRequested, makeProfileDir, removeProfile } = require("./fixtures/temp-brave.js");
const { BraveSupervisor } = require("../src/broker/brave-supervisor.js");
const { CdpProxy, redact } = require("../src/broker/cdp-proxy.js");

const SKIP = !braveAvailable() && "needs Windows + Brave";

function ps(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (r.status !== 0) throw new Error(`powershell failed: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter(Boolean);
}
/** brave.exe processes (browser and helpers) whose command line names this profile dir. */
function braveProcesses(profileDir) {
  const needle = path.basename(profileDir).replace(/'/g, "''");
  return ps(`Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { '' + $_.ProcessId }`).map(Number);
}
/** TCP sockets of these PIDs: "pid|state|local->remote". */
function tcpSockets(pids, { listenOnly }) {
  if (!pids.length) return [];
  const state = listenOnly ? "-State Listen " : "";
  return ps(`Get-NetTCPConnection ${state}-ErrorAction SilentlyContinue | Where-Object { @(${pids.join(",")}) -contains $_.OwningProcess } | ForEach-Object { '' + $_.OwningProcess + '|' + $_.State + '|' + $_.LocalAddress + ':' + $_.LocalPort + '->' + $_.RemoteAddress + ':' + $_.RemotePort }`);
}
function listenerOwners(port) {
  return ps(`Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { '' + $_.OwningProcess }`).map(Number);
}

function upgrade(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers, perMessageDeflate: false });
    const done = (v) => { try { ws.terminate(); } catch { /* closed */ } resolve(v); };
    ws.once("open", () => done("OPEN"));
    ws.once("unexpected-response", (_req, res) => done(`HTTP ${res.statusCode}`));
    ws.once("error", (e) => done(`error ${e.message}`));
    setTimeout(() => done("timeout"), 5000);
  });
}

/** A raw-websocket cookie read: a plain ws client asking for every cookie. Resolves the cookie names, or how it was refused. */
function rawGetCookies(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    const done = (v) => { try { ws.close(); } catch { /* closed */ } resolve(v); };
    ws.once("open", () => ws.send(JSON.stringify({ id: 1, method: "Storage.getCookies" })));
    ws.on("message", (d) => { const m = JSON.parse(d); if (m.id === 1) done(m.result ? m.result.cookies.map((c) => c.name) : m.error); });
    ws.once("unexpected-response", (_req, res) => done(`HTTP ${res.statusCode}`));
    ws.once("error", (e) => done(`error ${e.message}`));
    setTimeout(() => done("timeout"), 5000);
  });
}

/** One raw CDP call over the proxy (with the secret), on the client's browser session. */
function rawCall(url, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false });
    ws.once("open", () => ws.send(JSON.stringify({ id: 1, method, ...(params ? { params } : {}) })));
    ws.on("message", (d) => { const m = JSON.parse(d); if (m.id === 1) { ws.close(); resolve(m); } });
    ws.once("error", reject);
  });
}

function startSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": ["w2g_http=only-via-cdp; Path=/; HttpOnly", "w2g_js=visible; Path=/"],
    });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="description" content="w2g lockdown"><title>W2G lockdown</title></head><body><h1>W2G lockdown</h1><p>served for ${req.url}</p></body></html>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test("W2G real Brave: no TCP debugging port; only the secret proxy URL serves CDP (Playwright, upstream, Lighthouse)", { skip: SKIP, timeout: 300_000 }, async (t) => {
  const { chromium } = require("playwright-core");
  const profileDir = makeProfileDir("w2g-lockdown");
  const logs = [];
  const log = (m) => logs.push(String(m));
  const sup = new BraveSupervisor({ profileDir, headless: !headfulRequested(), log });
  const proxy = new CdpProxy({ log });
  await proxy.listen();
  sup.on("pipe", (p) => proxy.setPipe(p));
  const { wsUrl, port, secret } = proxy;
  const site = await startSite();
  const base = `http://127.0.0.1:${site.address().port}`;
  const measured = {};
  const browsers = [];

  t.after(async () => {
    for (const b of browsers) await b.close().catch(() => {});
    await sup.closeGracefully().catch(() => {});
    await proxy.close();
    site.close();
    let left = [];
    for (let i = 0; i < 60 && (left = braveProcesses(profileDir)).length; i++) await new Promise((r) => setTimeout(r, 250));
    for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await removeProfile(profileDir).catch(() => {});
    t.diagnostic(`measured: ${JSON.stringify(measured)}`);
    assert.deepStrictEqual(left, [], "Brave processes left on the test profile (killed now)");
  });

  const t0 = Date.now();
  const { pid } = await sup.ensure();
  measured.launchMs = Date.now() - t0;

  await t.test("no brave.exe process of the profile has a TCP LISTEN socket; no DevToolsActivePort; the only listener is the proxy, in this node process", async () => {
    await new Promise((r) => setTimeout(r, 1500)); // helpers (GPU, network, renderers) start after the browser answers
    const pids = braveProcesses(profileDir);
    assert.ok(pids.includes(pid), `the browser process ${pid} is among ${pids}`);
    measured.braveProcesses = pids.length;
    const listeners = tcpSockets(pids, { listenOnly: true });
    measured.braveListenSockets = listeners;
    measured.braveTcpAnyState = tcpSockets(pids, { listenOnly: false });
    assert.deepStrictEqual(listeners, [], "a Brave process listens on TCP");
    assert.ok(!fs.existsSync(path.join(profileDir, "DevToolsActivePort")), "DevToolsActivePort exists: a debugging port was opened");
    assert.deepStrictEqual(listenerOwners(port), [process.pid], "the proxy port belongs to this process");
    const args = ps(`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`).join(" ");
    assert.ok(args.includes("--remote-debugging-pipe") && !/--remote-debugging-port/.test(args), args);
  });

  await t.test("without the secret: the raw-websocket cookie theft and every /json/* discovery are refused", async () => {
    assert.strictEqual(await rawGetCookies(`ws://127.0.0.1:${port}/devtools/browser`), "HTTP 403");
    assert.strictEqual(await rawGetCookies(`ws://127.0.0.1:${port}/${"0".repeat(64)}/devtools/browser`), "HTTP 403");
    for (const p of ["/json/version", "/json/list", "/json", "/json/new?about:blank", `/${secret}/json/version`]) {
      const r = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.strictEqual(r.status, 404, p);
      assert.ok(!(await r.text()).includes(secret));
    }
    assert.strictEqual(await upgrade(wsUrl, { Origin: "https://evil.example" }), "HTTP 403", "a web page");
    assert.strictEqual(await upgrade(wsUrl, { Host: `evil.example:${port}` }), "HTTP 403", "DNS rebinding");
    for (const u of [`http://127.0.0.1:${port}`, `ws://127.0.0.1:${port}/devtools/browser`]) {
      const e = await chromium.connectOverCDP(u, { timeout: 5000 }).then((b) => { b.close(); return "CONNECTED"; }, (x) => x.message);
      assert.notStrictEqual(e, "CONNECTED", u);
    }
  });

  await t.test("Playwright connectOverCDP(secret URL): navigation, HttpOnly cookies, browser + page CDP sessions; a second client is independent", async () => {
    const b1 = await chromium.connectOverCDP(wsUrl, { timeout: 15000 });
    browsers.push(b1);
    const ctx = b1.contexts()[0];
    const page = await ctx.newPage();
    assert.strictEqual((await page.goto(`${base}/pw`)).status(), 200);
    const cookies = (await ctx.cookies()).map((c) => `${c.name}${c.httpOnly ? "(HttpOnly)" : ""}`);
    assert.ok(cookies.includes("w2g_http(HttpOnly)"), cookies.join(","));
    const bs = await b1.newBrowserCDPSession(); // window-pages.js
    const { targetInfos } = await bs.send("Target.getTargets");
    const win = await bs.send("Browser.getWindowForTarget", { targetId: targetInfos.find((x) => x.type === "page").targetId });
    assert.ok(win.windowId);
    await bs.detach();
    const s = await ctx.newCDPSession(page); // own-tools/_page-cdp-session.js
    assert.strictEqual((await s.send("Runtime.evaluate", { expression: "document.title", returnByValue: true })).result.value, "W2G lockdown");
    await s.detach();
    const b2 = await chromium.connectOverCDP(wsUrl, { timeout: 15000 });
    assert.ok(b2.contexts()[0].pages().some((p) => p.url() === `${base}/pw`), "one shared browser");
    await b2.close(); // connectOverCDP: disconnect only
    assert.ok(b1.isConnected() && (await page.title()) === "W2G lockdown", "the first client is unaffected");
    const raw = await rawCall(wsUrl, "Storage.getCookies");
    assert.ok(raw.result.cookies.some((c) => c.name === "w2g_http"), "with the secret it is plain CDP");
    await page.close();
  });

  await t.test("a client can't close or crash the shared Brave", async () => {
    for (const method of ["Browser.close", "Browser.crash"]) {
      const r = await rawCall(wsUrl, method);
      assert.strictEqual(r.error && r.error.code, -32000, `${method}: ${JSON.stringify(r)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(sup.isUp(), "Brave is still up");
  });

  await t.test("upstream browser-devtools-mcp in-process on the secret URL: navigation_go-to, content_get-as-text, cookies", async () => {
    const inproc = require("../src/broker/upstream-inproc.js");
    const tu = Date.now();
    const up = await inproc.loadUpstream({ cdpUrl: wsUrl, env: {} });
    delete process.env.BROWSER_CDP_ENDPOINT_URL; // as the broker does once upstream is imported
    const z = inproc.resolveUpstreamPackage({}).require("zod");
    const byName = new Map(up.tools.map((e) => [e.name, e]));
    const run = (name, args) => { const e = byName.get(name); return up.execute(ctx, e.tool, z.object(e.inputShape).parse(args)); };
    const ctx = await up.createContext("w2g:main");
    try {
      await run("navigation_go-to", { url: `${base}/upstream` });
      const text = JSON.stringify(await run("content_get-as-text", {}));
      assert.match(text, /served for \/upstream/);
      assert.ok(!text.includes(secret));
      assert.ok((await ctx.browserContext.cookies()).some((c) => c.name === "w2g_http"));
    } finally {
      await ctx.close().catch(() => {});
    }
    measured.upstreamMs = Date.now() - tu;
  });

  await t.test("the real lighthouse_audit tool through the secret URL (puppeteer page); its tab is closed after", async () => {
    const lighthouse = require("../src/own-tools/lighthouse-audit.js");
    const before = (await rawCall(wsUrl, "Target.getTargets")).result.targetInfos.filter((x) => x.type === "page").length;
    const tl = Date.now();
    const r = await lighthouse.handler({ url: `${base}/lighthouse`, onlyCategories: ["performance", "seo"] }, { cdpUrl: wsUrl });
    measured.lighthouseMs = Date.now() - tl;
    assert.notStrictEqual(r.isError, true, r.content[0].text);
    const out = JSON.parse(r.content[0].text);
    measured.lighthouseScores = Object.fromEntries(Object.entries(out.categories).map(([k, v]) => [k, v.score]));
    assert.ok(Number.isInteger(out.categories.performance.score) && Number.isInteger(out.categories.seo.score), r.content[0].text);
    assert.ok(!r.content[0].text.includes(secret));
    const after = (await rawCall(wsUrl, "Target.getTargets")).result.targetInfos.filter((x) => x.type === "page").length;
    assert.strictEqual(after, before, "Lighthouse's tab was closed");
    assert.ok(sup.isUp(), "the shared Brave stays up");
  });

  await t.test("Playwright's connect error prints the whole secret URL; redact() takes the secret out", async () => {
    const dead = wsUrl.replace(`:${port}/`, ":1/");
    const msg = await chromium.connectOverCDP(dead, { timeout: 3000 }).then(() => "CONNECTED", (e) => e.message);
    assert.ok(msg.includes(secret), "the leak the broker redacts (if Playwright stops printing it, this can go)");
    const clean = redact(msg);
    assert.ok(!clean.includes(secret) && clean.includes("<redacted>"), clean);
    assert.ok(!logs.some((l) => l.includes(secret)), "nothing the supervisor or proxy logged carries the secret");
  });

  await t.test("crash → relaunch behind the same URL: Playwright reconnects, and the new Brave has no port either", async () => {
    const down = new Promise((r) => sup.once("down", r));
    process.kill(pid, "SIGKILL");
    await down;
    assert.strictEqual(await upgrade(wsUrl), "HTTP 503", "Brave is down");
    const tr = Date.now();
    const again = await sup.ensure();
    measured.crashRelaunchMs = Date.now() - tr;
    assert.notStrictEqual(again.pid, pid);
    const b = await chromium.connectOverCDP(wsUrl, { timeout: 15000 });
    browsers.push(b);
    const page = await b.contexts()[0].newPage();
    assert.strictEqual((await page.goto(`${base}/after-crash`)).status(), 200);
    await page.close();
    await new Promise((r) => setTimeout(r, 1000));
    const pids = braveProcesses(profileDir);
    assert.ok(pids.includes(again.pid));
    assert.deepStrictEqual(tcpSockets(pids, { listenOnly: true }), []);
  });
});
