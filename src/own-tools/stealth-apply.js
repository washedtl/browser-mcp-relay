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
//   • navigator.userAgentData replaced only when it contradicts   [T1-A]
//     the UA (W1D-3; shared generator in _client-hints.js)
//   • toString defense on patched getters (returns native-looking) [T1-B]
//   • AudioBuffer getChannelData per-session jitter, applied once  [T1-C]
//     per buffer+channel (W1D-2)
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
//
// W1D fixes (2026-11-03):
//   • force:true used to report success while changing nothing: the new
//     init script (and the open-page evaluate) stopped at the first apply's
//     page flag. The flag now carries a generation + live config; a newer
//     apply updates the config in place (patches still install once per
//     document), and the replaced init script is disposed when
//     addInitScript returns a Disposable (playwright-core 1.59.1 does).
//   • audio jitter used to be re-added to the LIVE buffer on every
//     getChannelData call (cumulative drift) with a per-page seed.
//
// W2D (2026-11-03): stealth_apply patches the calling session, never another
// one, so it takes no tabId (needsPage:false). Broker mode (per-connection
// registry): one BrowserContext holds every session's tabs, so each of the
// connection's tabs is patched (scope "tab"). Legacy mode (registry.scope
// "context"): the whole registry.context is this session's, so it is patched
// (scope "context"), which also covers the page upstream opens after the
// call (the usual "stealth, then navigate" order).

const { CLIENT_HINTS_SOURCE } = require("./_client-hints.js");

// Page | BrowserContext → { languages, initScript }. WeakMap so closed tabs
// and contexts are garbage-collected normally.
const APPLIED = new WeakMap();

// W1D-2 → W2D: one audio seed per relay/broker process, i.e. per browser,
// kept across force re-applies: every tab shows the same perturbation, like
// one real device. In [5e-8, 1e-7): imperceptible, yet more than half a
// float32 ulp for any sample in (-1, 1), so it never rounds away.
const AUDIO_SEED = (1 + Math.random()) * 5e-8;

// W1D-1: each apply gets a newer generation than any before it. Date-based so
// a restarted relay still outranks an install an older relay process left in
// an already-open page.
let lastGeneration = 0;
function nextGeneration() {
  lastGeneration = Math.max(Date.now(), lastGeneration + 1);
  return lastGeneration;
}

/**
 * Patch one target: a tab (scope "tab": that Page) or a whole BrowserContext
 * that belongs to one session (scope "context": every page in it, incl.
 * later ones). Future loads via addInitScript; open documents via evaluate.
 * Once per target unless force. → { applied, languages, patchedOpenPages, skippedOpenPages }
 */
async function applyStealth(target, scope, { languages, force }) {
  // T1-7: per-target applied-flag. Without `force`, calling stealth_apply
  // twice no-ops on the second call — preventing init-script accumulation.
  const prior = APPLIED.get(target);
  if (prior && !force) return { applied: false, languages: prior.languages, patchedOpenPages: 0, skippedOpenPages: 0 };
  // Claim the target synchronously so a concurrent first call no-ops
  // instead of registering a second script.
  const entry = { languages, initScript: null };
  APPLIED.set(target, entry);

  // T0-4 → W1D-1: page-level sentinel inside the injected script. Patches
  // install once per document, so `navigator.permissions.query` (and the
  // other wrappers) never chain. A NEWER apply — a later init script, or
  // page.evaluate on an open page — updates the live config instead of
  // stopping at the flag; an older one is ignored, whatever the run order.
  const stealthScript = `
    (function() {
      var GEN = ${nextGeneration()};
      var CFG = ${JSON.stringify({ languages, audioSeed: AUDIO_SEED })};
      Object.freeze(CFG.languages);
      var installed = window.__relayStealthApplied;
      if (installed) {
        if (typeof installed === 'object' && installed.gen < GEN) { installed.gen = GEN; installed.cfg = CFG; }
        return;
      }
      var state = { gen: GEN, cfg: CFG };
      try {
        Object.defineProperty(window, '__relayStealthApplied', { value: state, configurable: false, enumerable: false, writable: false });
      } catch (e) { return; }

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
        // Reads the live config so a newer apply (force) takes effect here.
        const getter = nativeLike(function () { return state.cfg.languages; }, 'get languages');
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

      // ─── Tier 1-A → W1D-3: navigator.userAgentData coherence ───────
      // Chromium builds navigator.userAgentData from the same metadata as
      // the Sec-CH-UA-* headers: Brave's own values (incl. its "Brave"
      // brand) when nothing is overridden, emulate_device's metadata when
      // it set one. Replacing a coherent native object would CREATE a
      // header-vs-JS mismatch, so we only step in when the native hints
      // contradict the UA — typically a UA override without metadata,
      // which blanks the brands. The replacement comes from the same
      // generator emulate_device uses for the headers. No userAgentData at
      // all (insecure context) stays that way, as in real Chrome.
      try {
        const nativeUAD = navigator.userAgentData;
        if (nativeUAD) {
          const clientHintsFromUA = ${CLIENT_HINTS_SOURCE};
          const hints = clientHintsFromUA(navigator.userAgent || '');
          let coherent = false;
          try {
            const nativeBrands = nativeUAD.brands || [];
            coherent = nativeBrands.length > 0
              && nativeUAD.platform === hints.platform
              && nativeUAD.mobile === hints.mobile
              && Array.prototype.some.call(nativeBrands, function (b) { return !!b && b.version === hints.brands[0].version; });
          } catch (e) {}
          if (!coherent) {
            const copyList = function (list) { return list.map(function (b) { return { brand: b.brand, version: b.version }; }); };
            const fakeUAD = {
              brands: copyList(hints.brands),
              mobile: hints.mobile,
              platform: hints.platform,
              getHighEntropyValues: nativeLike(function (keys) {
                const out = { brands: copyList(hints.brands), mobile: hints.mobile, platform: hints.platform };
                if (Array.isArray(keys)) {
                  ['platformVersion', 'architecture', 'bitness', 'model', 'wow64'].forEach(function (k) {
                    if (keys.includes(k)) out[k] = hints[k];
                  });
                  if (keys.includes('uaFullVersion')) out.uaFullVersion = hints.fullVersionList[0].version;
                  if (keys.includes('fullVersionList')) out.fullVersionList = copyList(hints.fullVersionList);
                  if (keys.includes('formFactors')) out.formFactors = hints.mobile ? ['Mobile'] : ['Desktop'];
                }
                return Promise.resolve(out);
              }, 'getHighEntropyValues'),
              toJSON: nativeLike(function () { return { brands: copyList(hints.brands), mobile: hints.mobile, platform: hints.platform }; }, 'toJSON'),
            };
            const uadGetter = nativeLike(function () { return fakeUAD; }, 'get userAgentData');
            Object.defineProperty(navigator, 'userAgentData', { configurable: true, get: uadGetter });
          }
        }
      } catch (e) {}

      // ─── Tier 1-C → W1D-2: AudioBuffer fingerprint perturbation ────
      // Common detection: render a known waveform via OfflineAudioContext
      // → getChannelData → hash the samples. We add a tiny seed to every
      // 100th sample. The seed is generated once per relay session and
      // embedded here, so the fingerprint is stable across reads AND
      // pages (per-page randomness is its own tell). getChannelData
      // returns the buffer's LIVE storage, so each (buffer, channel) is
      // perturbed exactly once — re-adding on every call made it drift.
      try {
        if (typeof AudioBuffer !== 'undefined' && AudioBuffer.prototype && AudioBuffer.prototype.getChannelData) {
          const seed = CFG.audioSeed;
          const proto = AudioBuffer.prototype;
          const orig = proto.getChannelData;
          // Keyed on the returned live storage, not (buffer, channel): a
          // channel object whose valueOf returns a different number per
          // conversion would desync a channel-keyed record and re-perturb.
          const perturbed = new WeakSet(); // Float32Array (live channel storage)
          const perturbOnce = function (data) {
            if (perturbed.has(data)) return;
            perturbed.add(data);
            for (var i = 0; i < data.length; i += 100) {
              data[i] = data[i] + seed;
            }
          };
          proto.getChannelData = nativeLike(function (channel) {
            const data = orig.apply(this, arguments); // throws on bad this / channel first
            perturbOnce(data);
            return data;
          }, 'getChannelData');
          // copyFromChannel reads the same storage: jitter it first so both
          // read paths agree and no read visibly changes the buffer. The
          // channel is converted exactly once (as the native call would).
          if (typeof proto.copyFromChannel === 'function') {
            const origCopy = proto.copyFromChannel;
            proto.copyFromChannel = nativeLike(function (destination, channelNumber) {
              const ch = channelNumber >>> 0;
              perturbOnce(orig.call(this, ch));
              return arguments.length > 2
                ? origCopy.call(this, destination, ch, arguments[2])
                : origCopy.call(this, destination, ch);
            }, 'copyFromChannel');
          }
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

  try {
    entry.initScript = await target.addInitScript(stealthScript);
  } catch (e) {
    // Un-claim so the caller can retry (e.g. after the page recovers).
    if (APPLIED.get(target) === entry) {
      if (prior) APPLIED.set(target, prior);
      else APPLIED.delete(target);
    }
    throw e;
  }
  // W1D-1: retire the script this apply replaces so force doesn't stack
  // init scripts. Without a Disposable (older playwright-core) the stale
  // script keeps running first on each load, then this newer generation
  // overrides its config — same end state.
  if (prior && prior.initScript && typeof prior.initScript.dispose === "function") {
    try { await prior.initScript.dispose(); } catch { /* the newer generation still wins */ }
  }

  // Also patch open documents (addInitScript only affects future loads).
  const openPages = scope === "context" ? target.pages() : [target];
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

  return { applied: true, languages, patchedOpenPages, skippedOpenPages };
}

module.exports = {
  name: "stealth_apply",
  description:
    "Inject anti-fingerprinting patches into all your tabs: every future page load " +
    "and, best-effort, the open documents (other sessions are never touched; tabs " +
    "you open later need another call): hides navigator.webdriver; " +
    "fakes plugins, languages, permission states and window.chrome; UA-matched " +
    "WebGL vendor; stable audio jitter; replaces navigator.userAgentData only " +
    "when it contradicts the UA. Once per tab; force=true re-applies with " +
    "new languages. Pair with emulate_device so Sec-CH-UA headers match. Won't " +
    "beat TLS fingerprinting, deep toString checks, isTrusted or behavioral detection.",
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
        description: "If true, re-apply even if already applied to this tab (changes the languages override). Default false: subsequent calls are no-ops.",
      },
    },
  },
  needsPage: false,
  handler: async (_args = {}, { registry, connId }) => {
    // F0-9 (2026-05-10): treat null as missing (JSON-RPC clients commonly
    // send null for unset optionals; JS destructure defaults only fire on
    // undefined). Languages: must be a non-empty string-array.
    let languages = _args.languages;
    if (!Array.isArray(languages) || languages.length === 0 || !languages.every((s) => typeof s === "string" && s.length > 0)) {
      languages = ["en-US", "en"];
    }
    const opts = { languages, force: !!_args.force };
    const whole = registry.scope === "context";
    let targets;
    if (whole) {
      targets = [{ tabKey: "all tabs", target: registry.context, scope: "context" }];
    } else {
      let tabs = (await registry.listTabs(connId)).filter((t) => t.page);
      // A connection with no tab yet: open its main tab, as any page tool would.
      if (!tabs.length) tabs = [{ tabKey: "main", page: (await registry.getCtx(connId, "main")).page }];
      targets = tabs.map((t) => ({ tabKey: t.tabKey, target: t.page, scope: "tab" }));
    }
    const results = await Promise.all(targets.map(async (t) => ({ tabKey: t.tabKey, ...(await applyStealth(t.target, t.scope, opts)) })));
    const applied = results.filter((r) => r.applied).map((r) => r.tabKey);
    const alreadyApplied = results.filter((r) => !r.applied).map((r) => r.tabKey);
    const sum = (k) => results.reduce((n, r) => n + r[k], 0);
    let note;
    if (!applied.length) note = "Already applied. Pass force=true to re-apply with new languages.";
    else if (whole) note = "Patches active for every future page load in this browser session; open pages patched best-effort (see skippedOpenPages).";
    else note = "Patches active for every future page load in these tabs (not popups); open pages patched best-effort (see skippedOpenPages). Tabs you open later need another stealth_apply call.";
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          applied,
          alreadyApplied,
          // An already-applied tab keeps its languages until force.
          languages: (results.find((r) => r.applied) || results[0] || opts).languages,
          patchedOpenPages: sum("patchedOpenPages"),
          skippedOpenPages: sum("skippedOpenPages"),
          note,
        }, null, 2),
      }],
    };
  },
};
