// memory_take-heap-snapshot — V8 heap snapshot via CDP HeapProfiler.
// Saves to a file (default OS temp dir) and returns the path.
//
// V1-1: previously detached the CDP session inline + used fs.writeFileSync.
// Two issues:
//   (a) if takeHeapSnapshot threw, detach was skipped → CDP session leaked.
//   (b) writeFileSync on a 50-500 MB heap blocks the event loop for seconds.
// Fix: use fs.promises / streams (and, since W1C2, detach in `finally`).
//
// W1C2 (2026-11-03):
//   • dedicated CDP session per snapshot, detached afterwards. The shared
//     per-page session (_page-cdp-session.js) re-emits every chunk to every
//     listener, so two concurrent calls wrote each other's chunks; it also
//     can't be detached to abort a hung snapshot without dropping
//     emulate_device's overrides.
//   • per-page lock: snapshots on the same page run one at a time.
//   • timeoutMs: a hung snapshot returns isError instead of blocking forever.
//
// T1-3 fix (2026-05-09):
//   • stream chunks directly to disk via createWriteStream as they arrive,
//     instead of accumulating them in a string array and joining at the end.
//     `chunks.join("")` materializes the full snapshot string in memory before
//     write — peak RSS ~2× snapshot size. On a 500MB heap that's an extra
//     500MB of duplication. Streaming = roughly constant memory regardless
//     of snapshot size.

const path = require("node:path");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_TIMEOUT_MS = 30 * 60 * 1000;

// W1C2: page → tail of that page's snapshot queue (entry dies with the page).
const SNAPSHOT_QUEUE = new WeakMap();
let defaultPathSeq = 0;

function withPageLock(page, fn) {
  const run = (SNAPSHOT_QUEUE.get(page) || Promise.resolve()).then(() => fn());
  SNAPSHOT_QUEUE.set(page, run.catch(() => {}));
  return run;
}

module.exports = {
  name: "memory_take-heap-snapshot",
  description:
    "Take a V8 heap snapshot of this tab via CDP HeapProfiler. " +
    "Saves the .heapsnapshot file to disk and returns its path. " +
    "The file can be loaded into Chrome DevTools' Memory tab for analysis. " +
    "Chunks are streamed directly to disk so memory overhead stays constant " +
    "regardless of snapshot size; raise timeoutMs for multi-GB heaps. Snapshots " +
    "of the same page run one at a time, and a timed-out snapshot keeps running " +
    "in the page, so the next call may wait for it.",
  inputSchema: {
    type: "object",
    properties: {
      outputPath: {
        type: "string",
        description: "Optional output file path. Default: OS temp dir with timestamped name.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 1000,
        maximum: MAX_TIMEOUT_MS,
        default: DEFAULT_TIMEOUT_MS,
        description: "Give up (isError, partial file removed) after this many ms of snapshotting. The timer starts once any earlier snapshot of the same page has finished. Default 300000.",
      },
    },
  },
  handler: async (_args = {}, { page, context }) => {
    // F0-9 reviewer V1 (2026-05-10): null/undefined → use default; reject
    // empty-string explicitly so `outputPath: ""` doesn't sneak past as a
    // truthy-but-useless path.
    const outputPath = _args.outputPath;
    if (outputPath != null && (typeof outputPath !== "string" || outputPath.length === 0)) {
      return {
        content: [{ type: "text", text: `memory_take-heap-snapshot: outputPath must be a non-empty string when provided (got ${JSON.stringify(outputPath)})` }],
        isError: true,
      };
    }
    const timeoutMs = _args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
      return {
        content: [{ type: "text", text: `memory_take-heap-snapshot: timeoutMs must be a number in [1000, ${MAX_TIMEOUT_MS}] (got ${JSON.stringify(_args.timeoutMs)})` }],
        isError: true,
      };
    }
    // W1C2: pid + counter so same-millisecond calls (and other relays
    // sharing the temp dir) never pick the same default file.
    const dst = outputPath || path.join(os.tmpdir(), `heap-${Date.now()}-${process.pid}-${++defaultPathSeq}.heapsnapshot`);
    return withPageLock(page, () => snapshotToFile(context, page, dst, timeoutMs));
  },
};

async function snapshotToFile(context, page, dst, timeoutMs) {
  // T1-3: stream chunks to disk as they arrive. Track byte count locally;
  // a final fsp.stat would also work but bytes-written is cheaper.
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  // W1C2: dedicated session, detached in the finally below.
  const cdp = await context.newCDPSession(page);
  // F1-13 (2026-05-10): capture stream-level errors (disk full, EACCES,
  // EROFS) so they propagate to the structured error path instead of
  // being unhandled-error'd through the event loop. Without this listener,
  // a mid-snapshot disk-full would crash the relay process.
  //
  // Reviewer V1 (2026-05-10): register the listener in the SAME tick as
  // the stream is created, before any other awaits. Node fires the open's
  // 'error' event via nextTick at minimum, but defensive coding says
  // attach listeners before any await boundary so a yield-back from the
  // microtask queue can't run an error event handler-less.
  let streamError = null;
  const ws = fs.createWriteStream(dst, { encoding: "utf8" });
  ws.on("error", (e) => { streamError = streamError || e; });

  let bytesWritten = 0;
  let backpressureWaits = 0;
  const onChunk = (e) => {
    // F1-13: skip writing once a stream error has been captured — Node
    // would otherwise queue more failing writes that pile errors on the
    // already-failed stream.
    if (streamError) return;
    // ws.write returns false when the internal buffer is full; we don't
    // await drain here because CDP events keep arriving and we'd block the
    // event loop. Node will buffer for us; backpressureWaits is just a
    // diagnostic. Strings are immediately handed to the OS write queue.
    const ok = ws.write(e.chunk);
    bytesWritten += Buffer.byteLength(e.chunk, "utf8");
    if (!ok) backpressureWaits++;
  };
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);

  let snapshotError = null;
  let timer;
  try {
    const snapshot = cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    snapshot.catch(() => {}); // W1C2: may reject after the timeout already won
    await Promise.race([
      snapshot,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    snapshotError = e;
  } finally {
    clearTimeout(timer);
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    // Not awaited: detach first round-trips to the renderer, which stays
    // busy until a timed-out snapshot finishes.
    cdp.detach().catch(() => { /* page already closed */ });
  }

  // Close the write stream and wait for OS-level flush.
  await new Promise((resolve) => {
    // F1-13: don't reject on end() error — capture it and surface via the
    // unified streamError path below. Rejecting from a finally-style
    // cleanup loses the original snapshotError reason.
    ws.end((err) => {
      if (err) streamError = streamError || err;
      resolve();
    });
  });

  // F1-13: surface stream errors with the same shape as snapshot errors;
  // snapshot error wins if both fired (it's the more diagnostic root cause).
  snapshotError = snapshotError || streamError;
  if (snapshotError) {
    // Best-effort cleanup of the (likely partial) file.
    try { await fsp.unlink(dst); } catch { /* ignore */ }
    return {
      content: [{ type: "text", text: `memory_take-heap-snapshot: ${snapshotError.message || snapshotError}` }],
      isError: true,
    };
  }

  const stat = await fsp.stat(dst);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        outputPath: dst,
        sizeBytes: stat.size,
        sizeMB: (stat.size / 1024 / 1024).toFixed(2),
        backpressureWaits,
      }, null, 2),
    }],
  };
}
