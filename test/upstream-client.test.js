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
