const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/form-fill.js");

test("form_fill has required tool shape", () => {
  assert.strictEqual(tool.name, "form_fill");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.required[0], "fields");
});

test("form_fill returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ fields: [{ selector: "#a", value: "x" }] });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
