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

// ──────────────────────────────────────────────────────────────────
// V0-6: setInputFiles failures must return structured {ok:false,error}
// instead of throwing through to relay-server's generic catch.
// ──────────────────────────────────────────────────────────────────

test("V0-6: file_upload returns isError + structured error when setInputFiles throws", async () => {
  const prev = globalThis.__relayBridge;
  // Fake bridge with a context whose pages()[0] is a page whose locator()
  // returns an object whose setInputFiles throws.
  const fakePage = {
    url: () => "about:blank",
    locator: () => ({
      setInputFiles: async () => { throw new Error("ENOENT: file not found"); },
    }),
  };
  const fakeContext = { pages: () => [fakePage] };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const result = await tool.handler({
      selector: "input[type=file]",
      files: ["/nonexistent/file.png"],
    });
    assert.strictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.ok, false);
    assert.match(parsed.error, /ENOENT|not found/i);
    assert.deepStrictEqual(parsed.files, ["/nonexistent/file.png"]);
    assert.strictEqual(parsed.selector, "input[type=file]");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("V0-6: file_upload success path returns ok:true with uploaded list", async () => {
  const prev = globalThis.__relayBridge;
  let lastFiles = null;
  const fakePage = {
    url: () => "about:blank",
    locator: () => ({
      setInputFiles: async (files) => { lastFiles = files; },
    }),
  };
  const fakeContext = { pages: () => [fakePage] };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const result = await tool.handler({
      selector: "input#file",
      files: ["/tmp/a.txt", "/tmp/b.txt"],
    });
    assert.notStrictEqual(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.uploaded, ["/tmp/a.txt", "/tmp/b.txt"]);
    assert.deepStrictEqual(lastFiles, ["/tmp/a.txt", "/tmp/b.txt"]);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
