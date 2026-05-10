// download_capture — wait for the next download triggered by user action and
// save it to disk. Bypasses the OS download dialog. Pair with interaction_click
// to: click button → wait for download → save to known path.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { withActivePage } = require("./_active-page.js");

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
  handler: async ({ clickSelector, savePath, timeoutMs = 30000 }) => withActivePage(async ({ page }) => {
    // Promise-race pattern: setup the download wait BEFORE triggering, to avoid
    // missing fast downloads.
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });

    // T0-9: race the download wait against the page's `close` event. Without
    // this, calling tabs_close on the page mid-download (or having the page
    // crash) leaves waitForEvent pending until the full timeoutMs (default 30s).
    // The close-promise rejects with a clean message so the user gets actionable
    // feedback instead of a generic timeout.
    //
    // G0-1 (2026-05-10): hoist `onClose` outside the Promise constructor so it
    // can be `page.off()`'d on the SUCCESS path. Previously the close listener
    // was only removed when it fired (rejection path) — every successful
    // download leaked one `close` listener until the page actually closed,
    // tripping MaxListenersExceededWarning after ~10 sequential downloads.
    let onClose;
    const closePromise = new Promise((_, reject) => {
      onClose = () => reject(new Error("page closed before download started"));
      page.once("close", onClose);
    });

    if (clickSelector) {
      try {
        await page.click(clickSelector, { timeout: timeoutMs });
      } catch (e) {
        // Cleanup before early-return.
        if (onClose) page.off("close", onClose);
        return { content: [{ type: "text", text: `click failed: ${e.message}` }], isError: true };
      }
    }

    let download;
    try {
      download = await Promise.race([downloadPromise, closePromise]);
    } catch (e) {
      const isPageClosed = /page closed/i.test(e.message);
      // If we're here because of a NON-close error (timeout, etc.), the
      // close listener is still attached and needs removal. If we're here
      // because of close, the listener already fired (page.once auto-cleans).
      if (!isPageClosed && onClose) page.off("close", onClose);
      return {
        content: [{
          type: "text",
          text: isPageClosed
            ? `download_capture: ${e.message}`
            : `no download in ${timeoutMs}ms: ${e.message}`,
        }],
        isError: true,
      };
    }
    // G0-1: success path — remove the close listener now that the download
    // has fired. Otherwise it accumulates per call until the page closes.
    if (onClose) page.off("close", onClose);

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
  }),
};
