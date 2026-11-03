// core-importer.test.js — W2F: the broker's cookie import
// (src/cookie-bridge/importer.js). Fake supervisor + fake CDP; the real-Brave
// round trip is core-real-brave.test.js.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { CookieImporter } = require("../../src/cookie-bridge/importer.js");

const SECRET = "SENTINEL-c00kie-VALUE-9f2b";
const FAR = 1893456000; // 2030

const ck = (over = {}) => ({
  name: "sid", value: SECRET, domain: ".example.com", hostOnly: false, path: "/", secure: true, httpOnly: true,
  sameSite: "lax", session: false, expirationDate: FAR, storeId: "0", ...over,
});

function fakeSupervisor(up = false) {
  const sup = new EventEmitter();
  sup.up = up;
  sup.isUp = () => sup.up;
  return sup;
}

/**
 * Records every CDP call; `refuse(param)` → true makes Storage.setCookies fail
 * for a batch holding it. hang: openCdp never resolves; hangSend: send never
 * answers.
 */
function fakeCdp({ refuse = () => false, hang = false, hangSend = false } = {}) {
  const calls = [];
  const opened = [];
  const openCdp = async (cdpUrl) => {
    if (hang) return new Promise(() => {});
    const conn = {
      closed: false,
      async send(method, params) {
        if (hangSend) return new Promise(() => {});
        const ok = !(method === "Storage.setCookies" && params.cookies.some(refuse));
        calls.push({ method, ok, params: JSON.parse(JSON.stringify(params)) });
        if (!ok) throw new Error("Invalid cookie fields");
        return {};
      },
      close() { conn.closed = true; },
    };
    opened.push(cdpUrl);
    return conn;
  };
  // cookies Brave accepted (a refused batch stores nothing)
  const set = () => calls.filter((c) => c.method === "Storage.setCookies" && c.ok).flatMap((c) => c.params.cookies);
  return { calls, opened, openCdp, set, live: () => set().filter((p) => p.expires !== 1), expired: () => set().filter((p) => p.expires === 1) };
}

function make({ up = false, cdp = fakeCdp(), now = () => 1_800_000_000_000, ...opts } = {}) {
  const logs = [];
  const supervisor = fakeSupervisor(up);
  const imp = new CookieImporter({ supervisor, log: (m) => logs.push(m), openCdp: cdp.openCdp, now, ...opts });
  return { imp, supervisor, cdp, logs };
}

test("importer: Brave down → the full sync is kept in memory only (no Brave launch, no CDP)", async () => {
  const { imp, cdp } = make();
  const r = await imp.full("b1", [ck(), ck({ name: "other", domain: "shop.example.net", hostOnly: true })], true);
  assert.deepStrictEqual(r, { applied: 2, rejected: [] });
  assert.strictEqual(cdp.opened.length, 0);
  assert.deepStrictEqual(imp.status().cookies, 2);
});

test("importer: deny and hold domains are rejected broker-side unless the cookie carries userOverride:true", async () => {
  const { imp } = make();
  const r = await imp.full("b1", [
    ck({ domain: ".chase.com" }), ck({ domain: "secure.chase.com", name: "b" }), ck({ domain: ".mybank.example" }),
    ck({ domain: ".paypal.com", userOverride: true }), ck({ domain: ".amazon.com" }), ck({ domain: "" }),
  ], true);
  assert.strictEqual(r.applied, 2);
  assert.deepStrictEqual(r.rejected, [
    { domain: "chase.com", reason: "deny:finance", count: 1 },
    { domain: "secure.chase.com", reason: "deny:finance", count: 1 },
    { domain: "mybank.example", reason: "hold:keyword", count: 1 },
    { domain: "", reason: "malformed cookie (domain)", count: 1 },
  ]);
  // userOverride must be exactly true
  const r2 = await imp.full("b1", [ck({ domain: ".chase.com", userOverride: "true" })], true);
  assert.strictEqual(r2.applied, 0);
});

test("importer: braveReady applies the whole snapshot to a new Brave once per launch, mapped for CDP", async () => {
  const { imp, cdp, supervisor } = make();
  await imp.full("b1", [ck(), ck({ name: "host", domain: "www.example.com", hostOnly: true, sameSite: "no_restriction", session: true, expirationDate: undefined })], true);
  supervisor.up = true;
  await imp.braveReady({ cdpUrl: "http://127.0.0.1:12345", pid: 100 });
  const live = cdp.live();
  assert.deepStrictEqual(live.map((p) => p.name).sort(), ["host", "sid"]);
  const host = live.find((p) => p.name === "host");
  assert.deepStrictEqual(host, { name: "host", value: SECRET, url: "https://www.example.com/", path: "/", secure: true, httpOnly: true, sameSite: "None" });
  // the same Brave again (every tool call ensures it): nothing new
  await imp.braveReady({ cdpUrl: "http://127.0.0.1:12345", pid: 100 });
  assert.strictEqual(cdp.live().length, 2);
  // relaunch (down, then the same or a new PID): applied again (session cookies don't survive restarts)
  supervisor.emit("down", "closed");
  await imp.braveReady({ cdpUrl: "http://127.0.0.1:12345", pid: 100 });
  assert.strictEqual(cdp.live().length, 4);
  await imp.braveReady({ cdpUrl: "http://127.0.0.1:12345", pid: 101 });
  assert.strictEqual(cdp.live().length, 6);
});

test("importer: concurrent braveReady calls for one launch share one apply", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck()], true);
  const before = cdp.live().length;
  await Promise.all([1, 2, 3].map(() => imp.braveReady({ pid: 7 })));
  assert.strictEqual(cdp.live().length - before, 1);
});

test("importer: with an empty snapshot braveReady opens no CDP connection", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.braveReady({ pid: 1 });
  assert.strictEqual(cdp.opened.length, 0);
});

test("importer: Brave up → a full sync is applied before the reply", async () => {
  const { imp, cdp } = make({ up: true });
  const r = await imp.full("b1", [ck()], true);
  assert.strictEqual(r.applied, 1);
  assert.deepStrictEqual(cdp.live().map((p) => p.name), ["sid"]);
});

test("importer: big syncs go to CDP in batches", async () => {
  const { imp, cdp } = make({ up: true, batchSize: 50 });
  await imp.full("b1", Array.from({ length: 120 }, (_, i) => ck({ name: `c${i}` })), true);
  const sizes = cdp.calls.filter((c) => c.method === "Storage.setCookies" && c.ok).map((c) => c.params.cookies.length);
  assert.deepStrictEqual(sizes, [50, 50, 20]);
});

test("importer: a batched full sync (last:false … last:true) expires the cookies the new full no longer has", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ name: "a" }), ck({ name: "b" }), ck({ name: "c" })], true);
  await imp.full("b1", [ck({ name: "a" })], false);
  assert.strictEqual(cdp.expired().length, 0, "nothing deleted before the last batch");
  await imp.full("b1", [ck({ name: "c" })], true);
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["b"]);
  assert.strictEqual(imp.status().cookies, 2);
});

test("importer: a full sync left unfinished by a closed bridge doesn't leak into the next one", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ name: "a" }), ck({ name: "b" })], true);
  await imp.full("b1", [ck({ name: "b" })], false);
  imp.connClosed("b1");
  await imp.full("b2", [ck({ name: "a" })], true);
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["b"]);
});

test("importer: deltas — an add sets; a removal expires the cookie in Brave, synced by this broker or not (deleting is always safe)", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ name: "a" })], true);
  const r = await imp.delta([
    { removed: false, cause: "explicit", cookie: ck({ name: "b" }) },
    { removed: true, cause: "explicit", cookie: ck({ name: "a" }) },
    { removed: true, cause: "explicit", cookie: ck({ name: "synced-by-an-earlier-broker" }) },
  ]);
  assert.deepStrictEqual(r, { applied: 3, rejected: [] });
  assert.deepStrictEqual(cdp.live().map((p) => p.name), ["a", "b"]);
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a", "synced-by-an-earlier-broker"]);
  assert.strictEqual(imp.status().cookies, 1);
});

test("importer: an overwrite (removed + added for one cookie) becomes one set, never a delete", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ name: "a" })], true);
  const before = cdp.live().length;
  await imp.delta([
    { removed: true, cause: "overwrite", cookie: ck({ name: "a" }) },
    { removed: false, cause: "explicit", cookie: ck({ name: "a", value: "new-" + SECRET }) },
  ]);
  assert.strictEqual(cdp.expired().length, 0);
  assert.strictEqual(cdp.live().length - before, 1);
  assert.strictEqual(cdp.live().at(-1).value, "new-" + SECRET);
});

test("importer: an add for a deny or hold domain is rejected and never reaches Brave", async () => {
  const { imp, cdp } = make({ up: true });
  const r = await imp.delta([
    { removed: false, cause: "explicit", cookie: ck({ domain: ".coinbase.com" }) },
    { removed: false, cause: "explicit", cookie: ck({ domain: ".coinbase.com", name: "x" }) },
    { removed: false, cause: "explicit", cookie: ck({ domain: ".mybank.example" }) },
  ]);
  assert.strictEqual(r.applied, 0);
  assert.deepStrictEqual(r.rejected, [{ domain: "coinbase.com", reason: "deny:finance", count: 2 }, { domain: "mybank.example", reason: "hold:keyword", count: 1 }]);
  assert.strictEqual(cdp.calls.length, 0);
});

test("importer: a removal for a deny domain is accepted when the bridge manages that cookie, or the removal carries userOverride", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ domain: ".paypal.com", userOverride: true })], true);
  assert.strictEqual(imp.status().cookies, 1);
  const r = await imp.delta([
    { removed: true, cause: "explicit", cookie: ck({ domain: ".paypal.com" }) }, // managed: accepted without the flag
    { removed: true, cause: "explicit", cookie: ck({ domain: ".venmo.com", name: "y", userOverride: true }) }, // flagged
  ]);
  assert.deepStrictEqual(r, { applied: 2, rejected: [] });
  assert.deepStrictEqual(cdp.expired().map((p) => [p.name, p.domain]), [["sid", ".paypal.com"], ["y", ".venmo.com"]]);
  assert.strictEqual(imp.status().cookies, 0);
});

test("importer: Chrome removing a deny-domain cookie the bridge never synced leaves Brave's own cookie alone", async () => {
  const { imp, cdp } = make({ up: true });
  const r = await imp.delta([
    { removed: true, cause: "explicit", cookie: ck({ domain: ".chase.com", name: "y" }) },
    { removed: true, cause: "expired", cookie: ck({ domain: ".mybank.example", name: "z" }) },
  ]);
  assert.strictEqual(r.applied, 0);
  assert.deepStrictEqual(r.rejected.map((x) => [x.domain, x.reason]), [["chase.com", "deny:finance"], ["mybank.example", "hold:keyword"]]);
  assert.strictEqual(cdp.calls.length, 0);
});

test("importer: a partitioned cookie is also judged by its top-level site (deny/hold without userOverride → refused)", async () => {
  const { imp, cdp } = make({ up: true });
  const part = (over) => ck({ name: "p", sameSite: "no_restriction", partitionKey: { topLevelSite: "https://chase.com" }, ...over });
  const r = await imp.full("b1", [part(), part({ name: "q", partitionKey: { topLevelSite: "https://amazon.com", hasCrossSiteAncestor: false } })], true);
  assert.deepStrictEqual(r, { applied: 1, rejected: [{ domain: "chase.com", reason: "deny:finance", count: 1 }] });
  const r2 = await imp.full("b1", [part({ userOverride: true }), part({ name: "q", partitionKey: { topLevelSite: "https://amazon.com" } })], true);
  assert.strictEqual(r2.applied, 2);
  assert.ok(cdp.live().some((p) => p.name === "p" && p.partitionKey.topLevelSite === "https://chase.com"));
});

test("importer: delta during a batched full sync — an add isn't swept as stale, a removal or newer value isn't undone by a later batch", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ name: "a" }), ck({ name: "b" })], true);
  // the extension read all cookies at t0 and sends them in batches; Chrome changes meanwhile
  await imp.full("b1", [ck({ name: "a" })], false);
  await imp.delta([
    { removed: false, cause: "explicit", cookie: ck({ name: "x" }) }, // new in Chrome
    { removed: true, cause: "explicit", cookie: ck({ name: "b" }) }, // gone from Chrome
    { removed: false, cause: "explicit", cookie: ck({ name: "a", value: "newer-" + SECRET }) },
  ]);
  const before = cdp.live().length;
  await imp.full("b1", [ck({ name: "b" }), ck({ name: "a" })], true); // stale reads from t0
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["b"], "x not swept, b expired once");
  assert.strictEqual(cdp.live().length, before, "the stale b and a were not set again");
  assert.strictEqual(cdp.live().filter((p) => p.name === "a").at(-1).value, "newer-" + SECRET);
  assert.strictEqual(imp.status().cookies, 2); // a, x
});

test("importer: a CDP failure while Brave is up is reported as not applied, and the next ensure re-applies the snapshot", async () => {
  let fail = true;
  const cdp = fakeCdp();
  const inner = cdp.openCdp;
  cdp.openCdp = async () => { if (fail) throw new Error("connect ECONNREFUSED"); return inner(); };
  const { imp } = make({ up: true, cdp });
  await imp.braveReady({ pid: 5 }); // nothing to apply yet: memoized for pid 5
  await assert.rejects(imp.full("b1", [ck()], true), (e) => /not applied/i.test(e.message) && !e.message.includes(SECRET));
  assert.strictEqual(imp.status().cookies, 1, "kept in the snapshot");
  fail = false;
  await imp.braveReady({ pid: 5 }); // same Brave: applied again after the failure
  assert.deepStrictEqual(cdp.live().map((p) => p.name), ["sid"]);
});

test("importer: a braveReady apply that fails after its timeout still clears the memo for that Brave", async () => {
  let rejectOpen;
  let opens = 0;
  const cdp = fakeCdp();
  const inner = cdp.openCdp;
  cdp.openCdp = async () => { opens++; if (opens === 1) return new Promise((_, reject) => { rejectOpen = reject; }); return inner(); };
  const { imp } = make({ cdp, applyTimeoutMs: 50 });
  await imp.full("b1", [ck()], true); // Brave down: kept for the launch
  await imp.braveReady({ pid: 8 }); // times out
  rejectOpen(new Error("late failure"));
  await new Promise((r) => setTimeout(r, 20));
  await imp.braveReady({ pid: 8 });
  assert.deepStrictEqual(cdp.live().map((p) => p.name), ["sid"]);
});

test("importer: a stuck CDP send (Brave hung mid-apply) never blocks a tool call past applyTimeoutMs", async () => {
  const cdp = fakeCdp({ hangSend: true });
  const { imp, supervisor } = make({ cdp, applyTimeoutMs: 100 });
  await imp.full("b1", [ck()], true);
  supervisor.up = true;
  const t0 = Date.now();
  await imp.braveReady({ pid: 4 });
  assert.ok(Date.now() - t0 < 1000);
});

test("importer: one bridge at a time — a second concurrent bridge is refused (EBUSY) until the first closes", () => {
  const { imp } = make();
  const h1 = imp.handlers("b1");
  assert.throws(() => imp.handlers("b2"), (e) => e.code === "EBUSY" && /already connected/.test(e.message));
  h1.close();
  assert.doesNotThrow(() => imp.handlers("b2"));
});

// ── the bridge-managed key set, persisted across broker restarts ──

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function stateDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-w2f-state-"));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test("importer state: a broker restart forgets nothing — a full resync expires managed cookies Chrome no longer has", async (t) => {
  const file = path.join(stateDir(t), "cookie-bridge-x.json");
  const first = make({ up: true, stateFile: file });
  await first.imp.full("b1", [
    ck({ name: "a" }),
    ck({ name: "b", domain: "www.shop.example", hostOnly: true }),
    ck({ name: "c", sameSite: "no_restriction", partitionKey: { topLevelSite: "https://amazon.com" } }),
  ], true);
  const saved = fs.readFileSync(file, "utf8");
  assert.ok(!saved.includes(SECRET), "never a value on disk");
  assert.deepStrictEqual(JSON.parse(saved).managed.map((m) => m.name).sort(), ["a", "b", "c"]);
  // the broker exits; Chrome deletes b and c meanwhile; a new broker starts
  const second = make({ up: true, stateFile: file });
  assert.strictEqual(second.imp.status().managed, 3);
  await second.imp.full("b1", [ck({ name: "a" })], true);
  assert.deepStrictEqual(second.cdp.expired().map((p) => p.name).sort(), ["b", "c"]);
  const host = second.cdp.expired().find((p) => p.name === "b");
  assert.deepStrictEqual([host.url, host.domain], ["https://www.shop.example/", undefined], "expired by its own identity (host-only)");
  assert.deepStrictEqual(second.cdp.expired().find((p) => p.name === "c").partitionKey, { topLevelSite: "https://amazon.com", hasCrossSiteAncestor: false });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).managed.map((m) => m.name), ["a"]);
});

test("importer state: deletions queued while Brave is down survive a restart and apply at the next launch; kept until that Brave wrote them to disk", async (t) => {
  const file = path.join(stateDir(t), "cookie-bridge-x.json");
  let now = 1_800_000_000_000;
  const first = make({ stateFile: file, now: () => now }); // Brave down
  await first.imp.full("b1", [ck({ name: "a" }), ck({ name: "b" })], true);
  await first.imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "a" }) }]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).pendingDeletes.map((m) => m.name), ["a"]);
  const second = make({ stateFile: file, now: () => now });
  second.supervisor.up = true;
  await second.imp.braveReady({ pid: 1 });
  assert.deepStrictEqual(second.cdp.expired().map((p) => p.name), ["a"]);
  // applied, but Chromium may not have written it yet: a broker killed now re-applies it
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).pendingDeletes.map((m) => m.name), ["a"]);
  now += 60_000; // that Brave held it for the flush interval
  second.supervisor.emit("down", "closed");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).pendingDeletes, []);
});

test("importer state: written atomically (no temp file left), private, and a corrupt file starts empty (logged)", async (t) => {
  const dir = stateDir(t);
  const file = path.join(dir, "cookie-bridge-x.json");
  const { imp } = make({ stateFile: file });
  await imp.full("b1", [ck()], true);
  assert.deepStrictEqual(fs.readdirSync(dir), ["cookie-bridge-x.json"]);
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(file).mode & 0o077, 0);
  fs.writeFileSync(file, "{not json " + SECRET);
  const again = make({ stateFile: file });
  assert.strictEqual(again.imp.status().managed, 0);
  assert.ok(again.logs.some((l) => /state/.test(l)), again.logs.join("\n"));
  assert.ok(!again.logs.join("\n").includes(SECRET));
});

test("importer state: no state file is written when nothing was ever synced", (t) => {
  const dir = stateDir(t);
  make({ stateFile: path.join(dir, "cookie-bridge-x.json") });
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test("importer: a removal still has to be a well-formed cookie", async () => {
  const { imp, cdp } = make({ up: true });
  const r = await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ domain: "" }) }]);
  assert.deepStrictEqual(r, { applied: 0, rejected: [{ domain: "", reason: "malformed cookie (domain)", count: 1 }] });
  assert.strictEqual(cdp.calls.length, 0);
});

test("importer: an add replaces the synced cookie with the same name/domain/path/partition (Chrome's overwrite arrives as the add only)", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ name: "a" })], true);
  await imp.delta([{ removed: false, cause: "explicit", cookie: ck({ name: "a", value: "new-" + SECRET, secure: true, httpOnly: false }) }]);
  assert.strictEqual(imp.status().cookies, 1);
  assert.strictEqual(cdp.expired().length, 0);
  const last = cdp.live().at(-1);
  assert.deepStrictEqual([last.name, last.value, last.httpOnly], ["a", "new-" + SECRET, false]);
  // and at the next launch only the new value is applied
  imp.braveDown();
  await imp.braveReady({ pid: 2 });
  assert.deepStrictEqual(cdp.live().slice(-1).map((p) => p.value), ["new-" + SECRET]);
});

test("importer: a delta re-adding an expired-in-the-past cookie is a removal", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ name: "a" })], true);
  await imp.delta([{ removed: false, cause: "explicit", cookie: ck({ name: "a", expirationDate: 10 }) }]);
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a"]);
  assert.strictEqual(imp.status().cookies, 0);
});

test("importer: deletions while Brave is down are applied at the next launch, then forgotten once that Brave wrote them to disk", async () => {
  let now = 1_800_000_000_000;
  const { imp, cdp, supervisor } = make({ now: () => now });
  await imp.full("b1", [ck({ name: "a" }), ck({ name: "b" })], true);
  await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "a" }) }]);
  assert.strictEqual(cdp.opened.length, 0);
  supervisor.up = true;
  await imp.braveReady({ pid: 1 });
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a"]);
  assert.deepStrictEqual(cdp.live().map((p) => p.name), ["b"]);
  now += 60_000; // Chromium commits cookies every 30 s: this Brave has it on disk
  supervisor.emit("down", "closed");
  await imp.braveReady({ pid: 2 });
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a"], "a later launch must not delete it again (it may be the agent's own cookie by then)");
});

test("importer: a deletion Brave may not have written to disk (it died within the flush interval) is applied again at the relaunch", async () => {
  let now = 1_800_000_000_000;
  const { imp, cdp, supervisor } = make({ up: true, now: () => now });
  await imp.braveReady({ pid: 1 });
  await imp.full("b1", [ck({ name: "a" }), ck({ name: "b" })], true);
  await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "a" }) }]); // applied at once
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a"]);
  now += 5_000;
  supervisor.emit("down", "exited (pid gone)"); // killed 5 s later: the deletion may be lost
  now += 600_000; // however long until the next tool call
  await imp.braveReady({ pid: 2 });
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a", "a"], "re-applied to the relaunched Brave");
  // this one stays up long enough: no third time
  now += 60_000;
  supervisor.emit("down", "closed");
  await imp.braveReady({ pid: 3 });
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a", "a"]);
  // and Chrome re-adding the cookie drops its tombstone at once
  await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "b" }) }]);
  await imp.delta([{ removed: false, cause: "explicit", cookie: ck({ name: "b" }) }]);
  supervisor.emit("down", "exited (pid gone)");
  await imp.braveReady({ pid: 4 });
  const last = cdp.calls.filter((c) => c.method === "Storage.setCookies" && c.ok).slice(-2).flatMap((c) => c.params.cookies);
  assert.ok(!last.some((p) => p.name === "b" && p.expires === 1), "the re-synced b is never deleted by its old tombstone");
});

test("importer: expired cookies are dropped, not applied at a later launch", async () => {
  let now = 1_800_000_000_000;
  const { imp, cdp, supervisor } = make({ now: () => now });
  await imp.full("b1", [ck({ name: "soon", expirationDate: 1_800_000_100 }), ck({ name: "later" })], true);
  now = 1_800_000_200_000;
  supervisor.up = true;
  await imp.braveReady({ pid: 1 });
  assert.deepStrictEqual(cdp.live().map((p) => p.name), ["later"]);
  assert.strictEqual(imp.status().cookies, 1);
});

test("importer: a cookie Brave refuses is isolated (per-cookie retry), reported rejected and dropped", async () => {
  const cdp = fakeCdp({ refuse: (p) => p.name === "bad" });
  const { imp } = make({ up: true, cdp });
  const r = await imp.full("b1", [ck({ name: "a" }), ck({ name: "bad", domain: ".weird.example" }), ck({ name: "c" })], true);
  assert.deepStrictEqual(r, { applied: 2, rejected: [{ domain: "weird.example", reason: "brave refused the cookie", count: 1 }] });
  assert.deepStrictEqual(cdp.live().map((p) => p.name).sort(), ["a", "c"]);
  assert.strictEqual(imp.status().cookies, 2);
});

test("importer: a stuck CDP never blocks a tool call past applyTimeoutMs", async () => {
  const cdp = fakeCdp({ hang: true });
  const { imp, logs } = make({ up: true, cdp, applyTimeoutMs: 100 });
  await imp.full("b1", [ck()], true).catch(() => {});
  const t0 = Date.now();
  await imp.braveReady({ pid: 9 });
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(logs.some((l) => /timed out|still applying/i.test(l)), logs.join("\n"));
});

test("importer: cookie values never appear in the log, the replies or status()", async () => {
  const cdp = fakeCdp({ refuse: (p) => p.name === "bad" });
  const { imp, logs, supervisor } = make({ cdp });
  const out = [];
  out.push(await imp.full("b1", [ck(), ck({ name: "bad" }), ck({ domain: ".chase.com" }), ck({ path: "x" })], true));
  supervisor.up = true;
  await imp.braveReady({ pid: 3 });
  out.push(await imp.delta([{ removed: false, cause: "explicit", cookie: ck({ name: "n" }) }, { removed: true, cookie: ck() }, { bogus: 1 }]));
  out.push(imp.status());
  const all = JSON.stringify(out) + "\n" + logs.join("\n");
  assert.ok(!all.includes(SECRET), all);
  assert.ok(logs.length > 0);
});

test("importer: status() — counts only: cookies, domains, bridges, pending deletes, last sync", async () => {
  const { imp } = make();
  const h = imp.handlers("b1");
  await h["cookies.full"]({ cookies: [ck(), ck({ name: "x", domain: ".other.example" })], last: true });
  const s = imp.status();
  assert.strictEqual(s.bridges, 1);
  assert.strictEqual(s.cookies, 2);
  assert.strictEqual(s.domains, 2);
  assert.strictEqual(typeof s.lastSyncAt, "string");
  h.close();
  assert.strictEqual(imp.status().bridges, 0);
});

test("importer: handlers validate the request shape", async () => {
  const { imp } = make();
  const h = imp.handlers("b1");
  await assert.rejects(h["cookies.full"]({ cookies: "nope" }), /cookies must be an array/);
  await assert.rejects(h["cookies.delta"]({ changes: null }), /changes must be an array/);
  const r = await h["cookies.delta"]({ changes: [{ removed: false }, 7] });
  assert.strictEqual(r.applied, 0);
  assert.strictEqual(r.rejected[0].reason, "malformed cookie (not an object)");
});

// ── v0.4.1 integration: W2G's 'pipe' signal, cookies_export's matcher, the always-allow list ──

test("importer (W2G): every 'pipe' (a launch came up) applies the snapshot with no tool call, and the ensureBrave that follows shares it", async () => {
  const { imp, cdp, supervisor } = make();
  await imp.full("b1", [ck(), ck({ name: "sess", session: true, expirationDate: undefined })], true);
  assert.strictEqual(cdp.opened.length, 0, "Brave down: nothing applied yet");
  supervisor.up = true;
  supervisor.pid = 300;
  supervisor.emit("pipe", {});
  const t0 = Date.now();
  while (cdp.live().length < 2 && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(cdp.live().map((p) => p.name).sort(), ["sess", "sid"]);
  await imp.braveReady({ pid: 300 }); // ensureBrave right after: the same launch, nothing new
  assert.strictEqual(cdp.live().length, 2);
  // Brave crashes and comes back with the SAME pid (Windows reuses them): still a new launch
  supervisor.emit("down", "exited (code=1)");
  supervisor.emit("pipe", {});
  await imp.braveReady({ pid: 300 });
  assert.strictEqual(cdp.live().length, 4, "re-applied to the relaunched Brave");
});

test("importer (W2G): a 'pipe' listener never throws into the supervisor's emit, even when the apply fails", async () => {
  const cdp = fakeCdp();
  cdp.openCdp = async () => { throw new Error("the broker's CDP endpoint: HTTP 503 (Brave is not running)"); };
  const { imp, supervisor, logs } = make({ cdp, applyTimeoutMs: 200 });
  await imp.full("b1", [ck()], true);
  supervisor.up = true;
  assert.doesNotThrow(() => supervisor.emit("pipe", {}));
  await imp.braveReady({ pid: 1 }); // waits for (and swallows) that failure
  const t0 = Date.now();
  while (!logs.some((l) => /HTTP 503/.test(l)) && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
  assert.ok(logs.some((l) => /HTTP 503/.test(l)), logs.join("\n"));
});

test("importer: managedMatcher() — the cookies_export check: bridge-managed name/domain/path, host-only and domain cookies, case-insensitive, any partition", async () => {
  const { imp } = make();
  assert.strictEqual(imp.managedMatcher()({ name: "sid", domain: ".example.com", path: "/" }), false, "nothing managed yet");
  await imp.full("b1", [
    ck(),
    ck({ name: "host", domain: "www.example.com", hostOnly: true, path: "/app" }),
    ck({ name: "part", sameSite: "no_restriction", partitionKey: { topLevelSite: "https://top.example" } }),
  ], true);
  const m = imp.managedMatcher();
  // as Playwright's context.cookies() reports them
  assert.strictEqual(m({ name: "sid", domain: ".example.com", path: "/", value: "x" }), true);
  assert.strictEqual(m({ name: "sid", domain: ".EXAMPLE.com", path: "/" }), true);
  assert.strictEqual(m({ name: "host", domain: "www.example.com", path: "/app" }), true, "host-only: no leading dot");
  assert.strictEqual(m({ name: "part", domain: ".example.com", path: "/", partitionKey: "https://other.example" }), true, "the partition is ignored (a doubt hides)");
  assert.strictEqual(m({ name: "sid", domain: "example.com", path: "/" }), false, "a host-only twin is a different cookie");
  assert.strictEqual(m({ name: "host", domain: "www.example.com", path: "/" }), false, "another path");
  assert.strictEqual(m({ name: "brave-own", domain: ".example.com", path: "/" }), false, "Brave's own cookie");
  assert.strictEqual(m(null), false);
  // Chrome deletes one: still hidden (the bridge put a value there; the deletion may not have landed)
  await imp.delta([{ removed: true, cause: "explicit", cookie: ck() }]);
  assert.strictEqual(imp.status().managed, 2);
  assert.strictEqual(imp.managedMatcher()({ name: "sid", domain: ".example.com", path: "/" }), true);
});

test("importer: managedMatcher() also hides a cookie whose update Brave refused (Brave still holds the bridge's earlier value) and one loaded from an earlier broker's state", async (t) => {
  let refuse = false;
  const cdp = fakeCdp({ refuse: () => refuse });
  const { imp } = make({ up: true, cdp });
  await imp.braveReady({ pid: 1 });
  await imp.full("b1", [ck()], true); // applied
  refuse = true;
  await imp.delta([{ removed: false, cause: "explicit", cookie: ck({ value: "newer" }) }]); // refused: dropped from the managed set
  assert.strictEqual(imp.status().managed, 0);
  assert.strictEqual(imp.managedMatcher()({ name: "sid", domain: ".example.com", path: "/" }), true);
  const file = path.join(stateDir(t), "cookie-bridge-x.json");
  const first = make({ stateFile: file });
  await first.imp.full("b1", [ck({ name: "old" })], true);
  const second = make({ stateFile: file });
  assert.strictEqual(second.imp.managedMatcher()({ name: "old", domain: ".example.com", path: "/" }), true);
});

test("importer: a deletion lost in a crash is applied again at the relaunch even when the snapshot is empty", async () => {
  let now = 1_800_000_000_000;
  const { imp, cdp, supervisor } = make({ now: () => now });
  await imp.full("b1", [ck()], true); // Brave down: in memory only
  await imp.delta([{ removed: true, cause: "explicit", cookie: ck() }]); // snapshot now empty, deletion pending
  supervisor.up = true;
  await imp.braveReady({ pid: 1 });
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["sid"]);
  now += 5_000;
  supervisor.emit("down", "exited (pid gone)"); // within Chromium's flush interval
  await imp.braveReady({ pid: 2 });
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["sid", "sid"], "re-applied although nothing is left to set");
});

test("importer: the always-allow list never lets a Chrome deletion reach a held-domain cookie the bridge didn't put into Brave", async () => {
  const policy = require("../../extensions/cookie-bridge/policy.js");
  const { allow } = policy.parseAllowList("pay.example.com");
  const { imp, cdp } = make({ up: true, allow });
  const r = await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ domain: ".pay.example.com", name: "brave-own" }) }]);
  assert.deepStrictEqual(r.rejected.map((x) => [x.domain, x.reason]), [["pay.example.com", "hold:keyword"]]);
  assert.strictEqual(cdp.calls.length, 0);
  // one it did put there is deleted as usual
  await imp.full("b1", [ck({ domain: ".pay.example.com", name: "synced" })], true);
  const d = await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ domain: ".pay.example.com", name: "synced" }) }]);
  assert.strictEqual(d.applied, 1);
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["synced"]);
});

test("importer: the owner's always-allow list lets a keyword-held domain in broker-side, never a denied one", async () => {
  const policy = require("../../extensions/cookie-bridge/policy.js");
  const { allow } = policy.parseAllowList("pay.example.com, chase.com");
  const { imp } = make({ allow });
  const r = await imp.full("b1", [
    ck({ domain: ".pay.example.com" }),
    ck({ domain: "checkout.pay.example.com", hostOnly: true, name: "h" }),
    ck({ domain: ".chase.com", name: "bank" }),
    ck({ domain: ".mybank.example", name: "held" }),
  ], true);
  assert.strictEqual(r.applied, 2);
  assert.deepStrictEqual(r.rejected.map((x) => [x.domain, x.reason]), [["chase.com", "deny:finance"], ["mybank.example", "hold:keyword"]]);
  assert.deepStrictEqual(imp.status().allow, ["pay.example.com", "chase.com"], "broker:status shows the list it read");
});
