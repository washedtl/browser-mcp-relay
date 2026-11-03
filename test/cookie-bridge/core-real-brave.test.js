// core-real-brave.test.js — W2F against a real, throwaway Brave (temp
// profiles, OS-assigned CDP ports; skips when Brave is not installed):
//   - the CookieImporter's mapping as Brave stores it (host-only, domain,
//     session, SameSite, partitioned), a synced cookie really sent on a
//     request, deletions, and re-application after a relaunch;
//   - the extension ID bridge-install.js derives from a manifest "key" is
//     the one Brave gives the unpacked extension.
// Only Brave processes this file's supervisors started are ever closed.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

const { BraveSupervisor } = require("../../src/broker/brave-supervisor.js");
const { detectBravePath } = require("../../src/detect-browser.js");
const { CookieImporter } = require("../../src/cookie-bridge/importer.js");
const { openBrowserCdp } = require("../../src/cookie-bridge/cdp-client.js");
const { extensionIdFromKey } = require("../../scripts/bridge-install.js");
const { chooseCdpPort } = require("../../src/broker/main.js");

let BRAVE = null;
try { BRAVE = detectBravePath(); } catch { /* skip */ }
const REAL = { skip: BRAVE ? false : "Brave is not installed", timeout: 90_000 };

const supervisors = [];
const dirs = [];
test.after(async () => {
  for (const s of supervisors) await s.closeGracefully().catch(() => {});
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
});

function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `bmr-w2f-real-${tag}-`));
  dirs.push(d);
  return d;
}

function realSupervisor(opts = {}) {
  const sup = new BraveSupervisor({ profileDir: tmpDir("profile"), port: 0, log: () => {}, ...opts });
  supervisors.push(sup);
  return sup;
}

const FAR = Math.floor(Date.now() / 1000) + 86400 * 30;
const ck = (over = {}) => ({ name: "sid", value: "v-sid", domain: ".bmr-w2f.example", hostOnly: false, path: "/", secure: true, httpOnly: true, sameSite: "lax", session: false, expirationDate: FAR, storeId: "0", ...over });

async function braveCookies(cdpUrl) {
  const cdp = await openBrowserCdp(cdpUrl);
  try {
    return (await cdp.send("Storage.getCookies", {})).cookies;
  } finally {
    cdp.close();
  }
}

test("real Brave: synced cookies land as Chrome had them, are sent on requests, deletions apply, and a relaunch re-applies", REAL, async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push(req.headers.cookie || ""); res.end("<title>ok</title>ok"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    // as the broker does: the CDP port (and so cdpUrl) is fixed up front
    const cdpPort = await chooseCdpPort();
    const sup = realSupervisor({ port: cdpPort });
    const logs = [];
    const imp = new CookieImporter({ supervisor: sup, openCdp: () => openBrowserCdp(`http://127.0.0.1:${cdpPort}`), log: (m) => logs.push(m) });
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
    await imp.braveReady(info);
    const byName = Object.fromEntries((await braveCookies(info.cdpUrl)).map((c) => [c.name, c]));
    assert.deepStrictEqual(Object.keys(byName).sort(), ["host", "local", "part", "plain", "sess", "sid"]);
    assert.deepStrictEqual([byName.sid.domain, byName.sid.secure, byName.sid.httpOnly, byName.sid.sameSite, byName.sid.session, byName.sid.value], [".bmr-w2f.example", true, true, "Lax", false, "v-sid"]);
    assert.strictEqual(Math.round(byName.sid.expires), FAR);
    assert.deepStrictEqual([byName.host.domain, byName.host.sameSite, byName.host.httpOnly], ["www.bmr-w2f.example", "Strict", false], "host-only stays host-only");
    assert.deepStrictEqual([byName.sess.session, byName.sess.sameSite], [true, "None"]);
    assert.deepStrictEqual([byName.plain.secure, byName.plain.sameSite], [false, undefined]);
    assert.deepStrictEqual(byName.part.partitionKey, { topLevelSite: "https://top-bmr-w2f.example", hasCrossSiteAncestor: false });

    // really used: a page load sends the synced cookie
    const cdp = await openBrowserCdp(info.cdpUrl);
    await cdp.send("Target.createTarget", { url: `http://127.0.0.1:${port}/` });
    const t0 = Date.now();
    while (!seen.some((c) => c.includes("local=v-local")) && Date.now() - t0 < 15_000) await new Promise((res) => setTimeout(res, 100));
    cdp.close();
    assert.ok(seen.some((c) => c.includes("local=v-local")), `requests carried: ${JSON.stringify(seen)}`);

    // a deletion in Chrome (Brave up) expires it now
    await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "host", domain: "www.bmr-w2f.example", hostOnly: true, sameSite: "strict", httpOnly: false }) }]);
    assert.ok(!(await braveCookies(info.cdpUrl)).some((c) => c.name === "host"));

    // Brave closes; a deletion while it's down applies at the next launch;
    // the session cookie (gone with the restart) is re-applied
    await sup.closeGracefully();
    await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "plain", secure: false, sameSite: "unspecified" }) }]);
    info = await sup.ensure();
    await imp.braveReady(info);
    const after = (await braveCookies(info.cdpUrl)).map((c) => c.name).sort();
    assert.deepStrictEqual(after, ["local", "part", "sess", "sid"]);
    assert.ok(logs.every((l) => !/v-sid|v-local/.test(l)), logs.join("\n"));
  } finally {
    server.close();
  }
});

test("real Brave: after a broker restart, the persisted identity alone (no value) deletes what Chrome no longer has", REAL, async () => {
  const cdpPort = await chooseCdpPort();
  const cdpUrl = `http://127.0.0.1:${cdpPort}`;
  const sup = realSupervisor({ port: cdpPort });
  const stateFile = path.join(tmpDir("state"), "cookie-bridge-x.json");
  const first = new CookieImporter({ supervisor: sup, openCdp: () => openBrowserCdp(cdpUrl), stateFile });
  await first.braveReady(await sup.ensure());
  await first.full("b1", [
    ck({ name: "keep" }),
    ck({ name: "host", domain: "www.bmr-w2f.example", hostOnly: true, httpOnly: true }),
    ck({ name: "part", sameSite: "no_restriction", partitionKey: { topLevelSite: "https://top-bmr-w2f.example" } }),
    ck({ name: "__Host-x", domain: "www.bmr-w2f.example", hostOnly: true }),
  ], true);
  assert.deepStrictEqual((await braveCookies(cdpUrl)).map((c) => c.name).sort(), ["__Host-x", "host", "keep", "part"]);
  // the broker exits (Brave closes); Chrome deletes three of them; a new broker starts
  await sup.closeGracefully();
  const second = new CookieImporter({ supervisor: sup, openCdp: () => openBrowserCdp(cdpUrl), stateFile });
  await second.braveReady(await sup.ensure());
  await second.full("b1", [ck({ name: "keep" })], true);
  assert.deepStrictEqual((await braveCookies(cdpUrl)).map((c) => c.name), ["keep"]);
});

test("real Brave: the extension ID bridge-install derives from a manifest key is the ID Brave assigns", REAL, async () => {
  const extDir = tmpDir("ext");
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "bmr-w2f id probe", version: "1.0", key, background: { service_worker: "w2f-probe-sw.js" } }));
  fs.writeFileSync(path.join(extDir, "w2f-probe-sw.js"), "self.addEventListener('install', () => {});\n");
  const sup = realSupervisor({ extensionPath: extDir });
  const info = await sup.ensure();
  const cdp = await openBrowserCdp(info.cdpUrl);
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
const EXT_MERGED = fs.existsSync(path.join(EXT_DIR, "manifest.json")) && fs.existsSync(path.join(EXT_DIR, "background.js"));

test("real Brave: the cookie-bridge extension's module service worker loads policy.js (globalThis.CookieBridgePolicy)", { ...REAL, skip: REAL.skip || (!EXT_MERGED && "W2F-ext's extension files are not in this branch yet") }, async () => {
  const WebSocket = require("ws");
  const sup = realSupervisor({ extensionPath: EXT_DIR });
  const info = await sup.ensure();
  const id = extensionIdFromKey(JSON.parse(fs.readFileSync(path.join(EXT_DIR, "manifest.json"), "utf8")).key);
  let target = null;
  const t0 = Date.now();
  while (!target && Date.now() - t0 < 20_000) {
    const list = await (await fetch(`${info.cdpUrl}/json/list`)).json();
    target = list.find((x) => x.type === "service_worker" && x.url.startsWith(`chrome-extension://${id}/`) && x.webSocketDebuggerUrl);
    if (!target) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(target, `no service worker for chrome-extension://${id}/`);
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const evaluate = (expression) => new Promise((resolve) => {
    const msgId = Math.floor(Math.random() * 1e9);
    ws.on("message", function onMsg(data) {
      const m = JSON.parse(data);
      if (m.id === msgId) { ws.off("message", onMsg); resolve(m.result && m.result.result && m.result.result.value); }
    });
    ws.send(JSON.stringify({ id: msgId, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  try {
    // the worker target is listed before its module script has run
    const t1 = Date.now();
    while ((await evaluate("typeof globalThis.CookieBridgePolicy")) !== "object" && Date.now() - t1 < 15_000) await new Promise((r) => setTimeout(r, 200));
    const got = await evaluate(`JSON.stringify(["chase.com", "amazon.com", "mybank.example"].map((d) => globalThis.CookieBridgePolicy.classify(d).decision))`);
    assert.strictEqual(got, JSON.stringify(["deny", "allow", "hold"]));
  } finally {
    ws.close();
  }
});
