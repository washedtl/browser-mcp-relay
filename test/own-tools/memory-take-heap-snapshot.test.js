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

// ──────────────────────────────────────────────────────────────────
// W1C2: per-page lock, timeout, and session detach.
//
// Fake models playwright-core 1.59 client CDPSession: an EventEmitter that
// re-emits every CDP event to EVERY listener on that session, and each
// context.newCDPSession(page) call returns a NEW session. Chunks of a
// HeapProfiler.takeHeapSnapshot are delivered as events on the session that
// sent the command, before the command resolves.
// ──────────────────────────────────────────────────────────────────

const { EventEmitter } = require("node:events");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

function makeSnapshotFixture({ snapshotImpl } = {}) {
  const sessions = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let seq = 0;
  const page = { url: () => "https://x", isClosed: () => false, once: () => {} };
  const context = {
    pages: () => [page],
    newCDPSession: async () => {
      const s = new EventEmitter();
      s.detachCalls = 0;
      s.detach = async () => { s.detachCalls++; };
      s.send = async (method) => {
        if (method !== "HeapProfiler.takeHeapSnapshot") return {};
        const tag = String.fromCharCode(65 + seq++); // "A", "B", …
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (snapshotImpl) return await snapshotImpl(s, tag);
          for (let i = 1; i <= 3; i++) {
            await new Promise((r) => setImmediate(r));
            s.emit("HeapProfiler.addHeapSnapshotChunk", { chunk: `${tag}${i}` });
          }
          return {};
        } finally {
          inFlight--;
        }
      };
      sessions.push(s);
      return s;
    },
  };
  return { page, context, sessions, maxInFlight: () => maxInFlight };
}

const tmpDirs = [];
function tmpOut(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w1c2-heap-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}
test.after(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

async function withBridge(context, fn) {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = { context };
  try { return await fn(); } finally { globalThis.__relayBridge = prev; }
}

test("W1C2: concurrent snapshots on one page write uncorrupted files and never overlap", async () => {
  const fx = makeSnapshotFixture();
  const out1 = tmpOut("one.heapsnapshot");
  const out2 = tmpOut("two.heapsnapshot");
  const [r1, r2] = await withBridge(fx.context, () => Promise.all([
    tool.handler({ outputPath: out1 }),
    tool.handler({ outputPath: out2 }),
  ]));
  assert.notStrictEqual(r1.isError, true, r1.content[0].text);
  assert.notStrictEqual(r2.isError, true, r2.content[0].text);
  const files = [fs.readFileSync(out1, "utf8"), fs.readFileSync(out2, "utf8")].sort();
  assert.deepStrictEqual(files, ["A1A2A3", "B1B2B3"], "each file must hold exactly one snapshot's chunks");
  assert.strictEqual(fx.maxInFlight(), 1, "snapshots on the same page must be serialized");
});

test("W1C2: snapshot session is detached after success and after a CDP failure", async () => {
  const ok = makeSnapshotFixture();
  const r = await withBridge(ok.context, () => tool.handler({ outputPath: tmpOut("ok.heapsnapshot"), timeoutMs: null }));
  assert.notStrictEqual(r.isError, true, r.content[0].text);
  assert.strictEqual(ok.sessions.length, 1);
  assert.strictEqual(ok.sessions[0].detachCalls, 1, "session must be detached after a successful snapshot");

  const bad = makeSnapshotFixture({ snapshotImpl: async () => { throw new Error("Target crashed"); } });
  const out = tmpOut("bad.heapsnapshot");
  const r2 = await withBridge(bad.context, () => tool.handler({ outputPath: out }));
  assert.strictEqual(r2.isError, true);
  assert.match(r2.content[0].text, /Target crashed/);
  assert.strictEqual(bad.sessions[0].detachCalls, 1, "session must be detached when takeHeapSnapshot throws");
  assert.ok(!fs.existsSync(out), "partial file must be removed");
});

test("W1C2: hung snapshot times out, detaches, removes the partial file, and releases the lock", { timeout: 10000 }, async () => {
  let hang = true;
  const fx = makeSnapshotFixture({
    snapshotImpl: async (s, tag) => {
      s.emit("HeapProfiler.addHeapSnapshotChunk", { chunk: `${tag}1` });
      if (hang) { hang = false; return new Promise(() => {}); } // first call never completes
      return {};
    },
  });
  const out = tmpOut("hung.heapsnapshot");
  const r = await withBridge(fx.context, () => tool.handler({ outputPath: out, timeoutMs: 1000 }));
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /timed out after 1000ms/);
  assert.strictEqual(fx.sessions[0].detachCalls, 1, "timed-out session must be detached");
  assert.ok(!fs.existsSync(out), "partial file must be removed after a timeout");

  // Lock released: the next snapshot on the same page runs on a fresh session.
  const r2 = await withBridge(fx.context, () => tool.handler({ outputPath: tmpOut("next.heapsnapshot"), timeoutMs: 1000 }));
  assert.notStrictEqual(r2.isError, true, r2.content[0].text);
});

test("W1C2: timeoutMs is validated", async () => {
  const fx = makeSnapshotFixture();
  for (const bad of [0, -5, "abc", Number.NaN, 1800001]) {
    const r = await withBridge(fx.context, () => tool.handler({ timeoutMs: bad }));
    assert.strictEqual(r.isError, true, `timeoutMs=${bad} must be rejected`);
    assert.match(r.content[0].text, /timeoutMs/);
  }
  assert.strictEqual(fx.sessions.length, 0, "no CDP session for rejected input");
});

test("W1C2: concurrent default-path snapshots in the same millisecond get distinct files", async (t) => {
  t.mock.method(Date, "now", () => 1700000000000);
  const fx = makeSnapshotFixture();
  const results = await withBridge(fx.context, () => Promise.all([tool.handler({}), tool.handler({})]));
  const outs = results.map((r) => {
    assert.notStrictEqual(r.isError, true, r.content[0].text);
    return JSON.parse(r.content[0].text).outputPath;
  });
  try {
    assert.notStrictEqual(outs[0], outs[1], "default paths must not collide");
    const files = outs.map((p) => fs.readFileSync(p, "utf8")).sort();
    assert.deepStrictEqual(files, ["A1A2A3", "B1B2B3"]);
  } finally {
    for (const p of new Set(outs)) fs.rmSync(p, { force: true });
  }
});
