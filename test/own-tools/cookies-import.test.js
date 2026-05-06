const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/cookies-import.js");

test("cookies_import has required tool shape", () => {
  assert.strictEqual(tool.name, "cookies_import");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.deepStrictEqual(tool.inputSchema.required, ["cookies"]);
});

test("cookies_import returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ cookies: [] });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
