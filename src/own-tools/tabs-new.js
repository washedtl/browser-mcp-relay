// tabs_new — open a new tab, optionally navigating to a URL, and return its
// tabId. The only tool that creates tabs (an unknown tabId is an error).
//
// W2D (2026-11-03): the tab comes from ctx.registry, so it is a session tab
// like main: in broker mode its own window, used by upstream's tools as well
// as ours; in legacy mode a tab of the relay's browser that only the relay's
// own tools accept a tabId for. Before W2D, tabs_new opened a relay tab AND
// navigated upstream's page to the same URL: every URL loaded twice.
//
// T0-7 / T1-10 (2026-05-09): a failed goto still returns the tab (it exists;
// close it with tabs_close) with a structured navError; `waitUntil` is
// accepted for SPA-heavy sites.

const { errorResult } = require("./_tool-args.js");
const { legacyNote } = require("./_tabs.js");

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle", "commit"];

// tabIds are unique per process (one broker, or one legacy relay).
let lastTabNumber = 0;

module.exports = {
  name: "tabs_new",
  description:
    "Open a new tab, optionally navigating to a URL, and return its tabId. Pass the tabId on later calls " +
    "to act on that tab (a tool that can't take it says so); without it, calls act on your main tab. " +
    "Parallel subagents share one connection: each should open its own tab and pass its tabId.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Optional URL to navigate the new tab to" },
      waitUntil: {
        type: "string",
        enum: WAIT_UNTIL,
        default: "load",
        description: "Playwright navigation lifecycle to wait for. Default 'load'. Use 'networkidle' for SPA-heavy sites.",
      },
      timeoutMs: {
        type: "integer",
        minimum: 100,
        maximum: 300000,
        default: 30000,
        description: "Max wait for the navigation in ms. Default 30s.",
      },
    },
  },
  // Opens its own tab through the registry; the caller's tab isn't needed.
  needsPage: false,
  handler: async (_args = {}, { registry, connId }) => {
    // F0-9 (2026-05-10): treat null as missing.
    // W1C2: reject invalid values like the sibling tools do — silently
    // defaulting turned waitUntil "networkIdle" into a plain "load" wait.
    const url = _args.url ?? undefined;
    const waitUntil = _args.waitUntil ?? "load";
    if (!WAIT_UNTIL.includes(waitUntil)) {
      return errorResult(`tabs_new: waitUntil must be one of ${WAIT_UNTIL.join(", ")} (got ${JSON.stringify(_args.waitUntil)})`);
    }
    const timeoutMs = _args.timeoutMs ?? 30000;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) {
      return errorResult(`tabs_new: timeoutMs must be a number in [100, 300000] (got ${JSON.stringify(_args.timeoutMs)})`);
    }
    const tabId = `t${++lastTabNumber}`;
    const { page } = await registry.getCtx(connId, tabId);

    let navError = null;
    if (url) {
      try {
        await page.goto(url, { waitUntil, timeout: timeoutMs });
      } catch (e) {
        navError = e.message || String(e);
      }
    }

    const result = {
      content: [{
        type: "text",
        text: JSON.stringify({
          tabId,
          url: page.url(),
          waitUntil,
          navError,
          note: "Pass this tabId to act on this tab; calls without tabId act on your main tab.",
          legacyMode: legacyNote(registry),
        }, null, 2),
      }],
    };
    // Only set isError when truthy — keeping success-path shape `{ content }`.
    if (navError) result.isError = true;
    return result;
  },
};
