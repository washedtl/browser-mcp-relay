const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/lighthouse-audit.js");

test("lighthouse_audit has required tool shape", () => {
  assert.strictEqual(tool.name, "lighthouse_audit");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.strictEqual(tool.inputSchema.required[0], "url");
});

// W2D: lighthouse opens its own tab over CDP, so it needs the endpoint,
// not a session page (needsPage:false — no tab is opened for the call).
test("W2D: lighthouse_audit is page-less and needs ctx.cdpUrl", async () => {
  assert.strictEqual(tool.needsPage, false);
  const result = await tool.handler({ url: "https://example.com" }, {});
  assert.strictEqual(result.isError, true);
  assert.match(result.content[0].text, /^lighthouse_audit unavailable: no browser CDP endpoint/);
});

const CTX = { cdpUrl: "http://127.0.0.1:9333" };

test("audits run one at a time across sessions, and a failed one doesn't block the next", async (t) => {
  // Lighthouse keeps process-global state: measured, a second concurrent audit fails with
  // 'The "start lh:runner:gather" performance mark has not been set'.
  let running = 0, peak = 0, calls = 0;
  tool._setLighthouseForTest({
    desktopConfig: {},
    default: async () => {
      calls++;
      const n = calls;
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      if (n === 2) throw new Error("boom");
      return { lhr: { categories: {}, finalUrl: "https://a.example/", fetchTime: "t" } };
    },
  });
  tool._setPuppeteerForTest({ connect: async () => ({ newPage: async () => ({ close: async () => {} }), disconnect: async () => {} }) });
  t.after(() => { tool._setLighthouseForTest(null); tool._setPuppeteerForTest(null); });
  const ctx = { cdpUrl: "ws://127.0.0.1:1/secret/devtools/browser" };
  const results = await Promise.all([1, 2, 3].map(() => tool.handler({ url: "https://a.example/" }, ctx)));
  assert.strictEqual(peak, 1, "never two at once");
  assert.deepStrictEqual(results.map((r) => !!r.isError), [false, true, false]);
});

// ──────────────────────────────────────────────────────────────────
// T0-6: bad URL / dead Brave must return structured isError, not throw.
// T1-1: lighthouse import is memoized (lazy + cached).
// ──────────────────────────────────────────────────────────────────

test("T0-6: lighthouse_audit rejects malformed URL with isError", async () => {
  const r = await tool.handler({ url: "not-a-url" }, CTX);
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /invalid URL/i);
});

test("T0-6: lighthouse_audit rejects empty url string", async () => {
  const r = await tool.handler({ url: "" }, CTX);
  assert.strictEqual(r.isError, true);
  assert.match(r.content[0].text, /non-empty string/i);
});

test("T1-1: lighthouse import is hoisted as a memoized lazy promise (source-level guard)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "lighthouse-audit.js"),
    "utf8",
  );
  // The memoization variable + helper must exist at module scope.
  assert.ok(/let\s+_lhPromise\s*=\s*null/.test(src),
    "expected `let _lhPromise = null` module-scope memoization");
  assert.ok(/function\s+getLighthouse\s*\(/.test(src),
    "expected getLighthouse() helper");
  // The handler must NOT do `await import("lighthouse")` directly anymore —
  // it must go through the memoized helper.
  // (Allow it inside the helper itself; only check the handler uses getLighthouse.)
  assert.ok(/await\s+getLighthouse\(\)/.test(src),
    "handler must call await getLighthouse() — direct await import would defeat memoization");
});

test("T0-6: lighthouse_audit catches lighthouse() throws and returns isError", async () => {
  // We can't easily mock the import inside this single-file test without
  // require.cache shenanigans, but we can verify the source has the wrapper.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "lighthouse-audit.js"),
    "utf8",
  );
  // The lighthouse() call must be inside a try/catch.
  // Match `try { ... result = await oneAuditAtATime(... lighthouse(... } catch`.
  assert.ok(
    /try\s*\{[\s\S]*?result\s*=\s*await\s+oneAuditAtATime\([\s\S]*?lighthouse\([\s\S]*?\}\s*catch\s*\(/m.test(src),
    "lighthouse() call must be wrapped in try/catch",
  );
});

// ──────────────────────────────────────────────────────────────────
// W1C2: desktop runs use Lighthouse's desktop config (desktop throttling +
// desktop UA). Passing only formFactor/screenEmulation flags kept the default
// config's mobileSlow4G throttling and Moto G UA.
// ──────────────────────────────────────────────────────────────────

function fakeLighthouseModule(result) {
  const calls = [];
  const desktopConfig = { extends: "lighthouse:default", settings: { formFactor: "desktop" } };
  const run = async (url, flags, config) => {
    calls.push({ url, flags, config });
    if (result !== undefined) return result;
    return { lhr: { categories: { performance: { score: 0.9, title: "Performance" } }, finalUrl: url, fetchTime: "t" } };
  };
  return { mod: { default: run, desktopConfig }, calls, desktopConfig };
}

async function withFakes({ fetchImpl, result }, fn) {
  const prevFetch = globalThis.fetch;
  const fake = fakeLighthouseModule(result);
  fake.probes = [];
  const probe = fetchImpl || (async () => ({ ok: true, status: 200 }));
  globalThis.fetch = async (url, opts) => { fake.probes.push(String(url)); return probe(url, opts); };
  tool._setLighthouseForTest(fake.mod);
  try {
    return await fn(fake);
  } finally {
    tool._setLighthouseForTest(null);
    globalThis.fetch = prevFetch;
  }
}

test("W1C2: desktop audit passes Lighthouse's desktopConfig; mobile uses the default config", async () => {
  await withFakes({}, async (fake) => {
    const d = await tool.handler({ url: "https://example.com/" }, CTX);
    assert.notStrictEqual(d.isError, true, d.content[0].text);
    const m = await tool.handler({ url: "https://example.com/", formFactor: "mobile" }, CTX);
    assert.notStrictEqual(m.isError, true, m.content[0].text);
    assert.strictEqual(fake.calls.length, 2);
    assert.strictEqual(fake.calls[0].config, fake.desktopConfig, "desktop must run with desktopConfig");
    assert.strictEqual(fake.calls[1].config, undefined, "mobile must run with the default (mobile) config");
    for (const c of fake.calls) {
      // Flags override config settings in Lighthouse, so none may re-impose
      // mobile emulation/throttling on top of desktopConfig.
      assert.strictEqual(c.flags.throttling, undefined);
      assert.strictEqual(c.flags.screenEmulation, undefined);
      assert.strictEqual(c.flags.emulatedUserAgent, undefined);
      assert.strictEqual(c.flags.port, 9333);
      assert.strictEqual(c.flags.hostname, "127.0.0.1");
    }
  });
});

// W2D: the reset clears the origin's service workers / Cache Storage and the
// browser-wide HTTP cache in the profile every session shares.
test("W2D: lighthouse_audit never resets storage (disableStorageReset), on the ctx.cdpUrl endpoint", async () => {
  await withFakes({}, async (fake) => {
    for (const formFactor of ["desktop", "mobile"]) {
      const r = await tool.handler({ url: "https://example.com/", formFactor }, { cdpUrl: "http://127.0.0.1:9555" });
      assert.notStrictEqual(r.isError, true, r.content[0].text);
    }
    assert.deepStrictEqual(fake.calls.map((c) => [c.flags.disableStorageReset, c.flags.port]), [[true, 9555], [true, 9555]]);
    assert.deepStrictEqual(fake.probes, ["http://127.0.0.1:9555/json/version", "http://127.0.0.1:9555/json/version"]);
  });
});

// Uses the config file directly: importing the full lighthouse entry costs
// ~10s here, the config file ~15ms. The entry re-export is checked as text.
test("W1C2: installed lighthouse exports a desktopConfig with desktop throttling + UA", async (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  let lhDir;
  try { lhDir = path.dirname(require.resolve("lighthouse/package.json")); } catch { t.skip("lighthouse not installed"); return; }
  const entry = fs.readFileSync(path.join(lhDir, "core", "index.js"), "utf8");
  assert.match(entry, /export\s*\{\s*default as desktopConfig\s*\}\s*from\s*['"]\.\/config\/desktop-config\.js['"]/,
    "lighthouse entry must re-export desktopConfig");
  const { pathToFileURL } = require("node:url");
  const cfg = (await import(pathToFileURL(path.join(lhDir, "core", "config", "desktop-config.js")).href)).default;
  const s = cfg.settings;
  assert.strictEqual(s.formFactor, "desktop");
  assert.strictEqual(s.throttling.cpuSlowdownMultiplier, 1, "desktop throttling has no CPU slowdown (mobile is 4x)");
  assert.strictEqual(s.screenEmulation.mobile, false);
  assert.doesNotMatch(s.emulatedUserAgent, /Mobile/);
});

test("W1C2: CDP probe failures give current advice (no Cursor restart / 'call another tool first')", async () => {
  const cases = [
    async () => ({ ok: false, status: 500 }),
    async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:9333"); },
  ];
  for (const fetchImpl of cases) {
    await withFakes({ fetchImpl }, async (fake) => {
      const r = await tool.handler({ url: "https://example.com/" }, CTX);
      assert.strictEqual(r.isError, true);
      const text = r.content[0].text;
      assert.doesNotMatch(text, /Cursor/);
      assert.doesNotMatch(text, /call any (other|browser) tool/i);
      assert.match(text, /retry/i);
      assert.strictEqual(fake.calls.length, 0);
    });
  }
});

// ──────────────────────────────────────────────────────────────────
// W2G: broker mode has no TCP debugging port. ctx.cdpUrl is the broker's
// CDP proxy, ws://127.0.0.1:<port>/<secret>/devtools/browser, which serves no
// /json/version, so Lighthouse's own {hostname, port} connect can't use it.
// The tool connects puppeteer (Lighthouse's own) to the ws URL and hands
// Lighthouse a page. The http path above stays for legacy mode.
// ──────────────────────────────────────────────────────────────────

const WS_CTX = { cdpUrl: `ws://127.0.0.1:41234/${"c".repeat(64)}/devtools/browser` };

function fakePuppeteer({ connectError = null, newPageError = null } = {}) {
  const log = [];
  const page = { closed: 0, async close() { this.closed++; log.push("page.close"); } };
  const browser = {
    disconnected: 0,
    async newPage() { log.push("newPage"); if (newPageError) throw newPageError; return page; },
    async disconnect() { this.disconnected++; log.push("disconnect"); },
    async close() { log.push("BROWSER.CLOSE"); },
  };
  return {
    log, page, browser,
    mod: { async connect(opts) { log.push(["connect", opts]); if (connectError) throw connectError; return browser; } },
  };
}

async function withWsFakes({ result, lighthouseError, ...pp } = {}, fn) {
  const prevFetch = globalThis.fetch;
  const lh = fakeLighthouseModule(result);
  const run = lh.mod.default;
  lh.mod = { ...lh.mod, default: async (url, flags, config, page) => { lh.calls.push({ page }); if (lighthouseError) throw lighthouseError; return run(url, flags, config); } };
  const pptr = fakePuppeteer(pp);
  const probes = [];
  globalThis.fetch = async (url) => { probes.push(String(url)); return { ok: true, status: 200 }; };
  tool._setLighthouseForTest(lh.mod);
  tool._setPuppeteerForTest(pptr.mod);
  try {
    return await fn({ lh, pptr, probes });
  } finally {
    tool._setLighthouseForTest(null);
    tool._setPuppeteerForTest(null);
    globalThis.fetch = prevFetch;
  }
}

test("W2G: a ws:// cdpUrl runs Lighthouse on a page of puppeteer connected to that URL; the page is closed, puppeteer disconnected, Brave never closed", async () => {
  await withWsFakes({}, async ({ lh, pptr, probes }) => {
    const r = await tool.handler({ url: "https://example.com/" }, WS_CTX);
    assert.notStrictEqual(r.isError, true, r.content[0].text);
    assert.deepStrictEqual(JSON.parse(r.content[0].text).categories.performance.score, 90);
    assert.deepStrictEqual(pptr.log, [["connect", { browserWSEndpoint: WS_CTX.cdpUrl, defaultViewport: null }], "newPage", "page.close", "disconnect"]);
    // lighthouse(url, flags, config, page): the page is what it drives
    const call = lh.calls.find((c) => c.flags);
    assert.strictEqual(lh.calls.find((c) => "page" in c).page, pptr.page);
    assert.strictEqual(call.flags.port, undefined, "no {hostname, port}: there is no port to discover");
    assert.strictEqual(call.flags.hostname, undefined);
    assert.strictEqual(call.flags.disableStorageReset, true);
    assert.strictEqual(call.config, lh.desktopConfig, "desktop config, as on the http path");
    assert.deepStrictEqual(probes, [], "no /json/version probe: the proxy answers none");
  });
});

test("W2G ws: mobile uses the default config, as on the http path", async () => {
  await withWsFakes({}, async ({ lh }) => {
    const r = await tool.handler({ url: "https://example.com/", formFactor: "mobile" }, WS_CTX);
    assert.notStrictEqual(r.isError, true, r.content[0].text);
    assert.strictEqual(lh.calls.find((c) => c.flags).config, undefined);
    assert.strictEqual(lh.calls.find((c) => c.flags).flags.formFactor, "mobile");
  });
});

test("W2G ws: a failed connect (Brave down: 503) is an isError result with retry advice; the tool's own text never prints the URL", async () => {
  await withWsFakes({ connectError: new Error("Unexpected server response: 503") }, async ({ lh, pptr }) => {
    const r = await tool.handler({ url: "https://example.com/" }, WS_CTX);
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /^lighthouse_audit: .*503.*retry/is);
    assert.ok(!r.content[0].text.includes("c".repeat(64)), r.content[0].text);
    assert.strictEqual(lh.calls.length, 0);
    assert.ok(!pptr.log.includes("BROWSER.CLOSE"));
  });
});

test("W2G ws: puppeteer-core failing to load says so (not 'Brave may have crashed')", async () => {
  await withWsFakes({}, async ({ lh }) => {
    tool._setPuppeteerForTest(new Error("Cannot find module 'puppeteer-core'"));
    const r = await tool.handler({ url: "https://example.com/" }, WS_CTX);
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /^lighthouse_audit: failed to load puppeteer-core .*Cannot find module/);
    assert.doesNotMatch(r.content[0].text, /crashed/);
    assert.strictEqual(lh.calls.length, 0);
  });
});

test("W2G ws: Lighthouse throwing (or newPage failing) still closes the page and disconnects; isError", async () => {
  await withWsFakes({ lighthouseError: new Error("PROTOCOL_TIMEOUT") }, async ({ pptr }) => {
    const r = await tool.handler({ url: "https://example.com/" }, WS_CTX);
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /^lighthouse_audit: PROTOCOL_TIMEOUT/);
    assert.strictEqual(pptr.page.closed, 1);
    assert.strictEqual(pptr.browser.disconnected, 1);
  });
  await withWsFakes({ newPageError: new Error("Target.createTarget failed") }, async ({ pptr }) => {
    const r = await tool.handler({ url: "https://example.com/" }, WS_CTX);
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /Target\.createTarget failed/);
    assert.strictEqual(pptr.browser.disconnected, 1);
    assert.ok(!pptr.log.includes("BROWSER.CLOSE"));
  });
});

test("W2G: puppeteer-core is the one Lighthouse itself imports (resolved from lighthouse, its ESM build)", (t) => {
  const fs = require("node:fs");
  const path = require("node:path");
  try { require.resolve("lighthouse/package.json"); } catch { t.skip("lighthouse not installed"); return; }
  const entry = tool._puppeteerEntry();
  assert.ok(fs.existsSync(entry), entry);
  assert.match(entry.split(path.sep).join("/"), /\/puppeteer-core\/lib\/esm\/puppeteer\/puppeteer-core\.js$/);
  const lhDir = path.dirname(require.resolve("lighthouse/package.json"));
  const nav = fs.readFileSync(path.join(lhDir, "core", "gather", "navigation-runner.js"), "utf8");
  assert.match(nav, /import puppeteer from 'puppeteer-core'/, "lighthouse imports puppeteer-core by its package name");
});

test("W2D: lighthouse_audit description says storage is not reset (warm cache, shared profile)", () => {
  assert.match(tool.description, /does not reset storage/i);
  assert.match(tool.description, /warm/i);
  assert.doesNotMatch(tool.description, /wipes|clears/i);
});

test("W1C2: lighthouse_audit 'no result' error carries the tool-name prefix", async () => {
  await withFakes({ result: {} }, async () => {
    const r = await tool.handler({ url: "https://example.com/" }, CTX);
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /^lighthouse_audit: /);
  });
});
