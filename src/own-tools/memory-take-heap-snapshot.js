// memory_take-heap-snapshot — V8 heap snapshot via CDP HeapProfiler.
// Saves to a file (default OS temp dir) and returns the path.
//
// V1-1: previously detached the CDP session inline + used fs.writeFileSync.
// Two issues:
//   (a) if takeHeapSnapshot threw, detach was skipped → CDP session leaked.
//   (b) writeFileSync on a 50-500 MB heap blocks the event loop for seconds.
// Fix: route through the per-page CDP session cache (auto-detached on page
// close) and use fs.promises.writeFile.
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
const { getOrCreatePageCdp } = require("./_page-cdp-session.js");
const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "memory_take-heap-snapshot",
  description:
    "Take a V8 heap snapshot of the active page via CDP HeapProfiler. " +
    "Saves the .heapsnapshot file to disk and returns its path. " +
    "The file can be loaded into Chrome DevTools' Memory tab for analysis. " +
    "Chunks are streamed directly to disk so memory overhead stays constant " +
    "regardless of snapshot size (50MB to multi-GB heaps OK).",
  inputSchema: {
    type: "object",
    properties: {
      outputPath: {
        type: "string",
        description: "Optional output file path. Default: OS temp dir with timestamped name.",
      },
    },
  },
  handler: async (_args = {}) => withActivePage(async ({ bridge, page }) => {
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
    // V1-1: per-page CDP cache — session is auto-detached on page close.
    // Detach is no longer manual, so a takeHeapSnapshot throw cannot leak
    // the session.
    const cdp = await getOrCreatePageCdp(page, bridge.context);
    const dst = outputPath || path.join(os.tmpdir(), `heap-${Date.now()}.heapsnapshot`);

    // T1-3: stream chunks to disk as they arrive. Track byte count locally;
    // a final fsp.stat would also work but bytes-written is cheaper.
    await fsp.mkdir(path.dirname(dst), { recursive: true });
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
    try {
      await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    } catch (e) {
      snapshotError = e;
    } finally {
      // Always remove the per-call listener — session is reused across calls.
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
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
  }),
};
