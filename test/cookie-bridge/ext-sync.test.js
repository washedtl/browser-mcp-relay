// ext-sync.test.js — W2F-ext: the full sync is batched (every message well
// under the 1 MB native-messaging budget, last:true on the final batch) and
// cookies.onChanged becomes live deltas, removals included.

const test = require("node:test");
const assert = require("node:assert");

const { makeEnv, cookie, APPROVED } = require("./ext-fakes.js");
const { createBridge, batchCookies, MAX_BATCH_BYTES } = require("../../extensions/cookie-bridge/bridge-core.js");

const bytes = (m) => Buffer.byteLength(JSON.stringify(m), "utf8");

async function connected(env) {
  const bridge = createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  return bridge;
}
async function resync(env) {
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
}

test("the batch budget leaves big headroom under the 1 MB native-messaging limit", () => {
  assert.ok(MAX_BATCH_BYTES <= 512 * 1024, `MAX_BATCH_BYTES=${MAX_BATCH_BYTES}`);
});

test("batchCookies splits by encoded size, keeps order, never returns an empty batch", () => {
  const big = (i) => cookie("site" + i + ".example", "n", { value: "x".repeat(1000) });
  const list = Array.from({ length: 50 }, (_, i) => big(i));
  const batches = batchCookies(list, 10_000);
  assert.ok(batches.length >= 5);
  assert.deepStrictEqual(batches.flat(), list);
  for (const b of batches) {
    assert.ok(b.length >= 1);
    assert.ok(bytes(b) <= 10_000, `batch of ${bytes(b)} bytes`);
  }
  assert.deepStrictEqual(batchCookies([], 10_000), []);
  // a single cookie bigger than the budget still goes, alone
  assert.deepStrictEqual(batchCookies([big(1)], 100).map((b) => b.length), [1]);
});

test("a large jar goes out as several full batches, each well under 1 MB, seq increasing, last only on the final one", async () => {
  // ~3000 cookies with 3 KB values ≈ 9 MB total
  const jar = Array.from({ length: 3000 }, (_, i) => cookie(`s${i % 400}.example.com`, "c" + i, { value: "v".repeat(3000) }));
  const env = makeEnv({ cookies: jar, storage: APPROVED });
  await connected(env);
  await resync(env);
  const fulls = env.port.ofType("full");
  assert.ok(fulls.length > 10, `${fulls.length} batches`);
  for (const m of fulls) assert.ok(bytes(m) < 1024 * 1024 / 2, `batch of ${bytes(m)} bytes`);
  assert.deepStrictEqual(fulls.map((m) => m.last), [...Array(fulls.length - 1).fill(false), true]);
  const seqs = fulls.map((m) => m.seq);
  assert.deepStrictEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.strictEqual(new Set(seqs).size, seqs.length);
  assert.strictEqual(fulls.reduce((n, m) => n + m.cookies.length, 0), 3000);
});

test("an empty (or fully filtered) jar still sends one full message with last:true so the broker knows", async () => {
  const env = makeEnv({ cookies: [cookie(".chase.com")], storage: APPROVED });
  await connected(env);
  await resync(env);
  const fulls = env.port.ofType("full");
  assert.strictEqual(fulls.length, 1);
  assert.deepStrictEqual(fulls[0].cookies, []);
  assert.strictEqual(fulls[0].last, true);
});

test("onChanged: a set and a removal become delta changes ({removed, cause, cookie})", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com")], storage: APPROVED });
  await connected(env);
  await resync(env);
  env.cookies.set(cookie("github.com", "user_session"));
  env.cookies.remove(cookie(".amazon.com"), "expired");
  await env.clock.advance(1000);
  const deltas = env.port.ofType("delta");
  assert.strictEqual(deltas.length, 1, "a burst is coalesced into one message");
  assert.ok(typeof deltas[0].seq === "number" && deltas[0].seq > env.port.ofType("full")[0].seq);
  assert.deepStrictEqual(deltas[0].changes, [
    { removed: false, cause: "explicit", cookie: cookie("github.com", "user_session") },
    { removed: true, cause: "expired", cookie: cookie(".amazon.com") },
  ]);
});

test("onChanged: an overwrite sends only the new cookie (Chrome's remove+add pair collapses)", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com")], storage: APPROVED });
  await connected(env);
  await resync(env);
  env.cookies.set(cookie(".amazon.com", "sid", { value: "rotated" }));
  await env.clock.advance(1000);
  const changes = env.port.ofType("delta").flatMap((m) => m.changes);
  assert.deepStrictEqual(changes.map((c) => [c.removed, c.cause, c.cookie.value]), [[false, "explicit", "rotated"]]);
});

test("onChanged: deny and held domains never produce deltas (sets or removals)", async () => {
  const env = makeEnv({ cookies: [cookie(".chase.com")], storage: APPROVED });
  await connected(env);
  await resync(env);
  env.cookies.set(cookie(".chase.com", "x"));
  env.cookies.remove(cookie(".chase.com"));
  env.cookies.set(cookie("mybank.example"));
  await env.clock.advance(1000);
  assert.strictEqual(env.port.ofType("delta").length, 0);
});

test("a delta burst bigger than the budget is split into several delta messages", async () => {
  const env = makeEnv({ cookies: [], storage: APPROVED });
  await connected(env);
  await resync(env);
  for (let i = 0; i < 400; i++) env.cookies.set(cookie(`d${i}.example.com`, "n", { value: "z".repeat(3000) }));
  await env.clock.advance(1000);
  const deltas = env.port.ofType("delta");
  assert.ok(deltas.length >= 3, `${deltas.length} delta messages`);
  for (const m of deltas) assert.ok(bytes(m) < 1024 * 1024 / 2);
  assert.strictEqual(deltas.reduce((n, m) => n + m.changes.length, 0), 400);
});

test("changes that happen while a full sync is reading the jar are sent AFTER its last batch", async () => {
  const env = makeEnv({ cookies: [cookie(".amazon.com")], storage: APPROVED });
  await connected(env);
  // hold getAll open so the change lands mid-sync
  let release;
  const realGetAll = env.cookies.getAll;
  env.cookies.getAll = (d) => new Promise((r) => { release = () => r(realGetAll.call(env.cookies, d)); });
  env.port.emit({ t: "resync" });
  await env.clock.advance(1);
  env.cookies.set(cookie("github.com"));
  await env.clock.advance(1000);
  assert.strictEqual(env.port.ofType("delta").length, 0, "delta held back while the full sync is in flight");
  release();
  await env.clock.advance(1000);
  const types = env.port.sent.map((m) => m.t);
  assert.deepStrictEqual(types, ["hello", "full", "delta"]);
});

test("deltas are dropped while the host is disconnected (the host's resync on reconnect covers them)", async () => {
  const env = makeEnv({ cookies: [], storage: APPROVED });
  await connected(env);
  env.port.crash();
  env.cookies.set(cookie("github.com"));
  await env.clock.advance(500);
  assert.ok(env.ports.every((p) => p.ofType("delta").length === 0));
});
