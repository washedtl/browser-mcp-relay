// ext-sw-globals.test.js — W2F-ext: bridge-core.js must run in an MV3
// service worker, which has Web globals only: no Buffer, process, require or
// module. Node's test realm hides that (Buffer exists here), so the core is
// evaluated in a fresh vm context that exposes only TextEncoder and URL, and
// must still do a full sync and a live delta.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { makeEnv, cookie, APPROVED } = require("./ext-fakes.js");

const SRC = fs.readFileSync(path.join(__dirname, "..", "..", "extensions", "cookie-bridge", "bridge-core.js"), "utf8");

function loadInWebRealm() {
  const ctx = vm.createContext({ TextEncoder, URL });
  vm.runInContext("globalThis.self = globalThis;", ctx);
  for (const g of ["Buffer", "process", "require", "module"]) {
    assert.strictEqual(vm.runInContext(`typeof ${g}`, ctx), "undefined", `${g} must not exist in the SW-like realm`);
  }
  vm.runInContext(SRC, ctx, { filename: "bridge-core.js" });
  const Core = vm.runInContext("globalThis.CookieBridgeCore", ctx);
  assert.ok(Core && typeof Core.createBridge === "function", "the core publishes itself on globalThis");
  return Core;
}

test("SW realm: batching works without Buffer", () => {
  const Core = loadInWebRealm();
  const batches = Core.batchCookies([cookie("a.example"), cookie("b.example")], 100_000);
  assert.strictEqual(batches.length, 1);
  assert.strictEqual(batches[0].length, 2);
});

test("SW realm: a full sync and a live delta both reach the host", async (t) => {
  const Core = loadInWebRealm();
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));

  const env = makeEnv({ cookies: [cookie(".amazon.com")], storage: APPROVED });
  const bridge = Core.createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  env.cookies.set(cookie("github.com"));
  await env.clock.advance(1000);
  assert.deepStrictEqual(env.port.sent.map((m) => m.t), ["hello", "full", "delta"]);
  assert.strictEqual(env.port.ofType("full")[0].cookies[0].domain, ".amazon.com");
  assert.strictEqual(env.port.ofType("delta")[0].changes[0].cookie.domain, "github.com");
  assert.deepStrictEqual(unhandled, []);
});

test("a throw inside a full sync never wedges it: later deltas and resyncs still go out", async () => {
  const Core = loadInWebRealm();
  const poison = { ...cookie(".amazon.com"), toJSON() { throw new Error("cannot serialize"); } };
  const env = makeEnv({ cookies: [], storage: APPROVED });
  const bridge = Core.createBridge(env.deps());
  await bridge.ready;
  await env.clock.advance(10);
  const realGetAll = env.cookies.getAll;
  env.cookies.getAll = async () => [poison];
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  env.cookies.getAll = realGetAll;
  env.cookies.set(cookie("github.com"));
  await env.clock.advance(1000);
  assert.strictEqual(env.port.ofType("delta").length, 1, "the failed full sync must not hold deltas back forever");
  env.port.emit({ t: "resync" });
  await env.clock.advance(10);
  assert.strictEqual(env.port.ofType("full").length, 1, "the next resync runs normally");
});
