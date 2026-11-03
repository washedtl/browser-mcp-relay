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

/** Records every CDP call; `refuse(param)` → true makes Storage.setCookies fail for a batch holding it. */
function fakeCdp({ refuse = () => false, hang = false } = {}) {
  const calls = [];
  const opened = [];
  const openCdp = async (cdpUrl) => {
    if (hang) return new Promise(() => {});
    const conn = {
      closed: false,
      async send(method, params) {
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
  const imp = new CookieImporter({ supervisor, cdpUrl: "http://127.0.0.1:12345", log: (m) => logs.push(m), openCdp: cdp.openCdp, now, ...opts });
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

test("importer: a removal for a deny domain is accepted, with or without userOverride (the owner unticked a re-allowed domain)", async () => {
  const { imp, cdp } = make({ up: true });
  await imp.full("b1", [ck({ domain: ".paypal.com", userOverride: true })], true);
  assert.strictEqual(imp.status().cookies, 1);
  const r = await imp.delta([
    { removed: true, cause: "explicit", cookie: ck({ domain: ".paypal.com", userOverride: true }) },
    { removed: true, cause: "explicit", cookie: ck({ domain: ".chase.com", name: "y" }) },
  ]);
  assert.deepStrictEqual(r, { applied: 2, rejected: [] });
  assert.deepStrictEqual(cdp.expired().map((p) => [p.name, p.domain]), [["sid", ".paypal.com"], ["y", ".chase.com"]]);
  assert.strictEqual(imp.status().cookies, 0);
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

test("importer: deletions while Brave is down are applied once at the next launch, then forgotten", async () => {
  const { imp, cdp, supervisor } = make();
  await imp.full("b1", [ck({ name: "a" }), ck({ name: "b" })], true);
  await imp.delta([{ removed: true, cause: "explicit", cookie: ck({ name: "a" }) }]);
  assert.strictEqual(cdp.opened.length, 0);
  supervisor.up = true;
  await imp.braveReady({ pid: 1 });
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a"]);
  assert.deepStrictEqual(cdp.live().map((p) => p.name), ["b"]);
  supervisor.emit("down", "closed");
  await imp.braveReady({ pid: 2 });
  assert.deepStrictEqual(cdp.expired().map((p) => p.name), ["a"], "a later launch must not delete it again (it may be the agent's own cookie by then)");
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
