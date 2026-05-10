const test = require("node:test");
const assert = require("node:assert");

const { attachAutofill, USERNAME_FIELD_SELECTORS } = require("../src/autofill-injector.js");

// Minimal mock of a Playwright BrowserContext: just enough surface for
// attachAutofill — `pages()` returns existing pages, `on("page", fn)`
// registers a future-page callback. `pageCalls` lets us assert whether the
// `page` listener was registered.
function makeMockContext() {
  const calls = { onCalls: [], pages: [] };
  return {
    calls,
    pages: () => calls.pages,
    on: (event, fn) => calls.onCalls.push({ event, fn }),
  };
}

test("attachAutofill: vault=null → no listeners attached, logs skip", () => {
  const ctx = makeMockContext();
  const logs = [];
  attachAutofill(ctx, null, (m) => logs.push(m));
  assert.strictEqual(ctx.calls.onCalls.length, 0);
  assert.ok(logs.some((m) => m.includes("vault empty")), "expected skip log");
});

test("attachAutofill: vault.totalEntries=0 → no listeners attached", () => {
  const ctx = makeMockContext();
  const logs = [];
  attachAutofill(ctx, { totalEntries: 0, lookup: () => [] }, (m) => logs.push(m));
  assert.strictEqual(ctx.calls.onCalls.length, 0);
  assert.ok(logs.some((m) => m.includes("vault empty")), "expected skip log");
});

test("attachAutofill: vault with entries → registers a `page` listener on context", () => {
  const ctx = makeMockContext();
  attachAutofill(ctx, { totalEntries: 1, lookup: () => [] }, () => {});
  // One `page` listener registered for future pages.
  assert.strictEqual(ctx.calls.onCalls.length, 1);
  assert.strictEqual(ctx.calls.onCalls[0].event, "page");
  assert.strictEqual(typeof ctx.calls.onCalls[0].fn, "function");
});

test("attachAutofill: hooks existing pages (calls page.on framenavigated)", () => {
  const pageEvents = [];
  const fakePage = { on: (event, fn) => pageEvents.push({ event, fn }) };
  const ctx = makeMockContext();
  ctx.calls.pages.push(fakePage);
  attachAutofill(ctx, { totalEntries: 1, lookup: () => [] }, () => {});
  // Existing page got a framenavigated listener attached.
  assert.strictEqual(pageEvents.length, 1);
  assert.strictEqual(pageEvents[0].event, "framenavigated");
});

// V1-2: framenavigated fires for every redirect step in OAuth chains.
// Without debouncing, multiple concurrent 3-second fill loops spin up
// against the same frame.
test("V1-2: rapid framenavigated events do NOT spawn concurrent fills", async () => {
  // Capture the framenavigated handler so we can fire it ourselves.
  let frameNavHandler = null;
  const fakeMainFrame = { url: () => "https://example.com/oauth/step1" };
  const evaluateCalls = [];
  // The handler awaits frame.evaluate — we fake one that resolves after
  // a microtask so the test can fire 5 events before any fill completes.
  fakeMainFrame.evaluate = async () => {
    evaluateCalls.push(Date.now());
    await new Promise((r) => setTimeout(r, 50));
    return { user: true, pass: true };
  };
  const fakePage = {
    on: (event, fn) => { if (event === "framenavigated") frameNavHandler = fn; },
    mainFrame: () => fakeMainFrame,
  };
  const ctx = makeMockContext();
  ctx.calls.pages.push(fakePage);
  // Vault returns a real cred each time — without debounce, every nav fires.
  const vault = {
    totalEntries: 1,
    lookup: () => [{ username: "alice", password: "p1" }],
  };
  attachAutofill(ctx, vault, () => {});

  assert.ok(frameNavHandler, "framenavigated handler must be registered");
  // Fire 5 framenavigated events back-to-back synchronously — simulates
  // OAuth redirect chain.
  for (let i = 0; i < 5; i++) {
    frameNavHandler(fakeMainFrame);
  }
  // Wait for all microtasks + the 50ms fill to drain.
  await new Promise((r) => setTimeout(r, 150));
  // Critical assertion: only ONE evaluate fired, even though 5 events landed.
  assert.strictEqual(evaluateCalls.length, 1,
    `expected exactly 1 fill on rapid framenavigated, got ${evaluateCalls.length}`);
});

// ──────────────────────────────────────────────────────────────────
// W0-5: cross-subdomain credential leak protection. When vault.lookup
// returns multiple registrable-fallback matches with no exact-host
// entry, autofill must SKIP — picking creds[0] would silently fill
// the wrong account on a brand with multiple subdomains in the vault
// (AWS, Audible, Twitch all under amazon.com).
// ──────────────────────────────────────────────────────────────────

test("W0-5: autofill SKIPS when lookup returns ambiguous registrable fallback (>1 _match=registrable)", async () => {
  const evalCalls = [];
  const logs = [];
  const fakeFrame = {
    url: () => "https://signin.amazon.com/login",
    evaluate: async () => { evalCalls.push("called"); return { user: true, pass: true }; },
  };
  const fakePage = {
    on: (event, fn) => { fakePage._fn = fn; },
    mainFrame: () => fakeFrame,
  };
  fakeFrame.equals = (other) => other === fakeFrame;
  // Patch fakeFrame === comparison: page.mainFrame() returns fakeFrame, and
  // attachToPage compares `frame !== page.mainFrame()`. Use object identity.
  const ctx = {
    pages: () => [fakePage],
    on: () => {},
  };
  // Vault with two AMBIGUOUS registrable matches.
  const vault = {
    totalEntries: 2,
    lookup: () => [
      { username: "aws-user", password: "p1", url: "https://aws.amazon.com", _match: "registrable" },
      { username: "audible-user", password: "p2", url: "https://www.audible.com", _match: "registrable" },
    ],
  };
  attachAutofill(ctx, vault, (m) => logs.push(m));
  // Trigger framenavigated.
  fakePage._fn(fakeFrame);
  // Allow microtasks to drain.
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(evalCalls.length, 0,
    "autofill must SKIP frame.evaluate when lookup is ambiguous-registrable (>1 cred, no exact host)");
  assert.ok(logs.some((m) => /ambiguous|skipping/i.test(m)),
    "expected a 'skipping' log line when ambiguous fallback");
});

test("W0-5: autofill DOES fill when lookup returns 1 registrable match (unambiguous)", async () => {
  const evalCalls = [];
  const fakeFrame = {
    url: () => "https://signin.amazon.com/login",
    evaluate: async () => { evalCalls.push("called"); return { user: true, pass: true }; },
  };
  const fakePage = {
    on: (event, fn) => { fakePage._fn = fn; },
    mainFrame: () => fakeFrame,
  };
  const ctx = { pages: () => [fakePage], on: () => {} };
  const vault = {
    totalEntries: 1,
    lookup: () => [
      { username: "alice", password: "p1", url: "https://amazon.com", _match: "registrable" },
    ],
  };
  attachAutofill(ctx, vault, () => {});
  fakePage._fn(fakeFrame);
  await new Promise((r) => setImmediate(r));
  // Single registrable match is unambiguous — fill DID happen.
  assert.strictEqual(evalCalls.length, 1, "single registrable match must fill");
});

// ──────────────────────────────────────────────────────────────────
// W0-6: USERNAME_FIELD_SELECTORS list expanded for Microsoft AAD,
// Google, Apple, common SaaS patterns.
// ──────────────────────────────────────────────────────────────────

test("W0-6: USERNAME_FIELD_SELECTORS includes Microsoft AAD `loginfmt`", () => {
  assert.ok(
    USERNAME_FIELD_SELECTORS.some((s) => s.includes('"loginfmt"')),
    "expected `name=\"loginfmt\"` selector for Microsoft AAD",
  );
});

test("W0-6: USERNAME_FIELD_SELECTORS includes Google `identifier`", () => {
  assert.ok(
    USERNAME_FIELD_SELECTORS.some((s) => s.includes('"identifier"')),
    "expected `name=\"identifier\"` selector for Google",
  );
});

test("W0-6: USERNAME_FIELD_SELECTORS includes Apple `account_name_text_field`", () => {
  assert.ok(
    USERNAME_FIELD_SELECTORS.some((s) => s.includes("account_name_text_field")),
    "expected `id=\"account_name_text_field\"` selector for Apple ID",
  );
});
