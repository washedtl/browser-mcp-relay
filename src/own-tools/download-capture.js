// download_capture — wait for the next download and save it to disk.
// Bypasses the OS download dialog. The listener starts when the tool is
// called and the call blocks, so the download is normally triggered by
// clickSelector inside this same call.
//
// W1C1 (2026-11-03): savePath must be absolute (a relative path resolved
// against the relay's cwd) and an existing file is only replaced with
// overwrite: true; waits orphaned by an early return are marked handled so
// they never surface as unhandled rejections.

const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { errorResult, intArg, outputPathArg, writeExclusive } = require("./_tool-args.js");

const noop = () => {};

// F1-14 (2026-05-10): control-char range built from char codes so the source
// file stays plain ASCII. Embedding literal U+0000..U+001F bytes into a regex
// literal in the file makes git classify the file as binary (per its
// is-binary heuristic), which breaks code-review diff rendering.
const CONTROL_CHAR_RANGE = (() => {
  let s = "";
  for (let i = 0; i <= 0x1f; i++) s += String.fromCharCode(i);
  s += String.fromCharCode(0x7f);
  return s;
})();
const CONTROL_CHAR_RE = new RegExp("[" + CONTROL_CHAR_RANGE.replace(/[\\^\]-]/g, "\\$&") + "]", "g");

/**
 * Sanitize a server-supplied download filename so it can be safely concatenated
 * into a path inside os.tmpdir() without enabling path traversal.
 *
 * Pure helper — exported for tests.
 *
 * Steps (in order):
 *   1. Coerce to string.
 *   2. Strip any leading/trailing whitespace.
 *   3. Replace ALL forward slashes + backslashes with `_` (so a Linux-shaped
 *      "../foo" sent to a Windows host doesn't sneak past path.basename, which
 *      on win32 only splits on backslash).
 *   4. Replace control chars (U+0000..U+001F + U+007F) with `_`.
 *   5. Strip any leading "." prefix to defang `..`/`...etc`/hidden file names.
 *   6. Replace any colon (Windows ADS / drive-letter shenanigans) with `_`.
 *   7. Take path.basename ONE more time to belt-and-brace.
 *   8. If the result is empty (was just slashes / dots), substitute "file.bin".
 *   9. Cap at 200 chars to avoid OS NAME_MAX issues.
 */
function sanitizeDownloadFilename(raw) {
  let s = String(raw == null ? "" : raw).trim();
  s = s.replace(/[/\\]/g, "_");
  s = s.replace(CONTROL_CHAR_RE, "_");
  s = s.replace(/^\.+/, "");
  s = s.replace(/:/g, "_");
  s = path.basename(s);
  if (s.length === 0) s = "file.bin";
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

module.exports = {
  name: "download_capture",
  description:
    "Save the next download from the active page to disk and return its path. " +
    "Listening starts when this tool is called and the call blocks until a download starts, " +
    "so pass clickSelector to trigger it here; a download started before the call is missed.",
  inputSchema: {
    type: "object",
    properties: {
      clickSelector: { type: "string", description: "Selector to click to start the download." },
      savePath: { type: "string", description: "Absolute output path (default: OS temp dir + suggested filename)." },
      overwrite: { type: "boolean", default: false, description: "Allow replacing an existing savePath." },
      timeoutMs: { type: "integer", default: 30000, minimum: 1, description: "Max wait for the download to start." },
    },
  },
  handler: async (_args, { page }) => {
    // F0-9: null means "omitted".
    const args = _args || {};
    const { clickSelector } = args;
    const overwrite = !!args.overwrite;
    // Playwright treats timeout 0 as "no timeout", which would block forever.
    const timeout = intArg("download_capture", "timeoutMs", args.timeoutMs, 30000, 1);
    if (timeout.error) return errorResult(timeout.error);
    const timeoutMs = timeout.value;
    // Validate the destination before listening, so a bad path never costs
    // the agent a triggered-but-unsaved download.
    const save = outputPathArg("download_capture", "savePath", args.savePath, overwrite);
    if (save.error) return errorResult(save.error);

    // Promise-race pattern: setup the download wait BEFORE triggering, to avoid
    // missing fast downloads. Early returns below abandon this wait; mark it
    // handled so its eventual timeout rejection isn't an unhandledRejection.
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
    downloadPromise.catch(noop);

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
    // The page can close during the click, before the race below subscribes.
    closePromise.catch(noop);

    if (clickSelector) {
      try {
        await page.click(clickSelector, { timeout: timeoutMs });
      } catch (e) {
        // Cleanup before early-return.
        if (onClose) page.off("close", onClose);
        return errorResult(`click failed: ${e.message}`);
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

    // F1-14 (2026-05-10): sanitize the server-suggested filename. The
    // download's HTTP Content-Disposition header is fully attacker-controlled —
    // a malicious server could send `../../../etc/passwd` or `\..\..\windows\
    // system32\foo` and our default-path concat would write outside os.tmpdir().
    // sanitizeDownloadFilename strips any directory components on either
    // separator + control chars + leading dots + colons.
    const rawSuggested = download.suggestedFilename() || "file.bin";
    const suggested = sanitizeDownloadFilename(rawSuggested);
    const dst = save.path || path.join(os.tmpdir(), `download-${Date.now()}-${suggested}`);
    let target = dst;
    let claimed = false;
    try {
      if (overwrite) {
        // Ensure parent dir exists when caller passed a custom savePath.
        fs.mkdirSync(path.dirname(dst), { recursive: true });
      } else {
        // saveAs always overwrites, and up to timeoutMs passed since the
        // up-front check: claim dst — or a free sibling if a file appeared
        // meanwhile — with an empty placeholder that saveAs then replaces.
        target = await writeExclusive(dst, "");
        claimed = true;
      }
      await download.saveAs(target);
    } catch (e) {
      if (claimed) fs.rmSync(target, { force: true });
      return errorResult(`saveAs failed: ${e.message}`);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ savedTo: target, suggestedFilename: suggested, url: download.url() }),
      }],
    };
  },
  // F1-14: exported as a test seam.
  sanitizeDownloadFilename,
};
