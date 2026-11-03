// core-e2e.test.js — W2F end to end, on the merged tree: W2F-ext's real
// bridge logic (extensions/cookie-bridge/bridge-core.js) with the real
// policy.js, talking native messaging to the REAL host process
// (src/cookie-bridge/host.js), which authenticates to a real test broker
// (in-process startBroker; fake Brave + a recording CDP) on a private pipe.
// Only chrome.* is faked (a real Chrome would need the HKCU registry key,
// which tests never write). Skips until W2F-ext's files are in the tree.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const EXT_DIR = path.join(__dirname, "..", "..", "extensions", "cookie-bridge");
const MERGED = fs.existsSync(path.join(EXT_DIR, "bridge-core.js"));
const SKIP = MERGED ? false : "W2F-ext's bridge-core.js is not in this branch yet";

const SECRET = "SENTINEL-e2e-VALUE-5d1e";
const HOST_SCRIPT = path.join(__dirname, "..", "..", "src", "cookie-bridge", "host.js");

const chromeCookie = (domain, name = "sid", extra = {}) => ({
  domain, name, value: SECRET, path: "/", secure: true, httpOnly: true, hostOnly: !domain.startsWith("."),
  session: false, expirationDate: 1_900_000_000, sameSite: "lax", storeId: "0", ...extra,
});

/** Just enough chrome.* for bridge-core: storage, cookies, action, alarms. */
function fakeChrome(jar, settings) {
  const data = { settings };
  const storageL = [];
  const cookieL = [];
  return {
    jar,
    storage: {
      async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k])); return out; },
      async set(obj) { const ch = {}; for (const [k, v] of Object.entries(obj)) { ch[k] = { newValue: v }; data[k] = JSON.parse(JSON.stringify(v)); } for (const fn of storageL) fn(ch, "local"); },
      onChanged: { addListener: (fn) => storageL.push(fn) },
      data,
    },
    cookies: {
      async getAll() { return jar.map((c) => ({ ...c })); },
      onChanged: { addListener: (fn) => cookieL.push(fn) },
      change(info) { for (const fn of cookieL) fn(info); },
    },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {}, setTitle() {} },
    alarms: { create() {}, clear() { return true; }, onAlarm: { addListener() {} } },
  };
}

/** runtime.connectNative, the way Chrome does it on Windows: start the host, framed stdio. */
function nativeConnector(env, hosts) {
  const { encodeMessage, MessageReader } = require("../../src/cookie-bridge/framing.js");
  return (name) => {
    assert.strictEqual(name, "com.browser_mcp_relay.cookie_bridge");
    const child = spawn(process.execPath, [HOST_SCRIPT, "chrome-extension://dfcccancdkogdddemhecnffcjllbjmba/", "--parent-window=0"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    hosts.push(child);
    const msgL = [];
    const discL = [];
    const reader = new MessageReader({ onMessage: (m) => { for (const fn of msgL) fn(m); } });
    child.stdout.on("data", (c) => reader.push(c));
    child.on("exit", () => { for (const fn of discL) fn("Native host has exited."); });
    return {
      name,
      postMessage(m) { child.stdin.write(encodeMessage(m)); },
      disconnect() { child.stdin.end(); },
      onMessage: { addListener: (fn) => msgL.push(fn) },
      onDisconnect: { addListener: (fn) => discL.push(fn) },
    };
  };
}

test("e2e: approved extension → real host process → real broker pipe: allowed cookies applied, deny/hold never sent, live add and removal mirrored", { skip: SKIP, timeout: 60_000 }, async (t) => {
  const core = require(path.join(EXT_DIR, "bridge-core.js"));
  const { classify } = require(path.join(EXT_DIR, "policy.js"));
  const { startBroker } = require("../../src/broker/main.js");
  const { keyFileFor, loadOrCreateKey } = require("../../src/broker/pipe-server.js");
  const { CookieImporter } = require("../../src/cookie-bridge/importer.js");
  const fakes = require("../fixtures/broker-fakes.js");
  const { until } = fakes;

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-w2f-e2e-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const env = { LOCALAPPDATA: home, XDG_STATE_HOME: home };
  const keyFile = keyFileFor(env);
  loadOrCreateKey(keyFile);
  const pipe = fakes.testPipe("w2f-e2e");
  const logs = [];
  const set = [];
  const handle = await startBroker({
    pipe, profileDir: path.join(home, "profile"), env: {}, keyFile, log: (m) => logs.push(m), idle: { exitMs: 60_000, browserMs: 60_000 }, onExit: () => {},
    deps: {
      createSupervisor: (opts) => Object.assign(fakes.fakeSupervisor(opts), { up: true }), // Brave up: applied at once
      upstreamModule: () => fakes.fakeUpstreamModule(),
      windowPages: () => fakes.fakeWindowPages(),
      ownTools: () => [],
      toolContext: fakes.fakeToolContextModule,
      loadCatalog: async () => fakes.FAKE_CATALOG,
      cookieBridge: ({ supervisor, log }) => new CookieImporter({
        supervisor, log,
        openCdp: async () => ({ closed: false, async send(method, params) { set.push(...params.cookies.map((c) => ({ ...c }))); return {}; }, close() {} }),
      }),
    },
  });
  t.after(() => handle.close("test done"));

  const chrome = fakeChrome([
    chromeCookie(".amazon.com", "session-id"),
    chromeCookie("sellercentral.amazon.com", "sc"),
    chromeCookie(".chase.com", "bank"),
    chromeCookie(".mybank.example", "held"),
  ], { approved: true, approvedAt: 1, paused: false, overrides: {}, reviewed: {} });
  const hosts = [];
  t.after(() => { for (const h of hosts) try { h.kill(); } catch { /* gone */ } });
  const bridge = core.createBridge({
    cookies: chrome.cookies, storage: chrome.storage, action: chrome.action, alarms: chrome.alarms, classify,
    connectNative: nativeConnector({ ...env, BROWSER_RELAY_BROKER_PIPE: pipe }, hosts),
    timers: { setTimeout, clearTimeout }, now: Date.now, log: () => {},
  });
  t.after(() => bridge.stop());
  await bridge.ready;

  // host up → broker authenticated → resync → full sync → applied
  await until(() => set.length >= 2, 20_000, `the full sync to reach Brave (broker log: ${logs.slice(-5).join(" | ")})`);
  assert.deepStrictEqual(set.map((c) => c.name).sort(), ["sc", "session-id"]);
  assert.ok(!set.some((c) => /chase|mybank/.test(c.domain || c.url)), "deny / hold domains never reach Brave");

  // live: Chrome rotates a cookie, then deletes one
  const rotated = chromeCookie(".amazon.com", "session-id", { value: `rotated-${SECRET}` });
  chrome.jar[0] = rotated;
  chrome.cookies.change({ removed: true, cause: "overwrite", cookie: chromeCookie(".amazon.com", "session-id") });
  chrome.cookies.change({ removed: false, cause: "explicit", cookie: rotated });
  await until(() => set.some((c) => c.value === `rotated-${SECRET}`), 10_000, "the rotated cookie");
  const sc = chrome.jar.splice(1, 1)[0];
  chrome.cookies.change({ removed: true, cause: "explicit", cookie: sc });
  await until(() => set.some((c) => c.name === "sc" && c.expires === 1), 10_000, "the deletion to be mirrored");

  assert.ok(logs.some((l) => /cookie bridge: full sync batch/.test(l)), logs.join("\n"));
  assert.ok(!logs.join("\n").includes(SECRET), "a cookie value reached the broker log");
  const hostLog = path.join(path.dirname(keyFile), "cookie-bridge.log");
  assert.ok(fs.existsSync(hostLog) && !fs.readFileSync(hostLog, "utf8").includes(SECRET));
  assert.ok(!JSON.stringify(chrome.storage.data).includes(SECRET), "a cookie value reached chrome.storage");
});
