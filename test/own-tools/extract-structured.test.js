const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/extract-structured.js");

test("extract_structured has required tool shape", () => {
  assert.strictEqual(tool.name, "extract_structured");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
  assert.deepStrictEqual(tool.inputSchema.required, ["schema"]);
});

test("extract_structured returns isError when bridge missing", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = undefined;
  try {
    const result = await tool.handler({ schema: { x: { selector: ".x" } } });
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /bridge|initialized|missing/i);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

// ──────────────────────────────────────────────────────────────────
// T0-5: validate schema arg upfront — null / non-object / empty
// produce a clean structured error instead of an opaque failure
// inside page.evaluate's "Cannot convert undefined or null to object".
// ──────────────────────────────────────────────────────────────────

const fakeBridgeWithPage = () => ({
  context: {
    pages: () => [{
      url: () => "https://x",
      isClosed: () => false,
      evaluate: async () => ({}),
      goto: async () => undefined,
      waitForSelector: async () => undefined,
    }],
  },
});

test("T0-5: extract_structured rejects schema=null at entry", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = fakeBridgeWithPage();
  try {
    const r = await tool.handler({ schema: null });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /schema must be a non-null object/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T0-5: extract_structured rejects empty schema {} at entry", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = fakeBridgeWithPage();
  try {
    const r = await tool.handler({ schema: {} });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /at least one field/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T0-5: extract_structured rejects schema=array (non-object)", async () => {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = fakeBridgeWithPage();
  try {
    const r = await tool.handler({ schema: [{ selector: ".x" }] });
    assert.strictEqual(r.isError, true);
    assert.match(r.content[0].text, /schema must be a non-null object/);
  } finally {
    globalThis.__relayBridge = prev;
  }
});

test("T1-4: extract_structured default attribute is textContent (source-level guard)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "src", "own-tools", "extract-structured.js"),
    "utf8",
  );
  // The default `attr = spec.attribute || "textContent"` line is what makes
  // big-list extraction fast. Reverting to innerText would re-introduce the
  // layout-thrash slowdown.
  assert.ok(
    /spec\.attribute\s*\|\|\s*"textContent"/.test(src),
    "default attribute must be textContent (was innerText pre-T1-4)",
  );
});

// ──────────────────────────────────────────────────────────────────
// W1C1 (2026-11-03): cap multiple + innerHTML output (maxItems per
// multiple field, maxBytes total), compact JSON.
// ──────────────────────────────────────────────────────────────────

// Fake page whose evaluate runs the tool's in-page function against a tiny
// fake DOM: `dom` maps selector → array of { text, html, attrs }.
function makeDomPage(dom) {
  const el = (d) => ({
    textContent: d.text ?? "",
    innerText: d.text ?? "",
    innerHTML: d.html ?? "",
    value: d.value,
    getAttribute: (n) => (d.attrs && n in d.attrs ? d.attrs[n] : null),
  });
  const document = {
    querySelectorAll: (s) => (dom[s] || []).map(el),
    querySelector: (s) => (dom[s] && dom[s][0] ? el(dom[s][0]) : null),
  };
  return {
    url: () => "https://shop.example/list",
    isClosed: () => false,
    goto: async () => undefined,
    waitForSelector: async () => undefined,
    evaluate: async (fn, arg) => {
      const g = new Proxy({ document }, { has: (_t, p) => p === "document", get: (t, p) => t[p] });
      // eslint-disable-next-line no-new-func
      return new Function("__g", "fn", "arg", "with (__g) { return (" + fn.toString() + ")(arg); }")(g, fn, arg);
    },
  };
}

async function onDom(dom, fn) {
  const prev = globalThis.__relayBridge;
  globalThis.__relayBridge = { context: { pages: () => [makeDomPage(dom)] } };
  try { return await fn(); } finally { globalThis.__relayBridge = prev; }
}

test("W1C1: extract_structured still extracts normally (compact JSON, no truncation noise)", async () => {
  await onDom({ "h1": [{ text: "Title" }], "a.item": [{ attrs: { href: "/1" } }, { attrs: { href: "/2" } }] }, async () => {
    const r = await tool.handler({ schema: { title: { selector: "h1" }, links: { selector: "a.item", attribute: "href", multiple: true } } });
    assert.ok(!r.isError, r.content[0].text);
    assert.ok(!r.content[0].text.includes("\n"), "inline JSON must be compact");
    const p = JSON.parse(r.content[0].text);
    assert.deepStrictEqual(p.data, { title: "Title", links: ["/1", "/2"] });
    assert.strictEqual(p.truncated, undefined);
  });
});

test("W1C1: extract_structured multiple + innerHTML output is capped near 100KB by default", async () => {
  const cards = [];
  for (let i = 0; i < 1000; i++) cards.push({ html: `<div class="card">${"x".repeat(2000)}</div>` });
  await onDom({ ".card": cards }, async () => {
    const r = await tool.handler({ schema: { cards: { selector: ".card", attribute: "innerHTML", multiple: true } } });
    assert.ok(r.content[0].text.length < 120_000, `output must stay near 100KB (got ${r.content[0].text.length})`);
    const p = JSON.parse(r.content[0].text);
    assert.ok(p.data.cards.length < 1000);
    assert.match(p.truncated.cards, /of 1000/, "truncated says how many matched");
  });
});

test("W1C1: extract_structured maxItems caps a multiple field", async () => {
  const items = [];
  for (let i = 0; i < 50; i++) items.push({ text: `item ${i}` });
  await onDom({ "li": items }, async () => {
    const p = JSON.parse((await tool.handler({ schema: { items: { selector: "li", multiple: true } }, maxItems: 10 })).content[0].text);
    assert.strictEqual(p.data.items.length, 10);
    assert.deepStrictEqual(p.truncated, { items: "kept 10 of 50" });
  });
});

test("W1C1: extract_structured — one huge field can't starve later fields (fair share of maxBytes)", async () => {
  await onDom({ "main": [{ html: "m".repeat(5000) }], "h1": [{ text: "Late" }] }, async () => {
    const p = JSON.parse((await tool.handler({
      schema: { body: { selector: "main", attribute: "innerHTML" }, title: { selector: "h1" } },
      maxBytes: 2000,
    })).content[0].text);
    assert.ok(p.data.body.length <= 1000 + 20, `first of 2 fields gets ~half of maxBytes (got ${p.data.body.length})`);
    assert.match(p.data.body, /\[truncated\]$/);
    assert.strictEqual(p.data.title, "Late", "later small fields still come back");
    assert.deepStrictEqual(p.truncated, { body: "clipped" });
  });
});

test("W1C1: extract_structured — small early fields leave their unused share to later ones", async () => {
  await onDom({ "h1": [{ text: "T" }], "main": [{ html: "m".repeat(5000) }] }, async () => {
    const p = JSON.parse((await tool.handler({
      schema: { title: { selector: "h1" }, body: { selector: "main", attribute: "innerHTML" } },
      maxBytes: 2000,
    })).content[0].text);
    assert.strictEqual(p.data.title, "T");
    assert.ok(p.data.body.length > 1900, `last field gets the remaining budget (got ${p.data.body.length})`);
  });
});

test("W1C1: extract_structured maxBytes counts JSON-escaped size", async () => {
  await onDom({ "main": [{ html: '"'.repeat(5000) }] }, async () => {
    const r = await tool.handler({ schema: { body: { selector: "main", attribute: "innerHTML" } }, maxBytes: 2000 });
    assert.ok(r.content[0].text.length < 2200, `escaped output must respect maxBytes (got ${r.content[0].text.length})`);
  });
});

test("W1C1 V2-1: extract_structured clips front-loaded escapes to the real escaped size", async () => {
  const html = String.fromCharCode(1).repeat(3000) + "a".repeat(30000);
  await onDom({ "main": [{ html }] }, async () => {
    const p = JSON.parse((await tool.handler({ schema: { body: { selector: "main", attribute: "innerHTML" } }, maxBytes: 2000 })).content[0].text);
    assert.ok(JSON.stringify(p.data.body).length <= 2000, `escaped value ${JSON.stringify(p.data.body).length} > maxBytes 2000`);
    assert.deepStrictEqual(p.truncated, { body: "clipped" });
  });
});

test("W1C1: extract_structured validates maxItems / maxBytes", async () => {
  await onDom({}, async () => {
    for (const bad of [{ maxItems: 0 }, { maxItems: "5" }, { maxBytes: 10 }]) {
      const r = await tool.handler({ schema: { x: { selector: "h1" } }, ...bad });
      assert.strictEqual(r.isError, true, JSON.stringify(bad));
      assert.match(r.content[0].text, new RegExp(Object.keys(bad)[0]));
    }
  });
});
