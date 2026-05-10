const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/download-capture.js");

test("download_capture has required tool shape", () => {
  assert.strictEqual(tool.name, "download_capture");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("download_capture returns isError when bridge missing", async () => {
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

// ──────────────────────────────────────────────────────────────────
// T0-9: short-circuit on page close — without this, download wait on a
// closed page hangs until full timeoutMs (default 30s).
// ──────────────────────────────────────────────────────────────────

test("T0-9: download_capture short-circuits when page closes before download", async () => {
  const prev = globalThis.__relayBridge;
  let registeredCloseHandler = null;
  // Fake page where waitForEvent("download") never resolves; close fires.
  const fakePage = {
    waitForEvent: (event, opts) => new Promise(() => {
      // never resolves (simulates "no download forthcoming")
    }),
    once: (event, fn) => {
      if (event === "close") registeredCloseHandler = fn;
    },
    off: () => {},
  };
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  try {
    // Long timeoutMs to prove the close path is what triggers fast resolution.
    const promise = tool.handler({ timeoutMs: 30000 });
    setTimeout(() => {
      if (registeredCloseHandler) registeredCloseHandler();
    }, 10);
    const result = await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("hung > 1s after close")), 1000)),
    ]);
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /page closed before download started/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
