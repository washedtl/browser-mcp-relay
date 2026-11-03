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

test("W2D: form_fill fills ctx.page only, not the context's other pages", async () => {
  const mine = makePageWithFillRecorder();
  const other = makePageWithFillRecorder();
  const result = await tool.handler({ fields: [{ selector: "#a", value: "x" }] }, { page: mine.fakePage, context: { pages: () => [other.fakePage, mine.fakePage] } });
  assert.notStrictEqual(result.isError, true, result.content[0].text);
  assert.strictEqual(mine.calls.length, 1);
  assert.strictEqual(other.calls.length, 0);
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
  const { fakePage, calls } = makePageWithFillRecorder();
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  await tool.handler({
    fields: [{ selector: "#a", value: "x" }, { selector: "#b", value: "y" }],
    timeoutMs: 7777,
  }, ctx);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].opts.timeout, 7777, "first fill must use the per-call timeout");
  assert.strictEqual(calls[1].opts.timeout, 7777);
});

test("T1-11: form_fill default timeoutMs is 5000 (NOT Playwright default 30000)", async () => {
  const { fakePage, calls } = makePageWithFillRecorder();
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  await tool.handler({ fields: [{ selector: "#a", value: "x" }] }, ctx);
  assert.strictEqual(calls[0].opts.timeout, 5000, "default per-field timeout must be 5000ms (was: implicit Playwright 30000)");
});

test("T1-11: form_fill continueOnError=true attempts all fields even on failure", async () => {
  const calls = [];
  const fakePage = {
    url: () => "https://x",
    isClosed: () => false,
    fill: async (selector, value) => {
      calls.push(selector);
      if (selector === "#bad") throw new Error("element not found");
    },
  };
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  const r = await tool.handler({
    fields: [
      { selector: "#a", value: "x" },
      { selector: "#bad", value: "y" },
      { selector: "#c", value: "z" },
    ],
    continueOnError: true,
  }, ctx);
  // All 3 selectors must have been attempted, even after #bad failed.
  assert.deepStrictEqual(calls, ["#a", "#bad", "#c"]);
  const payload = JSON.parse(r.content[0].text);
  assert.strictEqual(payload.filledCount, 2);
  assert.strictEqual(payload.total, 3);
  assert.strictEqual(r.isError, true, "result still flags error if any field failed");
});

test("T1-11: form_fill continueOnError=false (default) stops at first failure", async () => {
  const calls = [];
  const fakePage = {
    url: () => "https://x",
    isClosed: () => false,
    fill: async (selector) => {
      calls.push(selector);
      if (selector === "#bad") throw new Error("element not found");
    },
  };
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  await tool.handler({
    fields: [
      { selector: "#a", value: "x" },
      { selector: "#bad", value: "y" },
      { selector: "#c", value: "z" },
    ],
  }, ctx);
  // Should have stopped after #bad — #c never attempted.
  assert.deepStrictEqual(calls, ["#a", "#bad"]);
});

// ──────────────────────────────────────────────────────────────────
// W1C2: never echo a field's value (passwords) in error output.
// playwright-core 1.59 server/dom.js logs `  fill("${value}")` into the call
// log, and client/connection.js appends that call log to the thrown error's
// message — so e.message from a failed page.fill contains the raw value.
// ──────────────────────────────────────────────────────────────────

const SECRET = "hunter2-s3cret";

function failLikePlaywright({ selector, value, opts }) {
  if (selector !== "#pw") return;
  throw new Error(
    `page.fill: Timeout ${opts.timeout}ms exceeded.\nCall log:\n` +
    `  - waiting for locator('${selector}')\n` +
    `    - locator resolved to <input type="password" value="${value}"/>\n` +
    `  - fill("${value}")\n`,
  );
}

for (const continueOnError of [false, true]) {
  test(`W1C2: form_fill error output never contains a field value (continueOnError=${continueOnError})`, async () => {
    const { fakePage } = makePageWithFillRecorder(failLikePlaywright);
    const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
    const r = await tool.handler({
      fields: [{ selector: "#user", value: "alice" }, { selector: "#pw", value: SECRET }],
      continueOnError,
    }, ctx);
    assert.strictEqual(r.isError, true);
    const text = r.content[0].text;
    assert.ok(!text.includes(SECRET), `value leaked into error output:\n${text}`);
    // The diagnostic part of the message must survive redaction.
    assert.match(text, /Timeout 5000ms exceeded/);
    assert.match(text, /#pw/);
  });
}

// W1C2 (altitude review): exact-value replacement is not enough. Playwright's
// element previews in the call log rewrite newlines and truncate, so a
// multi-line value (e.g. a key pasted into a textarea) leaks in pieces; and
// blanking a 1-char value garbles the message ("Tim<redacted>out").
test("W1C2: form_fill: element previews of a multi-line value can't leak", async () => {
  const KEY = "-----BEGIN KEY-----\nAAAAsecretline1\nBBBBsecretline2\n-----END KEY-----";
  const { fakePage } = makePageWithFillRecorder(({ value, opts }) => {
    throw new Error(
      `page.fill: Timeout ${opts.timeout}ms exceeded.\nCall log:\n` +
      `  - waiting for locator('#key')\n` +
      `    - locator resolved to <textarea>${value.replace(/\s+/g, " ").slice(0, 40)}…</textarea>\n` +
      `  - fill("${value}")\n`,
    );
  });
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  const r = await tool.handler({ fields: [{ selector: "#key", value: KEY }] }, ctx);
  assert.strictEqual(r.isError, true);
  const text = r.content[0].text;
  for (const frag of ["AAAAsecretline1", "BBBBsecretline2"]) {
    assert.ok(!text.includes(frag), `fragment ${frag} leaked:\n${text}`);
  }
  assert.match(text, /Timeout 5000ms exceeded/);
});

test("W1C2: form_fill keeps the error readable for very short values", async () => {
  const { fakePage } = makePageWithFillRecorder(failLikePlaywright);
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  const r = await tool.handler({ fields: [{ selector: "#pw", value: "e" }] }, ctx);
  assert.match(r.content[0].text, /Timeout 5000ms exceeded/);
});

// W1C2 (spec review): keep the call log's plain diagnostics (why the fill
// failed) while dropping the lines that carry the value or element previews.
test("W1C2: form_fill keeps call-log diagnostics but not the value-bearing lines", async () => {
  const { fakePage } = makePageWithFillRecorder(({ value, opts }) => {
    throw new Error(
      `page.fill: Timeout ${opts.timeout}ms exceeded.\nCall log:\n` +
      `  - waiting for locator('#pw')\n` +
      `    - locator resolved to <input type="password" value="${value}"/>\n` +
      `    - fill("${value}")\n` +
      `  - attempting fill action\n` +
      `    - waiting for element to be visible, enabled and editable\n` +
      `    - element is not visible\n`,
    );
  });
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  const r = await tool.handler({ fields: [{ selector: "#pw", value: SECRET }] }, ctx);
  const text = r.content[0].text;
  assert.ok(!text.includes(SECRET), `value leaked:\n${text}`);
  assert.match(text, /element is not visible/);
  assert.match(text, /waiting for locator/);
  assert.doesNotMatch(text, /locator resolved to/);
});

test("W1C2: form_fill drops the fill line even if Playwright escapes the value", async () => {
  const VALUE = 's3cr"et-word';
  const { fakePage } = makePageWithFillRecorder(({ value, opts }) => {
    throw new Error(
      `page.fill: Timeout ${opts.timeout}ms exceeded.\nCall log:\n` +
      `  - waiting for locator('#pw')\n` +
      `    - fill(${JSON.stringify(value)})\n`,
    );
  });
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  const r = await tool.handler({ fields: [{ selector: "#pw", value: VALUE }] }, ctx);
  assert.ok(!r.content[0].text.includes("et-word"), `value leaked:\n${r.content[0].text}`);
});

// W1C2 (re-review V0): build the error exactly like playwright-core 1.59 does —
// server/callLog.js compressCallLog + client/connection.js formatCallLog, whose
// colors.dim (enabled even with piped stdio) re-wraps ANSI codes at every
// newline, so a multi-line value no longer matches `fill("<value>")` verbatim.
test("W1C2: form_fill redacts a multi-line value in a real (ANSI-coloured) Playwright call log", async () => {
  const path = require("node:path");
  const { colors } = require("playwright-core/lib/utilsBundle");
  // callLog is not in the package "exports"; load it by file path (read-only).
  const { compressCallLog } = require(path.join(path.dirname(require.resolve("playwright-core")), "lib", "server", "callLog.js"));
  const KEY = "-----BEGIN KEY-----\nAAAAsecretline1\r\nBBBBsecretline2\n-----END KEY-----";
  const { fakePage } = makePageWithFillRecorder(({ value, opts }) => {
    const log = compressCallLog([
      "waiting for locator('#key')",
      `  locator resolved to <textarea>${value.replace(/\n/g, "↵").slice(0, 50)}</textarea>`,
      `  fill("${value}")`,
      "  attempting fill action",
      "    waiting for element to be visible, enabled and editable",
      "    element is not visible",
      "  retrying fill action",
      "  attempting fill action",
      "    waiting for element to be visible, enabled and editable",
      "    element is not visible",
      "  retrying fill action",
    ]);
    throw new Error(`page.fill: Timeout ${opts.timeout}ms exceeded.\nCall log:\n${colors.dim(log.join("\n"))}\n`);
  });
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  const r = await tool.handler({ fields: [{ selector: "#key", value: KEY }] }, ctx);
  const text = r.content[0].text;
  for (const frag of ["AAAAsecretline1", "BBBBsecretline2", "END KEY"]) {
    assert.ok(!text.includes(frag), `fragment ${frag} leaked:\n${text}`);
  }
  assert.match(text, /element is not visible/);
  // compressCallLog writes a repeated block's first line as "2 × …" (no "- ").
  assert.match(text, /2 × attempting fill action/, `repeat-block header dropped:\n${text}`);
});

test("W1C2 review: a value that itself contains ANSI codes + a '- ' line can't leak", async () => {
  const secret = "x\x1b[0m\n- s3cretTail";
  const page = {
    url: () => "https://example.com/login",
    fill: async () => {
      throw new Error(
        "page.fill: Timeout 5000ms exceeded.\nCall log:\n" +
        "  - waiting for locator('#pw')\n" +
        `  - fill("${secret}")\n` +
        "  - element is not visible\n",
      );
    },
  };
  const res = await tool.handler({ fields: [{ selector: "#pw", value: secret }] }, { page, context: { pages: () => [page] } });
  const text = res.content.map((c) => c.text).join("\n");
  assert.ok(!text.includes("s3cretTail"), "secret tail must not appear: " + text);
  assert.ok(text.includes("element is not visible"), "diagnostic line survives");
});
