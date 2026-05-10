const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/form-fill.js");

test("form_fill has required tool shape", () => {
  assert.strictEqual(tool.name, "form_fill");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.required[0], "fields");
});

test("form_fill returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ fields: [{ selector: "#a", value: "x" }] });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T1-11: per-field timeoutMs option + continueOnError mode.
// ──────────────────────────────────────────────────────────────────

function makePageWithFillRecorder(fillImpl) {
  const calls = [];
  const fakePage = {
    url: () => "https://x",
    isClosed: () => false,
    fill: async (selector, value, opts) => {
      calls.push({ selector, value, opts });
      if (fillImpl) await fillImpl({ selector, value, opts });
    },
  };
  return { fakePage, calls };
}

test("T1-11: form_fill passes timeoutMs to page.fill", async () => {
  const prev = globalThis.__relayBridge;
  const { fakePage, calls } = makePageWithFillRecorder();
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  try {
    await tool.handler({
      fields: [{ selector: "#a", value: "x" }, { selector: "#b", value: "y" }],
      timeoutMs: 7777,
    });
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].opts.timeout, 7777, "first fill must use the per-call timeout");
    assert.strictEqual(calls[1].opts.timeout, 7777);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T1-11: form_fill default timeoutMs is 5000 (NOT Playwright default 30000)", async () => {
  const prev = globalThis.__relayBridge;
  const { fakePage, calls } = makePageWithFillRecorder();
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  try {
    await tool.handler({ fields: [{ selector: "#a", value: "x" }] });
    assert.strictEqual(calls[0].opts.timeout, 5000, "default per-field timeout must be 5000ms (was: implicit Playwright 30000)");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T1-11: form_fill continueOnError=true attempts all fields even on failure", async () => {
  const prev = globalThis.__relayBridge;
  const calls = [];
  const fakePage = {
    url: () => "https://x",
    isClosed: () => false,
    fill: async (selector, value) => {
      calls.push(selector);
      if (selector === "#bad") throw new Error("element not found");
    },
  };
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  try {
    const r = await tool.handler({
      fields: [
        { selector: "#a", value: "x" },
        { selector: "#bad", value: "y" },
        { selector: "#c", value: "z" },
      ],
      continueOnError: true,
    });
    // All 3 selectors must have been attempted, even after #bad failed.
    assert.deepStrictEqual(calls, ["#a", "#bad", "#c"]);
    const payload = JSON.parse(r.content[0].text);
    assert.strictEqual(payload.filledCount, 2);
    assert.strictEqual(payload.total, 3);
    assert.strictEqual(r.isError, true, "result still flags error if any field failed");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T1-11: form_fill continueOnError=false (default) stops at first failure", async () => {
  const prev = globalThis.__relayBridge;
  const calls = [];
  const fakePage = {
    url: () => "https://x",
    isClosed: () => false,
    fill: async (selector) => {
      calls.push(selector);
      if (selector === "#bad") throw new Error("element not found");
    },
  };
  globalThis.__relayBridge = { context: { pages: () => [fakePage] } };
  try {
    await tool.handler({
      fields: [
        { selector: "#a", value: "x" },
        { selector: "#bad", value: "y" },
        { selector: "#c", value: "z" },
      ],
    });
    // Should have stopped after #bad — #c never attempted.
    assert.deepStrictEqual(calls, ["#a", "#bad"]);
  } finally {
    globalThis.__relayBridge = prev;
  }
});
