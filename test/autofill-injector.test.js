const test = require("node:test");
const assert = require("node:assert");

const vm = require("node:vm");

const { attachAutofill, fillScript, USERNAME_FIELD_SELECTORS, PASSWORD_FIELD_SELECTORS } = require("../src/autofill-injector.js");

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
    lookup: () => [{ username: "alice", password: "p1", url: "https://example.com/login" }],
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
// W1E-5 (2026-11-03): only fill a credential whose stored origin is
// exactly the page's origin, only on https://, and re-check the origin
// inside the page right before filling (the frame may have navigated
// between framenavigated and the evaluate landing). Replaces the W0-5
// "skip only when the registrable fallback is ambiguous" rule, which
// still filled a single lookalike match (evil.atlassian.net).
// ──────────────────────────────────────────────────────────────────

function makeNavHarness(pageUrl, creds) {
  const evalCalls = [];
  const logs = [];
  const fakeFrame = {
    url: () => pageUrl,
    evaluate: async (fn, args) => { evalCalls.push(args); return { user: true, pass: true }; },
  };
  const fakePage = {
    on: (event, fn) => { if (event === "framenavigated") fakePage._fn = fn; },
    mainFrame: () => fakeFrame,
  };
  const ctx = { pages: () => [fakePage], on: () => {} };
  attachAutofill(ctx, { totalEntries: creds.length, lookup: () => creds }, (m) => logs.push(m));
  return {
    evalCalls,
    logs,
    navigate: async () => { fakePage._fn(fakeFrame); await new Promise((r) => setImmediate(r)); },
  };
}

test("W1E-5: never fills a credential stored for a different origin (lookalike subdomain)", async () => {
  const h = makeNavHarness("https://evil.atlassian.net/login", [
    { username: "alice", password: "p1", url: "https://mycompany.atlassian.net/login" },
  ]);
  await h.navigate();
  assert.strictEqual(h.evalCalls.length, 0, "lookalike origin must not be filled");
});

test("W1E-5: never fills on an http:// page", async () => {
  const h = makeNavHarness("http://example.com/login", [
    { username: "alice", password: "p1", url: "http://example.com/login" },
  ]);
  await h.navigate();
  assert.strictEqual(h.evalCalls.length, 0, "plain-http page must not be filled");
});

test("W1E-5: fills an exact-origin match and hands the page origin to the in-page check", async () => {
  const h = makeNavHarness("https://example.com/signin?next=/", [
    { username: "alice", password: "p1", url: "https://example.com/login" },
  ]);
  await h.navigate();
  assert.strictEqual(h.evalCalls.length, 1);
  assert.strictEqual(h.evalCalls[0].expectedOrigin, "https://example.com");
  assert.strictEqual(h.evalCalls[0].username, "alice");
});

// Execute the injected function itself (as Playwright does: serialized
// source, run in the page) against a minimal fake DOM.
function runFillScript({ origin, args }) {
  const filled = [];
  const makeInput = (name) => ({
    value: "",
    offsetParent: {},
    dispatchEvent: () => true,
    _name: name,
  });
  const userEl = makeInput("user");
  const passEl = makeInput("pass");
  const document = {
    querySelectorAll: (sel) => {
      if (sel === args.usernameSelectors[0]) return [userEl];
      if (sel === args.passwordSelectors[0]) return [passEl];
      return [];
    },
  };
  const sandbox = {
    document,
    location: { origin },
    getComputedStyle: () => ({ visibility: "visible" }),
    Event: class { constructor(type) { this.type = type; } },
    setTimeout,
    Date,
    Promise,
    Object,
  };
  const run = vm.runInNewContext("(" + fillScript.toString() + ")", sandbox);
  return run(args).then((result) => {
    if (userEl.value) filled.push("user");
    if (passEl.value) filled.push("pass");
    return { result, filled, userEl, passEl };
  });
}

const fillArgs = (expectedOrigin) => ({
  username: "alice",
  password: "p1",
  expectedOrigin,
  usernameSelectors: USERNAME_FIELD_SELECTORS,
  passwordSelectors: PASSWORD_FIELD_SELECTORS,
});

test("W1E-5: injected fill runs when the document is still on the expected origin", async () => {
  const { filled, passEl } = await runFillScript({ origin: "https://example.com", args: fillArgs("https://example.com") });
  assert.deepStrictEqual(filled, ["user", "pass"]);
  assert.strictEqual(passEl.value, "p1");
});

test("W1E-5: injected fill refuses once the document is on another origin", async () => {
  const { result, filled } = await runFillScript({ origin: "https://evil.example", args: fillArgs("https://example.com") });
  assert.deepStrictEqual(filled, [], "no field may be touched on a different origin");
  assert.strictEqual(result.user, false);
  assert.strictEqual(result.pass, false);
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
