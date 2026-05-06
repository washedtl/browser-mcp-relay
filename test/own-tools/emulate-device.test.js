const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/emulate-device.js");

test("emulate_device has required tool shape", () => {
  assert.strictEqual(tool.name, "emulate_device");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.type, "object");
  assert.ok(tool.inputSchema.properties.viewport);
  assert.ok(tool.inputSchema.properties.network);
});

test("emulate_device returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ userAgent: "test" });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
