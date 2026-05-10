// memory_take-heap-snapshot — V8 heap snapshot via CDP HeapProfiler.
// Saves to a file (default OS temp dir) and returns the path.
//
// V1-1: previously detached the CDP session inline + used fs.writeFileSync.
// Two issues:
//   (a) if takeHeapSnapshot threw, detach was skipped → CDP session leaked.
//   (b) writeFileSync on a 50-500 MB heap blocks the event loop for seconds.
// Fix: route through the per-page CDP session cache (auto-detached on page
// close) and use fs.promises.writeFile.

const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { getOrCreatePageCdp } = require("./_page-cdp-session.js");
const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "memory_take-heap-snapshot",
  description:
    "Take a V8 heap snapshot of the active page via CDP HeapProfiler. " +
    "Saves the .heapsnapshot file to disk and returns its path. " +
    "The file can be loaded into Chrome DevTools' Memory tab for analysis.",
  inputSchema: {
    type: "object",
    properties: {
      outputPath: {
        type: "string",
        description: "Optional output file path. Default: OS temp dir with timestamped name.",
      },
    },
  },
  handler: async ({ outputPath }) => withActivePage(async ({ bridge, page }) => {
    // V1-1: per-page CDP cache — session is auto-detached on page close.
    // Detach is no longer manual, so a takeHeapSnapshot throw cannot leak
    // the session.
    const cdp = await getOrCreatePageCdp(page, bridge.context);
    const dst = outputPath || path.join(os.tmpdir(), `heap-${Date.now()}.heapsnapshot`);
    const chunks = [];
    const onChunk = (e) => chunks.push(e.chunk);
    cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
    try {
      await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    } finally {
      // Always remove the per-call listener — session is reused across calls.
      cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    }
    // Async write — heap snapshots can be 50-500 MB; sync would block the
    // event loop for seconds.
    await fsp.writeFile(dst, chunks.join(""));
    const sizeBytes = (await fsp.stat(dst)).size;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ outputPath: dst, sizeBytes, sizeMB: (sizeBytes / 1024 / 1024).toFixed(2) }, null, 2),
      }],
    };
  }),
};
