// capture_xhr — record XHR/fetch responses during a navigation or time window.
// For API reverse-engineering: see what calls a page makes, capture response
// bodies, filter by URL pattern.
//
// T0-1/T0-2/T0-3 fixes (2026-05-09):
//   • split goto timeout from capture window (previously durationMs was reused
//     as page.goto's timeout, so a slow page aborted before any XHR fired)
//   • body fetch is fire-and-forget — pushes a Promise into a pending array so
//     response N+1 isn't blocked behind a slow body N. Promise.allSettled at
//     end before serializing
//   • bounded `captured` size with `maxResponses` cap (default 500) to prevent
//     unbounded heap growth on chatty pages

const { withActivePage } = require("./_active-page.js");

module.exports = {
  name: "capture_xhr",
  description:
    "Record XHR/fetch responses observed by the active page during a navigation " +
    "or fixed time window. Returns array of { url, status, method, contentType, " +
    "headers, body? } per response. Useful for reverse-engineering site APIs " +
    "while authenticated in the relay's browser session. " +
    "When navigateToUrl is set, navTimeoutMs caps the navigation; durationMs is " +
    "the total capture window (including the navigation time).",
  inputSchema: {
    type: "object",
    properties: {
      navigateToUrl: {
        type: "string",
        description: "If provided, navigate the active page to this URL while capturing. Otherwise just capture for durationMs from now.",
      },
      durationMs: {
        type: "integer",
        default: 5000,
        minimum: 100,
        maximum: 300000,
        description: "Total capture window in ms (default 5s, max 5min). Also caps how long this tool blocks.",
      },
      navTimeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 300000,
        description: "Optional separate cap on the page.goto timeout when navigateToUrl is set. Defaults to min(durationMs, 30000). Set higher than the durationMs only if you want to fail navigation fast then keep listening.",
      },
      waitUntil: {
        type: "string",
        enum: ["load", "domcontentloaded", "networkidle", "commit"],
        default: "domcontentloaded",
        description: "Playwright navigation lifecycle when navigateToUrl is set. Default 'domcontentloaded' — 'networkidle' often hangs on chatty pages and burns the whole capture window.",
      },
      urlFilter: {
        type: "string",
        description: "Optional regex pattern (as a string) to filter URLs. Only matching responses are returned.",
      },
      includeBody: {
        type: "boolean",
        default: true,
        description: "Whether to include response bodies (can be large).",
      },
      maxBodyBytes: {
        type: "integer",
        default: 100000,
        description: "Maximum body length per response (truncated if longer). Default 100KB.",
      },
      maxResponses: {
        type: "integer",
        default: 500,
        minimum: 1,
        maximum: 5000,
        description: "Stop recording new responses after this many. Default 500 — prevents unbounded heap on chatty pages. When the cap is hit, `truncated: true` is set on the result and any responses past the cap are dropped.",
      },
    },
  },
  handler: async ({
    navigateToUrl,
    durationMs = 5000,
    navTimeoutMs,
    waitUntil = "domcontentloaded",
    urlFilter,
    includeBody = true,
    maxBodyBytes = 100000,
    maxResponses = 500,
  }) => withActivePage(async ({ page }) => {
    let filter = null;
    if (urlFilter) {
      try {
        filter = new RegExp(urlFilter);
      } catch (e) {
        return {
          content: [{ type: "text", text: `invalid urlFilter regex: ${e.message}` }],
          isError: true,
        };
      }
    }

    // T0-1: separate navTimeoutMs from the capture window. The default keeps
    // navigation responsive (≤30s) while the capture window can be longer for
    // post-load XHRs.
    const effectiveNavTimeout = Number.isInteger(navTimeoutMs)
      ? navTimeoutMs
      : Math.min(durationMs, 30000);

    const captured = [];
    const pendingBodies = []; // T0-2: parallel body fetches resolved at end
    let truncated = false;

    const onResponse = (response) => {
      // T0-3: hard cap to prevent unbounded heap. Drop the rest, mark truncated.
      if (captured.length >= maxResponses) {
        truncated = true;
        return;
      }
      try {
        const url = response.url();
        if (filter && !filter.test(url)) return;
        const req = response.request();
        const resourceType = req.resourceType();
        // Limit to xhr/fetch — drop documents/scripts/stylesheets/images.
        if (resourceType !== "xhr" && resourceType !== "fetch") return;
        const entry = {
          url,
          status: response.status(),
          method: req.method(),
          contentType: response.headers()["content-type"] || "",
          headers: response.headers(),
        };
        // Push synchronously so ordering is preserved relative to event arrival.
        captured.push(entry);
        if (includeBody) {
          // T0-2: don't await here — fire-and-forget into pendingBodies. If body
          // N is slow, body N+1's listener doesn't queue behind it. We
          // Promise.allSettled at the end before serializing.
          pendingBodies.push(
            response.body()
              .then((buf) => {
                const text = buf.toString("utf8");
                entry.body = text.length > maxBodyBytes
                  ? text.slice(0, maxBodyBytes) + "...[truncated]"
                  : text;
              })
              .catch((e) => {
                entry.bodyError = e.message || String(e);
              })
          );
        }
      } catch { /* ignore per-response errors */ }
    };

    page.on("response", onResponse);

    // T0-9: short-circuit the wait if the page closes during capture so we
    // don't hang the full duration on a dead page. waitWithCloseShortCircuit
    // races a `setTimeout(durationMs)` against `page.once("close", ...)`.
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
      if (navigateToUrl) {
        await page.goto(navigateToUrl, { waitUntil, timeout: effectiveNavTimeout });
        // After navigation, keep listening for the remainder of the capture
        // window (durationMs total, minus elapsed nav time).
        const navElapsed = Date.now() - t0;
        const remaining = Math.max(0, durationMs - navElapsed);
        if (remaining > 0) {
          await waitWithCloseShortCircuit(remaining);
        }
      } else {
        await waitWithCloseShortCircuit(durationMs);
      }
    } catch (e) {
      // Don't propagate the goto/timeout error — preserve partial capture.
      // Caller still gets whatever XHRs fired before the failure.
      navError = e.message;
    } finally {
      page.off("response", onResponse);
    }

    // T0-2: drain in-flight body fetches before serializing. allSettled — we
    // tolerate body fetch failures (already captured per-entry as bodyError).
    if (pendingBodies.length > 0) {
      await Promise.allSettled(pendingBodies);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          count: captured.length,
          responses: captured,
          navError,
          truncated,
          pageClosedEarly,
        }, null, 2),
      }],
      isError: !!navError && captured.length === 0,
    };
  }),
};
