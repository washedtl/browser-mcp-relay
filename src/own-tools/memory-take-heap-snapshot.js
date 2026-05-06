// memory_take-heap-snapshot — V8 heap snapshot via CDP HeapProfiler.
// Saves to a file (default OS temp dir) and returns the path.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

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
  handler: async ({ outputPath }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) {
      return {
        content: [{ type: "text", text: "memory_take-heap-snapshot unavailable: relay bridge not initialized" }],
        isError: true,
      };
    }
    const pages = bridge.context.pages();
    if (pages.length === 0) {
      return {
        content: [{ type: "text", text: "no pages open in browser context" }],
        isError: true,
      };
    }
    const page = pages[0]; // active page
    const cdp = await bridge.context.newCDPSession(page);
    const dst = outputPath || path.join(os.tmpdir(), `heap-${Date.now()}.heapsnapshot`);
    const chunks = [];
    cdp.on("HeapProfiler.addHeapSnapshotChunk", (e) => chunks.push(e.chunk));
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    await cdp.detach();
    fs.writeFileSync(dst, chunks.join(""));
    const sizeBytes = fs.statSync(dst).size;
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ outputPath: dst, sizeBytes, sizeMB: (sizeBytes / 1024 / 1024).toFixed(2) }, null, 2),
      }],
    };
  },
};
