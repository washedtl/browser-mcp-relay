const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/cookies-export.js");

test("cookies_export has required tool shape", () => {
  assert.strictEqual(tool.name, "cookies_export");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("cookies_export returns isError when bridge missing", async () => {
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

// V1-4: Playwright's `context.cookies([])` returns ALL cookies (empty array
// = no filter). Caller passing `urls: []` likely expects "no matching URLs",
// not the entire cookie vault — privacy concern.
test("V1-4: cookies_export with urls=[] returns empty list, NOT all cookies", async () => {
  const prev = globalThis.__relayBridge;
  let cookiesCalledWith = "NOT_CALLED";
  const fakeContext = {
    cookies: async (filter) => {
      cookiesCalledWith = filter;
      // Pretend the vault is huge.
      return [
        { name: "session", value: "secret", domain: ".example.com", path: "/" },
        { name: "auth", value: "token", domain: ".other.com", path: "/" },
      ];
    },
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const result = await tool.handler({ urls: [] });
    const payload = JSON.parse(result.content[0].text);
    // Critical: empty filter must produce an EMPTY result, NOT the full vault.
    assert.strictEqual(payload.count, 0);
    assert.deepStrictEqual(payload.cookies, []);
    // Even better: context.cookies() must not be called at all when urls=[].
    assert.strictEqual(cookiesCalledWith, "NOT_CALLED",
      "context.cookies() must NOT be invoked for urls=[] (Playwright would treat empty as 'no filter')");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("V1-4: cookies_export with urls=undefined still returns full vault (existing behavior)", async () => {
  // Sanity: omitting `urls` entirely should still return everything.
  const prev = globalThis.__relayBridge;
  const fakeContext = {
    cookies: async () => [{ name: "session", value: "x", domain: ".example.com", path: "/" }],
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const result = await tool.handler({});
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.count, 1);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
