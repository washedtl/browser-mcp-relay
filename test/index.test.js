const test = require("node:test");
const assert = require("node:assert");

test("index.js can be required without spawning anything", () => {
  // index.js exports main() but only calls it when require.main === module.
  // Requiring from a test file should not trigger the launch.
  const mod = require("../src/index.js");
  assert.strictEqual(typeof mod.main, "function");
});

// ─────────── V0-1/V0-2: ensureBrave context-leak regression ───────────
//
// Reproduces the bug where a throw between launchBrave returning and
// `bridge` being assigned would leak the live BrowserContext (user-data-dir
// lock held forever).

test("V0-1/V0-2: attachWithCleanupOnError closes context when fn throws", async () => {
  const { attachWithCleanupOnError } = require("../src/index.js");
  let closeCalls = 0;
  const fakeContext = { close: async () => { closeCalls++; } };
  const fakeLaunched = { context: fakeContext, cdpConnectUrl: "ws://fake" };
  await assert.rejects(
    attachWithCleanupOnError(fakeLaunched, async () => {
      throw new Error("attachAutofill blew up");
    }),
    /attachAutofill blew up/,
  );
  // The single load-bearing assertion: context.close MUST have been called.
  assert.strictEqual(closeCalls, 1, "expected context.close() exactly once on throw");
});

test("V0-1/V0-2: attachWithCleanupOnError does NOT close context on success", async () => {
  const { attachWithCleanupOnError } = require("../src/index.js");
  let closeCalls = 0;
  const fakeContext = { close: async () => { closeCalls++; } };
  const fakeLaunched = { context: fakeContext, cdpConnectUrl: "ws://fake" };
  const result = await attachWithCleanupOnError(fakeLaunched, async (l) => {
    return { ok: true, sameContext: l.context === fakeContext };
  });
  assert.deepStrictEqual(result, { ok: true, sameContext: true });
  assert.strictEqual(closeCalls, 0, "context.close() must NOT be called on success path");
});

test("V0-1/V0-2: attachWithCleanupOnError swallows close() failure on the error path", async () => {
  // If context.close itself throws (already-closed race, etc.), we still
  // want the original error surfaced — not the close error.
  const { attachWithCleanupOnError } = require("../src/index.js");
  const fakeLaunched = {
    context: { close: async () => { throw new Error("close blew up"); } },
  };
  await assert.rejects(
    attachWithCleanupOnError(fakeLaunched, async () => {
      throw new Error("original failure");
    }),
    /original failure/,
  );
});
