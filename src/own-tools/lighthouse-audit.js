// lighthouse_audit — runs Lighthouse against a URL using the slot's CDP port.
// Returns category scores (performance, accessibility, best-practices, seo).
//
// T0-6 / T1-1 fixes (2026-05-09):
//   • try/catch around lighthouse() — a bad URL or dead Brave throws
//     synchronously; previously this propagated as an uncaught exception
//   • lighthouse module hoisted to a memoized lazy import — was importing
//     ~3MB CJS/ESM on every call (~80–150ms cold cost); now imports once
//     on first call and reuses

// T1-1: lazy + memoized — first call pays the import cost, subsequent calls
// reuse the resolved module. The module is ~3MB; eager loading at startup
// would add ~100ms to relay boot. Lazy + memoized = best of both.
let _lhPromise = null;
function getLighthouse() {
  if (!_lhPromise) {
    _lhPromise = import("lighthouse")
      .then((m) => m.default)
      .catch((e) => {
        // Reset so a future call can retry (e.g. after `npm install` fixes
        // a missing dep). Without reset, every retry would resolve to the
        // same rejected promise.
        _lhPromise = null;
        throw e;
      });
  }
  return _lhPromise;
}

module.exports = {
  name: "lighthouse_audit",
  description:
    "Run a Lighthouse audit against a URL using the relay's Brave instance. " +
    "Returns category scores (performance, accessibility, best-practices, seo). " +
    "The audit runs against a fresh page in the relay's browser; cookies and " +
    "extensions are inherited from the slot's profile.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to audit (must include scheme)" },
      formFactor: {
        type: "string",
        enum: ["desktop", "mobile"],
        default: "desktop",
        description: "Lighthouse form factor",
      },
      onlyCategories: {
        type: "array",
        items: { type: "string", enum: ["performance", "accessibility", "best-practices", "seo", "pwa"] },
        description: "Optional subset of categories to run (defaults to performance + accessibility + best-practices + seo)",
      },
    },
    required: ["url"],
  },
  handler: async ({ url, formFactor = "desktop", onlyCategories }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) {
      return {
        content: [{ type: "text", text: "lighthouse_audit unavailable: relay bridge not initialized" }],
        isError: true,
      };
    }

    // Fast-fail with an actionable error when the URL is malformed. Lighthouse
    // itself would eventually reject but with a less clear "Unable to connect"
    // message after a long delay.
    if (!url || typeof url !== "string") {
      return {
        content: [{ type: "text", text: "lighthouse_audit: url must be a non-empty string" }],
        isError: true,
      };
    }
    try {
      // eslint-disable-next-line no-new
      new URL(url);
    } catch {
      return {
        content: [{ type: "text", text: `lighthouse_audit: invalid URL "${url}" (must include scheme like https://)` }],
        isError: true,
      };
    }

    let lighthouse;
    try {
      lighthouse = await getLighthouse();
    } catch (e) {
      return {
        content: [{ type: "text", text: `lighthouse_audit: failed to load lighthouse module: ${e.message || e}` }],
        isError: true,
      };
    }

    const cats = onlyCategories || ["performance", "accessibility", "best-practices", "seo"];

    // T0-6: wrap the lighthouse() call in try/catch. Bad URL, unreachable host,
    // dead Brave (relay's CDP port 9333+slot not listening), Lighthouse internal
    // crashes — all surface here. Previously propagated as uncaught exceptions
    // to relay-server's generic catch with no context for the caller.
    //
    // Reviewer V2 follow-up (2026-05-09): probe the CDP port BEFORE invoking
    // lighthouse so a dead Brave fails fast (~ms) instead of after lighthouse's
    // ~30s connection timeout. Lighthouse on a dead port hangs without
    // surfacing a useful error until Lighthouse itself gives up.
    try {
      const probeResp = await fetch(`http://127.0.0.1:${bridge.port}/json/version`, {
        // 1.5s is enough to detect a healthy CDP endpoint without making the
        // happy path noticeably slower; Lighthouse adds tens of seconds anyway.
        signal: AbortSignal.timeout(1500),
      });
      if (!probeResp.ok) {
        return {
          content: [{ type: "text", text: `lighthouse_audit: relay's Brave CDP endpoint http://127.0.0.1:${bridge.port}/json/version returned status ${probeResp.status}. Brave may have crashed; restart Cursor or call any other tool to relaunch.` }],
          isError: true,
        };
      }
    } catch (e) {
      return {
        content: [{ type: "text", text: `lighthouse_audit: cannot reach relay's Brave CDP at http://127.0.0.1:${bridge.port}: ${e.message || e}. Likely Brave isn't launched yet — call any browser tool first to trigger ensureBrave().` }],
        isError: true,
      };
    }

    let result;
    try {
      result = await lighthouse(url, {
        port: bridge.port,
        output: "json",
        logLevel: "error",
        onlyCategories: cats,
        formFactor,
        screenEmulation: formFactor === "mobile"
          ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false }
          : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
      });
    } catch (e) {
      return {
        content: [{ type: "text", text: `lighthouse_audit: ${e.message || String(e)}` }],
        isError: true,
      };
    }

    if (!result || !result.lhr) {
      return {
        content: [{ type: "text", text: "lighthouse returned no result" }],
        isError: true,
      };
    }
    const summary = {};
    for (const [key, cat] of Object.entries(result.lhr.categories || {})) {
      summary[key] = {
        score: cat.score === null ? null : Math.round(cat.score * 100),
        title: cat.title,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ url, formFactor, categories: summary, finalUrl: result.lhr.finalUrl, fetchTime: result.lhr.fetchTime }, null, 2) }],
    };
  },
};
