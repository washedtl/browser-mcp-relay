const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/stealth-apply.js");

test("stealth_apply has required tool shape", () => {
  assert.strictEqual(tool.name, "stealth_apply");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("stealth_apply returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({});
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// V1-6 + T0-4 + T1-7: stealth_apply is now idempotent per context. First call
// installs the init script; second call no-ops with alreadyApplied:true; only
// `force: true` re-applies. Previously, repeat calls accumulated init scripts
// AND chained `navigator.permissions.query` recursively (each call's monkey-
// patch wrapped the previous override).
test("T0-4/T1-7: stealth_apply is idempotent per context (second call no-ops)", async () => {
  const prev = globalThis.__relayBridge;
  // Fresh WeakMap per test by getting a fresh context each time.
  tool._APPLIED_CONTEXTS && (() => {})(); // (sanity — _APPLIED_CONTEXTS exists for inspection)
  const initScripts = [];
  const fakeContext = {
    addInitScript: async (s) => { initScripts.push(s); },
    pages: () => [],
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const r1 = await tool.handler({ languages: ["en-US", "en"] });
    const r2 = await tool.handler({ languages: ["fr-FR", "fr"] });
    assert.strictEqual(r1.isError, undefined, "first call must not error");
    assert.strictEqual(r2.isError, undefined, "second call must not error");
    assert.strictEqual(initScripts.length, 1, "addInitScript called ONCE — second call must be no-op (T1-7)");
    const r2Body = JSON.parse(r2.content[0].text);
    assert.strictEqual(r2Body.alreadyApplied, true, "second call must report alreadyApplied=true");
    assert.strictEqual(r2Body.applied, false, "second call must report applied=false");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T1-7: stealth_apply with force=true re-applies even if already applied", async () => {
  const prev = globalThis.__relayBridge;
  const initScripts = [];
  const fakeContext = {
    addInitScript: async (s) => { initScripts.push(s); },
    pages: () => [],
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    await tool.handler({ languages: ["en-US"] });
    const r2 = await tool.handler({ languages: ["fr-FR"], force: true });
    assert.strictEqual(initScripts.length, 2, "force=true must re-add the init script");
    const r2Body = JSON.parse(r2.content[0].text);
    assert.strictEqual(r2Body.applied, true);
    assert.deepStrictEqual(r2Body.languages, ["fr-FR"]);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T0-4: stealth script has window.__relayStealthApplied sentinel for page-level idempotency", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  // The script must start with the sentinel guard so a re-run on the same
  // page short-circuits before re-monkey-patching navigator.permissions.query.
  assert.ok(/window\.__relayStealthApplied/.test(src),
    "stealth script must include window.__relayStealthApplied sentinel");
  assert.ok(/if\s*\(\s*window\.__relayStealthApplied\s*\)\s*return/.test(src),
    "stealth script must early-return when sentinel set");
});

test("V1-6: stealth script source guards each defineProperty in try/catch", () => {
  // Source-level guard against reverting to the unguarded form. Each
  // defineProperty must be inside its own try {…} catch block so a
  // second-run redefinition is a no-op rather than throwing the whole
  // script down.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  // Find each Object.defineProperty(navigator, ...) and confirm it sits
  // inside an open `try {` that hasn't been closed by `} catch` yet.
  // We scan backward up to 50 lines (the userAgentData synthesis block is
  // long because it builds a full NavigatorUAData literal). Bail when we
  // see `} catch` (means we're past the end of a previous try block) OR
  // when we find the enclosing `try {`.
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/Object\.defineProperty\(navigator/.test(lines[i])) continue;
    let inTry = false;
    for (let j = i; j >= Math.max(0, i - 50); j--) {
      if (/\}\s*catch\b/.test(lines[j]) && j !== i) break;
      if (/\btry\s*\{/.test(lines[j])) { inTry = true; break; }
    }
    assert.ok(inTry,
      `defineProperty(navigator,...) at line ${i + 1} must be inside a try {}: ${lines[i].trim()}`);
  }
});

// Sanity: the stealth script string itself, evaluated in a clean realm,
// must not throw when run twice. We can't run actual page JS, but we can
// extract the script body and verify it parses + the try/catch guards work
// on a normal Node.js global (where navigator doesn't exist) — the catch
// blocks should silently swallow the absent-navigator errors.
test("V1-6: stealth script source has try/catch guards on every patch block", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  // Count try/catch blocks inside the stealthScript template literal.
  const scriptStart = src.indexOf("const stealthScript = `");
  const scriptEnd = src.indexOf("`;", scriptStart + 1);
  assert.ok(scriptStart >= 0 && scriptEnd > scriptStart, "stealthScript template literal must exist");
  const scriptBody = src.slice(scriptStart, scriptEnd);
  const tryCount = (scriptBody.match(/\btry\s*\{/g) || []).length;
  // 7 guards now: T0 (webdriver / plugins / languages / permissions /
  // chrome runtime) + T1-A (userAgentData) + T1-C (AudioBuffer
  // getChannelData). T1-B toString defense is a helper used WITHIN those
  // try blocks, not its own.
  assert.ok(tryCount >= 7,
    `expected >=7 try blocks in stealthScript (5 T0 + T1-A + T1-C), got ${tryCount}`);
});

// ─── Tier 1 (v0.3.4) — new patches ───

test("T1-A: stealth script synthesizes navigator.userAgentData from current UA", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  // The userAgentData synthesis must:
  //  1. Read navigator.userAgent at runtime (so it tracks emulate_device)
  //  2. Produce { brands, mobile, platform, getHighEntropyValues, toJSON }
  //  3. Wrap in defineProperty so it overrides any existing userAgentData
  assert.ok(/navigator\.userAgent/.test(src),
    "must read navigator.userAgent at runtime");
  assert.ok(/Object\.defineProperty\(navigator,\s*['"]userAgentData['"]/.test(src),
    "must defineProperty(navigator, 'userAgentData')");
  assert.ok(/getHighEntropyValues/.test(src),
    "must expose getHighEntropyValues");
  assert.ok(/brands/.test(src) && /platform/.test(src) && /mobile/.test(src),
    "must expose brands + platform + mobile fields");
  assert.ok(/Chromium/.test(src),
    "Chromium brand must appear in synthesized brands list");
});

test("T1-B: stealth script installs toString defense on patched getters", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  // Helper must exist + be applied to the patched getters.
  assert.ok(/function nativeLike\b|nativeLike\(/.test(src),
    "must define + use nativeLike helper");
  // The native-string template must include "[native code]".
  assert.ok(/\[native code\]/.test(src),
    "toString defense must produce '[native code]' marker");
  // Verify nativeLike is applied to the patched getters by name.
  assert.ok(/nativeLike\([\s\S]{0,200}'get webdriver'/.test(src),
    "webdriver getter must use nativeLike");
  assert.ok(/nativeLike\([\s\S]{0,200}'get plugins'/.test(src),
    "plugins getter must use nativeLike");
  assert.ok(/nativeLike\([\s\S]{0,200}'get languages'/.test(src),
    "languages getter must use nativeLike");
  assert.ok(/nativeLike\([\s\S]{0,300}'get userAgentData'/.test(src),
    "userAgentData getter must use nativeLike");
});

test("T1-C: stealth script stabilizes AudioBuffer.getChannelData fingerprint with per-session seed", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  assert.ok(/AudioBuffer\.prototype\.getChannelData/.test(src),
    "must override AudioBuffer.prototype.getChannelData");
  // Must use a per-session seed (window.__relayAudioSeed) — NOT random per
  // call (which would be its OWN tell — real fingerprints are stable).
  assert.ok(/__relayAudioSeed/.test(src),
    "must use a per-session seed (window.__relayAudioSeed), not random per-call");
  // Seed must be in the floating-point error band so it's imperceptible.
  assert.ok(/1e-7/.test(src),
    "seed magnitude must be <= 1e-7 (imperceptible jitter)");
});

test("T1: handler runs with new patches without throwing", async () => {
  // Smoke-test the actual handler with all the new patches in place. We
  // want to confirm the stringified script doesn't have a syntax bug that
  // only manifests at addInitScript time.
  const prev = globalThis.__relayBridge;
  let scriptSeen = null;
  const fakeContext = {
    addInitScript: async (s) => { scriptSeen = s; },
    pages: () => [],
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    const r = await tool.handler({ languages: ["en-US", "en"] });
    assert.strictEqual(r.isError, undefined, "handler must not error");
    assert.ok(scriptSeen, "addInitScript must have been called");
    // Confirm the script contains all 3 Tier-1 patches.
    assert.ok(/userAgentData/.test(scriptSeen), "script must include userAgentData patch");
    assert.ok(/getChannelData/.test(scriptSeen), "script must include getChannelData patch");
    assert.ok(/\[native code\]/.test(scriptSeen), "script must include toString defense");
    // Confirm the script PARSES as valid JS by Function-constructing it.
    // (Node's parser throws on syntax errors.)
    assert.doesNotThrow(() => new Function(scriptSeen),
      "stealth script must be syntactically valid JS");
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ─── Tier 2 (v0.3.5) — additional patches ───

test("T2-B: stealth script populates window.chrome with loadTimes / csi / app", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  // chrome.loadTimes — must return an object with timing fields.
  assert.ok(/window\.chrome\.loadTimes\s*=/.test(src),
    "must populate window.chrome.loadTimes");
  assert.ok(/requestTime[\s\S]*startLoadTime/.test(src),
    "loadTimes must return realistic timing fields");
  assert.ok(/connectionInfo/.test(src),
    "loadTimes must include connectionInfo (real Chrome ships it)");
  // chrome.csi — Client-Side Instrumentation timing.
  assert.ok(/window\.chrome\.csi\s*=/.test(src),
    "must populate window.chrome.csi");
  assert.ok(/onloadT[\s\S]*pageT/.test(src),
    "csi must return onloadT + pageT fields");
  // chrome.app — installation/runtime state namespace.
  assert.ok(/window\.chrome\.app\s*=/.test(src),
    "must populate window.chrome.app");
  assert.ok(/InstallState[\s\S]*RunningState/.test(src),
    "chrome.app must include InstallState + RunningState constants");
  assert.ok(/getDetails[\s\S]*getIsInstalled/.test(src),
    "chrome.app must include getDetails + getIsInstalled methods");
});

test("T2-C: stealth script overrides multiple permission types beyond notifications", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  // PERMISSION_OVERRIDES map must cover the canonical bot-detection probes.
  const REQUIRED_PERMISSIONS = [
    "geolocation",
    "clipboard-read",
    "clipboard-write",
    "camera",
    "microphone",
    "midi",
    "push",
  ];
  for (const p of REQUIRED_PERMISSIONS) {
    assert.ok(new RegExp(`['"]${p}['"]`).test(src),
      `PERMISSION_OVERRIDES must include '${p}'`);
  }
  // Map must be consulted inside the patched query function.
  assert.ok(/PERMISSION_OVERRIDES\b/.test(src),
    "permissions.query patch must consult PERMISSION_OVERRIDES");
  // Notifications must STILL be handled separately (its state is dynamic
  // based on Notification.permission, not a static map value).
  assert.ok(/params\.name === ['"]notifications['"]/.test(src),
    "notifications must still be handled via dynamic Notification.permission lookup");
});

test("T2-D: stealth script overrides WebGL renderer + vendor on both WebGL1 and WebGL2", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "stealth-apply.js"),
    "utf8",
  );
  // The two debug-renderer-info constants.
  assert.ok(/0x9245/.test(src),
    "must reference UNMASKED_VENDOR_WEBGL constant (0x9245)");
  assert.ok(/0x9246/.test(src),
    "must reference UNMASKED_RENDERER_WEBGL constant (0x9246)");
  // Both WebGL1 and WebGL2 prototypes must be patched (WebGL2 has its own
  // getParameter — patching only WebGL1 leaves WebGL2 callers exposed).
  assert.ok(/WebGLRenderingContext\.prototype\.getParameter\s*=/.test(src),
    "must patch WebGLRenderingContext.prototype.getParameter");
  assert.ok(/WebGL2RenderingContext\.prototype\.getParameter\s*=/.test(src),
    "must patch WebGL2RenderingContext.prototype.getParameter (WebGL2 has its own getParameter)");
  // GPU string selection must be UA-aware (per docs/BACKLOG.md: mismatched
  // UA + GPU = instant flag).
  assert.ok(/Macintosh/.test(src) && /Linux/.test(src) && /Android/.test(src),
    "GPU string selection must branch on UA platform (Macintosh / Linux / Android / Windows)");
});

// T2-A is in emulate-device.js — its tests live in test/own-tools/emulate-device.test.js.

// ─── Sanity: full handler still ships valid JS with Tier 2 patches ───

test("T2: handler still ships valid JS after Tier 2 additions", async () => {
  const prev = globalThis.__relayBridge;
  let scriptSeen = null;
  const fakeContext = {
    addInitScript: async (s) => { scriptSeen = s; },
    pages: () => [],
  };
  globalThis.__relayBridge = { context: fakeContext };
  try {
    await tool.handler({ languages: ["en-US"] });
    // T2 markers — must all be present.
    assert.ok(/loadTimes/.test(scriptSeen), "T2-B loadTimes patch missing");
    assert.ok(/PERMISSION_OVERRIDES/.test(scriptSeen), "T2-C permissions map missing");
    assert.ok(/UNMASKED_VENDOR_WEBGL|0x9245/.test(scriptSeen), "T2-D WebGL patch missing");
    assert.doesNotThrow(() => new Function(scriptSeen),
      "stealth script with Tier 2 patches must be syntactically valid JS");
  } finally {
    globalThis.__relayBridge = prev;
  }
});
