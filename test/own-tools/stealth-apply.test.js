const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const tool = require("../../src/own-tools/stealth-apply.js");
const emulate = require("../../src/own-tools/emulate-device.js");

// ─── Execution harness ────────────────────────────────────────────────
// The stealth patches are a string injected into the page, so source regexes
// prove nothing about behaviour. Every behavioural test below EXECUTES the
// exact script the handler hands to addInitScript / page.evaluate inside a
// fresh vm realm ("a document") whose globals mimic Chromium: accessors on
// Navigator.prototype, a NavigatorUAData built the way Chromium builds it,
// an AudioBuffer whose getChannelData returns the SAME live Float32Array on
// every call, WebGL prototypes with native getParameter, etc.

const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36";

// Brave's own (native) client hints on Windows: note the "Brave" brand.
const BRAVE_NATIVE_UAD = {
  brands: [
    { brand: "Brave", version: "127" },
    { brand: "Chromium", version: "127" },
    { brand: "Not)A;Brand", version: "99" },
  ],
  mobile: false,
  platform: "Windows",
  platformVersion: "19.0.0",
  architecture: "x86",
  bitness: "64",
  model: "",
  wow64: false,
};
// What Chromium exposes when the UA is overridden WITHOUT userAgentMetadata:
// navigator.userAgentData still exists but brands are blanked.
const BLANKED_UAD = { brands: [], mobile: false, platform: "" };

const ALL_HINTS = ["architecture", "bitness", "brands", "fullVersionList", "mobile", "model", "platform", "platformVersion", "uaFullVersion", "wow64"];

// Runs INSIDE the vm realm (serialized via toString), so it may only use
// its argument and realm globals.
function installFakeBrowser(opts) {
  var g = globalThis;
  g.window = g;
  g.__nativeQueryCalls = [];
  var permissions = {
    query: function query(p) { g.__nativeQueryCalls.push(p && p.name); return Promise.resolve({ state: "denied" }); },
  };
  function Navigator() {}
  Object.defineProperties(Navigator.prototype, {
    userAgent: { get: function () { return opts.userAgent; }, configurable: true, enumerable: true },
    webdriver: { get: function () { return true; }, configurable: true, enumerable: true },
    languages: { get: function () { return Object.freeze(["en-US"]); }, configurable: true, enumerable: true },
    plugins: { get: function () { return []; }, configurable: true, enumerable: true },
    permissions: { get: function () { return permissions; }, configurable: true, enumerable: true },
  });
  if (opts.uaData) {
    // Chromium builds NavigatorUAData from the (possibly CDP-overridden)
    // UserAgentMetadata: low-entropy getters + getHighEntropyValues.
    var d = opts.uaData;
    var brands = Object.freeze(d.brands.map(function (b) { return Object.freeze({ brand: b.brand, version: b.version }); }));
    function NavigatorUAData() {}
    Object.defineProperties(NavigatorUAData.prototype, {
      brands: { get: function () { return brands; }, configurable: true, enumerable: true },
      mobile: { get: function () { return d.mobile; }, configurable: true, enumerable: true },
      platform: { get: function () { return d.platform; }, configurable: true, enumerable: true },
    });
    NavigatorUAData.prototype.getHighEntropyValues = function getHighEntropyValues(hints) {
      var out = { brands: brands, mobile: d.mobile, platform: d.platform };
      hints.forEach(function (h) { if (h in d) out[h] = d[h]; });
      return Promise.resolve(out);
    };
    var uad = new NavigatorUAData();
    g.__nativeUAD = uad;
    Object.defineProperty(Navigator.prototype, "userAgentData", { get: function () { return uad; }, configurable: true, enumerable: true });
  }
  g.navigator = new Navigator();
  g.Notification = function Notification() {};
  g.Notification.permission = "default";

  function AudioBuffer(o) {
    this._ch = [];
    for (var c = 0; c < o.numberOfChannels; c++) {
      var a = new Float32Array(o.length);
      for (var i = 0; i < a.length; i++) a[i] = Math.sin((i + 1) * (c + 1) / 7) * 0.25;
      this._ch.push(a);
    }
  }
  // Real Chromium returns the same live Float32Array view on every call.
  AudioBuffer.prototype.getChannelData = function getChannelData(ch) {
    if (!(this instanceof AudioBuffer)) throw new TypeError("Illegal invocation");
    var a = this._ch[ch >>> 0];
    if (!a) throw new RangeError("channel index out of range");
    return a;
  };
  AudioBuffer.prototype.copyFromChannel = function copyFromChannel(dest, ch, start) {
    if (!(this instanceof AudioBuffer)) throw new TypeError("Illegal invocation");
    var a = this._ch[ch >>> 0];
    if (!a) throw new RangeError("channel index out of range");
    start = start >>> 0;
    for (var i = 0; i < dest.length && start + i < a.length; i++) dest[i] = a[start + i];
  };
  g.AudioBuffer = AudioBuffer;

  function WebGLRenderingContext() {}
  WebGLRenderingContext.prototype.getParameter = function getParameter(p) { return "native1:" + p; };
  function WebGL2RenderingContext() {}
  WebGL2RenderingContext.prototype.getParameter = function getParameter(p) { return "native2:" + p; };
  g.WebGLRenderingContext = WebGLRenderingContext;
  g.WebGL2RenderingContext = WebGL2RenderingContext;
}

/** A fresh document. `uaData`: object (native hints) or null (insecure context / no UA-CH). */
function makeDoc({ userAgent = WIN_UA, uaData = BRAVE_NATIVE_UAD } = {}) {
  const ctx = vm.createContext({});
  vm.runInContext(`(${installFakeBrowser.toString()})(${JSON.stringify({ userAgent, uaData })})`, ctx);
  return {
    ctx,
    run: (script) => vm.runInContext(script, ctx),
    get: (expr) => vm.runInContext(expr, ctx),
  };
}

// Cross-realm values have foreign prototypes; normalize before deepStrictEqual.
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Records init scripts and returns Playwright-style disposables. */
function initScriptRecorder(disposable) {
  const scripts = [];
  const disposed = [];
  return {
    scripts,
    disposed,
    addInitScript: async (s) => {
      const idx = scripts.push(s) - 1;
      return disposable ? { dispose: async () => { disposed.push(idx); } } : undefined;
    },
  };
}

/** Fake Page (stealth_apply's target, ctx.page); `doc` is its open document. */
function makePage({ disposable = true, doc = null } = {}) {
  return { ...initScriptRecorder(disposable), evaluate: async (s) => (doc ? doc.run(s) : undefined) };
}

/** Fake BrowserContext: in legacy mode the session's whole context is patched. */
function makeContext({ pages = [], disposable = true } = {}) {
  return { ...initScriptRecorder(disposable), pages: () => pages };
}

/** Broker-style registry: connId → [tab pages]; listTabs → [{ tabKey, page }]. */
function tabsRegistry(byConn) {
  return { listTabs: async (connId) => (byConn[connId] || []).map((page, i) => ({ tabKey: i ? `t${i}` : "main", page })) };
}

/** Run a page "load": every still-registered init script, in registration order. */
function loadNewDoc(target, docOpts) {
  const doc = makeDoc(docOpts);
  target.scripts.forEach((s, i) => { if (!target.disposed.includes(i)) doc.run(s); });
  return doc;
}

/** Calls fn with the ctx a handler gets in a broker session whose only tab is `tab`. */
async function withTab(tab, fn) {
  return fn({ page: tab, registry: tabsRegistry({ c1: [tab] }), connId: "c1" });
}

/** Returns the script the handler injects for one fresh tab. */
async function captureScript(args = {}) {
  const tab = makePage();
  await withTab(tab, (ctx) => tool.handler(args, ctx));
  return tab.scripts[0];
}

// ─── Tool shape + handler contract ────────────────────────────────────

test("stealth_apply has required tool shape", () => {
  assert.strictEqual(tool.name, "stealth_apply");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("stealth_apply description stays compact (model-visible catalog weight)", () => {
  // Was ~1.2K chars before W1D; the full coverage list lives in docs/REFERENCE.md.
  assert.ok(tool.description.length <= 600, `description is ${tool.description.length} chars (cap 600)`);
  assert.match(tool.description, /force/);
  assert.match(tool.description, /emulate_device/);
});

// W2D: stealth patches the calling session only. Broker: each of the
// connection's tabs (the shared context holds other sessions' tabs).
// Legacy: the session's whole BrowserContext (registry.sessionContext).
test("W2D: stealth_apply patches every tab of the calling connection — never another connection's tab or the shared context", async () => {
  const docs = [makeDoc(), makeDoc()];
  const [main, t1] = docs.map((doc) => makePage({ doc }));
  const otherDoc = makeDoc();
  const other = makePage({ doc: otherDoc });
  const context = makeContext({ pages: [main, t1, other] });
  const registry = tabsRegistry({ c1: [main, t1], c2: [other] });
  const body = JSON.parse((await tool.handler({ languages: ["fr-FR"] }, { page: main, context, registry, connId: "c1" })).content[0].text);
  assert.deepStrictEqual(body.applied, ["main", "t1"]);
  assert.deepStrictEqual(body.alreadyApplied, []);
  assert.strictEqual(body.patchedOpenPages, 2);
  assert.deepStrictEqual([main.scripts.length, t1.scripts.length], [1, 1], "init script on each tab");
  for (const doc of docs) assert.deepStrictEqual(plain(doc.get("navigator.languages")), ["fr-FR"]);
  assert.strictEqual(context.scripts.length, 0, "nothing registered context-wide");
  assert.strictEqual(other.scripts.length, 0);
  assert.deepStrictEqual(plain(otherDoc.get("navigator.languages")), ["en-US"], "another session's document is untouched");
});

test("W2D: a tab opened after stealth_apply is patched by the next call; patched tabs report alreadyApplied", async () => {
  const tabs = [makePage()];
  const ctx = { registry: tabsRegistry({ c1: tabs }), connId: "c1" };
  await tool.handler({}, ctx);
  tabs.push(makePage());
  const body = JSON.parse((await tool.handler({}, ctx)).content[0].text);
  assert.deepStrictEqual(body.applied, ["t1"]);
  assert.deepStrictEqual(body.alreadyApplied, ["main"]);
  assert.deepStrictEqual(tabs.map((t) => t.scripts.length), [1, 1]);
});

// Spec-review regression: legacy "stealth, then navigate" — upstream opens
// its page AFTER the call, so patching the open tabs alone missed it.
test("W2D legacy: the session's whole BrowserContext is patched, covering pages opened later", async () => {
  const openDoc = makeDoc();
  const context = makeContext({ pages: [makePage({ doc: openDoc })] });
  const registry = { sessionContext: context, listTabs: async () => { throw new Error("not used in legacy"); } };
  const body = JSON.parse((await tool.handler({ languages: ["de-DE"] }, { registry, connId: "legacy" })).content[0].text);
  assert.deepStrictEqual(body.applied, ["all tabs"]);
  assert.strictEqual(body.patchedOpenPages, 1);
  assert.strictEqual(context.scripts.length, 1, "one context init script");
  assert.deepStrictEqual(plain(openDoc.get("navigator.languages")), ["de-DE"]);
  assert.deepStrictEqual(plain(loadNewDoc(context, {}).get("navigator.languages")), ["de-DE"], "a page upstream opens later is patched");
});

test("W2D: every tab of this browser gets the same audio perturbation (like one real device)", async () => {
  const a = makePage();
  const b = makePage();
  await withTab(a, (ctx) => tool.handler({}, ctx));
  await withTab(b, (ctx) => tool.handler({}, ctx));
  const read = (tab) => Array.from(loadNewDoc(tab, {}).get("new AudioBuffer({ numberOfChannels: 1, length: 800 }).getChannelData(0)"));
  assert.notDeepStrictEqual(read(a), read(makePage()), "the tab's audio is perturbed");
  assert.deepStrictEqual(read(b), read(a));
});

// T0-4 + T1-7: idempotent per tab — second call without force no-ops.
test("T0-4/T1-7: stealth_apply is idempotent per tab (second call no-ops)", async () => {
  const tab = makePage();
  await withTab(tab, async (ctx) => {
    const r1 = await tool.handler({ languages: ["en-US", "en"] }, ctx);
    const r2 = await tool.handler({ languages: ["fr-FR", "fr"] }, ctx);
    assert.strictEqual(r1.isError, undefined, "first call must not error");
    assert.strictEqual(r2.isError, undefined, "second call must not error");
    assert.strictEqual(tab.scripts.length, 1, "addInitScript called ONCE — second call must be no-op (T1-7)");
    const r2Body = JSON.parse(r2.content[0].text);
    assert.deepStrictEqual(r2Body.alreadyApplied, ["main"]);
    assert.deepStrictEqual(r2Body.applied, []);
    assert.deepStrictEqual(r2Body.languages, ["en-US", "en"]);
  });
});

test("T1-7: force=true registers a new init script and reports the new languages", async () => {
  // Older playwright-core: addInitScript returns nothing disposable.
  const tab = makePage({ disposable: false });
  await withTab(tab, async (ctx) => {
    await tool.handler({ languages: ["en-US"] }, ctx);
    const r2 = await tool.handler({ languages: ["fr-FR"], force: true }, ctx);
    assert.strictEqual(tab.scripts.length, 2, "force=true must register a new init script");
    const r2Body = JSON.parse(r2.content[0].text);
    assert.deepStrictEqual(r2Body.applied, ["main"]);
    assert.deepStrictEqual(r2Body.languages, ["fr-FR"]);
  });
});

test("handler injects syntactically valid JS that runs cleanly in a bare realm (no browser globals)", async () => {
  const script = await captureScript({ languages: ["en-US"] });
  assert.doesNotThrow(() => new Function(script), "stealth script must parse");
  // Every patch block is try-guarded: a window with none of the patched
  // APIs (no navigator, no AudioBuffer, no WebGL) must not throw.
  const bare = vm.createContext({});
  vm.runInContext("this.window = this;", bare);
  assert.doesNotThrow(() => vm.runInContext(script, bare));
});

// ─── W1D-1: force:true must actually take effect ──────────────────────

test("W1D-1: force re-apply changes navigator.languages on NEW documents (both scripts registered)", async () => {
  const tab = makePage({ disposable: false }); // worst case: old script can't be removed
  await withTab(tab, async (ctx) => {
    await tool.handler({ languages: ["en-US", "en"] }, ctx);
    await tool.handler({ languages: ["fr-FR", "fr"], force: true }, ctx);
  });
  const doc = loadNewDoc(tab, {});
  assert.deepStrictEqual(plain(doc.get("navigator.languages")), ["fr-FR", "fr"],
    "the newer apply must win even though the older init script runs first on every load");
});

test("W1D-1: force re-apply is order-independent (newer generation wins even if it runs first)", async () => {
  const tab = makePage({ disposable: false });
  await withTab(tab, async (ctx) => {
    await tool.handler({ languages: ["en-US"] }, ctx);
    await tool.handler({ languages: ["de-DE"], force: true }, ctx);
  });
  const doc = makeDoc();
  doc.run(tab.scripts[1]);
  doc.run(tab.scripts[0]);
  assert.deepStrictEqual(plain(doc.get("navigator.languages")), ["de-DE"]);
});

test("W1D-1: force re-apply updates ALREADY-OPEN pages (page.evaluate path)", async () => {
  const doc = makeDoc();
  const tab = makePage({ doc });
  await withTab(tab, async (ctx) => {
    const r1 = JSON.parse((await tool.handler({ languages: ["en-US"] }, ctx)).content[0].text);
    assert.strictEqual(r1.patchedOpenPages, 1);
    assert.deepStrictEqual(plain(doc.get("navigator.languages")), ["en-US"]);
    await tool.handler({ languages: ["ja-JP", "ja"], force: true }, ctx);
  });
  assert.deepStrictEqual(plain(doc.get("navigator.languages")), ["ja-JP", "ja"],
    "open page must reflect the forced languages, not stay on the first apply");
});

test("W1D-1: force re-apply retires the previous init script when Playwright returns a disposable", async () => {
  const tab = makePage({ disposable: true });
  await withTab(tab, async (ctx) => {
    await tool.handler({ languages: ["en-US"] }, ctx);
    await tool.handler({ languages: ["fr-FR"], force: true }, ctx);
    await tool.handler({ languages: ["es-ES"], force: true }, ctx);
  });
  assert.deepStrictEqual(tab.disposed, [0, 1], "each force must dispose the script it replaces (no accumulation)");
  const doc = loadNewDoc(tab, {});
  assert.deepStrictEqual(plain(doc.get("navigator.languages")), ["es-ES"]);
});

test("W1D-1: re-running the script on one document never chains permissions.query", async () => {
  const tab = makePage({ disposable: false });
  await withTab(tab, async (ctx) => {
    await tool.handler({ languages: ["en-US"] }, ctx);
    await tool.handler({ languages: ["fr-FR"], force: true }, ctx);
  });
  const doc = loadNewDoc(tab, {});
  doc.run(tab.scripts[1]); // e.g. page.evaluate on an open page after the init scripts
  await doc.get("navigator.permissions.query({ name: 'x-unknown' })");
  assert.deepStrictEqual(plain(doc.get("__nativeQueryCalls")), ["x-unknown"], "native query must be hit exactly once");
});

// ─── W1D-2: audio perturbation is stable and never accumulates ───────

test("W1D-2 review V1-1: a valueOf-shifting channel argument cannot re-perturb a channel", async () => {
  const script = await captureScript();
  const ref = makeDoc();
  ref.run(script);
  const once0 = Array.from(ref.get("new AudioBuffer({ numberOfChannels: 2, length: 1000 }).getChannelData(0)"));
  const doc = makeDoc();
  doc.run(script);
  doc.run("var __b = new AudioBuffer({ numberOfChannels: 2, length: 1000 }); var __k = 0;" +
    "var __c = { valueOf: function () { return __k++ ? 1 : 0; } }; __b.getChannelData(__c);");
  assert.strictEqual(doc.get("__k"), 1, "channel argument converted exactly once");
  assert.deepStrictEqual(Array.from(doc.get("__b.getChannelData(0)")), once0, "channel 0 perturbed exactly once");
});

test("W1D-2 review V2-1: copyFromChannel sees the same jitter and reads never change the buffer", async () => {
  const script = await captureScript();
  const doc = makeDoc();
  const original = Array.from(doc.get("new AudioBuffer({ numberOfChannels: 1, length: 500 }).getChannelData(0)"));
  doc.run(script);
  doc.run("var __b = new AudioBuffer({ numberOfChannels: 1, length: 500 });" +
    "var __d1 = new Float32Array(500); __b.copyFromChannel(__d1, 0);" +
    "var __g = Array.from(__b.getChannelData(0));" +
    "var __d2 = new Float32Array(500); __b.copyFromChannel(__d2, 0, 0);");
  const d1 = Array.from(doc.get("__d1"));
  assert.deepStrictEqual(Array.from(doc.get("__d2")), d1, "second copy equals first copy");
  assert.deepStrictEqual(Array.from(doc.get("__g")), d1, "getChannelData agrees with copyFromChannel");
  assert.notDeepStrictEqual(d1, original, "copyFromChannel output is perturbed too");
});

test("W1D-2: getChannelData returns the same values on every call (no cumulative drift)", async () => {
  const script = await captureScript();
  const doc = makeDoc();
  const original = Array.from(doc.get("new AudioBuffer({ numberOfChannels: 1, length: 1000 }).getChannelData(0)"));
  doc.run(script);
  doc.run("var __b = new AudioBuffer({ numberOfChannels: 1, length: 1000 });");
  const first = Array.from(doc.get("__b.getChannelData(0)"));
  const second = Array.from(doc.get("__b.getChannelData(0)"));
  const third = Array.from(doc.get("__b.getChannelData(0)"));
  assert.deepStrictEqual(second, first, "second read must equal first read");
  assert.deepStrictEqual(third, first, "third read must equal first read");
  assert.notDeepStrictEqual(first, original, "the perturbation must still change the fingerprint");
  const changed = first.filter((v, i) => v !== original[i]).length;
  assert.ok(changed > 0 && changed <= 10, `perturbation should touch a sparse set of samples, touched ${changed}`);
  assert.ok(first.every((v, i) => Math.abs(v - original[i]) < 1e-6), "perturbation must stay imperceptible");
});

test("W1D-2: each channel and each buffer is perturbed exactly once", async () => {
  const script = await captureScript();
  const mk = "new AudioBuffer({ numberOfChannels: 2, length: 500 })";
  // Reference: one read per channel on a fresh document with the same script.
  const ref = makeDoc();
  ref.run(script);
  ref.run(`var __r = ${mk};`);
  const once0 = Array.from(ref.get("__r.getChannelData(0)"));
  const once1 = Array.from(ref.get("__r.getChannelData(1)"));
  const orig0 = Array.from(makeDoc().get(`${mk}.getChannelData(0)`));
  assert.notDeepStrictEqual(once0, orig0, "first read must be perturbed");

  const doc = makeDoc();
  doc.run(script);
  doc.run(`var __a = ${mk}; var __b = ${mk};`);
  // Interleave reads across channels and buffers; repeated reads must not re-apply the seed.
  doc.run("__a.getChannelData(1); __b.getChannelData(0); __a.getChannelData(0); __a.getChannelData(1); __b.getChannelData(0);");
  assert.deepStrictEqual(Array.from(doc.get("__a.getChannelData(0)")), once0);
  assert.deepStrictEqual(Array.from(doc.get("__a.getChannelData(1)")), once1);
  assert.deepStrictEqual(Array.from(doc.get("__b.getChannelData(0)")), once0, "same waveform in another buffer → same output");
  assert.deepStrictEqual(Array.from(doc.get("__b.getChannelData(1)")), once1);
});

test("W1D-2: concurrent first calls register ONE init script (one audio seed per session)", async () => {
  const tab = makePage();
  await withTab(tab, (ctx) => Promise.all([tool.handler({}, ctx), tool.handler({}, ctx)]));
  assert.strictEqual(tab.scripts.length, 1);
});

test("W1D-2: a failed addInitScript releases the tab so a retry can apply", async () => {
  const tab = makePage();
  const realAdd = tab.addInitScript;
  tab.addInitScript = async () => { throw new Error("Target closed"); };
  await withTab(tab, async (ctx) => {
    await assert.rejects(tool.handler({}, ctx), /Target closed/);
    tab.addInitScript = realAdd;
    const body = JSON.parse((await tool.handler({ languages: ["en-US"] }, ctx)).content[0].text);
    assert.deepStrictEqual(body.applied, ["main"], "retry must apply, not report alreadyApplied");
  });
  assert.strictEqual(tab.scripts.length, 1);
});

test("W1D-2: the audio perturbation is identical across documents in one session", async () => {
  const tab = makePage();
  await withTab(tab, (ctx) => tool.handler({}, ctx));
  const read = (doc) => Array.from(doc.get("new AudioBuffer({ numberOfChannels: 1, length: 800 }).getChannelData(0)"));
  const docA = loadNewDoc(tab, {});
  const docB = loadNewDoc(tab, {});
  assert.deepStrictEqual(read(docB), read(docA), "a per-page random seed is its own tell — must be per-session");
});

test("W1D-2: force re-apply keeps the session's audio seed", async () => {
  const tab = makePage({ disposable: true });
  await withTab(tab, async (ctx) => {
    await tool.handler({ languages: ["en-US"] }, ctx);
    const before = Array.from(loadNewDoc(tab, {}).get("new AudioBuffer({ numberOfChannels: 1, length: 800 }).getChannelData(0)"));
    await tool.handler({ languages: ["fr-FR"], force: true }, ctx);
    const after = Array.from(loadNewDoc(tab, {}).get("new AudioBuffer({ numberOfChannels: 1, length: 800 }).getChannelData(0)"));
    assert.deepStrictEqual(after, before);
  });
});

// ─── W1D-3: client hints — JS side agrees with HTTP side, native kept ─

async function highEntropy(doc) {
  return plain(await doc.get(`navigator.userAgentData.getHighEntropyValues(${JSON.stringify(ALL_HINTS)})`));
}

test("W1D-3: Brave's native navigator.userAgentData is left alone when no UA override is active", async () => {
  const script = await captureScript();
  const doc = makeDoc({ userAgent: WIN_UA, uaData: BRAVE_NATIVE_UAD });
  doc.run(script);
  assert.strictEqual(doc.get("navigator.userAgentData === __nativeUAD"), true, "native object must not be replaced");
  assert.ok(plain(doc.get("navigator.userAgentData.brands")).some((b) => b.brand === "Brave"),
    "the Brave brand must survive (HTTP Sec-CH-UA still carries it)");
  assert.strictEqual(doc.get("Object.getOwnPropertyDescriptor(navigator, 'userAgentData')"), undefined,
    "no own-property shadow on navigator");
});

test("W1D-3: emulate_device's metadata (which Chromium also exposes to JS) is kept as-is", async () => {
  for (const ua of [WIN_UA, MAC_UA, ANDROID_UA]) {
    const http = plain(emulate.synthesizeUserAgentMetadata(ua)); // what emulate_device sends over CDP
    const script = await captureScript();
    const doc = makeDoc({ userAgent: ua, uaData: http });
    doc.run(script);
    assert.strictEqual(doc.get("navigator.userAgentData === __nativeUAD"), true, `kept native for ${ua}`);
  }
});

test("W1D-3: when a UA override blanked the hints, the synthesized JS hints equal emulate_device's HTTP hints", async () => {
  for (const ua of [WIN_UA, MAC_UA, ANDROID_UA]) {
    const http = plain(emulate.synthesizeUserAgentMetadata(ua));
    const script = await captureScript();
    const doc = makeDoc({ userAgent: ua, uaData: BLANKED_UAD });
    doc.run(script);
    const js = await highEntropy(doc);
    for (const k of ["brands", "fullVersionList", "platform", "platformVersion", "architecture", "bitness", "model", "mobile", "wow64"]) {
      assert.deepStrictEqual(js[k], http[k], `${k} disagrees between JS and HTTP for ${ua}`);
    }
    assert.strictEqual(doc.get("navigator.userAgentData.platform"), http.platform);
    assert.strictEqual(doc.get("navigator.userAgentData.mobile"), http.mobile);
    assert.strictEqual(js.uaFullVersion, http.fullVersionList.find((b) => b.brand === "Chromium").version);
  }
});

test("W1D-3: userAgentData is not invented where the browser exposes none (insecure context)", async () => {
  const script = await captureScript();
  const doc = makeDoc({ uaData: null });
  doc.run(script);
  assert.strictEqual(doc.get("typeof navigator.userAgentData"), "undefined");
});

test("W1D-3: stale native hints that contradict the UA are replaced", async () => {
  const script = await captureScript();
  // UA says Android, hints still say Windows (override from a tool that sent mismatched metadata).
  const doc = makeDoc({ userAgent: ANDROID_UA, uaData: BRAVE_NATIVE_UAD });
  doc.run(script);
  assert.strictEqual(doc.get("navigator.userAgentData.platform"), "Android");
  assert.strictEqual(doc.get("navigator.userAgentData.mobile"), true);
});

// ─── Characterization: the rest of the patch set, executed ───────────

test("patches: webdriver, plugins, languages, chrome runtime", async () => {
  const script = await captureScript({ languages: ["en-GB", "en"] });
  const doc = makeDoc();
  assert.strictEqual(doc.get("navigator.webdriver"), true, "fake starts as automation-flagged");
  doc.run(script);
  assert.strictEqual(doc.get("navigator.webdriver"), undefined);
  assert.strictEqual(doc.get("navigator.plugins.length"), 3);
  assert.deepStrictEqual(plain(doc.get("navigator.languages")), ["en-GB", "en"]);
  assert.strictEqual(doc.get("navigator.languages === navigator.languages"), true, "stable identity like a FrozenArray");
  assert.strictEqual(doc.get("Object.isFrozen(navigator.languages)"), true);
  assert.strictEqual(doc.get("typeof chrome.loadTimes().requestTime"), "number");
  assert.strictEqual(doc.get("typeof chrome.csi().pageT"), "number");
  assert.strictEqual(doc.get("chrome.app.InstallState.INSTALLED"), "installed");
  assert.strictEqual(doc.get("chrome.app.getIsInstalled()"), false);
});

test("patches: permissions.query overrides + passthrough", async () => {
  const script = await captureScript();
  const doc = makeDoc();
  doc.run(script);
  assert.strictEqual((await doc.get("navigator.permissions.query({ name: 'notifications' })")).state, "default");
  assert.strictEqual((await doc.get("navigator.permissions.query({ name: 'geolocation' })")).state, "prompt");
  assert.strictEqual((await doc.get("navigator.permissions.query({ name: 'clipboard-write' })")).state, "granted");
  for (const name of ["clipboard-read", "camera", "microphone", "midi", "push"]) {
    assert.strictEqual((await doc.get(`navigator.permissions.query({ name: '${name}' })`)).state, "prompt", name);
  }
  assert.strictEqual((await doc.get("navigator.permissions.query({ name: 'x-other' })")).state, "denied", "unknown names pass through");
  assert.deepStrictEqual(plain(doc.get("__nativeQueryCalls")), ["x-other"]);
});

test("patches: WebGL vendor/renderer follow the UA platform on WebGL1 + WebGL2, other params pass through", async () => {
  const script = await captureScript();
  const win = makeDoc({ userAgent: WIN_UA });
  win.run(script);
  assert.strictEqual(win.get("WebGLRenderingContext.prototype.getParameter.call(new WebGLRenderingContext(), 0x9245)"), "Google Inc. (Intel)");
  assert.match(win.get("WebGL2RenderingContext.prototype.getParameter.call(new WebGL2RenderingContext(), 0x9246)"), /Direct3D11/);
  assert.strictEqual(win.get("new WebGLRenderingContext().getParameter(7936)"), "native1:7936");
  assert.strictEqual(win.get("new WebGL2RenderingContext().getParameter(7936)"), "native2:7936");
  const mac = makeDoc({ userAgent: MAC_UA, uaData: BLANKED_UAD });
  mac.run(script);
  assert.match(mac.get("new WebGLRenderingContext().getParameter(0x9246)"), /Apple M1/);
});

test("patches: patched functions report native-looking toString", async () => {
  const script = await captureScript();
  const doc = makeDoc();
  doc.run(script);
  assert.strictEqual(doc.get("Object.getOwnPropertyDescriptor(navigator, 'webdriver').get.toString()"), "function get webdriver() { [native code] }");
  assert.strictEqual(doc.get("navigator.permissions.query.toString()"), "function query() { [native code] }");
  assert.strictEqual(doc.get("AudioBuffer.prototype.getChannelData.toString()"), "function getChannelData() { [native code] }");
  assert.strictEqual(doc.get("WebGLRenderingContext.prototype.getParameter.toString()"), "function getParameter() { [native code] }");
});
