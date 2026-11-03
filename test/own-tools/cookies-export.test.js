const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/cookies-export.js");

test("cookies_export has required tool shape", () => {
  assert.strictEqual(tool.name, "cookies_export");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

test("W2D: cookies_export is context-wide: needsPage false, reads ctx.context (shared by every tab)", async () => {
  assert.strictEqual(tool.needsPage, false);
  assert.match(tool.description, /shared by every tab and session/);
  const r = await tool.handler({}, { context: { cookies: async () => [{ name: "a", value: "1", domain: ".x.com", path: "/" }] } });
  assert.strictEqual(JSON.parse(r.content[0].text).count, 1);
});

// V1-4: Playwright's `context.cookies([])` returns ALL cookies (empty array
// = no filter). Caller passing `urls: []` likely expects "no matching URLs",
// not the entire cookie vault — privacy concern.
test("V1-4: cookies_export with urls=[] returns empty list, NOT all cookies", async () => {
  let cookiesCalledWith = "NOT_CALLED";
  const fakeContext = {
    cookies: async (filter) => {
      cookiesCalledWith = filter;
      // Pretend the vault is huge.
      return [
        { name: "session", value: "secret", domain: ".example.com", path: "/" },
        { name: "auth", value: "token", domain: ".other.com", path: "/" },
      ];
    },
  };
  const ctx = { context: fakeContext };
  const result = await tool.handler({ urls: [] }, ctx);
  const payload = JSON.parse(result.content[0].text);
  // Critical: empty filter must produce an EMPTY result, NOT the full vault.
  assert.strictEqual(payload.count, 0);
  assert.deepStrictEqual(payload.cookies, []);
  // Even better: context.cookies() must not be called at all when urls=[].
  assert.strictEqual(cookiesCalledWith, "NOT_CALLED",
    "context.cookies() must NOT be invoked for urls=[] (Playwright would treat empty as 'no filter')");
});

test("V1-4: cookies_export with urls=undefined still returns full vault (existing behavior)", async () => {
  // Sanity: omitting `urls` entirely should still return everything.
  const fakeContext = {
    cookies: async () => [{ name: "session", value: "x", domain: ".example.com", path: "/" }],
  };
  const ctx = { context: fakeContext };
  const result = await tool.handler({}, ctx);
  const payload = JSON.parse(result.content[0].text);
  assert.strictEqual(payload.count, 1);
});

// ──────────────────────────────────────────────────────────────────
// W1C1 (2026-11-03): domains / names filters, compact JSON, maxBytes,
// outputPath (values stay out of the model's context).
// ──────────────────────────────────────────────────────────────────

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const JAR = [
  { name: "session-id", value: "S1", domain: ".amazon.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
  { name: "ubid", value: "U1", domain: "www.amazon.com", path: "/", expires: -1, httpOnly: false, secure: true, sameSite: "Lax" },
  { name: "session-id", value: "E1", domain: ".evilamazon.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "None" },
  { name: "sid", value: "G1", domain: ".google.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Strict" },
];

async function withJar(jar, fn) {
  return fn({ context: { cookies: async () => jar.map((c) => ({ ...c })) } });
}

test("W1C1: cookies_export domains filter matches the domain and its subdomains only", async () => {
  await withJar(JAR, async (ctx) => {
    const r = await tool.handler({ domains: ["Amazon.com"] }, ctx);
    const p = JSON.parse(r.content[0].text);
    assert.deepStrictEqual(p.cookies.map((c) => c.value).sort(), ["S1", "U1"], "evilamazon.com must not match amazon.com");
    assert.strictEqual(p.count, 2);
  });
});

test("W1C1: cookies_export names filter + combination with domains", async () => {
  await withJar(JAR, async (ctx) => {
    const byName = JSON.parse((await tool.handler({ names: ["session-id"] }, ctx)).content[0].text);
    assert.deepStrictEqual(byName.cookies.map((c) => c.value).sort(), ["E1", "S1"]);
    const both = JSON.parse((await tool.handler({ names: ["session-id"], domains: [".amazon.com"] }, ctx)).content[0].text);
    assert.deepStrictEqual(both.cookies.map((c) => c.value), ["S1"]);
  });
});

test("W1C1: cookies_export empty domains/names filter matches nothing (like urls: [])", async () => {
  await withJar(JAR, async (ctx) => {
    assert.strictEqual(JSON.parse((await tool.handler({ domains: [] }, ctx)).content[0].text).count, 0);
    assert.strictEqual(JSON.parse((await tool.handler({ names: [] }, ctx)).content[0].text).count, 0);
  });
});

test("W1C1: cookies_export rejects malformed domains/names", async () => {
  await withJar(JAR, async (ctx) => {
    for (const bad of [{ domains: "amazon.com" }, { names: [42] }, { domains: [""] }]) {
      const r = await tool.handler(bad, ctx);
      assert.strictEqual(r.isError, true, JSON.stringify(bad));
      assert.match(r.content[0].text, new RegExp(Object.keys(bad)[0]));
    }
  });
});

test("W1C1: cookies_export output is compact JSON and null filters mean 'omitted'", async () => {
  await withJar(JAR, async (ctx) => {
    const r = await tool.handler({ urls: null, domains: null, names: null, maxBytes: null, outputPath: null }, ctx);
    assert.ok(!r.isError, r.content[0].text);
    assert.ok(!r.content[0].text.includes("\n"), "inline JSON must be compact");
    assert.strictEqual(JSON.parse(r.content[0].text).count, 4);
  });
});

test("W1C1: cookies_export maxBytes caps inline output and says what was left out", async () => {
  const big = [];
  for (let i = 0; i < 200; i++) big.push({ name: `c${i}`, value: "v".repeat(400), domain: ".example.com", path: "/" });
  await withJar(big, async (ctx) => {
    const r = await tool.handler({ maxBytes: 5000 }, ctx);
    assert.ok(r.content[0].text.length <= 5000, `inline output must respect maxBytes (got ${r.content[0].text.length})`);
    const p = JSON.parse(r.content[0].text);
    assert.strictEqual(p.count, 200, "count reports all matching cookies");
    assert.strictEqual(p.truncated, true);
    assert.strictEqual(p.returned, p.cookies.length);
    assert.ok(p.returned > 0 && p.returned < 200);
  });
});

test("W1C1: cookies_export default maxBytes keeps a big jar out of the context", async () => {
  const big = [];
  for (let i = 0; i < 2000; i++) big.push({ name: `c${i}`, value: "v".repeat(200), domain: ".example.com", path: "/" });
  await withJar(big, async (ctx) => {
    const r = await tool.handler({}, ctx);
    assert.ok(r.content[0].text.length <= 50_000, `default cap ~50KB (got ${r.content[0].text.length})`);
    assert.strictEqual(JSON.parse(r.content[0].text).truncated, true);
  });
});

test("W1C1: cookies_export outputPath writes all cookies; values never appear inline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-cookies-export-"));
  try {
    const out = path.join(dir, "jar.json");
    await withJar(JAR, async (ctx) => {
      const r = await tool.handler({ outputPath: out, maxBytes: 1024 }, ctx);
      assert.ok(!r.isError, r.content[0].text);
      const p = JSON.parse(r.content[0].text);
      assert.strictEqual(p.savedTo, out);
      assert.strictEqual(p.count, 4);
      for (const c of JAR) assert.ok(!r.content[0].text.includes(c.value), `value ${c.value} leaked inline`);
      const file = JSON.parse(fs.readFileSync(out, "utf8"));
      assert.strictEqual(file.cookies.length, 4, "file is never truncated by maxBytes");

      const again = await tool.handler({ outputPath: out }, ctx);
      assert.strictEqual(again.isError, true);
      assert.match(again.content[0].text, /exists/);
      const rel = await tool.handler({ outputPath: "jar.json" }, ctx);
      assert.strictEqual(rel.isError, true);
      assert.match(rel.content[0].text, /absolute/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── W2F (v0.4.1): cookies the cookie bridge manages never come back with their value ──

test("W2F: cookies_export hides bridge-managed values ([bridge-managed]) inline, keeps name/domain/path/flags, and counts them", async () => {
  const managed = (c) => c.domain === ".amazon.com" && c.name === "session-id";
  let matcherCalls = 0;
  const ctx = { context: { cookies: async () => JAR.map((c) => ({ ...c })) }, bridgeManagedMatcher: () => { matcherCalls++; return managed; } };
  const r = await tool.handler({}, ctx);
  const p = JSON.parse(r.content[0].text);
  assert.strictEqual(matcherCalls, 1, "one matcher per export");
  assert.strictEqual(p.bridgeManaged, 1);
  assert.ok(!r.content[0].text.includes("S1"), "the managed value never appears");
  const masked = p.cookies.find((c) => c.domain === ".amazon.com");
  assert.deepStrictEqual(masked, { ...JAR[0], value: tool.BRIDGE_MANAGED_VALUE });
  assert.strictEqual(tool.BRIDGE_MANAGED_VALUE, "[bridge-managed]");
  assert.deepStrictEqual(p.cookies.filter((c) => c !== masked).map((c) => c.value).sort(), ["E1", "G1", "U1"], "Brave's own cookies are untouched");
  assert.match(tool.description, /\[bridge-managed\]/);
  assert.match(tool.description, /execute/, "the description says page scripts can still read values");
});

test("W2F: cookies_export hides bridge-managed values in outputPath files too; without a matcher (legacy) nothing changes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-cookies-export-w2f-"));
  try {
    const out = path.join(dir, "jar.json");
    const ctx = { context: { cookies: async () => JAR.map((c) => ({ ...c })) }, bridgeManagedMatcher: () => (c) => c.value === "G1" || c.value === "S1" };
    const r = await tool.handler({ outputPath: out }, ctx);
    assert.strictEqual(JSON.parse(r.content[0].text).bridgeManaged, 2);
    const raw = fs.readFileSync(out, "utf8");
    assert.ok(!raw.includes('"S1"') && !raw.includes('"G1"'), "the file holds no managed value");
    assert.strictEqual(JSON.parse(raw).cookies.filter((c) => c.value === "[bridge-managed]").length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const legacy = await tool.handler({}, { context: { cookies: async () => JAR.map((c) => ({ ...c })) } });
  const p = JSON.parse(legacy.content[0].text);
  assert.strictEqual(p.bridgeManaged, undefined);
  assert.deepStrictEqual(p.cookies.map((c) => c.value).sort(), ["E1", "G1", "S1", "U1"]);
});
