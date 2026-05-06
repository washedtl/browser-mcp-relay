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
    const result = await tool.handler({ schema: {} });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
