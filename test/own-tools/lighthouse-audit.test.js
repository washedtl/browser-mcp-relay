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
  // Match `try { ... result = await lighthouse(... } catch`.
  assert.ok(
    /try\s*\{[\s\S]*?result\s*=\s*await\s+lighthouse\([\s\S]*?\}\s*catch\s*\(/m.test(src),
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
