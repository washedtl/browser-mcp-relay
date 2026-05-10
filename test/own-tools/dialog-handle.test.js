const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/dialog-handle.js");

test("dialog_handle has required tool shape", () => {
  assert.strictEqual(tool.name, "dialog_handle");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.deepStrictEqual(tool.inputSchema.properties.action.enum, ["accept", "dismiss"]);
});

test("dialog_handle returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-9: short-circuit on page close — without this, dialog wait on a
// closed page hangs until full timeoutMs (default 30s).
// ──────────────────────────────────────────────────────────────────

test("T0-9: dialog_handle short-circuits when page closes before dialog", async () => {
  const prev = globalThis.__relayBridge;
  let registeredCloseHandler = null;
  const fakePage = {
    once: (event, fn) => {
      if (event === "close") registeredCloseHandler = fn;
    },
    off: () => {},
  };
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  try {
    // Start dialog wait with a long timeout, then trigger close.
    const promise = tool.handler({ action: "accept", timeoutMs: 30000 });
    // Trigger close immediately.
    setTimeout(() => {
      if (registeredCloseHandler) registeredCloseHandler();
    }, 10);
    const result = await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("hung > 1s after close")), 1000)),
    ]);
    assert.strictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(payload.pageClosed, true);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-10: defaultValue is a method, not a getter. The `?.` was dead.
// ──────────────────────────────────────────────────────────────────

test("T0-10: dialog_handle calls defaultValue() as a method", async () => {
  const prev = globalThis.__relayBridge;
  let registeredDialogHandler = null;
  const fakePage = {
    once: (event, fn) => { if (event === "dialog") registeredDialogHandler = fn; },
    off: () => {},
  };
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  let dvCallCount = 0;
  const fakeDialog = {
    type: () => "prompt",
    message: () => "Enter name",
    defaultValue: () => { dvCallCount++; return "alice"; },
    accept: async () => {},
  };
  try {
    const promise = tool.handler({ action: "accept", timeoutMs: 1000 });
    // Allow the once() registration to occur.
    await new Promise((r) => setImmediate(r));
    await registeredDialogHandler(fakeDialog);
    const result = await promise;
    assert.notStrictEqual(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.strictEqual(dvCallCount, 1, "defaultValue() must be called exactly once");
    assert.strictEqual(payload.defaultValue, "alice", "defaultValue value must reach the response");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// V1-3: if timeout fires AND dialog arrives in the same tick, both branches
// would resolve the promise. The `settled` guard ensures exactly one outcome.
test("V1-3: dialog_handle settles exactly once when timeout + dialog race", async () => {
  const prev = globalThis.__relayBridge;

  // Fake page: capture the registered dialog handler + timeout listener so
  // we can fire BOTH ourselves in the same tick.
  let registeredDialogHandler = null;
  const fakePage = {
    once: (event, fn) => { if (event === "dialog") registeredDialogHandler = fn; },
    off: () => {},
  };
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };

  // Use a tiny timeout, then synchronously fire the dialog as well.
  let acceptCalls = 0;
  const fakeDialog = {
    type: () => "alert",
    message: () => "test",
    defaultValue: () => "",
    accept: async () => { acceptCalls++; },
    dismiss: async () => {},
  };

  try {
    // Start the handler with a 50ms timeout.
    const promise = tool.handler({ action: "accept", timeoutMs: 50 });
    // Wait long enough for the timeout to fire AND fire the dialog after.
    await new Promise((r) => setTimeout(r, 60));
    // Now invoke the dialog handler — simulating "dialog arrived in same
    // tick as timeout"; the guard should make this a no-op.
    if (registeredDialogHandler) {
      await registeredDialogHandler(fakeDialog);
    }
    const result = await promise;
    // The promise resolved exactly once. Either branch is acceptable as
    // long as the OPPOSITE branch was a no-op.
    assert.ok(result, "handler resolved");
    if (result.isError) {
      // Timeout won: dialog handler must NOT have accepted the dialog.
      assert.strictEqual(acceptCalls, 0,
        "if timeout won, dialog.accept() must NOT have been called");
      assert.match(result.content[0].text, /timeout/i);
    } else {
      // Dialog won: accept was called exactly once.
      assert.strictEqual(acceptCalls, 1, "if dialog won, accept called exactly once");
    }
  } finally {
    globalThis.__relayBridge = prev;
  }
});
