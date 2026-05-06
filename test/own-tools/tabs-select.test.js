const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/tabs-select.js");

test("tabs_select has required tool shape", () => {
  assert.strictEqual(tool.name, "tabs_select");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.required[0], "index");
});

test("tabs_select returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ index: 0 });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
