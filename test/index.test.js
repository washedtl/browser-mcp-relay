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

// ──────────────────────────────────────────────────────────────────
// V0-4: shutdown race. Previous implementation used a `shutdownStarted`
// flag — second concurrent caller would early-return and immediately
// `process.exit`, cutting the first caller's `await closeBrave()` short.
// The fix is to memoize the in-flight promise so all callers wait on
// the same chain. Source-pattern guard against accidental regression.
// ──────────────────────────────────────────────────────────────────

test("V0-4: shutdownAsync uses memoized promise (not boolean flag)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");

  // Must declare a shutdownPromise variable.
  assert.ok(
    /let\s+shutdownPromise\s*=\s*null/.test(src),
    "expected `let shutdownPromise = null` declaration in index.js",
  );

  // The shutdownAsync entry must check the memoized promise FIRST and
  // return it on re-entry (not run the body again).
  assert.ok(
    /function\s+shutdownAsync\s*\(\s*\)\s*\{[\s\S]*?if\s*\(\s*shutdownPromise\s*\)\s*return\s+shutdownPromise/.test(src),
    "expected `if (shutdownPromise) return shutdownPromise` at top of shutdownAsync",
  );

  // The signal handlers must wrap the await in try/catch (not naked) — a
  // throw mid-shutdown shouldn't prevent process.exit from firing.
  assert.ok(
    /SIGINT[\s\S]*?try\s*\{\s*await\s+shutdownAsync\(\)\s*;\s*\}\s*catch\s*\{\s*\}\s*[\s\S]*?process\.exit/.test(src),
    "expected `try { await shutdownAsync() } catch {} ` in SIGINT handler",
  );
  assert.ok(
    /SIGTERM[\s\S]*?try\s*\{\s*await\s+shutdownAsync\(\)\s*;\s*\}\s*catch\s*\{\s*\}\s*[\s\S]*?process\.exit/.test(src),
    "expected `try { await shutdownAsync() } catch {} ` in SIGTERM handler",
  );
});
