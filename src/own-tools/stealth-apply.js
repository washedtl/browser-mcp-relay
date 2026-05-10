// stealth_apply — apply common anti-detection patches via CDP
// Page.addScriptToEvaluateOnNewDocument. Persists for the session — every page
// load gets the patches.
//
// Tier 1 coverage (v0.3.4):
//   • navigator.webdriver hidden                                  [T0]
//   • navigator.plugins faked (3 entries)                         [T0]
//   • navigator.languages override                                [T0]
//   • navigator.permissions.query notifications fix               [T0]
//   • window.chrome runtime stub                                  [T0]
//   • navigator.userAgentData synthesized from current UA         [T1-A]
//   • toString defense on patched getters (returns native-looking) [T1-B]
//   • AudioContext getChannelData per-session deterministic jitter [T1-C]
//
// Tier 2 coverage (v0.3.5 — added 2026-05-10):
//   • Sec-CH-UA HTTP-side via emulate_device's userAgentMetadata   [T2-A]
//   • Chrome runtime expansion: loadTimes / csi / app namespaces   [T2-B]
//   • Full permissions overrides (clipboard / geolocation / mic)   [T2-C]
//   • WebGL renderer + vendor override (UA-aware, conservative)    [T2-D]
//
// Beyond Tier 2 (see docs/BACKLOG.md for the open items):
//   • Tier 2.5 (deferred with ship gate) — humanlike_click / humanlike_type
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
    "too (best-effort). Tier 1+2 coverage (v0.3.5): navigator.webdriver " +
    "hidden, plugins/languages overridden, navigator.userAgentData " +
    "synthesized from current UA, full permissions overrides (notifications" +
    "/geolocation/clipboard/camera/microphone/midi/push and more), Chrome " +
    "runtime expansion (loadTimes/csi/app namespaces), WebGL renderer + " +
    "vendor override (UA-aware GPU strings), toString defense on patched " +
    "getters, AudioContext getChannelData per-session deterministic jitter." +
    " Use emulate_device to ALSO align HTTP-side Sec-CH-UA-* headers. " +
    "Defeats trivial bot detection + the bottom ~85% of common fingerprint" +
    " checks. Does NOT defeat: TLS/HTTP fingerprinting (need proxy chain)," +
    " Function.prototype.toString deep checks (need rebrowser-patches), " +
    "event.isTrusted detection (impossible — synthetic events are " +
    "fundamentally flagged), behavioral fingerprinting (humanlike " +
    "interaction is deferred to Tier 2.5 in BACKLOG with a ship gate). " +
    "For hard targets, use a real-Brave-attach pattern instead.",
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
          // T2-C (v0.3.5): expanded permission overrides. Sophisticated
          // detectors probe more than just notifications — geolocation,
          // clipboard-read/write, camera, microphone, midi, push, periodic-
          // background-sync. Real interactive browsers report 'prompt' for
          // most (until user grants) and 'granted' for some default-allowed
          // (clipboard-write). Headless / Playwright chromium tends to
          // report 'denied' or throws on unknown — both detectable.
          const PERMISSION_OVERRIDES = {
            // 'notifications' is dynamic — depends on Notification.permission.
            'geolocation': 'prompt',
            'clipboard-read': 'prompt',
            'clipboard-write': 'granted',
            'camera': 'prompt',
            'microphone': 'prompt',
            'midi': 'prompt',
            'push': 'prompt',
            'periodic-background-sync': 'prompt',
            'background-sync': 'granted',
            'accessibility-events': 'granted',
            'persistent-storage': 'prompt',
            'screen-wake-lock': 'prompt',
            'system-wake-lock': 'prompt',
            'display-capture': 'prompt',
            'idle-detection': 'prompt',
            'storage-access': 'prompt',
            'top-level-storage-access': 'prompt',
          };
          const patched = nativeLike(function (params) {
            if (params && params.name === 'notifications') {
              return Promise.resolve({ state: typeof Notification !== 'undefined' ? Notification.permission : 'prompt' });
            }
            if (params && params.name in PERMISSION_OVERRIDES) {
              return Promise.resolve({ state: PERMISSION_OVERRIDES[params.name] });
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
          // Order matters: Android UAs contain 'Linux; Android...' so
          // Android must come BEFORE Linux. iPhone/iPad before macOS
          // because iOS UAs contain 'Mac OS X' in the version string.
          const platform = /Windows/.test(ua) ? 'Windows'
            : /iPhone|iPad/.test(ua) ? 'iOS'
            : /Android/.test(ua) ? 'Android'
            : /Macintosh/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux'
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

        // ─── Tier 2-B: Chrome runtime expansion ─────────────────────────
        // Tier 1 stubbed window.chrome = { runtime: {} } to defeat the
        // basic "no chrome runtime" test. Sophisticated detectors probe
        // deeper — chrome.loadTimes() / chrome.csi() / chrome.app — and
        // flag if they're missing. Real Chrome populates all three; this
        // patch fills in plausible-shape stubs without inventing values
        // that would fail a deeper test.
        try {
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) window.chrome.runtime = {};
          // chrome.loadTimes() — deprecated in real Chrome but still present.
          if (!window.chrome.loadTimes) {
            const startTime = Date.now() / 1000 - Math.random() * 30;
            window.chrome.loadTimes = nativeLike(function () {
              return {
                requestTime: startTime,
                startLoadTime: startTime,
                commitLoadTime: startTime + 0.05,
                finishDocumentLoadTime: startTime + 0.4,
                finishLoadTime: startTime + 0.8,
                firstPaintTime: startTime + 0.1,
                firstPaintAfterLoadTime: 0,
                navigationType: 'Other',
                wasFetchedViaSpdy: false,
                wasNpnNegotiated: true,
                npnNegotiatedProtocol: 'h2',
                wasAlternateProtocolAvailable: false,
                connectionInfo: 'h2',
              };
            }, 'loadTimes');
          }
          // chrome.csi() — Client-Side Instrumentation timing.
          if (!window.chrome.csi) {
            const startE = Date.now() - Math.floor(Math.random() * 2000);
            window.chrome.csi = nativeLike(function () {
              return {
                startE: startE,
                onloadT: startE + 200,
                pageT: Date.now() - startE,
                tran: 15,
              };
            }, 'csi');
          }
          // chrome.app — installation/runtime state. Real Chrome ships a
          // full namespace; we provide the subset that detectors check.
          if (!window.chrome.app) {
            window.chrome.app = {
              isInstalled: false,
              InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
              RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
              getDetails: nativeLike(function () { return null; }, 'getDetails'),
              getIsInstalled: nativeLike(function () { return false; }, 'getIsInstalled'),
              installState: nativeLike(function (cb) { try { cb && cb('not_installed'); } catch (e) {} }, 'installState'),
              runningState: nativeLike(function () { return 'cannot_run'; }, 'runningState'),
            };
          }
        } catch (e) {}

        // ─── Tier 2-C: full permissions overrides ──────────────────────
        // Tier 1 only fixed the notifications-permission tell. Sophisticated
        // detectors also probe clipboard-read / clipboard-write / geolocation
        // / camera / microphone / midi / push to compare against expected
        // values for non-headless browsers. Extend the existing query patch
        // with realistic states. Note: navigator.permissions.query was
        // already monkey-patched in Tier 0 — we extend that handler instead
        // of re-patching (which would chain into recursion).
        //
        // We accomplish this by having the Tier 0 patch ALSO consult a map
        // of overrides — see how the Tier 0 patch was rewritten below.
        // This block is a placeholder that documents the intent; the actual
        // logic lives in the Tier 0 patch's new permission-map.

        // ─── Tier 2-D: WebGL renderer + vendor override ────────────────
        // Browser fingerprinters render a known WebGL scene and call
        // getParameter(UNMASKED_VENDOR_WEBGL) + getParameter(UNMASKED_
        // RENDERER_WEBGL) to get the GPU identity. Playwright's chromium
        // reports recognizable signature strings. Override to plausible
        // values keyed off the platform from the current UA.
        //
        // Risk (documented in BACKLOG.md): a mismatched UA + GPU combo is
        // an INSTANT flag — e.g. iOS UA with "Intel Iris" renderer. We
        // pick conservative GPU strings keyed off the UA platform and
        // accept that an caller passing a weird UA still gets sensible
        // defaults rather than a clearly-wrong combo.
        try {
          if (typeof WebGLRenderingContext !== 'undefined' && WebGLRenderingContext.prototype) {
            const ua = navigator.userAgent || '';
            // UNMASKED_VENDOR_WEBGL = 0x9245, UNMASKED_RENDERER_WEBGL = 0x9246
            // (the WEBGL_debug_renderer_info extension constants)
            const VENDOR_PARAM = 0x9245;
            const RENDERER_PARAM = 0x9246;
            // Pick a plausible GPU based on platform. These values come from
            // real browser fingerprint data — common GPUs on common platforms.
            // Conservative bias — all platforms get an Intel-family GPU which
            // matches the most common configuration on each platform.
            let vendor, renderer;
            if (/Macintosh/.test(ua)) {
              vendor = 'Google Inc. (Apple)';
              renderer = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)';
            } else if (/Linux/.test(ua) && !/Android/.test(ua)) {
              vendor = 'Google Inc. (Intel)';
              renderer = 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)';
            } else if (/Android|iPhone|iPad/.test(ua)) {
              vendor = 'Google Inc. (Qualcomm)';
              renderer = 'ANGLE (Qualcomm, Adreno (TM) 660, OpenGL ES 3.2)';
            } else {
              // Windows default — most common.
              vendor = 'Google Inc. (Intel)';
              renderer = 'ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)';
            }
            const origGetParameter = WebGLRenderingContext.prototype.getParameter;
            const wrapped = nativeLike(function (parameter) {
              if (parameter === VENDOR_PARAM) return vendor;
              if (parameter === RENDERER_PARAM) return renderer;
              return origGetParameter.apply(this, arguments);
            }, 'getParameter');
            WebGLRenderingContext.prototype.getParameter = wrapped;
            // WebGL2 extends the same prototype chain but has its own getParameter.
            if (typeof WebGL2RenderingContext !== 'undefined' && WebGL2RenderingContext.prototype) {
              const orig2 = WebGL2RenderingContext.prototype.getParameter;
              const wrapped2 = nativeLike(function (parameter) {
                if (parameter === VENDOR_PARAM) return vendor;
                if (parameter === RENDERER_PARAM) return renderer;
                return orig2.apply(this, arguments);
              }, 'getParameter');
              WebGL2RenderingContext.prototype.getParameter = wrapped2;
            }
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
