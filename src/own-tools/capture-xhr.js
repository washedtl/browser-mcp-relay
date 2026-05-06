// capture_xhr — record XHR/fetch responses during a navigation or time window.
// For API reverse-engineering: see what calls a page makes, capture response
// bodies, filter by URL pattern.

module.exports = {
  name: "capture_xhr",
  description:
    "Record XHR/fetch responses observed by the active page during a navigation " +
    "or fixed time window. Returns array of { url, status, method, contentType, " +
    "headers, body? } per response. Useful for reverse-engineering site APIs " +
    "while authenticated in the relay's browser session.",
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
        maximum: 60000,
        description: "Total capture duration in ms.",
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
    },
  },
  handler: async ({ navigateToUrl, durationMs = 5000, urlFilter, includeBody = true, maxBodyBytes = 100000 }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "capture_xhr unavailable: bridge missing" }], isError: true };
    const pages = bridge.context.pages();
    if (pages.length === 0) return { content: [{ type: "text", text: "no pages open" }], isError: true };
    const page = pages[0];

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
    const captured = [];

    const onResponse = async (response) => {
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
        if (includeBody) {
          try {
            const buf = await response.body();
            const text = buf.toString("utf8");
            entry.body = text.length > maxBodyBytes ? text.slice(0, maxBodyBytes) + "...[truncated]" : text;
          } catch (e) {
            entry.bodyError = e.message;
          }
        }
        captured.push(entry);
      } catch { /* ignore per-response errors */ }
    };

    page.on("response", onResponse);
    let navError = null;
    try {
      if (navigateToUrl) {
        await page.goto(navigateToUrl, { waitUntil: "networkidle", timeout: durationMs });
      } else {
        await new Promise((r) => setTimeout(r, durationMs));
      }
    } catch (e) {
      // Don't propagate the goto/timeout error — preserve partial capture.
      // Caller still gets whatever XHRs fired before the failure.
      navError = e.message;
    } finally {
      page.off("response", onResponse);
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ count: captured.length, responses: captured, navError }, null, 2),
      }],
      isError: !!navError && captured.length === 0,
    };
  },
};
