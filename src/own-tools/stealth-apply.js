// stealth_apply — apply common anti-detection patches via CDP
// Page.addScriptToEvaluateOnNewDocument. Persists for the session — every page
// load gets the patches.
// Defeats basic bot detection (navigator.webdriver checks, missing plugins, etc.)
// — NOT a panacea against advanced fingerprinting (PerimeterX, FunCaptcha).

module.exports = {
  name: "stealth_apply",
  description:
    "Apply anti-detection JavaScript patches to all future page loads in the " +
    "active context: hide navigator.webdriver, add fake plugins, normalize " +
    "navigator.languages, etc. Session-wide and persistent. Defeats basic " +
    "bot detection (navigator.webdriver checks); not a substitute for full " +
    "stealth solutions like puppeteer-extra-stealth against advanced anti-bot.",
  inputSchema: {
    type: "object",
    properties: {
      languages: {
        type: "array",
        items: { type: "string" },
        default: ["en-US", "en"],
        description: "Override navigator.languages.",
      },
    },
  },
  handler: async ({ languages = ["en-US", "en"] }) => {
    const bridge = globalThis.__relayBridge;
    if (!bridge) return { content: [{ type: "text", text: "bridge missing" }], isError: true };

    // BrowserContext-wide init script — applied to every page in the context.
    //
    // V1-6: addInitScript is additive — calling stealth_apply twice means
    // both copies run on the next page load. On a second run, redefining
    // the already-non-configurable `navigator.webdriver` etc. throws and
    // takes the entire init script down. Guard each defineProperty with
    // try/catch so a second-run redefinition is a no-op rather than a crash.
    const stealthScript = `
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
    `;

    await bridge.context.addInitScript(stealthScript);

    // Also apply to currently-open pages (addInitScript only affects future loads).
    for (const page of bridge.context.pages()) {
      try { await page.evaluate(stealthScript); } catch { /* page may be in wrong state */ }
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          applied: true,
          languages,
          note: "Patches active for all future page loads in this context. Currently-open pages also patched (best-effort).",
        }, null, 2),
      }],
    };
  },
};
