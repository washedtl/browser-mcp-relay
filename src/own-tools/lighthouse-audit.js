// lighthouse_audit — runs Lighthouse against a URL over the browser's CDP
// endpoint (ctx.cdpUrl). Returns category scores (performance,
// accessibility, best-practices, seo). Lighthouse runs in its own tab, so the
// tool needs no session page (needsPage:false).
//
// W2G (2026-11-03): two endpoints.
//   ws://…  broker mode: the broker's CDP proxy (a secret in its path; Brave
//           has no TCP port). It serves no /json/version, so Lighthouse's
//           own {hostname, port} connect can't use it: puppeteer-core (the
//           copy Lighthouse imports) connects to the ws URL, opens a tab and
//           hands it to lighthouse(); the tool closes that tab and
//           disconnects (never browser.close(): the browser is shared).
//   http:// legacy mode (cdp-bridge.js's port): probe /json/version, then
//           lighthouse({hostname, port}), as before.
//
// W2D (2026-11-03): storage reset is always off. Lighthouse's reset clears
// the origin's service workers / Cache Storage / file systems and the whole
// browser's HTTP cache — in the one profile every session shares.
//
// T0-6 / T1-1 fixes (2026-05-09):
//   • try/catch around lighthouse() — a bad URL or dead Brave throws
//     synchronously; previously this propagated as an uncaught exception
//   • lighthouse module hoisted to a memoized lazy import — was importing
//     ~3MB CJS/ESM on every call (~80–150ms cold cost); now imports once
//     on first call and reuses

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { errorResult } = require("./_tool-args.js");

// T1-1: lazy + memoized — first call pays the import cost, subsequent calls
// reuse the resolved module. The module is ~3MB; eager loading at startup
// would add ~100ms to relay boot. Lazy + memoized = best of both.
let _lhPromise = null;
function getLighthouse() {
  if (!_lhPromise) {
    // Resolves the whole module: the handler needs `default` + `desktopConfig`.
    _lhPromise = import("lighthouse")
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

// Lighthouse keeps process-global state: a second audit in the same process
// fails the first (measured: 'The "start lh:runner:gather" performance mark
// has not been set'). Sessions take turns.
const AUDIT_DEADLINE_MS = 5 * 60_000; // a stuck audit must not block every later one for good
let _auditTurn = Promise.resolve();
function oneAuditAtATime(run) {
  const turn = _auditTurn.then(() => {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`the audit did not finish in ${AUDIT_DEADLINE_MS / 60_000} min`)), AUDIT_DEADLINE_MS);
      timer.unref();
    });
    return Promise.race([run(), deadline]).finally(() => clearTimeout(timer));
  });
  _auditTurn = turn.then(() => {}, () => {});
  return turn;
}

/**
 * puppeteer-core's ESM entry, resolved from lighthouse: the very module
 * Lighthouse imports, so the page we hand it is one of its own.
 */
function puppeteerEntry() {
  const { createRequire } = require("node:module");
  const pkgJson = createRequire(require.resolve("lighthouse/package.json")).resolve("puppeteer-core/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
  const entry = pkg.exports && pkg.exports["."] && pkg.exports["."].import;
  if (typeof entry !== "string") throw new Error(`puppeteer-core ${pkg.version} has no ESM entry at exports["."].import`);
  return path.join(path.dirname(pkgJson), entry);
}

let _pptrPromise = null;
function getPuppeteer() {
  if (!_pptrPromise) {
    _pptrPromise = Promise.resolve()
      .then(() => import(pathToFileURL(puppeteerEntry()).href))
      .then((m) => m.default || m)
      .catch((e) => {
        _pptrPromise = null;
        throw e;
      });
  }
  return _pptrPromise;
}

module.exports = {
  name: "lighthouse_audit",
  description:
    "Run a Lighthouse audit against a URL using the relay's Brave instance. " +
    "Returns category scores (performance, accessibility, best-practices, seo). " +
    "The audit runs in a fresh tab of the shared browser, with its cookies and " +
    "extensions. desktop uses Lighthouse's desktop config (desktop throttling + UA); " +
    "mobile its default mobile emulation. It does not reset storage (other sessions " +
    "share the profile), so the origin's caches and service workers stay: scores " +
    "reflect a warm load.",
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
  needsPage: false,
  handler: async (_args = {}, { cdpUrl }) => {
    // F0-9 reviewer V1 (2026-05-10): null-as-missing for defaulted params.
    const url = _args.url;
    const formFactor = (_args.formFactor == null) ? "desktop" : _args.formFactor;
    const onlyCategories = _args.onlyCategories;
    if (formFactor !== "desktop" && formFactor !== "mobile") {
      return {
        content: [{ type: "text", text: `lighthouse_audit: formFactor must be 'desktop' or 'mobile' (got ${JSON.stringify(_args.formFactor)})` }],
        isError: true,
      };
    }
    if (!cdpUrl) return errorResult("lighthouse_audit unavailable: no browser CDP endpoint");

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

    let lighthouse, desktopConfig;
    try {
      ({ default: lighthouse, desktopConfig } = await getLighthouse());
    } catch (e) {
      return {
        content: [{ type: "text", text: `lighthouse_audit: failed to load lighthouse module: ${e.message || e}` }],
        isError: true,
      };
    }

    // F1-12 (2026-05-10): validate onlyCategories upfront. An empty array
    // is treated as "use default" rather than "run zero categories" (which
    // is what lighthouse would do verbatim — produces an empty/useless
    // report). Non-array values surface a structured error.
    const VALID_CATS = new Set(["performance", "accessibility", "best-practices", "seo", "pwa"]);
    let cats;
    if (onlyCategories === undefined || onlyCategories === null) {
      cats = ["performance", "accessibility", "best-practices", "seo"];
    } else if (!Array.isArray(onlyCategories)) {
      return {
        content: [{ type: "text", text: `lighthouse_audit: onlyCategories must be an array (got ${typeof onlyCategories})` }],
        isError: true,
      };
    } else if (onlyCategories.length === 0) {
      cats = ["performance", "accessibility", "best-practices", "seo"];
    } else {
      const bad = onlyCategories.filter((c) => !VALID_CATS.has(c));
      if (bad.length > 0) {
        return {
          content: [{ type: "text", text: `lighthouse_audit: invalid categories ${JSON.stringify(bad)}; valid: ${[...VALID_CATS].join(", ")}` }],
          isError: true,
        };
      }
      cats = onlyCategories;
    }

    const flags = { disableStorageReset: true, output: "json", logLevel: "error", onlyCategories: cats, formFactor };
    // W1C2: formFactor/screenEmulation flags alone kept the default config's
    // mobile throttling + mobile UA on desktop runs. Desktop uses
    // Lighthouse's own desktopConfig; mobile uses the default config. Flags
    // override config settings, so none of those are passed as flags.
    const config = formFactor === "desktop" ? desktopConfig : undefined;
    const PROBE_ADVICE = "Brave may have crashed or hung. Retry: the relay relaunches Brave " +
      "after it sees the browser disconnect; if it keeps failing, restart the MCP server.";

    let result;
    if (/^wss?:\/\//i.test(cdpUrl)) {
      // W2G broker mode. Messages never print cdpUrl: it holds the secret.
      let puppeteer;
      try {
        puppeteer = await getPuppeteer();
      } catch (e) {
        return errorResult(`lighthouse_audit: failed to load puppeteer-core (Lighthouse's dependency): ${e.message || e}`);
      }
      let browser;
      try {
        browser = await puppeteer.connect({ browserWSEndpoint: cdpUrl, defaultViewport: null });
      } catch (e) {
        return errorResult(`lighthouse_audit: cannot reach the relay's Brave over CDP: ${e.message || e}. ${PROBE_ADVICE}`);
      }
      let page = null;
      try {
        result = await oneAuditAtATime(async () => {
          page = await browser.newPage();
          return lighthouse(url, flags, config, page);
        });
      } catch (e) {
        return errorResult(`lighthouse_audit: ${e.message || String(e)}`);
      } finally {
        // Given a page, Lighthouse leaves it open: close our tab, keep the shared browser.
        if (page) await page.close().catch(() => {});
        await browser.disconnect().catch(() => {});
      }
      return summarize(url, formFactor, result);
    }

    const { hostname, port } = new URL(cdpUrl);
    const probeUrl = new URL("/json/version", cdpUrl).href;
    // T0-6: wrap the lighthouse() call in try/catch. Bad URL, unreachable host,
    // dead Brave (relay's CDP port 9333+slot not listening), Lighthouse internal
    // crashes — all surface here. Previously propagated as uncaught exceptions
    // to relay-server's generic catch with no context for the caller.
    //
    // Reviewer V2 follow-up (2026-05-09): probe the CDP port BEFORE invoking
    // lighthouse so a dead Brave fails fast (~ms) instead of after lighthouse's
    // ~30s connection timeout. Lighthouse on a dead port hangs without
    // surfacing a useful error until Lighthouse itself gives up.
    // W1C2: ensureBrave() already ran for this call (relay-server does it
    // before every own-tool), so a failed probe means Brave died or hung.
    try {
      const probeResp = await fetch(probeUrl, {
        // 1.5s is enough to detect a healthy CDP endpoint without making the
        // happy path noticeably slower; Lighthouse adds tens of seconds anyway.
        signal: AbortSignal.timeout(1500),
      });
      if (!probeResp.ok) {
        return {
          content: [{ type: "text", text: `lighthouse_audit: relay's Brave CDP endpoint ${probeUrl} returned status ${probeResp.status}. ${PROBE_ADVICE}` }],
          isError: true,
        };
      }
    } catch (e) {
      return {
        content: [{ type: "text", text: `lighthouse_audit: cannot reach relay's Brave CDP at ${cdpUrl}: ${e.message || e}. ${PROBE_ADVICE}` }],
        isError: true,
      };
    }

    try {
      result = await oneAuditAtATime(() => lighthouse(url, { hostname, port: Number(port), ...flags }, config));
    } catch (e) {
      return {
        content: [{ type: "text", text: `lighthouse_audit: ${e.message || String(e)}` }],
        isError: true,
      };
    }
    return summarize(url, formFactor, result);
  },
  // Test seam: substitute the lighthouse module (null restores lazy import).
  _setLighthouseForTest(mod) {
    _lhPromise = mod ? Promise.resolve(mod) : null;
  },
  // Test seam: substitute puppeteer-core ({connect}), or an Error its import
  // fails with; null restores the lazy import.
  _setPuppeteerForTest(mod) {
    if (mod instanceof Error) {
      _pptrPromise = Promise.reject(mod);
      _pptrPromise.catch(() => {}); // handled when the tool awaits it
      return;
    }
    _pptrPromise = mod ? Promise.resolve(mod) : null;
  },
  _puppeteerEntry: puppeteerEntry,
};

function summarize(url, formFactor, result) {
  if (!result || !result.lhr) {
    return {
      content: [{ type: "text", text: "lighthouse_audit: lighthouse returned no result" }],
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
}
