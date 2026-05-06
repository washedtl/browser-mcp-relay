const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/file-upload.js");

test("file_upload has required tool shape", () => {
  assert.strictEqual(tool.name, "file_upload");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.deepStrictEqual(tool.inputSchema.required.sort(), ["files", "selector"]);
});

test("file_upload returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ selector: "input[type=file]", files: ["/tmp/x"] });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
