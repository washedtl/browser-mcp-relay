// download_capture — wait for the next download triggered by user action and
// save it to disk. Bypasses the OS download dialog. Pair with interaction_click
// to: click button → wait for download → save to known path.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { getActivePage } = require("./_active-page.js");

module.exports = {
  name: "download_capture",
  description:
    "Wait for the next download event in the active page and save the file to " +
    "disk. Returns the saved file path. Call AFTER triggering the action that " +
    "starts the download (or use clickSelector to trigger inside this tool). " +
    "Default save location is OS temp dir with the suggested filename.",
  inputSchema: {
    type: "object",
    properties: {
      clickSelector: {
        type: "string",
        description: "Optional: click this selector to trigger the download.",
      },
      savePath: {
        type: "string",
        description: "Optional output file path. Default: OS temp dir + suggested filename.",
      },
      timeoutMs: {
        type: "integer",
        default: 30000,
        description: "Max wait for download to start.",
      },
    },
  },
  handler: async ({ clickSelector, savePath, timeoutMs = 30000 }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };
    // Use the tracked active page (set by tabs_new / tabs_select) — not
    // pages[0] which is Brave's auto-opened about:blank. See _active-page.js.
    const page = getActivePage(bridge.context);
    if (!page) return { content: [{ type: "text", text: "no pages open" }], isError: true };

    // Promise-race pattern: setup the download wait BEFORE triggering, to avoid
    // missing fast downloads.
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });

    if (clickSelector) {
      try {
        await page.click(clickSelector, { timeout: timeoutMs });
      } catch (e) {
        return { content: [{ type: "text", text: `click failed: ${e.message}` }], isError: true };
      }
    }

    let download;
    try {
      download = await downloadPromise;
    } catch (e) {
      return { content: [{ type: "text", text: `no download in ${timeoutMs}ms: ${e.message}` }], isError: true };
    }

    const suggested = download.suggestedFilename() || "file.bin";
    const dst = savePath || path.join(os.tmpdir(), `download-${Date.now()}-${suggested}`);
    try {
      // Ensure parent dir exists when caller passed a custom savePath. The
      // default path uses os.tmpdir() which always exists, so this only
      // matters for explicit savePath values.
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      await download.saveAs(dst);
    } catch (e) {
      return {
        content: [{ type: "text", text: `saveAs failed: ${e.message}` }],
        isError: true,
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ savedTo: dst, suggestedFilename: suggested, url: download.url() }, null, 2),
      }],
    };
  },
};
