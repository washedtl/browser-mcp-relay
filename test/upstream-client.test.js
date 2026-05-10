const test = require("node:test");
const assert = require("node:assert");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { UpstreamClient } = require("../src/upstream-client.js");

const MOCK_UPSTREAM_PATH = path.join(__dirname, "fixtures", "mock-upstream.js");

test("UpstreamClient.request() resolves with matched id response", async () => {
  const child = spawn("node", [MOCK_UPSTREAM_PATH], { stdio: ["pipe", "pipe", "inherit"] });
  const client = new UpstreamClient(child.stdout, child.stdin);
  try {
    const result = await client.request("tools/list", {}, 5000);
    assert.ok(Array.isArray(result.tools), "expected tools array in result");
    assert.strictEqual(result.tools[0].name, "echo");
  } finally {
    client.close();
    child.kill();
  }
});

test("UpstreamClient rejects on timeout", async () => {
  const child = spawn("node", [MOCK_UPSTREAM_PATH, "--no-reply"], { stdio: ["pipe", "pipe", "inherit"] });
  const client = new UpstreamClient(child.stdout, child.stdin);
  try {
    await assert.rejects(
      client.request("any/method", {}, 200),
      /timeout/i,
    );
  } finally {
    client.close();
    child.kill();
  }
});

test("UpstreamClient.request() rejects after close()", async () => {
  const child = spawn("node", [MOCK_UPSTREAM_PATH], { stdio: ["pipe", "pipe", "inherit"] });
  const client = new UpstreamClient(child.stdout, child.stdin);
  client.close();
  await assert.rejects(client.request("tools/list", {}, 1000), /closed/i);
  child.kill();
});

test("V0-4: UpstreamClient.request() default timeout is 180s (covers lighthouse_audit)", () => {
  // Source-level guard: the default timeout signature must be 180_000.
  // 30_000 silently broke long-running forwarded calls (lighthouse, save-as-pdf)
  // — the upstream kept working past the timeout, but its eventual response
  // was orphaned because the request had already been deleted from `pending`.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "src", "upstream-client.js"),
    "utf8",
  );
  // Grep for the timeoutMs default. Must be 180000, not 30000.
  const m = src.match(/request\(\s*method,\s*params\s*=\s*\{\}\s*,\s*timeoutMs\s*=\s*(\d+)/);
  assert.ok(m, "expected to find request() signature");
  assert.strictEqual(m[1], "180000", "default timeoutMs must be 180000ms (3min) for slow forwarded calls");
});

test("V0-4: explicit timeout still wins over default", async () => {
  // Sanity: passing an explicit short timeout still triggers fast.
  const path = require("node:path");
  const child = spawn("node", [path.join(__dirname, "fixtures", "mock-upstream.js"), "--no-reply"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const client = new UpstreamClient(child.stdout, child.stdin);
  try {
    const t0 = Date.now();
    await assert.rejects(client.request("any/method", {}, 200), /timeout/i);
    const elapsed = Date.now() - t0;
    // Should fire within ~200ms, NOT wait for the default.
    assert.ok(elapsed < 5000, `expected timeout in <5s, got ${elapsed}ms`);
  } finally {
    client.close();
    child.kill();
  }
});

test("UpstreamClient handles multiple concurrent requests with id multiplexing", async () => {
  const child = spawn("node", [MOCK_UPSTREAM_PATH], { stdio: ["pipe", "pipe", "inherit"] });
  const client = new UpstreamClient(child.stdout, child.stdin);
  try {
    // Fire 5 requests in parallel; mock replies to each with empty result.
    const results = await Promise.all([
      client.request("a/x", {}, 5000),
      client.request("b/x", {}, 5000),
      client.request("c/x", {}, 5000),
      client.request("d/x", {}, 5000),
      client.request("tools/list", {}, 5000),
    ]);
    assert.strictEqual(results.length, 5);
    // The 5th request was tools/list; it should have a tools array.
    assert.ok(Array.isArray(results[4].tools));
  } finally {
    client.close();
    child.kill();
  }
});

// ──────────────────────────────────────────────────────────────────
// V0-2: setEncoding('utf8') prevents multi-byte UTF-8 corruption on
// chunk boundaries. Without it, an emoji / CJK / accented char split
// across two chunks decodes as U+FFFD, breaking JSON.parse.
// ──────────────────────────────────────────────────────────────────

test("V0-2: constructor calls setEncoding('utf8') on the readable", () => {
  const calls = [];
  const fakeReadable = {
    setEncoding(enc) { calls.push(enc); },
    on() { /* no-op for this test */ },
    off() {},
  };
  const fakeWritable = { write() {} };
  // eslint-disable-next-line no-new
  new UpstreamClient(fakeReadable, fakeWritable);
  assert.deepStrictEqual(calls, ["utf8"], "expected setEncoding('utf8') to be called exactly once");
});

test("V0-2: multi-byte UTF-8 char split across chunks decodes correctly via PassThrough", async () => {
  const { PassThrough } = require("node:stream");
  const readable = new PassThrough();
  const writable = new PassThrough(); // not actually used in this test
  const client = new UpstreamClient(readable, writable);

  // Send a request promise and resolve it via the response.
  // The response includes a multi-byte char (😀 = 4-byte UTF-8 F0 9F 98 80)
  // split between two raw-byte writes. setEncoding('utf8') buffers the
  // partial sequence inside Node's StringDecoder; without it, both halves
  // would surface as U+FFFD and JSON.parse would fail.
  const reqP = client.request("test/method", {}, 1000);
  const responseObj = { jsonrpc: "2.0", id: 1, result: { greeting: "hi 😀" } };
  const line = JSON.stringify(responseObj) + "\n";
  const buf = Buffer.from(line, "utf8");
  // Find a byte index inside the multi-byte emoji.
  const emojiStart = buf.indexOf(Buffer.from("😀", "utf8"));
  assert.ok(emojiStart > 0, "fixture should contain emoji bytes");
  const splitAt = emojiStart + 2; // mid-emoji split

  readable.write(buf.subarray(0, splitAt));
  readable.write(buf.subarray(splitAt));

  const result = await reqP;
  assert.strictEqual(result.greeting, "hi 😀");
  client.close();
});

// ──────────────────────────────────────────────────────────────────
// V0-5a: JSON-RPC 2.0 id may be number, string, or null. Production
// previously rejected anything not typeof === "number" — silently
// dropping spec-compliant string-id responses, causing the matching
// request() to time out at 180s instead of resolving immediately.
// ──────────────────────────────────────────────────────────────────

test("V0-5a: response with string id is dispatched (not silently dropped)", async () => {
  const { PassThrough } = require("node:stream");
  const readable = new PassThrough();
  const writable = new PassThrough();
  const client = new UpstreamClient(readable, writable);
  // Manually inject a pending entry with a string id (simulates a peer
  // that uses string ids — spec-allowed).
  let resolved = null;
  client.pending.set("custom-id", {
    resolve: (r) => { resolved = r; },
    reject: () => {},
    timer: setTimeout(() => {}, 0),
  });
  const line = JSON.stringify({ jsonrpc: "2.0", id: "custom-id", result: { ok: true } }) + "\n";
  readable.write(line);
  // Allow the data event to flush.
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(resolved, { ok: true });
  client.close();
});

// ──────────────────────────────────────────────────────────────────
// V0-5b: After _onError fires (e.g. transport error), subsequent
// request() calls must reject FAST instead of queueing into a doomed
// pending Map and timing out at 180s.
// ──────────────────────────────────────────────────────────────────

test("V0-5b: request() after _onError rejects fast (closed flag set)", async () => {
  const { PassThrough } = require("node:stream");
  const readable = new PassThrough();
  const writable = new PassThrough();
  const client = new UpstreamClient(readable, writable);
  // Trigger _onError directly.
  client._onError(new Error("transport boom"));
  await assert.rejects(
    client.request("any/method", {}, 30000),
    /closed/i,
    "expected fast rejection after _onError",
  );
});

// ──────────────────────────────────────────────────────────────────
// V0-7: _onClose / _onError / close() detach data/close/error listeners
// so a still-alive readable stops feeding chunks into a dead client.
// ──────────────────────────────────────────────────────────────────

test("V0-7: close() removes listeners from the readable", () => {
  const { EventEmitter } = require("node:events");
  const readable = new EventEmitter();
  readable.setEncoding = () => {}; // satisfy guard
  const writable = { write() {} };
  const client = new UpstreamClient(readable, writable);
  // Three listeners attached: data, close, error.
  assert.strictEqual(readable.listenerCount("data"), 1);
  assert.strictEqual(readable.listenerCount("close"), 1);
  assert.strictEqual(readable.listenerCount("error"), 1);
  client.close();
  assert.strictEqual(readable.listenerCount("data"), 0, "data listener should be removed");
  assert.strictEqual(readable.listenerCount("close"), 0, "close listener should be removed");
  assert.strictEqual(readable.listenerCount("error"), 0, "error listener should be removed");
});

test("V0-7: _onClose is idempotent (double-fire safe)", () => {
  const { EventEmitter } = require("node:events");
  const readable = new EventEmitter();
  readable.setEncoding = () => {};
  const writable = { write() {} };
  const client = new UpstreamClient(readable, writable);
  // Inject a pending; after first close it should reject; second close should be a no-op.
  let rejectCount = 0;
  client.pending.set(1, {
    resolve: () => {},
    reject: () => { rejectCount++; },
    timer: setTimeout(() => {}, 1000),
  });
  readable.emit("close");
  readable.emit("close"); // second emit must not double-reject
  assert.strictEqual(rejectCount, 1);
});
