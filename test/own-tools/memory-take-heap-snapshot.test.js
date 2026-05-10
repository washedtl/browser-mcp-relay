const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/memory-take-heap-snapshot.js");

test("memory_take-heap-snapshot has required tool shape", () => {
  assert.strictEqual(tool.name, "memory_take-heap-snapshot");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.type, "object");
});

test("memory_take-heap-snapshot returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// V1-1: source-level guard for the two known issues —
//   (a) sync I/O (writeFileSync on a 50-500MB heap) blocks the event loop;
//   (b) inline cdp.detach() right after takeHeapSnapshot leaks the session
//       if takeHeapSnapshot threw.
test("V1-1 + T1-3: memory_take-heap-snapshot streams chunks to disk (no sync I/O, no full-buffer)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "memory-take-heap-snapshot.js"),
    "utf8",
  );
  // Strip block + line comments so source-greps don't match comment text.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // The bug: writeFileSync blocks the event loop for seconds on big heaps.
  assert.ok(!/\bfs\.writeFileSync\s*\(/.test(code),
    "memory-take-heap-snapshot.js must NOT call fs.writeFileSync()");
  assert.ok(!/\bfs\.statSync\s*\(/.test(code),
    "memory-take-heap-snapshot.js must NOT call fs.statSync()");
  // T1-3: must stream via createWriteStream, NOT buffer + writeFile at end.
  // Buffering chunks.join("") doubles peak memory on large heaps.
  assert.ok(/fs\.createWriteStream\s*\(/.test(code),
    "memory-take-heap-snapshot.js must use fs.createWriteStream (T1-3 streaming)");
  assert.ok(!/chunks\.join\s*\(/.test(code),
    "memory-take-heap-snapshot.js must NOT call chunks.join() (T1-3: stream instead of buffer-and-join)");
});

test("V1-1: memory_take-heap-snapshot source no longer calls cdp.detach() inline", () => {
  // The bug: inline `cdp.detach()` after takeHeapSnapshot leaked the CDP
  // session if takeHeapSnapshot threw. Fix: route through the per-page
  // CDP cache (auto-detach on page close).
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "memory-take-heap-snapshot.js"),
    "utf8",
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  // Must not call detach() at all in this file — it's owned by the helper.
  assert.ok(!/\bcdp\.detach\s*\(/.test(code),
    "memory-take-heap-snapshot.js must NOT call cdp.detach() (use _page-cdp-session helper)");
  // Must use the shared helper.
  assert.ok(/getOrCreatePageCdp/.test(code),
    "memory-take-heap-snapshot.js must use getOrCreatePageCdp");
});
