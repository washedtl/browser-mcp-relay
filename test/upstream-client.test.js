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
