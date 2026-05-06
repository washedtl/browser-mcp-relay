const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/capture-xhr.js");

test("capture_xhr has required tool shape", () => {
  assert.strictEqual(tool.name, "capture_xhr");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("capture_xhr returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
