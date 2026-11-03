const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tool = require("../../src/own-tools/cookies-import.js");
const exportTool = require("../../src/own-tools/cookies-export.js");

test("cookies_import has required tool shape", () => {
  assert.strictEqual(tool.name, "cookies_import");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  // W1C1: `cookies` OR `inputPath` — neither is schema-required on its own.
  assert.strictEqual(tool.inputSchema.required, undefined);
  assert.ok(tool.inputSchema.properties.cookies);
  assert.ok(tool.inputSchema.properties.inputPath);
});

test("W2D: cookies_import is context-wide: needsPage false, writes ctx.context (shared by every tab)", async () => {
  assert.strictEqual(tool.needsPage, false);
  assert.match(tool.description, /shared by every tab and session/);
  const jarContext = makeJarContext();
  const r = await tool.handler({ cookies: [GOOD] }, { context: jarContext });
  assert.deepStrictEqual(JSON.parse(r.content[0].text), { imported: 1 });
  assert.strictEqual(jarContext.addCalls, 1);
});

// ──────────────────────────────────────────────────────────────────
// W1C1 (2026-11-03): validators exercised, inputPath, round trip.
// ──────────────────────────────────────────────────────────────────

// In-memory cookie jar that behaves like a BrowserContext for these tools.
function makeJarContext(initial = []) {
  const jar = initial.map((c) => ({ ...c }));
  let addCalls = 0;
  return {
    jar,
    get addCalls() { return addCalls; },
    cookies: async () => jar.map((c) => ({ ...c })),
    addCookies: async (list) => {
      addCalls++;
      for (const c of list) {
        const i = jar.findIndex((x) => x.name === c.name && x.domain === c.domain && x.path === c.path);
        if (i >= 0) jar[i] = { ...c }; else jar.push({ ...c });
      }
    },
  };
}

async function withContext(context, fn) {
  return fn({ context });
}

const GOOD = { name: "sid", value: "SECRET-VALUE", domain: ".example.com", path: "/" };

test("W1C1: cookies_import field validators reject malformed cookies before addCookies", async () => {
  const cases = [
    [null, /must be a non-null object/],
    [{ name: "a" }, /must have string name \+ value/],
    [{ ...GOOD, url: "" }, /\.url must be a non-empty string/],
    [{ ...GOOD, domain: 5 }, /\.domain must be a string/],
    [{ ...GOOD, path: 5 }, /\.path must be a string/],
    [{ ...GOOD, expires: "tomorrow" }, /\.expires must be a finite number/],
    [{ ...GOOD, httpOnly: "yes" }, /\.httpOnly must be boolean/],
    [{ ...GOOD, secure: 1 }, /\.secure must be boolean/],
    [{ ...GOOD, sameSite: "lax" }, /\.sameSite must be 'Strict' \| 'Lax' \| 'None'/],
  ];
  for (const [bad, re] of cases) {
    const jarContext = makeJarContext();
    await withContext(jarContext, async (ctx) => {
      const r = await tool.handler({ cookies: [GOOD, bad] }, ctx);
      assert.strictEqual(r.isError, true, `expected isError for ${JSON.stringify(bad)}`);
      assert.match(r.content[0].text, re);
      assert.match(r.content[0].text, /cookies\[1\]/, "error names the bad index");
      assert.ok(!r.content[0].text.includes("SECRET-VALUE"), "errors never echo cookie values");
      assert.strictEqual(jarContext.addCalls, 0, "nothing is imported when any entry is invalid");
    });
  }
});

test("W1C1: cookies_import needs exactly one of cookies / inputPath (null = omitted)", async () => {
  await withContext(makeJarContext(), async (ctx) => {
    const neither = await tool.handler({ cookies: null, inputPath: null }, ctx);
    assert.strictEqual(neither.isError, true);
    assert.match(neither.content[0].text, /cookies or inputPath/);
    const both = await tool.handler({ cookies: [GOOD], inputPath: path.join(os.tmpdir(), "x.json") }, ctx);
    assert.strictEqual(both.isError, true);
    assert.match(both.content[0].text, /not both/);
  });
});

test("W1C1: cookies_import inputPath — relative / missing / malformed files are clean errors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-cookies-import-"));
  try {
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{not json");
    const wrongShape = path.join(dir, "shape.json");
    fs.writeFileSync(wrongShape, JSON.stringify({ hello: 1 }));
    await withContext(makeJarContext(), async (ctx) => {
      const rel = await tool.handler({ inputPath: "jar.json" }, ctx);
      assert.match(rel.content[0].text, /absolute/);
      const missing = await tool.handler({ inputPath: path.join(dir, "nope.json") }, ctx);
      assert.strictEqual(missing.isError, true);
      assert.match(missing.content[0].text, /inputPath/);
      const unparsable = await tool.handler({ inputPath: bad }, ctx);
      assert.strictEqual(unparsable.isError, true);
      assert.match(unparsable.content[0].text, /JSON/);
      const shape = await tool.handler({ inputPath: wrongShape }, ctx);
      assert.strictEqual(shape.isError, true);
      assert.match(shape.content[0].text, /cookies array/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1C1: cookies_import accepts a bare array file (BOM tolerated)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-cookies-import-"));
  try {
    const file = path.join(dir, "arr.json");
    fs.writeFileSync(file, String.fromCharCode(0xfeff) + JSON.stringify([GOOD]));
    const jarContext = makeJarContext();
    await withContext(jarContext, async (ctx) => {
      const r = await tool.handler({ inputPath: file }, ctx);
      assert.ok(!r.isError, r.content[0].text);
      assert.deepStrictEqual(JSON.parse(r.content[0].text), { imported: 1 });
      assert.strictEqual(jarContext.jar[0].value, "SECRET-VALUE");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1C1: export(outputPath) → import(inputPath) round trip restores the jar; values never inline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-cookies-roundtrip-"));
  try {
    const file = path.join(dir, "session.json");
    const source = makeJarContext([
      { name: "session-id", value: "S-123", domain: ".amazon.com", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" },
      { name: "csrf", value: "C-456", domain: "www.amazon.com", path: "/ap", expires: 1893456000, httpOnly: false, secure: true, sameSite: "Strict" },
      { name: "other", value: "O-789", domain: ".other.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "None" },
    ]);
    const exported = await withContext(source, (ctx) => exportTool.handler({ domains: ["amazon.com"], outputPath: file }, ctx));
    assert.ok(!exported.isError, exported.content[0].text);
    assert.ok(!/S-123|C-456/.test(exported.content[0].text), "export summary must not carry values");

    const target = makeJarContext();
    const imported = await withContext(target, (ctx) => tool.handler({ inputPath: file }, ctx));
    assert.ok(!imported.isError, imported.content[0].text);
    assert.deepStrictEqual(JSON.parse(imported.content[0].text), { imported: 2 });
    assert.ok(!/S-123|C-456/.test(imported.content[0].text), "import result must not carry values");
    assert.deepStrictEqual(
      target.jar.slice().sort((a, b) => a.name.localeCompare(b.name)),
      source.jar.filter((c) => c.domain.endsWith("amazon.com")).sort((a, b) => a.name.localeCompare(b.name)),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
