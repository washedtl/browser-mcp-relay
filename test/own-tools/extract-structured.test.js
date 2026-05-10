const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/extract-structured.js");

test("extract_structured has required tool shape", () => {
  assert.strictEqual(tool.name, "extract_structured");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.deepStrictEqual(tool.inputSchema.required, ["schema"]);
});

test("extract_structured returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ schema: { x: { selector: ".x" } } });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-5: validate schema arg upfront — null / non-object / empty
// produce a clean structured error instead of an opaque failure
// inside page.evaluate's "Cannot convert undefined or null to object".
// ──────────────────────────────────────────────────────────────────

const fakeBridgeWithPage = () => ({
  context: {
    pages: () => [{
      url: () => "https://x",
      isClosed: () => false,
      evaluate: async () => ({}),
      goto: async () => undefined,
      waitForSelector: async () => undefined,
    }],
  },
});

test("T0-5: extract_structured rejects schema=null at entry", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = fakeBridgeWithPage();
  try {
    const r = await tool.handler({ schema: null });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /schema must be a non-null object/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T0-5: extract_structured rejects empty schema {} at entry", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = fakeBridgeWithPage();
  try {
    const r = await tool.handler({ schema: {} });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /at least one field/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T0-5: extract_structured rejects schema=array (non-object)", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = fakeBridgeWithPage();
  try {
    const r = await tool.handler({ schema: [{ selector: ".x" }] });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /schema must be a non-null object/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T1-4: extract_structured default attribute is textContent (source-level guard)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "extract-structured.js"),
    "utf8",
  );
  // The default `attr = spec.attribute || "textContent"` line is what makes
  // big-list extraction fast. Reverting to innerText would re-introduce the
  // layout-thrash slowdown.
  assert.ok(
    /spec\.attribute\s*\|\|\s*"textContent"/.test(src),
    "default attribute must be textContent (was innerText pre-T1-4)",
  );
});
