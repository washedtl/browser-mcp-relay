// capture_xhr — record XHR/fetch responses during a navigation or time window.
// For API reverse-engineering: see what calls a page makes, capture response
// bodies, filter by URL pattern.
//
// T0-1/T0-2/T0-3 fixes (2026-05-09):
//   • split goto timeout from capture window (previously durationMs was reused
//     as page.goto's timeout, so a slow page aborted before any XHR fired)
//   • body fetch is fire-and-forget (now via a bounded queue) so
//     response N+1 isn't blocked behind a slow body N. Settled at the end
//     before serializing
//   • bounded `captured` size with `maxResponses` cap (default 500) to prevent
//     unbounded heap growth on chatty pages
//
// W1C1 (2026-11-03): the result goes straight into the model's context, so
// inline defaults are compact (2KB bodies, ~100KB total, no headers, no
// pretty-print); `outputPath` writes the full capture to a file instead.
// Final body drain has a deadline (streaming responses hung the tool), the
// URL/type filter runs before the cap, a nav timeout keeps listening, and
// numeric arguments are range-checked against the schema.

const { errorResult, intArg, fitJson, outputPathArg, writeOutputFile } = require("./_tool-args.js");

// Playwright's response.body() resolves only when the request FINISHES, so a
// long-poll / SSE / streaming response never resolves. After the capture
// window, bodies get this long to finish before they're reported unfinished.
const BODY_DRAIN_MS = 2000;
// response.body() holds the full body in memory; bound how many run at once.
const MAX_BODY_FETCHES = 32;
const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"];
// Defaults by mode: inline output lands in the model's context; a file doesn't.
const INLINE_DEFAULTS = { maxBodyBytes: 2000, maxTotalBytes: 100_000, includeHeaders: false };
const FILE_DEFAULTS = { maxBodyBytes: 100_000, maxTotalBytes: 50_000_000, includeHeaders: true };
const PREVIEW_LINES = 20;

module.exports = {
  name: "capture_xhr",
  description:
    "Record XHR/fetch responses on this tab for durationMs, optionally while navigating to navigateToUrl. " +
    "Inline output is compact: url/status/method/contentType, bodies cut to 2KB, ~100KB total, no headers. " +
    "Pass outputPath to write the full capture (headers, 100KB bodies) to a file and get only a summary back.",
  inputSchema: {
    type: "object",
    properties: {
      navigateToUrl: { type: "string", description: "Navigate this tab here while capturing." },
      durationMs: {
        type: "integer", default: 5000, minimum: 100, maximum: 300000,
        description: "Capture window incl. navigation; the call blocks this long (+ up to 2s for bodies to finish).",
      },
      navTimeoutMs: {
        type: "integer", minimum: 100, maximum: 300000,
        description: "page.goto timeout (default min(durationMs, 30000)). After a nav timeout, capture continues for the rest of durationMs.",
      },
      waitUntil: { type: "string", enum: WAIT_UNTIL, default: "domcontentloaded" },
      urlFilter: { type: "string", description: "Regex; only matching URLs are recorded." },
      includeBody: { type: "boolean", default: true },
      includeHeaders: { type: "boolean", description: "Include response headers (default false; true with outputPath)." },
      maxBodyBytes: {
        type: "integer", minimum: 1, maximum: 50_000_000,
        description: "Per-body cap (default 2000; 100000 with outputPath).",
      },
      maxResponses: { type: "integer", default: 500, minimum: 1, maximum: 5000 },
      maxTotalBytes: {
        type: "integer", minimum: 1024, maximum: 50_000_000,
        description: "Cap on all captured bytes (default 100000; 50000000 with outputPath). Past it, bodies then responses are dropped.",
      },
      outputPath: { type: "string", description: "Absolute path; write the full capture there as JSON." },
      overwrite: { type: "boolean", default: false, description: "Allow replacing an existing outputPath." },
    },
  },
  handler: async (_args, { page }) => {
    // F0-9: null means "omitted" for every optional argument.
    const args = _args || {};
    const overwrite = !!args.overwrite;
    // Fail on a bad outputPath before the capture window, not after it.
    const out = outputPathArg("capture_xhr", "outputPath", args.outputPath, overwrite);
    if (out.error) return errorResult(out.error);
    const defaults = out.path ? FILE_DEFAULTS : INLINE_DEFAULTS;
    const n = {};
    for (const [name, def, min, max] of [
      ["durationMs", 5000, 100, 300000],
      ["navTimeoutMs", undefined, 100, 300000],
      ["maxBodyBytes", defaults.maxBodyBytes, 1, 50_000_000],
      ["maxResponses", 500, 1, 5000],
      ["maxTotalBytes", defaults.maxTotalBytes, 1024, 50_000_000],
    ]) {
      const r = intArg("capture_xhr", name, args[name], def, min, max);
      if (r.error) return errorResult(r.error);
      n[name] = r.value;
    }
    const { durationMs, navTimeoutMs, maxBodyBytes, maxResponses, maxTotalBytes } = n;
    const waitUntil = WAIT_UNTIL.includes(args.waitUntil) ? args.waitUntil : "domcontentloaded";
    const includeBody = args.includeBody == null ? true : !!args.includeBody;
    const includeHeaders = args.includeHeaders == null ? defaults.includeHeaders : !!args.includeHeaders;

    let filter = null;
    if (args.urlFilter) {
      try {
        filter = new RegExp(args.urlFilter);
      } catch (e) {
        return errorResult(`invalid urlFilter regex: ${e.message}`);
      }
    }

    // T0-1: separate navTimeoutMs from the capture window. The default keeps
    // navigation responsive (≤30s) while the capture window can be longer for
    // post-load XHRs.
    const effectiveNavTimeout = navTimeoutMs ?? Math.min(durationMs, 30000);

    const captured = [];
    let dropped = 0;
    // F1-18: one budget, in JSON characters (what reaches the model), for
    // everything kept: entry metadata + bodies. A body is charged when it
    // settles, clipped to the room left. response.body() loads the WHOLE
    // body into memory, so at most MAX_BODY_FETCHES run at once (the rest
    // queue) and no fetch starts once the budget is spent.
    let usedBytes = 0;
    let aggregateCapHit = false;
    const bodyQueue = []; // [response, entry] waiting for a fetch slot
    let bodiesInFlight = 0;
    let onBodiesIdle = null; // set while draining

    const capHit = (entry) => {
      entry.bodyError = "aggregate cap reached";
      aggregateCapHit = true;
    };

    const keepBody = (entry, buf) => {
      const room = Math.min(maxBodyBytes, maxTotalBytes - usedBytes);
      if (room <= 0) return capHit(entry);
      // Decode only a prefix that is surely enough: a char is at most 4
      // UTF-8 bytes and costs at least 1 escaped char, so a body longer than
      // this prefix always comes back cut (with the marker).
      const fit = fitJson(buf.toString("utf8", 0, Math.min(buf.length, 4 * room + 4)), room);
      entry.body = fit.text;
      usedBytes += fit.cost;
      if (fit.cut && room < maxBodyBytes) aggregateCapHit = true;
    };

    const pumpBodies = () => {
      while (bodiesInFlight < MAX_BODY_FETCHES && bodyQueue.length > 0) {
        const [response, entry] = bodyQueue.shift();
        if (usedBytes >= maxTotalBytes) {
          capHit(entry);
          continue;
        }
        bodiesInFlight++;
        // T0-2: don't await — body N+1 must not queue behind a slow body N.
        Promise.resolve()
          .then(() => response.body())
          .then((buf) => keepBody(entry, buf), (e) => { entry.bodyError = e.message || String(e); })
          .finally(() => {
            bodiesInFlight--;
            pumpBodies();
          });
      }
      if (onBodiesIdle && bodiesInFlight === 0 && bodyQueue.length === 0) onBodiesIdle();
    };

    const onResponse = (response) => {
      try {
        const url = response.url();
        if (filter && !filter.test(url)) return;
        const req = response.request();
        const resourceType = req.resourceType();
        // Limit to xhr/fetch — drop documents/scripts/stylesheets/images.
        if (resourceType !== "xhr" && resourceType !== "fetch") return;
        // T0-3: hard cap to prevent unbounded heap. Checked only for
        // responses we'd keep, so filtered-out traffic isn't "dropped".
        if (captured.length >= maxResponses) {
          dropped++;
          return;
        }
        const headers = response.headers();
        const entry = {
          url,
          status: response.status(),
          method: req.method(),
          contentType: headers["content-type"] || "",
        };
        if (includeHeaders) entry.headers = headers;
        const entryBytes = JSON.stringify(entry).length;
        if (usedBytes + entryBytes > maxTotalBytes) {
          dropped++;
          aggregateCapHit = true;
          return;
        }
        usedBytes += entryBytes;
        // Push synchronously so ordering is preserved relative to event arrival.
        captured.push(entry);
        if (includeBody) {
          bodyQueue.push([response, entry]);
          pumpBodies();
        }
      } catch { /* ignore per-response errors */ }
    };

    page.on("response", onResponse);

    // T0-9: short-circuit the wait if the page closes during capture so we
    // don't hang the full duration on a dead page.
    let pageClosedEarly = false;
    const t0 = Date.now();
    const waitWithCloseShortCircuit = (ms) => new Promise((resolve) => {
      let done = false;
      const finish = (reason) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        page.off("close", onClose);
        if (reason === "close") pageClosedEarly = true;
        resolve();
      };
      const timer = setTimeout(() => finish("timeout"), ms);
      const onClose = () => finish("close");
      page.once("close", onClose);
    });

    let navError = null;
    try {
      let keepListening = true;
      if (args.navigateToUrl) {
        try {
          await page.goto(args.navigateToUrl, { waitUntil, timeout: effectiveNavTimeout });
        } catch (e) {
          // Partial capture is preserved either way. A nav TIMEOUT means the
          // page is still loading, so keep listening for the rest of the
          // window; any other failure (bad URL, DNS, closed page) has nothing
          // more to capture.
          navError = e.message;
          keepListening = e.name === "TimeoutError";
        }
      }
      const remaining = durationMs - (Date.now() - t0);
      if (keepListening && remaining > 0) await waitWithCloseShortCircuit(remaining);
    } finally {
      page.off("response", onResponse);
    }

    if (bodiesInFlight > 0 || bodyQueue.length > 0) {
      let timer;
      await Promise.race([
        new Promise((resolve) => { onBodiesIdle = resolve; }),
        new Promise((resolve) => { timer = setTimeout(resolve, BODY_DRAIN_MS); }),
      ]);
      clearTimeout(timer);
      bodyQueue.length = 0; // start no more fetches
      // Anything still without a body is a stream / long-poll (or queued
      // behind them). Everything from here to serialization is synchronous,
      // so a late settle can't race it.
      for (const entry of captured) {
        if (entry.body === undefined && entry.bodyError === undefined) {
          entry.bodyError = `body not finished ${BODY_DRAIN_MS}ms after the capture window (streaming or long-poll?)`;
        }
      }
    }

    const summary = {
      count: captured.length,
      capturedBytes: usedBytes,
      aggregateCapHit,
      truncated: dropped > 0,
      dropped,
      navError,
      pageClosedEarly,
    };
    const isError = !!navError && captured.length === 0;
    const full = JSON.stringify({ ...summary, responses: captured }, null, out.path ? 2 : undefined);
    const preview = out.path && captured.slice(0, PREVIEW_LINES).map((r) => `${r.method} ${r.status} ${r.url.slice(0, 200)}`);
    // An unfinished body() keeps its callbacks — and through them this
    // handler's scope — alive until the stream ends. Drop the capture so
    // only those few small entries stay reachable.
    captured.length = 0;

    if (!out.path) return { content: [{ type: "text", text: full }], isError };
    let written;
    try {
      // If outputPath appeared during the capture, this writes a sibling.
      written = await writeOutputFile(out.path, full, overwrite);
    } catch (e) {
      return errorResult(`capture_xhr: writing outputPath failed: ${e.message}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ savedTo: written.path, fileBytes: written.bytes, ...summary, preview }) }],
      isError,
    };
  },
};
