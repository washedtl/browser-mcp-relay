// ext-background.test.js — W2F-ext: background.js wires bridge-core to the
// real chrome.* APIs. The module is copied into a temp dir marked
// "type":"module" (the repo is CommonJS) next to a stand-in policy.js
// (W2F-core's real one isn't ours), then imported with a fake `chrome`
// global. MV3 rule under test: every listener is registered synchronously
// while the module evaluates, or a waking event is lost.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { flush, fakeStorage, fakeCookies, fakePort, cookie } = require("./ext-fakes.js");

const EXT = path.join(__dirname, "..", "..", "extensions", "cookie-bridge");

// Mirrors the real W2F-core policy.js contract: a plain IIFE that sets
// globalThis.CookieBridgePolicy (and module.exports under Node), no ES exports.
const POLICY_GLOBAL_OBJECT = `
  (function (root) {
    function classify(domain) {
      const d = String(domain).replace(/^\\.+/, "");
      if (d === "chase.com" || d.endsWith(".chase.com")) return { decision: "deny", category: "banking", reason: "denylist" };
      return { decision: "allow", category: null, reason: "ok" };
    }
    const api = { classify };
    root.CookieBridgePolicy = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
  })(typeof globalThis !== "undefined" ? globalThis : this);
`;
const POLICY_GLOBAL_FUNCTION = `globalThis.classify = function (d) { return { decision: "allow", category: null, reason: "ok" }; };`;
const POLICY_BROKEN = `globalThis.notAPolicy = { hello: 1 };`;

function fakeEvent() {
  const fns = [];
  return { fns, addListener: (fn) => fns.push(fn), fire: (...a) => fns.forEach((fn) => fn(...a)) };
}

function fakeChrome(storageInit = {}) {
  const local = fakeStorage(storageInit);
  const storageChanged = fakeEvent();
  // chrome.storage.onChanged fires (changes, areaName) for every area
  local.onChanged.addListener((changes) => storageChanged.fire(changes, "local"));
  const ports = [];
  const chrome = {
    runtime: {
      lastError: undefined,
      onInstalled: fakeEvent(),
      onStartup: fakeEvent(),
      openOptionsPage: () => { chrome.opened = (chrome.opened || 0) + 1; return Promise.resolve(); },
      connectNative(name) {
        const p = fakePort(name);
        // Chrome passes the port; the error is on runtime.lastError during the callback
        const discFns = [];
        p.onDisconnect = { addListener: (fn) => discFns.push(fn) };
        p.crash = (err) => {
          p.disconnected = true;
          chrome.runtime.lastError = err ? { message: err } : undefined;
          discFns.forEach((fn) => fn(p));
          chrome.runtime.lastError = undefined;
        };
        ports.push(p);
        return p;
      },
    },
    cookies: fakeCookies([cookie(".amazon.com"), cookie(".chase.com")]),
    storage: { local, onChanged: storageChanged },
    action: {
      onClicked: fakeEvent(),
      badge: { text: "", color: null, title: "" },
      setBadgeText({ text }) { this.badge.text = text; return Promise.resolve(); },
      setBadgeBackgroundColor({ color }) { this.badge.color = color; return Promise.resolve(); },
      setTitle({ title }) { this.badge.title = title; return Promise.resolve(); },
    },
    ports,
  };
  return chrome;
}

let counter = 0;
async function loadBackground(t, { policy = POLICY_GLOBAL_OBJECT, storage = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-ext-bg-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const f of ["background.js", "bridge-core.js"]) fs.copyFileSync(path.join(EXT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "policy.js"), policy);
  const chrome = fakeChrome(storage);
  const saved = {
    chrome: globalThis.chrome, Policy: globalThis.CookieBridgePolicy,
    policy: globalThis.cookieBridgePolicy, classify: globalThis.classify, core: globalThis.CookieBridgeCore,
  };
  t.after(() => {
    globalThis.chrome = saved.chrome;
    globalThis.CookieBridgePolicy = saved.Policy;
    globalThis.cookieBridgePolicy = saved.policy;
    globalThis.classify = saved.classify;
    globalThis.CookieBridgeCore = saved.core;
  });
  delete globalThis.CookieBridgePolicy;
  delete globalThis.cookieBridgePolicy;
  delete globalThis.classify;
  globalThis.chrome = chrome;
  const mod = await import(pathToFileURL(path.join(dir, "background.js")).href + "?n=" + (++counter));
  t.after(() => mod.bridge.stop());
  return chrome;
}

const APPROVED = { settings: { approved: true, approvedAt: 1, paused: false, overrides: {}, reviewed: {} } };

test("all listeners are registered synchronously at module evaluation", async (t) => {
  const chrome = await loadBackground(t);
  assert.strictEqual(chrome.storage.onChanged.fns.length, 1, "storage.onChanged");
  assert.strictEqual(chrome.runtime.onInstalled.fns.length, 1, "runtime.onInstalled");
  assert.strictEqual(chrome.action.onClicked.fns.length, 1, "action.onClicked");
  assert.strictEqual(chrome.cookies.listeners.length, 1, "cookies.onChanged");
});

test("first install opens the review page; clicking the icon opens it too", async (t) => {
  const chrome = await loadBackground(t);
  chrome.runtime.onInstalled.fire({ reason: "install" });
  chrome.runtime.onInstalled.fire({ reason: "update" });
  assert.strictEqual(chrome.opened, 1, "updates don't re-open it");
  chrome.action.onClicked.fire({});
  assert.strictEqual(chrome.opened, 2);
});

test("not approved: no native host; badge prompts for review", async (t) => {
  const chrome = await loadBackground(t);
  await flush();
  assert.strictEqual(chrome.ports.length, 0);
  assert.strictEqual(chrome.action.badge.text, "!");
});

test("approved: connects to the native host by name and says hello; lastError text reaches status", async (t) => {
  const chrome = await loadBackground(t, { storage: APPROVED });
  await flush();
  assert.strictEqual(chrome.ports.length, 1);
  assert.strictEqual(chrome.ports[0].name, "com.browser_mcp_relay.cookie_bridge");
  assert.deepStrictEqual(chrome.ports[0].sent, [{ t: "hello", v: 1 }]);
  chrome.ports[0].emit({ t: "resync" });
  await flush();
  const sent = chrome.ports[0].ofType("full").flatMap((m) => m.cookies.map((c) => c.domain));
  assert.deepStrictEqual(sent, [".amazon.com"], "the stand-in policy's deny domain is filtered");
  chrome.ports[0].crash("Specified native messaging host not found.");
  await new Promise((r) => setTimeout(r, 700));
  assert.match(chrome.storage.local.data.status.error, /not found/);
});

test("a policy.js that exposes classify as a global function works too", async (t) => {
  const chrome = await loadBackground(t, { policy: POLICY_GLOBAL_FUNCTION, storage: APPROVED });
  await flush();
  assert.strictEqual(chrome.ports.length, 1);
});

test("a policy.js without a classify function fails closed: nothing connects, status says why", async (t) => {
  const chrome = await loadBackground(t, { policy: POLICY_BROKEN, storage: APPROVED });
  await new Promise((r) => setTimeout(r, 700));
  assert.strictEqual(chrome.ports.length, 0);
  assert.match(chrome.storage.local.data.status.error, /policy/i);
});
