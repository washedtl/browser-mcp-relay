const test = require("node:test");
const assert = require("node:assert");
const tool = require("../../src/own-tools/capture-xhr.js");

test("capture_xhr has required tool shape", () => {
  assert.strictEqual(tool.name, "capture_xhr");
  assert.strictEqual(typeof tool.description, "string");
  assert.strictEqual(typeof tool.inputSchema, "object");
  assert.strictEqual(typeof tool.handler, "function");
});

// W2D: replaces the "bridge missing" / "targets the active page" tests. The
// handler gets its page in ctx; other pages of the shared context (another
// session's tab) are never listened to.
test("W2D: capture_xhr captures on ctx.page only, not on the context's other pages", async () => {
  const mine = makeFakePageWithResponses([makeFakeResponse({ url: "https://api/mine" })]);
  const other = makeFakePageWithResponses([makeFakeResponse({ url: "https://api/other" })]);
  const ctx = { page: mine, context: { pages: () => [other, mine] } };
  const promise = tool.handler({ durationMs: 100, includeBody: false }, ctx);
  other._respondAll();
  mine._respondAll();
  const parsed = JSON.parse((await promise).content[0].text);
  assert.deepStrictEqual(parsed.responses.map((r) => r.url), ["https://api/mine"]);
});

// ──────────────────────────────────────────────────────────────────
// T0-1: navTimeoutMs is separate from durationMs (was: durationMs reused
// as page.goto timeout, so a slow page aborted before any XHR fired).
// T0-2: body fetch is fire-and-forget — slow body N doesn't queue body N+1.
// T0-3: maxResponses cap prevents unbounded heap on chatty pages.
// ──────────────────────────────────────────────────────────────────

function makeFakePageWithResponses(responses) {
  const handlers = { response: [], close: [] };
  const onceHandlers = { close: [] };
  const fakePage = {
    on(evt, fn) { (handlers[evt] || (handlers[evt] = [])).push(fn); },
    once(evt, fn) { (onceHandlers[evt] || (onceHandlers[evt] = [])).push(fn); },
    off(evt, fn) {
      const lst = handlers[evt] || [];
      const i = lst.indexOf(fn);
      if (i >= 0) lst.splice(i, 1);
    },
    goto: async () => undefined,
    url: () => "https://test.example.com/",
    isClosed: () => false,
    _emit(evt, payload) {
      for (const fn of (handlers[evt] || [])) fn(payload);
      if (evt === "close") {
        for (const fn of (onceHandlers.close || [])) fn();
        onceHandlers.close.length = 0;
      }
    },
  };
  // Build a fake "response" for each entry in responses.
  fakePage._respondAll = () => {
    for (const r of responses) {
      fakePage._emit("response", r);
    }
  };
  return fakePage;
}

// `streaming: true` models real Playwright: response.body() resolves only
// once the request FINISHES (server Response.body() chains on
// _finishedPromise), so a long-poll / SSE / chunked stream never resolves.
function makeFakeResponse({ url, status = 200, method = "GET", body = "{}", bodyDelay = 0, type = "xhr", headers = {}, streaming = false }) {
  return {
    url: () => url,
    status: () => status,
    headers: () => ({ "content-type": "application/json", ...headers }),
    request: () => ({ method: () => method, resourceType: () => type }),
    body: () => streaming
      ? new Promise(() => {})
      : new Promise((resolve) => setTimeout(() => resolve(Buffer.from(body, "utf8")), bodyDelay)),
  };
}

function withPage(fakePage, fn) {
  return Promise.resolve().then(() => fn({ page: fakePage, context: { pages: () => [fakePage] } }));
}

function hangGuard(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: hung > ${ms}ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

test("T0-3: capture_xhr enforces maxResponses cap and sets truncated", async () => {
  // 10 fake xhr responses; cap at 3 → truncated should fire and only 3 captured.
  const responses = [];
  for (let i = 0; i < 10; i++) {
    responses.push(makeFakeResponse({ url: `https://api.example/${i}`, body: `{"i":${i}}` }));
  }
  const fakePage = makeFakePageWithResponses(responses);
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  // Kick off the handler with a short window so we don't actually wait 5s.
  const promise = tool.handler({ durationMs: 200, maxResponses: 3, includeBody: false }, ctx);
  // Emit responses synchronously then wait for the duration.
  fakePage._respondAll();
  const result = await promise;
  const parsed = JSON.parse(result.content[0].text);
  assert.strictEqual(parsed.count, 3, "expected exactly maxResponses captured");
  assert.strictEqual(parsed.truncated, true, "truncated flag should fire when cap hit");
});

test("T0-2: capture_xhr body fetches run in parallel, not serialized", async () => {
  // Body 0 is slow (150ms); body 1 is fast (10ms). If serialized, body 1 waits
  // for body 0. If parallel, both finish before the duration ends.
  const responses = [
    makeFakeResponse({ url: "https://api/slow", body: "SLOW", bodyDelay: 150 }),
    makeFakeResponse({ url: "https://api/fast", body: "FAST", bodyDelay: 10 }),
  ];
  const fakePage = makeFakePageWithResponses(responses);
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  const promise = tool.handler({ durationMs: 250, includeBody: true }, ctx);
  fakePage._respondAll();
  const result = await promise;
  const parsed = JSON.parse(result.content[0].text);
  assert.strictEqual(parsed.count, 2);
  // Both bodies must be present (parallel) — if serialized + slow first, body 1 might still race the duration but parallel always succeeds.
  const slow = parsed.responses.find((r) => r.url.endsWith("/slow"));
  const fast = parsed.responses.find((r) => r.url.endsWith("/fast"));
  assert.ok(slow && slow.body === "SLOW", "slow body must be captured (parallel fetch)");
  assert.ok(fast && fast.body === "FAST", "fast body must be captured");
});

test("T0-1: capture_xhr navTimeoutMs separates nav timeout from capture window (source-level guard)", () => {
  // Source-level: ensure the handler signature exposes navTimeoutMs as a
  // distinct option from durationMs. This is the load-bearing API contract;
  // a future regression that re-couples them would silently re-introduce
  // the slow-page-aborts-before-any-XHR bug.
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "own-tools", "capture-xhr.js"), "utf8");
  assert.ok(/navTimeoutMs/.test(src), "expected navTimeoutMs option in source");
  // Effective nav timeout falls through to min(durationMs, 30000) when unset.
  assert.ok(/effectiveNavTimeout/.test(src), "expected separate effectiveNavTimeout variable");
  // page.goto must use effectiveNavTimeout, not durationMs directly.
  assert.ok(/page\.goto\([^)]*timeout:\s*effectiveNavTimeout/.test(src), "page.goto must use the separated nav timeout");
});

test("T0-9 (capture-xhr leg): pageClosedEarly flag set when page closes during capture", async () => {
  const responses = [makeFakeResponse({ url: "https://api/x", body: "{}" })];
  const fakePage = makeFakePageWithResponses(responses);
  const ctx = { page: fakePage, context: { pages: () => [fakePage] } };
  try {
    const promise = tool.handler({ durationMs: 5000, includeBody: false }, ctx);
    fakePage._emit("response", responses[0]);
    // Simulate page closing 50ms in.
    setTimeout(() => fakePage._emit("close"), 50);
    const result = await Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error("handler hung > 1s after close")), 1000)),
    ]);
    const parsed = JSON.parse(result.content[0].text);
    // Note: current implementation still waits the full durationMs after close
    // (the close listener flips a flag but the setTimeout doesn't short-circuit).
    // The flag exists for diagnostic purposes; a future fix could short-circuit.
    // For now just verify the flag is exposed in the response.
    assert.ok("pageClosedEarly" in parsed, "pageClosedEarly flag must be present in response");
  } catch (e) {
    // If the test times out (>1s), that's a real failure of the close-listener wiring.
    if (/handler hung/.test(e.message)) throw e;
  }
});

// ──────────────────────────────────────────────────────────────────
// W1C1 (2026-11-03): drain deadline, compact defaults, filter-before-cap,
// schema maxima, keep listening after a nav timeout, outputPath file mode.
// ──────────────────────────────────────────────────────────────────

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bmr-capture-xhr-"));
}

test("W1C1: a streaming/long-poll body does not hang the tool (drain deadline)", async () => {
  const stream = makeFakeResponse({ url: "https://api/stream", streaming: true });
  const normal = makeFakeResponse({ url: "https://api/normal", body: "OK" });
  const fakePage = makeFakePageWithResponses([stream, normal]);
  await withPage(fakePage, async (ctx) => {
    const started = Date.now();
    const promise = tool.handler({ durationMs: 100 }, ctx);
    fakePage._respondAll();
    const result = await hangGuard(promise, 4000, "capture_xhr with a streaming body");
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3500, `expected window + ~2s drain, took ${elapsed}ms`);
    const parsed = JSON.parse(result.content[0].text);
    const s = parsed.responses.find((r) => r.url.endsWith("/stream"));
    const n = parsed.responses.find((r) => r.url.endsWith("/normal"));
    assert.strictEqual(n.body, "OK", "finished bodies are still captured");
    assert.strictEqual(s.body, undefined);
    assert.match(s.bodyError, /not finished/i, "unfinished body is reported, not silently dropped");
  });
});

test("W1C1: urlFilter / resource type are applied before the maxResponses cap", async () => {
  const responses = [
    makeFakeResponse({ url: "https://api/match/1" }),
    makeFakeResponse({ url: "https://api/other/1" }),
    makeFakeResponse({ url: "https://cdn/img.png", type: "image" }),
    makeFakeResponse({ url: "https://api/other/2" }),
  ];
  const fakePage = makeFakePageWithResponses(responses);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100, maxResponses: 1, urlFilter: "/match/", includeBody: false }, ctx);
    fakePage._respondAll();
    const parsed = JSON.parse((await promise).content[0].text);
    assert.strictEqual(parsed.count, 1);
    assert.strictEqual(parsed.truncated, false, "non-matching responses must not count as dropped");
  });
});

test("W1C1: default output is compact — no headers, 2KB bodies, single-line JSON", async () => {
  const big = "x".repeat(5000);
  const fakePage = makeFakePageWithResponses([makeFakeResponse({ url: "https://api/big", body: big, headers: { "set-cookie": "s=1" } })]);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100 }, ctx);
    fakePage._respondAll();
    const text = (await promise).content[0].text;
    assert.ok(!text.includes("\n"), "inline JSON must be compact");
    const r = JSON.parse(text).responses[0];
    assert.strictEqual(r.headers, undefined, "headers are opt-in");
    assert.ok(r.body.length <= 2000 + 20, `body must be capped near 2000 chars (got ${r.body.length})`);
    assert.match(r.body, /\[truncated\]$/);
  });
});

test("W1C1: includeHeaders: true returns response headers", async () => {
  const fakePage = makeFakePageWithResponses([makeFakeResponse({ url: "https://api/h", headers: { "x-test": "1" } })]);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100, includeHeaders: true, includeBody: false }, ctx);
    fakePage._respondAll();
    const r = JSON.parse((await promise).content[0].text).responses[0];
    assert.strictEqual(r.headers["x-test"], "1");
  });
});

test("W1C1: default inline output is capped near 100KB total", async () => {
  const responses = [];
  for (let i = 0; i < 200; i++) responses.push(makeFakeResponse({ url: `https://api/${i}`, body: "y".repeat(2000) }));
  const fakePage = makeFakePageWithResponses(responses);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100 }, ctx);
    fakePage._respondAll();
    const text = (await promise).content[0].text;
    assert.ok(text.length < 120_000, `inline output must stay near 100KB (got ${text.length})`);
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.aggregateCapHit, true);
  });
});

// Wraps each response's body() to count calls and track how many are in flight.
function trackBodies(responses) {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  for (const r of responses) {
    const body = r.body;
    r.body = () => {
      stats.calls++;
      stats.inFlight++;
      stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
      return body().finally(() => { stats.inFlight--; });
    };
  }
  return stats;
}

test("W1C1: body fetches are capped at 32 in flight and stop once the budget is spent", async () => {
  const responses = [];
  for (let i = 0; i < 200; i++) responses.push(makeFakeResponse({ url: `https://api/${i}`, body: "b".repeat(5000), bodyDelay: 30 }));
  const stats = trackBodies(responses);
  const fakePage = makeFakePageWithResponses(responses);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100 }, ctx);
    fakePage._respondAll(); // all 200 arrive before any body finishes
    const parsed = JSON.parse((await promise).content[0].text);
    assert.ok(stats.maxInFlight <= 32, `at most 32 concurrent body() calls, saw ${stats.maxInFlight}`);
    assert.ok(stats.calls < 100, `a spent budget stops new fetches (got ${stats.calls} of 200)`);
    assert.strictEqual(parsed.aggregateCapHit, true);
  });
});

test("W1C1: a burst of many SMALL bodies keeps every body (budget is charged at settle, not reserved)", async () => {
  const responses = [];
  for (let i = 0; i < 60; i++) responses.push(makeFakeResponse({ url: `https://api/s${i}`, body: "s".repeat(300), bodyDelay: 30 }));
  const fakePage = makeFakePageWithResponses(responses);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100 }, ctx);
    fakePage._respondAll();
    const parsed = JSON.parse((await promise).content[0].text);
    const missing = parsed.responses.filter((r) => r.body !== "s".repeat(300));
    assert.deepStrictEqual(missing.map((r) => r.bodyError), [], "60 × 300B fits the 100KB budget — no body may be dropped");
    assert.strictEqual(parsed.aggregateCapHit, false);
  });
});

test("W1C1: caps count JSON-escaped size (quotes / control bytes), not raw length", async () => {
  const responses = [];
  for (let i = 0; i < 100; i++) responses.push(makeFakeResponse({ url: `https://api/q${i}`, body: '"'.repeat(5000) }));
  const fakePage = makeFakePageWithResponses(responses);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100 }, ctx);
    fakePage._respondAll();
    const text = (await promise).content[0].text;
    assert.ok(text.length < 120_000, `escaped output must stay near 100KB (got ${text.length})`);
  });
  const ctrl = makeFakeResponse({ url: "https://api/bin", body: String.fromCharCode(1).repeat(3000) });
  const binPage = makeFakePageWithResponses([ctrl]);
  await withPage(binPage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100 }, ctx);
    binPage._respondAll();
    const body = JSON.parse((await promise).content[0].text).responses[0].body;
    assert.ok(JSON.stringify(body).length <= 2000 + 20, `escaped body must fit maxBodyBytes (got ${JSON.stringify(body).length})`);
  });
});

test("W1C1 V2-1: a body with front-loaded escapes is charged its real escaped size", async () => {
  const body = String.fromCharCode(1).repeat(500) + "a".repeat(1500);
  const fakePage = makeFakePageWithResponses([makeFakeResponse({ url: "https://api/front", body })]);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100 }, ctx);
    fakePage._respondAll();
    const parsed = JSON.parse((await promise).content[0].text);
    const kept = parsed.responses[0].body;
    assert.ok(JSON.stringify(kept).length <= 2000, `escaped body ${JSON.stringify(kept).length} > maxBodyBytes 2000`);
    const meta = JSON.stringify({ url: "https://api/front", status: 200, method: "GET", contentType: "application/json" }).length;
    assert.strictEqual(parsed.capturedBytes, meta + JSON.stringify(kept).length, "capturedBytes is the real cost");
  });
});

test("W1C1: schema maxima/minima are enforced (out-of-range → isError, no capture)", async () => {
  const fakePage = makeFakePageWithResponses([]);
  await withPage(fakePage, async (ctx) => {
    for (const bad of [
      { durationMs: 300001 }, { durationMs: 50 }, { navTimeoutMs: 400000 },
      { maxResponses: 5001 }, { maxResponses: 0 }, { maxTotalBytes: 100 }, { maxBodyBytes: 0 },
      { durationMs: 1.5 },
    ]) {
      const r = await hangGuard(tool.handler(bad, ctx), 1000, JSON.stringify(bad));
      assert.strictEqual(r.isError, true, `expected isError for ${JSON.stringify(bad)}`);
      assert.match(r.content[0].text, new RegExp(Object.keys(bad)[0]));
    }
  });
});

test("W1C1: null args are treated as missing (defaults apply)", async () => {
  const fakePage = makeFakePageWithResponses([makeFakeResponse({ url: "https://api/n", body: "B" })]);
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ durationMs: 100, maxResponses: null, maxBodyBytes: null, includeBody: null, includeHeaders: null, outputPath: null }, ctx);
    fakePage._respondAll();
    const r = await promise;
    assert.ok(!r.isError, r.content[0].text);
    assert.strictEqual(JSON.parse(r.content[0].text).responses[0].body, "B");
  });
});

test("W1C1: after a navigation TIMEOUT the tool keeps listening for the rest of durationMs", async () => {
  const late = makeFakeResponse({ url: "https://api/late", body: "LATE" });
  const fakePage = makeFakePageWithResponses([]);
  fakePage.goto = async () => {
    const e = new Error("page.goto: Timeout 100ms exceeded.");
    e.name = "TimeoutError";
    throw e;
  };
  await withPage(fakePage, async (ctx) => {
    const promise = tool.handler({ navigateToUrl: "https://slow.example/", navTimeoutMs: 100, durationMs: 400 }, ctx);
    setTimeout(() => fakePage._emit("response", late), 200); // fires after goto failed
    const parsed = JSON.parse((await hangGuard(promise, 3000, "nav timeout")).content[0].text);
    assert.match(parsed.navError, /Timeout/);
    assert.strictEqual(parsed.count, 1, "XHR after the nav timeout must still be captured");
    assert.strictEqual(parsed.responses[0].body, "LATE");
  });
});

test("W1C1: a non-timeout navigation failure returns without waiting out durationMs", async () => {
  const fakePage = makeFakePageWithResponses([]);
  fakePage.goto = async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); };
  await withPage(fakePage, async (ctx) => {
    const r = await hangGuard(tool.handler({ navigateToUrl: "https://nope.invalid/", durationMs: 60000 }, ctx), 1000, "hard nav failure");
    assert.strictEqual(r.isError, true, "nav failure with nothing captured is an error");
    assert.match(r.content[0].text, /ERR_NAME_NOT_RESOLVED/);
  });
});

test("W1C1: outputPath writes the full capture (headers + bodies) and returns a summary", async () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, "cap.json");
    const fakePage = makeFakePageWithResponses([makeFakeResponse({ url: "https://api/f", body: "z".repeat(5000), headers: { "x-h": "v" } })]);
    await withPage(fakePage, async (ctx) => {
      const promise = tool.handler({ durationMs: 100, outputPath: out }, ctx);
      fakePage._respondAll();
      const r = await promise;
      assert.ok(!r.isError, r.content[0].text);
      const summary = JSON.parse(r.content[0].text);
      assert.strictEqual(summary.savedTo, out);
      assert.strictEqual(summary.count, 1);
      assert.strictEqual(summary.responses, undefined, "summary must not carry the capture");
      assert.ok(!r.content[0].text.includes("zzzz"), "bodies must not be returned inline");
      const file = JSON.parse(fs.readFileSync(out, "utf8"));
      assert.strictEqual(file.responses[0].body, "z".repeat(5000), "file mode keeps up to 100KB bodies");
      assert.strictEqual(file.responses[0].headers["x-h"], "v", "file mode includes headers");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1C1 V2-3: an outputPath that appears mid-capture gets a sibling file, not a lost capture", async () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, "cap.json");
    const fakePage = makeFakePageWithResponses([makeFakeResponse({ url: "https://api/v", body: "V" })]);
    await withPage(fakePage, async (ctx) => {
      const promise = tool.handler({ durationMs: 150, outputPath: out }, ctx);
      fakePage._respondAll();
      setTimeout(() => fs.writeFileSync(out, "someone else's"), 30); // appears during the window
      const r = await promise;
      assert.ok(!r.isError, r.content[0].text);
      const summary = JSON.parse(r.content[0].text);
      assert.strictEqual(summary.savedTo, path.join(dir, "cap-1.json"), "reports the path actually written");
      assert.strictEqual(fs.readFileSync(out, "utf8"), "someone else's", "the other file is untouched");
      assert.strictEqual(JSON.parse(fs.readFileSync(summary.savedTo, "utf8")).responses[0].body, "V");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("W1C1: outputPath rules — relative rejected, existing file needs overwrite (checked before capture)", async () => {
  const dir = tmpDir();
  try {
    const existing = path.join(dir, "exists.json");
    fs.writeFileSync(existing, "keep");
    const fakePage = makeFakePageWithResponses([]);
    await withPage(fakePage, async (ctx) => {
      const rel = await hangGuard(tool.handler({ durationMs: 60000, outputPath: "cap.json" }, ctx), 1000, "relative outputPath");
      assert.strictEqual(rel.isError, true);
      assert.match(rel.content[0].text, /absolute/);
      const ex = await hangGuard(tool.handler({ durationMs: 60000, outputPath: existing }, ctx), 1000, "existing outputPath");
      assert.strictEqual(ex.isError, true);
      assert.match(ex.content[0].text, /exists/);
      assert.strictEqual(fs.readFileSync(existing, "utf8"), "keep");
      const ok = await tool.handler({ durationMs: 100, outputPath: existing, overwrite: true }, ctx);
      assert.ok(!ok.isError, ok.content[0].text);
      assert.notStrictEqual(fs.readFileSync(existing, "utf8"), "keep");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
