// ext-policy.test.js — W2F-ext: what syncs. allow syncs; deny + hold don't;
// the owner's per-domain toggles override that (userOverride:true on
// re-allowed deny/hold cookies); keyword-held domains that appear after
// approval wait on the review page with a badge. policy.js is W2F-core's,
// so a fake classifier stands in (ext-fakes.js).

const test = require("node:test");
const assert = require("node:assert");

const { makeEnv, cookie, fakeClassify, APPROVED } = require("./ext-fakes.js");
const core = require("../../extensions/cookie-bridge/bridge-core.js");
const { createBridge, decide, cookieDecision, buildReviewModel, toggleOverride, markReviewed, normDomain } = core;

const S = (over = {}) => ({ approved: true, paused: false, overrides: {}, reviewed: {}, ...over });

async function syncedOnce(env) {
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  return { bridge, sent: env.port.ofType("full").flatMap((m) => m.cookies) };
}

test("normDomain strips leading dots, lowercases and trims", () => {
  assert.strictEqual(normDomain("..WWW.Amazon.COM "), "www.amazon.com");
  assert.strictEqual(normDomain(".github.com"), "github.com");
});

test("decide: allow syncs; deny and hold don't", () => {
  assert.strictEqual(decide(".amazon.com", fakeClassify, S()).sync, true);
  assert.strictEqual(decide(".chase.com", fakeClassify, S()).sync, false);
  assert.strictEqual(decide("mybank.example", fakeClassify, S()).sync, false);
  assert.strictEqual(decide(".amazon.com", fakeClassify, S()).userOverride, false);
});

test("decide: re-allowing a deny or hold domain syncs it with userOverride", () => {
  const s = S({ overrides: { "chase.com": "on", "mybank.example": "on" } });
  assert.deepStrictEqual([decide(".chase.com", fakeClassify, s).sync, decide(".chase.com", fakeClassify, s).userOverride], [true, true]);
  assert.deepStrictEqual([decide("mybank.example", fakeClassify, s).sync, decide("mybank.example", fakeClassify, s).userOverride], [true, true]);
  // re-allow is exact: a subdomain of a re-allowed deny domain is still blocked
  assert.strictEqual(decide("secure.chase.com", fakeClassify, s).sync, false);
});

test("decide: unticking a domain blocks it and its subdomains; an exact tick on a subdomain wins", () => {
  const s = S({ overrides: { "reddit.com": "off" } });
  assert.strictEqual(decide("reddit.com", fakeClassify, s).sync, false);
  assert.strictEqual(decide(".old.reddit.com", fakeClassify, s).sync, false, "new subdomains stay unticked");
  assert.strictEqual(decide("notreddit.com", fakeClassify, s).sync, true);
  const s2 = S({ overrides: { "reddit.com": "off", "www.reddit.com": "on" } });
  assert.strictEqual(decide("www.reddit.com", fakeClassify, s2).sync, true);
});

test("decide fails closed: a throwing classifier, an unknown decision or no classifier never syncs", () => {
  assert.strictEqual(decide("a.com", () => { throw new Error("boom"); }, S()).sync, false);
  assert.strictEqual(decide("a.com", () => ({ decision: "maybe" }), S()).sync, false);
  assert.strictEqual(decide("a.com", null, S()).sync, false);
  assert.strictEqual(decide("a.com", () => { throw new Error("boom"); }, S()).cls.decision, "deny");
});

test("cookieDecision: a partitioned cookie also needs its top-level site to be syncable", () => {
  const underBank = cookie("widget.example", "p", { partitionKey: { topLevelSite: "https://chase.com" } });
  const underShop = cookie("widget.example", "p", { partitionKey: { topLevelSite: "https://amazon.com" } });
  assert.strictEqual(cookieDecision(underBank, fakeClassify, S()).sync, false);
  assert.strictEqual(cookieDecision(underShop, fakeClassify, S()).sync, true);
  assert.strictEqual(cookieDecision(cookie("widget.example", "p", { partitionKey: {} }), fakeClassify, S()).sync, true);
});

test("full sync sends approved cookies as-is (partitioned ones too); re-allowed ones carry userOverride:true", async () => {
  const amazon = cookie(".amazon.com");
  const part = cookie("widget.example", "chips", { partitionKey: { topLevelSite: "https://amazon.com" } });
  const env = makeEnv({
    cookies: [amazon, part, cookie(".chase.com"), cookie("mybank.example")],
    storage: { settings: S({ overrides: { "chase.com": "on" } }) },
  });
  const { sent } = await syncedOnce(env);
  assert.deepStrictEqual(env.cookies.calls[0], { partitionKey: {} }, "getAll must ask for partitioned cookies too");
  const byDomain = Object.fromEntries(sent.map((c) => [c.domain + "|" + c.name, c]));
  assert.deepStrictEqual(byDomain[".amazon.com|sid"], amazon, "allowed cookie is chrome.cookies.Cookie as-is");
  assert.deepStrictEqual(byDomain["widget.example|chips"], part);
  assert.deepStrictEqual(byDomain[".chase.com|sid"], { ...cookie(".chase.com"), userOverride: true });
  assert.strictEqual(byDomain["mybank.example|sid"], undefined, "held domain without override stays home");
});

test("with no classifier (policy.js failed to load) nothing ever connects, and status says why", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com")], storage: APPROVED, classify: null });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(60_000);
  assert.strictEqual(env.ports.length, 0);
  assert.match(env.store.data.status.error, /policy/i);
});

test("a keyword-held domain that appears after approval waits for review: pending + badge, not sent", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com"), cookie("oldbank.example")],
    storage: { settings: S({ reviewed: { "oldbank.example": 1 } }) } });
  await syncedOnce(env);
  assert.deepStrictEqual(env.store.data.status.pending, [], "held domains the owner already saw aren't pending");
  assert.strictEqual(env.action.state.text, "");

  env.cookies.set(cookie("newbank.example"));
  env.cookies.set(cookie("paypal.com"));
  await env.clock.advance(1000);
  assert.deepStrictEqual(env.store.data.status.pending, ["newbank.example"], "deny domains never prompt");
  assert.strictEqual(env.action.state.text, "1");
  assert.strictEqual(env.port.ofType("delta").length, 0, "neither the held nor the deny cookie is sent");
});

test("a held domain still surfaces (pending + badge) while the host is down or not installed", async () => {
  const env = makeEnv({ cookies: [], storage: APPROVED });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  env.port.crash("Specified native messaging host not found.");
  env.cookies.set(cookie("newbank.example"));
  await env.clock.advance(200);
  assert.deepStrictEqual(env.store.data.status.pending, ["newbank.example"]);
  assert.strictEqual(env.action.state.text, "1");
});

test("a partitioned cookie blocked by a HELD top-level site puts that site up for review", async () => {
  const env = makeEnv({ cookies: [], storage: APPROVED });
  await syncedOnce(env);
  env.cookies.set(cookie("widget.example", "p", { partitionKey: { topLevelSite: "https://mybank.example" } }));
  await env.clock.advance(1000);
  assert.deepStrictEqual(env.store.data.status.pending, ["mybank.example"]);
  assert.strictEqual(env.port.ofType("delta").length, 0);
});

test("buildReviewModel: Will-sync totals count cookies the way the sync does (partition site included)", () => {
  const jar = [cookie(".amazon.com"), cookie("widget.example", "p", { partitionKey: { topLevelSite: "https://chase.com" } }),
    cookie("widget.example", "q")];
  const m = buildReviewModel(jar, fakeClassify, S());
  assert.strictEqual(m.totals.syncCookies, 2, "the cookie partitioned under a blocked bank site is not counted");
  assert.strictEqual(m.totals.syncDomains, 2);
});

test("held domains the owner never saw (e.g. after a policy update) become pending during a full sync", async () => {
  const env = makeEnv({ cookies: [cookie("taxhelper.example")], storage: { settings: S() } });
  await syncedOnce(env);
  assert.deepStrictEqual(env.store.data.status.pending, ["taxhelper.example"]);
  assert.strictEqual(env.action.state.text, "1");
});

test("'Keep held' clears the badge; allowing a pending domain sends its cookies with userOverride", async () => {
  const env = makeEnv({ cookies: [cookie("newbank.example"), cookie("wallet.example")], storage: { settings: S() } });
  await syncedOnce(env);
  assert.strictEqual(env.action.state.text, "2");

  await env.store.set({ settings: markReviewed(env.store.data.settings, ["wallet.example"], 5) });
  await env.clock.advance(1000);
  assert.deepStrictEqual(env.store.data.status.pending, ["newbank.example"]);
  assert.strictEqual(env.action.state.text, "1");

  await env.store.set({ settings: toggleOverride(env.store.data.settings, "newbank.example", true, fakeClassify, 6) });
  await env.clock.advance(1000);
  assert.deepStrictEqual(env.store.data.status.pending, []);
  assert.strictEqual(env.action.state.text, "");
  const changes = env.port.ofType("delta").flatMap((m) => m.changes);
  assert.deepStrictEqual(changes, [{ removed: false, cause: "explicit", cookie: { ...cookie("newbank.example"), userOverride: true } }]);
});

test("unticking a synced domain sends removals so the broker drops what it already has", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com", "a"), cookie("www.amazon.com", "b"), cookie("github.com")],
    storage: { settings: S() } });
  await syncedOnce(env);
  await env.store.set({ settings: toggleOverride(env.store.data.settings, "amazon.com", false, fakeClassify, 7) });
  await env.clock.advance(1000);
  const changes = env.port.ofType("delta").flatMap((m) => m.changes);
  assert.deepStrictEqual(changes.map((c) => [c.removed, c.cookie.domain]).sort(), [[true, ".amazon.com"], [true, "www.amazon.com"]]);
});

test("un-re-allowing a deny domain sends its removal WITH userOverride so the broker accepts it", async () => {
  const env = makeEnv({ cookies: [cookie(".chase.com")], storage: { settings: S({ overrides: { "chase.com": "on" } }) } });
  await syncedOnce(env);
  await env.store.set({ settings: toggleOverride(env.store.data.settings, "chase.com", false, fakeClassify, 8) });
  await env.clock.advance(1000);
  const changes = env.port.ofType("delta").flatMap((m) => m.changes);
  assert.deepStrictEqual(changes, [{ removed: true, cause: "explicit", cookie: { ...cookie(".chase.com"), userOverride: true } }]);
  assert.deepStrictEqual(env.store.data.settings.overrides, {}, "back to the default: no override stored");
});

test("toggleOverride stores only differences from the default and marks the domain reviewed", () => {
  let s = S();
  s = toggleOverride(s, "amazon.com", false, fakeClassify, 1);
  assert.deepStrictEqual(s.overrides, { "amazon.com": "off" });
  s = toggleOverride(s, "amazon.com", true, fakeClassify, 2);
  assert.deepStrictEqual(s.overrides, {});
  s = toggleOverride(s, "mybank.example", true, fakeClassify, 3);
  assert.deepStrictEqual(s.overrides, { "mybank.example": "on" });
  assert.ok(s.reviewed["mybank.example"]);
  // ticking a subdomain of an unticked parent stores an exact "on"
  s = toggleOverride(S({ overrides: { "reddit.com": "off" } }), "www.reddit.com", true, fakeClassify, 4);
  assert.deepStrictEqual(s.overrides, { "reddit.com": "off", "www.reddit.com": "on" });
});

test("buildReviewModel groups every cookie domain into allow / hold / deny with counts, related domains together", () => {
  const jar = [
    cookie("www.amazon.com"), cookie(".amazon.com", "a"), cookie(".amazon.com", "b"),
    cookie("sellercentral.amazon.com"), cookie("github.com"),
    cookie(".chase.com"), cookie("mybank.example"), cookie("wallet.example"),
  ];
  const m = buildReviewModel(jar, fakeClassify, S({ overrides: { "github.com": "off", "wallet.example": "on" } }));
  assert.deepStrictEqual(m.groups.allow.map((r) => r.domain), ["amazon.com", "sellercentral.amazon.com", "www.amazon.com", "github.com"]);
  assert.deepStrictEqual(m.groups.hold.map((r) => r.domain), ["mybank.example", "wallet.example"]);
  assert.deepStrictEqual(m.groups.deny.map((r) => [r.domain, r.category]), [["chase.com", "banking"]]);
  const row = (d) => m.rows.find((r) => r.domain === d);
  assert.strictEqual(row("amazon.com").cookies, 2);
  assert.strictEqual(row("github.com").sync, false);
  assert.strictEqual(row("github.com").override, "off");
  assert.strictEqual(row("wallet.example").sync, true);
  assert.strictEqual(row("mybank.example").pending, true);
  assert.strictEqual(row("wallet.example").pending, false);
  assert.deepStrictEqual(m.totals, { domains: 7, cookies: 8, syncDomains: 4, syncCookies: 5, held: 2, blocked: 1 });
});
