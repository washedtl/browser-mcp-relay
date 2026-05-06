const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/stealth-apply.js");

test("stealth_apply has required tool shape", () => {
  assert.strictEqual(tool.name, "stealth_apply");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("stealth_apply returns isError when bridge missing", async () => {
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
