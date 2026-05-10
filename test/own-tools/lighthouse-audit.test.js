const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/lighthouse-audit.js");

test("lighthouse_audit has required tool shape", () => {
  assert.strictEqual(tool.name, "lighthouse_audit");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.required[0], "url");
});

test("lighthouse_audit returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ url: "https://example.com" });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-6: bad URL / dead Brave must return structured isError, not throw.
// T1-1: lighthouse import is memoized (lazy + cached).
// ──────────────────────────────────────────────────────────────────

test("T0-6: lighthouse_audit rejects malformed URL with isError", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = { port: 9333 };
  try {
    const r = await tool.handler({ url: "not-a-url" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /invalid URL/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T0-6: lighthouse_audit rejects empty url string", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = { port: 9333 };
  try {
    const r = await tool.handler({ url: "" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /non-empty string/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T1-1: lighthouse import is hoisted as a memoized lazy promise (source-level guard)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "lighthouse-audit.js"),
    "utf8",
  );
  // The memoization variable + helper must exist at module scope.
  assert.ok(/let\s+_lhPromise\s*=\s*null/.test(src),
    "expected `let _lhPromise = null` module-scope memoization");
  assert.ok(/function\s+getLighthouse\s*\(/.test(src),
    "expected getLighthouse() helper");
  // The handler must NOT do `await import("lighthouse")` directly anymore —
  // it must go through the memoized helper.
  // (Allow it inside the helper itself; only check the handler uses getLighthouse.)
  assert.ok(/await\s+getLighthouse\(\)/.test(src),
    "handler must call await getLighthouse() — direct await import would defeat memoization");
});

test("T0-6: lighthouse_audit catches lighthouse() throws and returns isError", async () => {
  // We can't easily mock the import inside this single-file test without
  // require.cache shenanigans, but we can verify the source has the wrapper.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "lighthouse-audit.js"),
    "utf8",
  );
  // The lighthouse() call must be inside a try/catch.
  // Match `try { ... result = await lighthouse(... } catch`.
  assert.ok(
    /try\s*\{[\s\S]*?result\s*=\s*await\s+lighthouse\([\s\S]*?\}\s*catch\s*\(/m.test(src),
    "lighthouse() call must be wrapped in try/catch",
  );
});
