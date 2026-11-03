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

test("lighthouse_audit returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ url: "https://example.com" });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-6: bad URL / dead Brave must return structured isError, not throw.
// T1-1: lighthouse import is memoized (lazy + cached).
// ──────────────────────────────────────────────────────────────────

test("T0-6: lighthouse_audit rejects malformed URL with isError", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = { port: 9333 };
  try {
    const r = await tool.handler({ url: "not-a-url" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /invalid URL/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T0-6: lighthouse_audit rejects empty url string", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = { port: 9333 };
  try {
    const r = await tool.handler({ url: "" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /non-empty string/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
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
  const prevBridge = globalThis.__relayBridge;
  const prevFetch = globalThis.fetch;
  const fake = fakeLighthouseModule(result);
  globalThis.__relayBridge = { port: 9333, context: { pages: () => [] } };
  globalThis.fetch = fetchImpl || (async () => ({ ok: true, status: 200 }));
  tool._setLighthouseForTest(fake.mod);
  try {
    return await fn(fake);
  } finally {
    tool._setLighthouseForTest(null);
    globalThis.__relayBridge = prevBridge;
    globalThis.fetch = prevFetch;
  }
}

test("W1C2: desktop audit passes Lighthouse's desktopConfig; mobile uses the default config", async () => {
  await withFakes({}, async (fake) => {
    const d = await tool.handler({ url: "https://example.com/" });
    assert.notStrictEqual(d.isError, true, d.content[0].text);
    const m = await tool.handler({ url: "https://example.com/", formFactor: "mobile" });
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
    }
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
      const r = await tool.handler({ url: "https://example.com/" });
      assert.strictEqual(r.isError, true);
      const text = r.content[0].text;
      assert.doesNotMatch(text, /Cursor/);
      assert.doesNotMatch(text, /call any (other|browser) tool/i);
      assert.match(text, /retry/i);
      assert.strictEqual(fake.calls.length, 0);
    });
  }
});

test("W1C2: lighthouse_audit description warns about clearing data in the shared profile", () => {
  assert.match(tool.description, /cache/i);
  assert.match(tool.description, /service worker/i);
});

test("W1C2: lighthouse_audit 'no result' error carries the tool-name prefix", async () => {
  await withFakes({ result: {} }, async () => {
    const r = await tool.handler({ url: "https://example.com/" });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /^lighthouse_audit: /);
  });
});
