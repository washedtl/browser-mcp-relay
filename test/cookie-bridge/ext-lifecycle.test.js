// ext-lifecycle.test.js — W2F-ext: host messages (status / resync / ack),
// reconnect with backoff, and MV3 service-worker restarts (all state comes
// back from chrome.storage.local; events that arrive before it has loaded
// aren't lost).

const test = require("node:test");
const assert = require("node:assert");

const { makeEnv, cookie, flush, APPROVED } = require("./ext-fakes.js");
const { createBridge, RECONNECT_MAX_MS } = require("../../extensions/cookie-bridge/bridge-core.js");

async function connected(env) {
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  return bridge;
}

test("host status messages update broker up/down in storage for the review page", async () => {
  const env = makeEnv({ storage: APPROVED });
  await connected(env);
  assert.strictEqual(env.store.data.status.host, "connecting");
  env.port.emit({ t: "status", broker: "up" });
  await env.clock.advance(1000);
  assert.strictEqual(env.store.data.status.host, "connected");
  assert.strictEqual(env.store.data.status.broker, "up");
  env.port.emit({ t: "status", broker: "down" });
  await env.clock.advance(1000);
  assert.strictEqual(env.store.data.status.broker, "down");
});

test("every resync from the host triggers a fresh full sync; an in-flight one is superseded", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com")], storage: APPROVED });
  await connected(env);
  env.port.emit({ t: "resync" });
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  assert.strictEqual(env.port.ofType("full").length, 1, "two back-to-back resyncs send one full sync, not two");
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  assert.strictEqual(env.port.ofType("full").length, 2);
  assert.strictEqual(env.cookies.calls.length >= 2, true, "each resync re-reads the jar");
});

test("acks are tracked: applied/rejected totals, last rejections by domain, last sync time, nothing in flight", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com"), cookie("github.com")], storage: APPROVED });
  await connected(env);
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  const full = env.port.ofType("full")[0];
  assert.strictEqual(env.store.data.status.inflight >= 0, true);
  env.port.emit({ t: "ack", seq: full.seq, applied: 1, rejected: [{ domain: "github.com", reason: "denied by broker policy" }] });
  await env.clock.advance(1000);
  const st = env.store.data.status;
  assert.strictEqual(st.sent, 2);
  assert.strictEqual(st.applied, 1);
  assert.strictEqual(st.rejected, 1);
  assert.deepStrictEqual(st.rejections.map((r) => [r.domain, r.reason]), [["github.com", "denied by broker policy"]]);
  assert.strictEqual(st.inflight, 0);
  assert.strictEqual(typeof st.lastSyncAt, "number");
  assert.strictEqual(st.lastFullAt, st.lastSyncAt, "acking the last full batch records a completed full sync");
});

test("an ack for an unknown seq is ignored (no double counting)", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com")], storage: APPROVED });
  await connected(env);
  env.port.emit({ t: "ack", seq: 999, applied: 5, rejected: [] });
  env.port.emit({ t: "bogus" });
  env.port.emit(null);
  await env.clock.advance(1000);
  assert.strictEqual(env.store.data.status.applied || 0, 0);
});

test("host disconnect → reconnect with exponential backoff, capped below the 30 s SW idle limit", async () => {
  assert.ok(RECONNECT_MAX_MS < 30_000, "each retry must land before an idle MV3 worker is stopped");
  const env = makeEnv({ storage: APPROVED });
  await connected(env);
  const gaps = [];
  let last = env.clock.now();
  for (let i = 0; i < 8; i++) {
    const n = env.ports.length;
    env.port.crash("Specified native messaging host not found.");
    if (i === 0) {
      await env.clock.advance(600);
      assert.strictEqual(env.store.data.status.host, "retrying");
      assert.strictEqual(env.ports.length, n, "not yet: the first retry waits ~1 s");
    }
    while (env.ports.length === n) await env.clock.advance(100);
    gaps.push(env.clock.now() - last);
    last = env.clock.now();
  }
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1], `backoff never shrinks: ${gaps}`);
  assert.ok(gaps[0] <= 1500, `first retry is quick: ${gaps[0]}`);
  assert.ok(gaps[gaps.length - 1] <= RECONNECT_MAX_MS + 100, `capped: ${gaps}`);
  assert.match(env.store.data.status.error, /not found/);
  assert.strictEqual(env.port.sent[0].t, "hello", "every new port says hello");
});

test("a connection that stayed up resets the backoff; a crash-looping host does not", async () => {
  const env = makeEnv({ storage: APPROVED });
  await connected(env);
  // crash loop: host answers then dies immediately, several times
  for (let i = 0; i < 4; i++) {
    const n = env.ports.length;
    env.port.emit({ t: "status", broker: "up" });
    env.port.crash();
    while (env.ports.length === n) await env.clock.advance(100);
  }
  const t0 = env.clock.now();
  let n = env.ports.length;
  env.port.crash();
  while (env.ports.length === n) await env.clock.advance(100);
  assert.ok(env.clock.now() - t0 >= 8000, "crash loop keeps backing off");

  await env.clock.advance(60_000); // stays up a minute
  const t1 = env.clock.now();
  n = env.ports.length;
  env.port.crash();
  while (env.ports.length === n) await env.clock.advance(100);
  assert.ok(env.clock.now() - t1 <= 1500, "after a stable connection the next retry is quick again");
});

test("a postMessage on a dead port is handled as a disconnect, not a thrown error", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com")], storage: APPROVED });
  await connected(env);
  env.port.disconnected = true; // Chrome closed it, onDisconnect not delivered yet
  env.port.emit({ t: "resync" });
  await env.clock.advance(2000);
  assert.ok(env.ports.length >= 2, "reconnected after the failed post");
});

test("SW restart: settings, counters, pending and rejections come back from storage; the host reconnects", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com"), cookie("newbank.example")], storage: APPROVED });
  await connected(env);
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  const full = env.port.ofType("full")[0];
  env.port.emit({ t: "ack", seq: full.seq, applied: 1, rejected: [{ domain: "x.example", reason: "r" }] });
  await env.clock.advance(1000);
  const before = JSON.parse(JSON.stringify(env.store.data.status));
  assert.deepStrictEqual(before.pending, ["newbank.example"]);

  // MV3 kills the worker: the port closes, the in-memory bridge is gone.
  env.restart();
  assert.strictEqual(env.action.state.text, "");

  const bridge2 = createBridge(env.deps());
  await bridge2.ready;
  await env.clock.advance(10);
  assert.strictEqual(env.ports.length, 1, "approved + not paused → reconnects on its own");
  assert.deepStrictEqual(env.port.sent, [{ t: "hello", v: 1 }]);
  const st = env.store.data.status;
  assert.strictEqual(st.applied, before.applied);
  assert.strictEqual(st.sent, before.sent);
  assert.strictEqual(st.lastSyncAt, before.lastSyncAt);
  assert.deepStrictEqual(st.rejections, before.rejections);
  assert.deepStrictEqual(st.pending, ["newbank.example"]);
  assert.strictEqual(env.action.state.text, "1", "badge restored without waiting for a sync");
  assert.strictEqual(st.broker, "unknown", "broker state is re-learned from the new host, not trusted from before");
});

test("SW restart while paused stays paused (no host started)", async () => {
  const env = makeEnv({ storage: { settings: { ...APPROVED.settings, paused: true } } });
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(60_000);
  assert.strictEqual(env.ports.length, 0);
  assert.strictEqual(env.store.data.status.host, "paused");
});

test("events that wake the worker are not lost while state is still loading from storage", async () => {
  const env = makeEnv({ cookies: [], storage: APPROVED });
  // storage.get resolves late (cold start), but listeners are registered synchronously
  const realGet = env.store.get;
  let release;
  env.store.get = (k) => new Promise((r) => { release = () => r(realGet.call(env.store, k)); });
  const bridge = createBridge(env.deps());
  env.cookies.set(cookie("newbank.example")); // the event that woke us
  await flush();
  release();
  await bridge.ready;
  await env.clock.advance(1000);
  assert.deepStrictEqual(env.store.data.status.pending, ["newbank.example"]);
});

test("stop() disconnects, cancels timers and ignores later events (used on revoke)", async () => {
  const env = makeEnv({ cookies: [], storage: APPROVED });
  const bridge = await connected(env);
  bridge.stop();
  assert.strictEqual(env.port.disconnected, true);
  env.cookies.set(cookie("github.com"));
  await env.clock.advance(60_000);
  assert.strictEqual(env.ports.length, 1);
});
