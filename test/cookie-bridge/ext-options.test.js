// ext-options.test.js — W2F-ext: the review page's render logic (options.js).
// The real module is copied into a temp dir marked "type":"module" next to
// bridge-core.js and a stand-in policy.js (W2F-core owns the real one; this
// one has the same globalThis.CookieBridgePolicy contract), then imported
// against a fake DOM (ext-fakedom.js) and a fake chrome.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { flush, fakeStorage, fakeClassify, cookie, SECRET } = require("./ext-fakes.js");
const { makeDocument } = require("./ext-fakedom.js");

const EXT = path.join(__dirname, "..", "..", "extensions", "cookie-bridge");
const MOUNTS = ["status", "host-line", "rejections", "actions", "groups"];
const POLICY = `(function (root) {
  const classify = ${fakeClassify.toString()};
  root.CookieBridgePolicy = { classify };
})(globalThis);`;

const JAR = () => [cookie(".amazon.com"), cookie("github.com"), cookie(".chase.com"), cookie("mybank.example")];
const APPROVED_SETTINGS = { approved: true, approvedAt: 1, paused: false, overrides: {}, reviewed: { "mybank.example": 1 } };

let counter = 0;
async function loadOptions(t, { settings, status, cookies = JAR() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-ext-opt-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ type: "module" }));
  for (const f of ["options.js", "bridge-core.js"]) fs.copyFileSync(path.join(EXT, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, "policy.js"), POLICY);

  const init = {};
  if (settings) init.settings = settings;
  if (status) init.status = status;
  const local = fakeStorage(init);
  const changed = [];
  local.onChanged.addListener((ch) => changed.forEach((fn) => fn(ch, "local")));
  const chrome = {
    cookies: { getAll: async () => cookies.map((c) => ({ ...c })) },
    storage: { local, onChanged: { addListener: (fn) => changed.push(fn) } },
  };
  const doc = makeDocument(MOUNTS);
  const saved = { chrome: globalThis.chrome, document: globalThis.document, setInterval: globalThis.setInterval,
    Policy: globalThis.CookieBridgePolicy, core: globalThis.CookieBridgeCore };
  t.after(() => Object.assign(globalThis, saved));
  globalThis.chrome = chrome;
  globalThis.document = doc;
  globalThis.setInterval = () => 0; // the page's 5 s refresh; driven by hand here
  const mod = await import(pathToFileURL(path.join(dir, "options.js")).href + "?n=" + (++counter));
  await mod.ready;
  await flush();
  /** Simulate another context (the worker) writing storage. */
  const write = async (obj) => { await local.set(obj); await flush(); };
  const byId = (id) => doc.getElementById(id);
  return { mod, doc, local, write, byId };
}

test("statusView: approval comes from settings (not status); paused; broker up/down", async (t) => {
  const { mod } = await loadOptions(t);
  const { statusView } = mod;
  assert.strictEqual(statusView({ approved: false }, { host: "connected", broker: "up" }).broker, "not started");
  assert.strictEqual(statusView({ approved: true, paused: true }, { host: "paused" }).dot, "paused");
  const up = statusView({ approved: true }, { host: "connected", broker: "up" });
  assert.deepStrictEqual([up.dot, up.broker], ["up", "broker up"]);
  const down = statusView({ approved: true }, { host: "connected", broker: "down" });
  assert.strictEqual(down.dot, "down");
  assert.ok(down.hint, "explains why the broker can be down");
});

test("hostHint turns the native-host and policy errors into the fix", async (t) => {
  const { mod } = await loadOptions(t);
  assert.match(mod.hostHint("Specified native messaging host not found."), /npm run bridge:install/);
  assert.match(mod.hostHint("Access to the specified native messaging host is forbidden."), /npm run bridge:install/);
  assert.match(mod.hostHint("policy.js did not load a classify function"), /policy\.js/);
  assert.strictEqual(mod.hostHint("Native host has exited."), "Native host has exited.");
  assert.strictEqual(mod.hostHint(null), "");
});

test("the page shows the host state and the error's fix in the live region", async (t) => {
  const { byId } = await loadOptions(t, {
    settings: APPROVED_SETTINGS,
    status: { host: "retrying", broker: "unknown", error: "Specified native messaging host not found." },
  });
  const line = byId("host-line").textContent;
  assert.match(line, /retrying/i);
  assert.match(line, /npm run bridge:install/);
});

test("before approval: Approve is enabled, no pause switch; approving records the held domains seen", async (t) => {
  const { byId, local } = await loadOptions(t);
  const approve = byId("approve");
  assert.ok(approve && !approve.disabled);
  assert.strictEqual(byId("pause"), null);
  approve.click();
  await flush();
  assert.strictEqual(local.data.settings.approved, true);
  assert.deepStrictEqual(Object.keys(local.data.settings.reviewed), ["mybank.example"]);
  assert.ok(byId("pause"), "pause switch appears once approved");
});

test("categories show only on Held/Blocked rows; values never reach the page", async (t) => {
  const { doc, byId } = await loadOptions(t, { settings: APPROVED_SETTINGS });
  const rowText = (domain) => byId("tg-" + domain).parentNode.parentNode.textContent;
  assert.ok(!/business|default/.test(rowText("amazon.com")), rowText("amazon.com"));
  assert.match(rowText("chase.com"), /banking/);
  assert.match(rowText("mybank.example"), /keyword/);
  assert.ok(!doc.all().some((n) => n.textContent.includes(SECRET)));
});

test("ticking a blocked domain stores an 'on' override (the worker then syncs it with userOverride)", async (t) => {
  const { byId, local } = await loadOptions(t, { settings: APPROVED_SETTINGS });
  const box = byId("tg-chase.com");
  assert.strictEqual(box.checked, false);
  box.checked = true;
  box.dispatch("change");
  await flush();
  assert.deepStrictEqual(local.data.settings.overrides, { "chase.com": "on" });
});

test("an unchanged refresh rebuilds nothing and doesn't re-announce", async (t) => {
  const { byId, write, local } = await loadOptions(t, {
    settings: APPROVED_SETTINGS, status: { host: "connected", broker: "up", applied: 3, updatedAt: 1 },
  });
  const toggle = byId("tg-amazon.com");
  assert.ok(toggle, "the toggle exists (no vacuous null === null)");
  const live = byId("host-line");
  assert.match(live.textContent, /connected/i);
  const before = live.mutations;
  await write({ status: { ...local.data.status, updatedAt: 2 } }); // only bookkeeping changed
  assert.strictEqual(byId("tg-amazon.com"), toggle, "same element: the list wasn't rebuilt");
  assert.strictEqual(live.mutations, before, "live region untouched");
});

test("a real change re-renders, keeps focus on the same control, and leaves an unchanged live region alone", async (t) => {
  const { doc, byId, write, local } = await loadOptions(t, {
    settings: APPROVED_SETTINGS, status: { host: "connected", broker: "up", applied: 3 },
  });
  byId("tg-amazon.com").focus();
  const old = byId("tg-amazon.com");
  const live = byId("host-line");
  const before = live.mutations;
  await write({ status: { ...local.data.status, applied: 9 } });
  assert.notStrictEqual(byId("tg-amazon.com"), old, "re-rendered");
  assert.strictEqual(doc.activeElement.id, "tg-amazon.com", "focus restored by id");
  assert.ok(doc.activeElement.isConnected);
  assert.strictEqual(live.mutations, before, "host/broker text didn't change, so no re-announcement");
  await write({ status: { ...local.data.status, broker: "down" } });
  assert.ok(live.mutations > before, "a broker change IS announced");
});

test("options.html provides every mount point the script renders into", () => {
  const html = fs.readFileSync(path.join(EXT, "options.html"), "utf8");
  for (const id of MOUNTS) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /id="host-line"[^>]*aria-live="polite"|aria-live="polite"[^>]*id="host-line"/);
  assert.ok(!/id="status"[^>]*aria-live/.test(html), "the stats strip is not a live region (it would re-announce counts)");
});

test("V2-2: an elevated broker (status reason) shows its fix on the review page", async (t) => {
  const { mod } = await loadOptions(t);
  const hint = mod.statusView({ approved: true }, { host: "connected", broker: "down", error: "broker elevated" }).hint;
  assert.match(hint, /running elevated/);
  assert.match(hint, /npm run broker:stop/);
  assert.match(hint, /BROWSER_RELAY_BROKER_DEELEVATE=off/);
  assert.match(mod.statusView({ approved: true }, { host: "connected", broker: "down" }).hint, /isn't running/, "a plain down broker keeps its hint");
});
