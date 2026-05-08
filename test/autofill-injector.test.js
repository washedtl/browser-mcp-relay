const test = require("node:test");
const assert = require("node:assert");

const { attachAutofill } = require("../src/autofill-injector.js");

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
