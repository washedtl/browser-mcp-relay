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

// ──────────────────────────────────────────────────────────────────
// W0-8: upstream-exit handler must NOT use process.kill(pid, signal)
// (re-raises the signal → handler recursion on POSIX, no-op on
// Windows). Since W1A the upstream-exit handler doesn't exit the relay
// at all (it respawns upstream lazily — see index-lifecycle.test.js),
// so only the negative guard remains.
// ──────────────────────────────────────────────────────────────────

test("W0-8: relay never re-raises a signal on itself via process.kill(process.pid, signal)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  let src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  // Strip comments before pattern-checking — the W0-8 fix's docblock
  // describes the previous bug literally ("`process.kill(process.pid, signal)`")
  // which would trip the negative assertion below.
  src = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  // Source-level guard: previous bug was process.kill(process.pid, signal)
  // immediately after upstream-exit's await shutdownAsync. That re-raised
  // SIGINT into the registered handler → recursion on POSIX, and was a
  // no-op on Windows so the relay never exited.
  assert.ok(!/process\.kill\(\s*process\.pid\s*,\s*signal\s*\)/.test(src),
    "W0-8: must NOT call process.kill(process.pid, signal) — re-raises signal");
});

// ──────────────────────────────────────────────────────────────────
// W1-5: getUpstream must wrap spawnUpstream in Promise.resolve().then
// so a synchronous throw from spawnUpstream (e.g. resolveBdmcpEntry
// throwing) is captured by the .catch instead of bypassing the
// memoization assignment entirely.
// ──────────────────────────────────────────────────────────────────

test("W1-5: getUpstream wraps spawnUpstream() in Promise.resolve().then for sync-throw safety", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  // Must use the Promise.resolve().then pattern, not a naked spawnUpstream() call.
  assert.ok(/Promise\.resolve\(\)\.then\(\s*spawnUpstream\s*\)/.test(src),
    "expected `Promise.resolve().then(spawnUpstream)` to capture sync throws");
});

// ──────────────────────────────────────────────────────────────────
// W1-6: releasePool() must come BEFORE the long-running closeBrave
// in shutdownAsync — second Ctrl-C interrupts mid-await, leaves lock
// stranded if released last.
// ──────────────────────────────────────────────────────────────────

// W1A revision: the lock is now released LAST. Releasing first let a
// successor relay claim the dir while our Brave still held it; a mid-
// shutdown process exit still releases through shutdownSync, and stale or
// recycled-PID locks are reclaimable since W0. Behavior is covered in
// index-lifecycle.test.js; this guards the textual order.
test("W1-6 (revised): shutdownAsync calls releasePool() AFTER closeBrave() (lock-last ordering)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  const m = src.match(/function\s+shutdownAsync[\s\S]*?shutdownDone\s*=\s*true/);
  assert.ok(m, "expected to find shutdownAsync body");
  const body = m[0];
  const releaseIdx = body.indexOf("releasePool()");
  const closeBraveIdx = body.indexOf("closeBrave(");
  assert.ok(releaseIdx >= 0, "releasePool() must be called");
  assert.ok(closeBraveIdx >= 0, "closeBrave() must be called");
  assert.ok(closeBraveIdx < releaseIdx, "releasePool() must come AFTER closeBrave()");
});

// ──────────────────────────────────────────────────────────────────
// G0-3: upstreamChild.kill() must use process-tree kill on Windows.
// Bare child.kill() only TerminateProcess's the immediate node PID,
// orphaning any BDMCP-launched Brave subtree (renderers/GPU/utility).
// ──────────────────────────────────────────────────────────────────

test("G0-3: upstream is killed via killProcessTree (taskkill /F /T on Windows)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  // Must define a killProcessTree helper.
  assert.ok(/function\s+killProcessTree\s*\(\s*child\s*\)/.test(src),
    "expected killProcessTree(child) helper");
  // Async helper (recovery + shutdownAsync) must run taskkill /F /T via
  // execFile — a sync taskkill would freeze the event loop mid-session.
  assert.ok(/execFile\(\s*"taskkill",\s*\[\s*"\/F",\s*"\/T",\s*"\/PID",\s*String\(child\.pid\)\s*\]/.test(src),
    "killProcessTree must call execFile(\"taskkill\", [\"/F\", \"/T\", \"/PID\", ...]) on win32");
  // Sync helper (process 'exit' only) uses execSync taskkill /F /T.
  assert.ok(/function\s+killProcessTreeSync\s*\(\s*child\s*\)[\s\S]*?execSync\(`taskkill\s+\/F\s+\/T\s+\/PID\s+\$\{child\.pid\}`/.test(src),
    "killProcessTreeSync must call `taskkill /F /T /PID ${child.pid}` via execSync on win32");
  // They are the lifecycle's defaults (behavior covered in index-lifecycle.test.js).
  assert.ok(/killTree\s*=\s*killProcessTree,/.test(src),
    "expected killProcessTree as createLifecycle's default killTree");
  assert.ok(/killTreeSync\s*=\s*killProcessTreeSync/.test(src),
    "expected killProcessTreeSync as createLifecycle's default killTreeSync");
  // Strip comments first since the change-rationale comment mentions the bug.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
  assert.ok(!/upstreamChild\.kill\(\)/.test(code),
    "must not have bare upstreamChild.kill() — orphans Brave subtree on Windows");
});

// ──────────────────────────────────────────────────────────────────
// W1A item 7: main() starts the in-process inspector through the retry
// loop with startInspector's own "port in use" hint silenced (the loop
// logs one line itself; the option is implemented in inspector-server.js
// by W1E and ignored until then). Bind comes from inspector-server's
// defaultBind so the two never disagree.
// ──────────────────────────────────────────────────────────────────

test("W1A: the inspector starts via startInspectorWithRetry with quietPortInUse + defaultBind (inspector-launch.js, shared by the relay and the broker)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const read = (...p) => fs.readFileSync(path.resolve(__dirname, "..", "src", ...p), "utf8");
  const launch = read("inspector-launch.js");
  assert.ok(/startInspectorWithRetry\(\{[\s\S]*?start:\s*\(\)\s*=>\s*startInspector\(\{[\s\S]*?quietPortInUse:\s*true[\s\S]*?\}\)/.test(launch),
    "startInspector({...}) inside startInspectorWithRetry must pass quietPortInUse: true");
  assert.ok(/defaultBind\(env\)/.test(launch), "inspector bind must come from defaultBind(env)");
  const index = read("index.js");
  const main = index.slice(index.indexOf("async function main"));
  assert.ok(/inspectorPortFromEnv\(RELAY_ENV/.test(main) && /launchInspector\(\{[^}]*env: RELAY_ENV/.test(main), "index.js main uses the shared launcher with RELAY_ENV");
  assert.ok(!/require\("\.\.\/index\.js"\)/.test(read("broker", "main.js")), "the broker must not require the CLI entrypoint");
});

// ──────────────────────────────────────────────────────────────────
// G0-4: uncaughtException + unhandledRejection handlers — without
// these, an unhandled throw orphans Brave + strands the lock.
// ──────────────────────────────────────────────────────────────────

test("G0-4: registers uncaughtException + unhandledRejection handlers", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  assert.ok(/process\.on\(\s*["']uncaughtException["']/.test(src),
    "expected process.on('uncaughtException', ...) registration");
  assert.ok(/process\.on\(\s*["']unhandledRejection["']/.test(src),
    "expected process.on('unhandledRejection', ...) registration");
  // uncaughtException handler must call shutdownAsync before exiting.
  const m = src.match(/process\.on\(\s*["']uncaughtException["'][\s\S]{0,500}/);
  assert.ok(m && /shutdownAsync\(\)/.test(m[0]),
    "uncaughtException handler must invoke shutdownAsync() so Brave + lock get cleaned up");
});

// ──────────────────────────────────────────────────────────────────
// G0-7 + G1-2: shutdown awaits closeBrave + inspectorHandle.close in
// PARALLEL via Promise.all([withTimeout, withTimeout]). Sequential
// awaits with no timeout means a hung Brave + hung inspector = sum
// of waits. Parallel + per-step timeout = max of waits, capped.
// ──────────────────────────────────────────────────────────────────

test("G0-7 + G1-2: shutdown runs lifecycle + inspector close in parallel, each capped by withTimeout", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");
  // Must define withTimeout helper.
  assert.ok(/function\s+withTimeout\s*\(/.test(src),
    "expected withTimeout helper for shutdown timeout safety");
  // Lifecycle shutdown (first shutdownAsync) caps closeBrave.
  const lifecycleBody = src.match(/function\s+shutdownAsync[\s\S]*?shutdownDone\s*=\s*true/);
  assert.ok(lifecycleBody, "expected the lifecycle's shutdownAsync body");
  assert.ok(/withTimeout\(closeBrave/.test(lifecycleBody[0]),
    "closeBrave must be wrapped in withTimeout");
  // main()'s shutdownAsync runs the lifecycle and the capped inspector close
  // in parallel.
  const mainBody = src.match(/async\s+function\s+main[\s\S]*?function\s+shutdownAsync[\s\S]*?return\s+shutdownPromise;\s*\}/);
  assert.ok(mainBody, "expected main()'s shutdownAsync body");
  const body = mainBody[0].slice(mainBody[0].lastIndexOf("function shutdownAsync"));
  assert.ok(/Promise\.all\(\s*tasks\s*\)/.test(body),
    "shutdownAsync must run close tasks in parallel via Promise.all");
  assert.ok(/lifecycle\.shutdownAsync\(\)/.test(body), "main shutdown must include the lifecycle");
  assert.ok(/withTimeout\(inspectorHandle\.close/.test(body),
    "inspectorHandle.close must be wrapped in withTimeout");
});

// ──────────────────────────────────────────────────────────────────
// F1-16 (2026-05-10): pre-launch reap of orphan Brave squatters.
//
// claimSlot() reaps orphans at lock-acquire time, but a relay can claim
// a slot without launching Brave (lazy launch on first tool call). If a
// previous-session Brave is later orphaned onto that user-data-dir
// (parent died, hard-killed Cursor, blue screen), claimSlot's old reap
// has already run and missed it. launchBrave then fails with "user data
// dir already in use".
//
// Invariant: the reap call MUST appear in ensureBrave's body BEFORE the
// launchBrave() call, so any squatter that sneaked in after the
// claim-time reap is killed before Playwright touches the dir.
// ──────────────────────────────────────────────────────────────────

test("F1-16: ensureBrave reaps orphans BEFORE calling launchBrave", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "index.js"), "utf8");

  // Find the slice from the "launching Brave" log line through the
  // launchBrave call. The reap must appear in this slice; anything before
  // the log line is too early (could be from claimSlot's own reap path
  // bleeding in via comments).
  const launchMatch = src.match(/launching Brave[\s\S]*?await\s+launchBrave\(/);
  assert.ok(launchMatch, "expected launching-Brave log + await launchBrave block in ensureBrave");
  const slice = launchMatch[0];

  assert.ok(/pool\.reapOrphansFor\(\s*dir\s*\)/.test(slice),
    "F1-16: ensureBrave must call pool.reapOrphansFor(dir) between the launch log and launchBrave()");

  // Belt-and-brace: the reap should be inside a try/catch so a reap
  // failure doesn't block the launch attempt itself (we'd rather see
  // Playwright's "user data dir in use" diagnostic than a silent reap
  // exception).
  assert.ok(/try\s*\{[\s\S]*?pool\.reapOrphansFor\([\s\S]*?\}\s*catch/.test(slice),
    "F1-16: pre-launch reap must be wrapped in try/catch (best-effort)");
});
