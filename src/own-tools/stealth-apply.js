// stealth_apply — apply common anti-detection patches via CDP
// Page.addScriptToEvaluateOnNewDocument. Persists for the session — every page
// load gets the patches.
// Defeats basic bot detection (navigator.webdriver checks, missing plugins, etc.)
// — NOT a panacea against advanced fingerprinting (PerimeterX, FunCaptcha).
//
// T0-4 / T1-7 fixes (2026-05-09):
//   • per-context applied-flag (via WeakMap on bridge.context) prevents
//     repeat calls from accumulating multiple init scripts in the context.
//     Previously, every call appended another script — over a long session
//     the same patches ran N times on every page load.
//   • inside the script, `navigator.permissions.query` was monkey-patched
//     without an idempotency sentinel — a second run would chain
//     `origQuery = navigator.permissions.query` to the PREVIOUS override,
//     creating a recursive call chain. A `__relayStealthApplied` flag on
//     window short-circuits re-runs at the page level.

// WeakMap so contexts get garbage-collected normally — no leak when the
// relay's BrowserContext closes.
const APPLIED_CONTEXTS = new WeakMap();

module.exports = {
  name: "stealth_apply",
  description:
    "Apply anti-detection JavaScript patches to all future page loads in the " +
    "active context: hide navigator.webdriver, add fake plugins, normalize " +
    "navigator.languages, etc. Session-wide and persistent. Re-runs against " +
    "currently-open pages too (best-effort — pages mid-navigation may be " +
    "skipped and pick up the patches on next load). Idempotent — calling " +
    "twice is a no-op. Defeats basic bot detection; not a substitute for " +
    "puppeteer-extra-stealth against advanced anti-bot.",
  inputSchema: {
    type: "object",
    properties: {
      languages: {
        type: "array",
        items: { type: "string" },
        default: ["en-US", "en"],
        description: "Override navigator.languages.",
      },
      force: {
        type: "boolean",
        default: false,
        description: "If true, re-apply even if already applied to this context (changes the languages override). Default false: subsequent calls are no-ops.",
      },
    },
  },
  handler: async (_args = {}) => {
    // F0-9 (2026-05-10): treat null as missing (JSON-RPC clients commonly
    // send null for unset optionals; JS destructure defaults only fire on
    // undefined). Languages: must be a non-empty string-array.
    let languages = _args.languages;
    if (!Array.isArray(languages) || languages.length === 0 || !languages.every((s) => typeof s === "string" && s.length > 0)) {
      languages = ["en-US", "en"];
    }
    const force = !!_args.force;
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };

    // T1-7: per-context applied-flag. Without `force`, calling stealth_apply
    // twice no-ops on the second call — preventing init-script accumulation.
    const alreadyApplied = APPLIED_CONTEXTS.get(bridge.context);
    if (alreadyApplied && !force) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            applied: false,
            alreadyApplied: true,
            languages: alreadyApplied.languages,
            note: "stealth_apply was already applied to this context. Pass force=true to re-apply with new languages.",
          }, null, 2),
        }],
      };
    }

    // T0-4: page-level idempotency sentinel inside the injected script.
    // Even if `addInitScript` somehow runs the script twice (different
    // call sites, framework bug, etc.), the sentinel ensures the
    // `navigator.permissions.query` monkey-patch chain doesn't recurse.
    const stealthScript = `
      (function() {
        if (window.__relayStealthApplied) return;
        window.__relayStealthApplied = true;
        // Hide webdriver flag.
        try { Object.defineProperty(navigator, 'webdriver', { configurable: true, get: () => undefined }); } catch (e) {}
        // Fake plugins (not empty — common bot tells expect non-empty).
        try { Object.defineProperty(navigator, 'plugins', {
          configurable: true,
          get: () => [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ],
        }); } catch (e) {}
        // Override languages.
        try { Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ${JSON.stringify(languages)} }); } catch (e) {}
        // Permissions: notifications check is a common bot tell.
        try {
          const origQuery = navigator.permissions.query;
          navigator.permissions.query = (params) => {
            if (params && params.name === 'notifications') {
              return Promise.resolve({ state: typeof Notification !== 'undefined' ? Notification.permission : 'prompt' });
            }
            return origQuery(params);
          };
        } catch (e) {}
        // Chrome runtime fakery.
        try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}
      })();
    `;

    await bridge.context.addInitScript(stealthScript);

    // Also apply to currently-open pages (addInitScript only affects future loads).
    const openPages = bridge.context.pages();
    let patchedOpenPages = 0;
    let skippedOpenPages = 0;
    for (const page of openPages) {
      try {
        await page.evaluate(stealthScript);
        patchedOpenPages++;
      } catch {
        skippedOpenPages++; // page may be at chrome:// / mid-nav / closed
      }
    }

    APPLIED_CONTEXTS.set(bridge.context, { languages });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          applied: true,
          languages,
          patchedOpenPages,
          skippedOpenPages,
          note: "Patches active for all future page loads in this context. " +
                "Currently-open pages also patched (best-effort — see skippedOpenPages count).",
        }, null, 2),
      }],
    };
  },
  // Test seam — exposed so unit tests can reset the WeakMap between runs.
  _APPLIED_CONTEXTS: APPLIED_CONTEXTS,
};
