// ext-approval.test.js — W2F-ext: NOTHING syncs until the owner clicks
// "Approve & start sync" on the review page (settings.approved in
// chrome.storage.local), and "Pause sync" stops everything.

const test = require("node:test");
const assert = require("node:assert");

const { makeEnv, cookie, APPROVED } = require("./ext-fakes.js");
const { createBridge, HOST_NAME, approveSettings } = require("../../extensions/cookie-bridge/bridge-core.js");

const JAR = () => [cookie(".amazon.com"), cookie("github.com"), cookie(".chase.com"), cookie("mybank.example")];

test("before approval: no native host is started, nothing is sent, the badge asks for review", async () => {
  const env = makeEnv({ cookies: JAR() });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  env.cookies.set(cookie(".amazon.com", "fresh"));
  await env.clock.advance(60_000);
  assert.strictEqual(env.ports.length, 0, "connectNative must not be called before approval");
  assert.strictEqual(env.store.data.status.host, "off");
  assert.strictEqual(env.action.state.text, "!", "badge prompts the owner to review");
});

test("approval written by the review page starts the host: hello first, cookies only after the host asks", async () => {
  const env = makeEnv({ cookies: JAR() });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.store.set({ settings: approveSettings(undefined, ["mybank.example"], env.clock.now()) });
  await env.clock.advance(10);
  assert.strictEqual(env.ports.length, 1);
  assert.strictEqual(env.port.name, HOST_NAME);
  assert.strictEqual(HOST_NAME, "com.browser_mcp_relay.cookie_bridge");
  assert.deepStrictEqual(env.port.sent, [{ t: "hello", v: 1 }]);

  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  const fulls = env.port.ofType("full");
  assert.ok(fulls.length >= 1);
  assert.strictEqual(fulls[fulls.length - 1].last, true);
  const domains = fulls.flatMap((m) => m.cookies.map((c) => c.domain)).sort();
  assert.deepStrictEqual(domains, [".amazon.com", "github.com"], "deny + held domains are not sent");
});

test("approveSettings records the held domains the owner saw, so only LATER ones wait for review", () => {
  const s = approveSettings({ overrides: { "a.com": "off" } }, ["mybank.example", "wallet.io"], 42);
  assert.strictEqual(s.approved, true);
  assert.strictEqual(s.approvedAt, 42);
  assert.strictEqual(s.paused, false);
  assert.deepStrictEqual(s.overrides, { "a.com": "off" });
  assert.deepStrictEqual(Object.keys(s.reviewed).sort(), ["mybank.example", "wallet.io"]);
});

test("a resync from the host before approval is ignored (no port exists to receive it anyway)", async () => {
  const env = makeEnv({ cookies: JAR(), storage: { settings: { approved: false } } });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await bridge.fullSync("test");
  assert.strictEqual(env.ports.length, 0);
  assert.strictEqual(env.cookies.calls.length, 0, "cookies are not even read for syncing before approval");
});

test("pause disconnects the host and stops deltas; un-pause reconnects and says hello again", async () => {
  const env = makeEnv({ cookies: JAR(), storage: APPROVED });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  const first = env.port;
  assert.ok(first && !first.disconnected);

  await env.store.set({ settings: { ...APPROVED.settings, paused: true } });
  await env.clock.advance(10);
  assert.strictEqual(first.disconnected, true);
  assert.strictEqual(env.store.data.status.host, "paused");

  env.cookies.set(cookie(".amazon.com", "while-paused"));
  await env.clock.advance(60_000);
  assert.strictEqual(env.ports.length, 1, "no reconnect while paused");
  assert.strictEqual(first.ofType("delta").length, 0);

  await env.store.set({ settings: { ...APPROVED.settings, paused: false } });
  await env.clock.advance(10);
  assert.strictEqual(env.ports.length, 2);
  assert.deepStrictEqual(env.port.sent, [{ t: "hello", v: 1 }]);
});

test("revoking approval disconnects and returns to the pre-approval state", async () => {
  const env = makeEnv({ cookies: JAR(), storage: APPROVED });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  await env.store.set({ settings: { ...APPROVED.settings, approved: false } });
  await env.clock.advance(10);
  assert.strictEqual(env.port.disconnected, true);
  assert.strictEqual(env.store.data.status.host, "off");
});
