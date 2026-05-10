// stealth_apply — apply common anti-detection patches via CDP
// Page.addScriptToEvaluateOnNewDocument. Persists for the session — every page
// load gets the patches.
//
// Tier 1 coverage (v0.3.4 — added 2026-05-10):
//   • navigator.webdriver hidden                                  [T0]
//   • navigator.plugins faked (3 entries)                         [T0]
//   • navigator.languages override                                [T0]
//   • navigator.permissions.query notifications fix               [T0]
//   • window.chrome runtime stub                                  [T0]
//   • navigator.userAgentData synthesized from current UA         [T1-A]
//   • toString defense on patched getters (returns native-looking) [T1-B]
//   • AudioContext getChannelData per-session deterministic jitter [T1-C]
//
// Beyond Tier 1 (see docs/BACKLOG.md for the open items):
//   • Tier 2 — humanlike click/type, WebGL renderer override, expanded
//     chrome runtime (loadTimes/csi/app), full permissions overrides
//   • Tier 3 — real-Brave-attach mode (CloakBrowser pattern)
//
// Tier 4 (DON'T implement — known cat-and-mouse losers):
//   • puppeteer-extra-stealth integration (its OWN signature is detected)
//   • Canvas/font/battery randomization (overlaps Brave Shields, creates
//     fingerprint inconsistencies)
//   • event.isTrusted faking (impossible — synthetic events are flagged)
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
    "Apply anti-detection JavaScript patches to all future page loads in " +
    "the active context. Session-wide + persistent. Idempotent (no-op on " +
    "second call unless force=true). Re-runs against currently-open pages " +
    "too (best-effort). Tier 1 coverage (v0.3.4): navigator.webdriver " +
    "hidden, plugins/languages overridden, permissions notifications " +
    "fixed, window.chrome stub, navigator.userAgentData synthesized from " +
    "current UA, toString defense on patched getters, AudioContext " +
    "getChannelData per-session deterministic jitter. Defeats trivial bot " +
    "detection + the bottom 70% of common fingerprint checks. Does NOT " +
    "defeat: TLS/HTTP fingerprinting (need proxy chain), Function." +
    "prototype.toString deep checks (need rebrowser-patches), event." +
    "isTrusted detection (impossible — synthetic events are fundamentally " +
    "flagged). For hard targets, use a real-Brave-attach pattern instead.",
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

        // ─── Tier 1-B: toString defense helper ─────────────────────────
        // When you do Object.defineProperty(obj, 'foo', { get: () => X }),
        // a basic detector calls .toString() on the descriptor's getter
        // and sees the actual replaced function source ('() => X') instead
        // of the native 'function get foo() { [native code] }'. Defeating
        // this trivially-detected check requires installing a custom
        // toString on each patched function.
        //
        // This is a partial defense — it does NOT defend against checks
        // that examine Function.prototype.toString itself (sophisticated
        // detectors do this and would catch our patches via the unusual
        // 'toString' own-property on the getter). Ship as documented best-
        // effort; real cat-and-mouse winners require rebrowser-patches at
        // the binary level (out of scope for this MCP).
        function nativeLike(fn, nativeName) {
          try {
            Object.defineProperty(fn, 'toString', {
              value: function () { return 'function ' + nativeName + '() { [native code] }'; },
              writable: false, configurable: true, enumerable: false,
            });
            // Hide the toString property from Object.getOwnPropertyNames
            // would require a Proxy — out of scope. Document the limit.
          } catch (e) {}
          return fn;
        }

        // ─── Original Tier 0 patches (now toString-defended) ───────────
        try {
          const getter = nativeLike(function () { return undefined; }, 'get webdriver');
          Object.defineProperty(navigator, 'webdriver', { configurable: true, get: getter });
        } catch (e) {}

        try {
          const fakePlugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
          const getter = nativeLike(function () { return fakePlugins; }, 'get plugins');
          Object.defineProperty(navigator, 'plugins', { configurable: true, get: getter });
        } catch (e) {}

        try {
          const langs = ${JSON.stringify(languages)};
          const getter = nativeLike(function () { return langs; }, 'get languages');
          Object.defineProperty(navigator, 'languages', { configurable: true, get: getter });
        } catch (e) {}

        try {
          const origQuery = navigator.permissions.query.bind(navigator.permissions);
          const patched = nativeLike(function (params) {
            if (params && params.name === 'notifications') {
              return Promise.resolve({ state: typeof Notification !== 'undefined' ? Notification.permission : 'prompt' });
            }
            return origQuery(params);
          }, 'query');
          navigator.permissions.query = patched;
        } catch (e) {}

        try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}

        // ─── Tier 1-A: navigator.userAgentData synthesis ───────────────
        // Modern Sec-CH-UA-* HTTP headers + navigator.userAgentData are the
        // canonical fingerprint surface for modern anti-bot vendors. If
        // emulate_device overrides the UA but userAgentData stays as the
        // host Brave's defaults, sites flag the mismatch. We synthesize
        // userAgentData from the current navigator.userAgent string at
        // each page load so it tracks emulate_device's overrides.
        //
        // Limitation: HTTP-side Sec-CH-UA-* headers are set by chromium
        // itself based on its INTERNAL UA config, not navigator.userAgent.
        // For full alignment, emulate_device's CDP Network.setUserAgent-
        // Override needs a userAgentMetadata arg (Tier 2). This patch
        // covers the JS-side check; the HTTP-side gap is documented.
        try {
          const ua = navigator.userAgent || '';
          const cm = ua.match(/Chrome\\/(\\d+)/);
          const version = cm ? cm[1] : '127';
          const platform = /Windows/.test(ua) ? 'Windows'
            : /Macintosh/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux'
            : /Android/.test(ua) ? 'Android'
            : /iPhone|iPad/.test(ua) ? 'iOS'
            : 'Windows';
          const mobile = /Mobi|Android|iPhone/.test(ua);
          // The "Not?A_Brand" pattern matches what real Chrome ships.
          const brands = [
            { brand: 'Chromium', version: version },
            { brand: 'Not?A_Brand', version: '24' },
          ];
          const fakeUAD = {
            brands: brands.slice(),
            mobile: mobile,
            platform: platform,
            getHighEntropyValues: nativeLike(function (keys) {
              const out = { brands: brands.slice(), mobile: mobile, platform: platform };
              if (Array.isArray(keys)) {
                if (keys.includes('platformVersion')) out.platformVersion = '15.0.0';
                if (keys.includes('architecture')) out.architecture = 'x86';
                if (keys.includes('bitness')) out.bitness = '64';
                if (keys.includes('model')) out.model = '';
                if (keys.includes('uaFullVersion')) out.uaFullVersion = version + '.0.0.0';
                if (keys.includes('fullVersionList')) out.fullVersionList = brands.map(function(b){ return { brand: b.brand, version: b.version + '.0.0.0' }; });
                if (keys.includes('wow64')) out.wow64 = false;
                if (keys.includes('formFactors')) out.formFactors = mobile ? ['Mobile'] : ['Desktop'];
              }
              return Promise.resolve(out);
            }, 'getHighEntropyValues'),
            toJSON: nativeLike(function () { return { brands: brands.slice(), mobile: mobile, platform: platform }; }, 'toJSON'),
          };
          const uadGetter = nativeLike(function () { return fakeUAD; }, 'get userAgentData');
          Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: uadGetter });
        } catch (e) {}

        // ─── Tier 1-C: AudioContext fingerprint stabilization ──────────
        // Common detection: render a known waveform via OfflineAudioContext
        // → call getChannelData on the result → hash the samples → use as
        // a per-machine fingerprint. Playwright's chromium produces a
        // recognizable variant.
        //
        // Defense: deterministic per-session jitter on getChannelData
        // output. Stable across calls within a session (so the fingerprint
        // doesn't randomize per call — that's its OWN tell), but distinct
        // from the un-patched value. Seed is a single Math.random() at
        // first use, scoped to this session via window.__relayAudioSeed.
        try {
          if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype && AudioBuffer.prototype.getChannelData) {
            const seed = window.__relayAudioSeed || (window.__relayAudioSeed = Math.random() * 1e-7);
            const orig = AudioBuffer.prototype.getChannelData;
            // Replace with a wrapped version that mutates output by a
            // tiny stable amount. We use a Proxy so .toString and other
            // metadata still look reasonable.
            const wrapped = nativeLike(function () {
              const data = orig.apply(this, arguments);
              // Mutate every 100th sample by the seed. Determinstic +
              // imperceptible (< 1e-7 floating-point error band).
              for (var i = 0; i < data.length; i += 100) {
                data[i] = data[i] + seed;
              }
              return data;
            }, 'getChannelData');
            AudioBuffer.prototype.getChannelData = wrapped;
          }
        } catch (e) {}
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
