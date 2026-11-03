// core-real-brave.test.js — W2F against a real, throwaway Brave, wired as
// the broker wires it since W2G: BraveSupervisor runs Brave on
// --remote-debugging-pipe (no TCP port) and hands every launch's pipe to a
// CdpProxy; the CookieImporter reaches Brave only through the proxy's
// secret ws URL (cdp-client.js openBrowserCdp). Proven here:
//   - the importer's mapping as Brave stores it (host-only, domain,
//     session, SameSite, partitioned), a synced cookie really sent on a
//     request, deletions;
//   - re-application after a relaunch with NO tool call (the supervisor's
//     'pipe' signal), after a graceful close AND after a crash;
//   - a persisted identity alone deletes what Chrome no longer has;
//   - the extension ID bridge-install.js derives from a manifest "key" is
//     the one Brave gives the unpacked extension, and the real extension's
//     module service worker loads policy.js.
// Temp profiles (os.tmpdir()), headless unless BMR_TEST_HEADFUL=1; skips
// when Brave is not installed. Only Brave processes this file's
// supervisors started are ever closed or killed (by their own PID).

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const WebSocket = require("ws");

const { BraveSupervisor } = require("../../src/broker/brave-supervisor.js");
const { CdpProxy } = require("../../src/broker/cdp-proxy.js");
const { detectBravePath } = require("../../src/detect-browser.js");
const { CookieImporter } = require("../../src/cookie-bridge/importer.js");
const { openBrowserCdp } = require("../../src/cookie-bridge/cdp-client.js");
const { extensionIdFromKey } = require("../../scripts/bridge-install.js");
const { headfulRequested } = require("../fixtures/temp-brave.js");

let BRAVE = null;
try { BRAVE = detectBravePath(); } catch { /* skip */ }
const REAL = { skip: BRAVE ? false : "Brave is not installed", timeout: 120_000 };

const brokers = [];
const dirs = [];
test.after(async () => {
  for (const b of brokers) {
    await b.sup.closeGracefully().catch(() => {});
    await b.proxy.close().catch(() => {});
  }
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bmr-w2f-real-${tag}-`));
  dirs.push(d);
  return d;
}

/** A Brave supervisor + the CDP proxy in front of it, as src/broker/main.js wires them. */
async function realBroker(opts = {}) {
  const sup = new BraveSupervisor({ profileDir: tmpDir("profile"), headless: !headfulRequested(), log: () => {}, ...opts });
  const proxy = new CdpProxy({});
  await proxy.listen();
  sup.on("pipe", (p) => proxy.setPipe(p));
  const b = { sup, proxy, url: proxy.wsUrl };
  brokers.push(b);
  return b;
}

const FAR = Math.floor(Date.now() / 1000) + 86400 * 30;
const ck = (over = {}) => ({ name: "sid", value: "v-sid", domain: ".bmr-w2f.example", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: FAR, storeId: "0", ...over });

async function braveCookies(url) {
  const cdp = await openBrowserCdp(url);
  try {
    return (await cdp.send("Storage.getCookies", {})).cookies;
  } finally {
    cdp.close();
  }
}

async function waitForNames(url, want, ms = 20_000) {
  const t0 = Date.now();
  let got = [];
  while (Date.now() - t0 < ms) {
    got = (await braveCookies(url)).map((c) => c.name).sort();
    if (JSON.stringify(got) === JSON.stringify([...want].sort())) return got;
    await new Promise((r) => setTimeout(r, 200));
  }
  return got;
}

test("real Brave (pipe + secret URL): synced cookies land as Chrome had them, are sent on requests, deletions apply, and every relaunch (close or crash) re-applies with no tool call", REAL, async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers.cookie || ""); res.end("<title>ok</title>ok"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const { sup, url, proxy } = await realBroker();
    const logs = [];
    const imp = new CookieImporter({ supervisor: sup, openCdp: () => openBrowserCdp(url), log: (m) => logs.push(m) });
    // Brave down: kept in memory only
    const r = await imp.full("b1", [
      ck(),
      ck({ name: "host", domain: "www.bmr-w2f.example", hostOnly: true, sameSite: "strict", httpOnly: false }),
      ck({ name: "sess", session: true, expirationDate: undefined, sameSite: "no_restriction" }),
      ck({ name: "plain", secure: false, sameSite: "unspecified" }),
      ck({ name: "part", sameSite: "no_restriction", partitionKey: { topLevelSite: "https://top-bmr-w2f.example" } }),
      ck({ name: "local", value: "v-local", domain: "127.0.0.1", hostOnly: true, secure: false, sameSite: "lax", userOverride: true }),
      ck({ name: "bank", domain: ".chase.com" }),
    ], true);
    assert.deepStrictEqual([r.applied, r.rejected.map((x) => x.domain)], [6, ["chase.com"]]);
    assert.strictEqual(sup.isUp(), false, "the bridge never launches Brave");

    let info = await sup.ensure();
    await imp.braveReady(info); // as main.js ensureBrave does
    const byName = Object.fromEntries((await braveCookies(url)).map((c) => [c.name, c]));
    assert.deepStrictEqual(Object.keys(byName).sort(), ["host", "local", "part", "plain", "sess", "sid"]);
    assert.deepStrictEqual([byName.sid.domain, byName.sid.secure, byName.sid.httpOnly, byName.sid.sameSite, byName.sid.session, byName.sid.value], [".bmr-w2f.example", true, true, "Lax", false, "v-sid"]);
    assert.strictEqual(Math.round(byName.sid.expires), FAR);
    assert.deepStrictEqual([byName.host.domain, byName.host.sameSite, byName.host.httpOnly], ["www.bmr-w2f.example", "Strict", false], "host-only stays host-only");
    assert.deepStrictEqual([byName.sess.session, byName.sess.sameSite], [true, "None"]);
    assert.deepStrictEqual([byName.plain.secure, byName.plain.sameSite], [false, undefined]);
    assert.deepStrictEqual(byName.part.partitionKey, { topLevelSite: "https://top-bmr-w2f.example", hasCrossSiteAncestor: false });

    // really used: a page load sends the synced cookie
    const cdp = await openBrowserCdp(url);
    await cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` });
    const t0 = Date.now();
    while (!seen.some((c) => c.includes("local=v-local")) && Date.now() - t0 < 15_000) await new Promise((res) => setTimeout(res, 100));
    cdp.close();
    assert.ok(seen.some((c) => c.includes("local=v-local")), `requests carried: ${JSON.stringify(seen)}`);

    // a deletion in Chrome (Brave up) expires it now
    await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "host", domain: "www.bmr-w2f.example", hostOnly: true, sameSite: "strict", httpOnly: false }) }]);
    assert.ok(!(await braveCookies(url)).some((c) => c.name === "host"));

    // Brave closes; a deletion while it's down applies at the next launch;
    // the session cookie (gone with the restart) comes back through the
    // 'pipe' signal alone: no braveReady / tool call after this ensure()
    await sup.closeGracefully();
    await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "plain", secure: false, sameSite: "unspecified" }) }]);
    info = await sup.ensure();
    assert.deepStrictEqual(await waitForNames(url, ["local", "part", "sess", "sid"]), ["local", "part", "sess", "sid"]);

    // a crash: kill OUR Brave by its PID; the relaunch gets the snapshot again
    const crashed = info.pid;
    process.kill(crashed, "SIGKILL");
    const t1 = Date.now();
    while (sup.isUp() && Date.now() - t1 < 10_000) await new Promise((res) => setTimeout(res, 50));
    info = await sup.ensure();
    assert.notStrictEqual(info.pid, crashed);
    assert.deepStrictEqual(await waitForNames(url, ["local", "part", "sess", "sid"]), ["local", "part", "sess", "sid"], "the session cookie is back after the crash");
    assert.ok(logs.every((l) => !/v-sid|v-local/.test(l)), logs.join("\n"));
    assert.ok(logs.every((l) => !l.includes(proxy.secret)), "no log line carries the CDP secret");
  } finally {
    server.close();
  }
});

test("real Brave (pipe + secret URL): after a broker restart, the persisted identity alone (no value) deletes what Chrome no longer has", REAL, async () => {
  const { sup, url } = await realBroker();
  const stateFile = path.join(tmpDir("state"), "cookie-bridge-x.json");
  const first = new CookieImporter({ supervisor: sup, openCdp: () => openBrowserCdp(url), stateFile });
  await first.braveReady(await sup.ensure());
  await first.full("b1", [
    ck({ name: "keep" }),
    ck({ name: "host", domain: "www.bmr-w2f.example", hostOnly: true, httpOnly: true }),
    ck({ name: "part", sameSite: "no_restriction", partitionKey: { topLevelSite: "https://top-bmr-w2f.example" } }),
    ck({ name: "__Host-x", domain: "www.bmr-w2f.example", hostOnly: true }),
  ], true);
  assert.deepStrictEqual((await braveCookies(url)).map((c) => c.name).sort(), ["__Host-x", "host", "keep", "part"]);
  assert.ok(!fs.readFileSync(stateFile, "utf8").includes("v-sid"), "the state file holds no value");
  // the broker exits (Brave closes); Chrome deletes three of them; a new broker starts
  await sup.closeGracefully();
  const second = new CookieImporter({ supervisor: sup, openCdp: () => openBrowserCdp(url), stateFile });
  await second.braveReady(await sup.ensure());
  await second.full("b1", [ck({ name: "keep" })], true);
  assert.deepStrictEqual((await braveCookies(url)).map((c) => c.name), ["keep"]);
});

/** Runtime.evaluate in an extension service worker, through the proxy (flat session). */
async function evaluateInWorker(url, urlPrefix, expression, ms = 20_000) {
  const ws = new WebSocket(url, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let id = 0;
  const call = (method, params, sessionId) => new Promise((resolve) => {
    const i = ++id;
    ws.on("message", function onMsg(data) {
      const m = JSON.parse(data);
      if (m.id === i) { ws.off("message", onMsg); resolve(m); }
    });
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    let target = null;
    const t0 = Date.now();
    while (!target && Date.now() - t0 < ms) {
      const { result } = await call("Target.getTargets", {});
      target = result.targetInfos.find((x) => x.type === "service_worker" && x.url.startsWith(urlPrefix));
      if (!target) await new Promise((r) => setTimeout(r, 200));
    }
    if (!target) return { target: null };
    const { result: att } = await call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const evaluate = async (expr) => {
      const m = await call("Runtime.evaluate", { expression: expr, returnByValue: true }, att.sessionId);
      return m.result && m.result.result && m.result.result.value;
    };
    return { target, value: await expression(evaluate) };
  } finally {
    ws.close();
  }
}

test("real Brave: the extension ID bridge-install derives from a manifest key is the ID Brave assigns", REAL, async () => {
  const extDir = tmpDir("ext");
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "bmr-w2f id probe", version: "1.0", key, background: { service_worker: "w2f-probe-sw.js" } }));
  fs.writeFileSync(path.join(extDir, "w2f-probe-sw.js"), "self.addEventListener('install', () => {});\n");
  const { sup, url } = await realBroker({ extensionPath: extDir });
  await sup.ensure();
  const cdp = await openBrowserCdp(url);
  let id = null;
  try {
    const t0 = Date.now();
    while (!id && Date.now() - t0 < 20_000) {
      const { targetInfos } = await cdp.send("Target.getTargets", {});
      const sw = targetInfos.find((x) => x.type === "service_worker" && x.url.endsWith("/w2f-probe-sw.js"));
      if (sw) id = new URL(sw.url).host;
      else await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    cdp.close();
  }
  assert.ok(id, "the probe extension's service worker never showed up");
  assert.strictEqual(extensionIdFromKey(key), id);
});

const EXT_DIR = path.join(__dirname, "..", "..", "extensions", "cookie-bridge");

test("real Brave: the cookie-bridge extension's module service worker loads policy.js (globalThis.CookieBridgePolicy)", REAL, async () => {
  const { sup, url } = await realBroker({ extensionPath: EXT_DIR });
  await sup.ensure();
  const id = extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8")).key);
  const { target, value } = await evaluateInWorker(url, `chrome-extension://${id}/`, async (evaluate) => {
    // the worker target is listed before its module script has run
    const t1 = Date.now();
    while ((await evaluate("typeof globalThis.CookieBridgePolicy")) !== "object" && Date.now() - t1 < 15_000) await new Promise((r) => setTimeout(r, 200));
    return evaluate(`JSON.stringify(["chase.com", "amazon.com", "mybank.example"].map((d) => globalThis.CookieBridgePolicy.classify(d).decision))`);
  });
  assert.ok(target, `no service worker for chrome-extension://${id}/`);
  assert.strictEqual(value, JSON.stringify(["deny", "allow", "hold"]));
});
