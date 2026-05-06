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
