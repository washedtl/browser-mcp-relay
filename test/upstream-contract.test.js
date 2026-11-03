// upstream-contract.test.js — W2B (v0.4 shared broker).
//
// The broker runs browser-devtools-mcp in-process and leans on its internals:
// chunk export names, platformInfo.toolsInfo, BrowserToolSessionContext
// fields, executor.executeTool, zod v3 shapes. This file imports the
// INSTALLED dist and asserts every one of those, so an upstream bump fails
// here, loudly, instead of in a live session.
//
// Static checks need no browser. The live block launches a throwaway Brave
// (test/fixtures/temp-brave.js) and skips cleanly when Brave is absent.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

// Catalog-shaping env must not leak in from the developer's shell: a set
// FIGMA_ACCESS_TOKEN alone adds a tool. Each test file runs in its own
// process, so this only affects this file.
for (const k of ["FIGMA_ACCESS_TOKEN", "AVAILABLE_TOOL_DOMAINS", "TOOL_NAME_PREFIX", "TOOL_INPUT_METADATA_ENABLE", "PLATFORM", "BROWSER_RELAY_UPSTREAM_PATH"]) {
  delete process.env[k];
}

const up = require("../src/broker/upstream-inproc.js");
const { braveAvailable, launchTempBrave } = require("./fixtures/temp-brave.js");

const PINNED_UPSTREAM_VERSION = "0.6.12";
// 49 enabled browser tools (figma_* is off without FIGMA_ACCESS_TOKEN) + execute + scenario-run.
const EXPECTED_TOOL_COUNT = 51;
const EXPECTED_SESSIONLESS = ["scenario-add", "scenario-update", "scenario-delete", "scenario-list", "scenario-search"];
const DUMMY_CDP_URL = "http://127.0.0.1:9"; // discard port: nothing listens, never connected to

const REPO_ROOT = path.resolve(__dirname, "..");
const UPSTREAM_PKG_DIR = path.dirname(require.resolve("browser-devtools-mcp/package.json"));
const UPSTREAM_DIST = path.join(UPSTREAM_PKG_DIR, "dist");

const isZ3 = (s) => !!s && typeof s === "object" && s._def !== undefined && s._zod === undefined;

// ─────────────────── export-statement chunk discovery (pure) ───────────────────

test("parseExportNames: reads the trailing export list and resolves `a as b` to b", () => {
  const src = "var x=1;function f(){}export{augmentToolInputSchema,ToolRegistry,platformInfo2 as platformInfo};\n";
  assert.deepStrictEqual(up.parseExportNames(src), ["augmentToolInputSchema", "ToolRegistry", "platformInfo"]);
});

test("parseExportNames: a file without a trailing export statement has no exports", () => {
  assert.deepStrictEqual(up.parseExportNames("#!/usr/bin/env node\nmain().catch(()=>{});"), []);
  assert.deepStrictEqual(up.parseExportNames("export{a};\nmain();"), [], "export must be the last statement");
});

test("findChunkByExports: matches by export names, whatever the file is called", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-chunks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "core-RENAMED1.js"), "export{a,b as platformInfo};");
  fs.writeFileSync(path.join(dir, "zzz-other.js"), "export{normalizeToolName};");
  fs.writeFileSync(path.join(dir, "index.js"), "main();");
  assert.strictEqual(up.findChunkByExports(dir, ["platformInfo"]), path.join(dir, "core-RENAMED1.js"));
  assert.strictEqual(up.findChunkByExports(dir, ["normalizeToolName"]), path.join(dir, "zzz-other.js"));
});

test("findChunkByExports: throws when no chunk, or more than one, exports the signature", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-chunks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "a.js"), "export{Execute};");
  fs.writeFileSync(path.join(dir, "b.js"), "export{Execute,other};");
  assert.throws(() => up.findChunkByExports(dir, ["missingThing"]), /no upstream chunk exports \{missingThing\}/);
  assert.throws(() => up.findChunkByExports(dir, ["Execute"]), /2 upstream chunks export \{Execute\}/);
});

// ─────────────────── installed dist (static, no import) ───────────────────

test("contract: package.json still pins browser-devtools-mcp to the version this contract covers", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.strictEqual(pkg.dependencies["browser-devtools-mcp"], PINNED_UPSTREAM_VERSION,
    "upstream pin changed: re-verify every symbol in this file before moving the pin");
});

test("contract: every chunk signature resolves to exactly one file in the installed dist", () => {
  const chunks = up.locateUpstreamChunks(UPSTREAM_DIST);
  for (const [role, required] of Object.entries(up.CHUNK_SIGNATURES)) {
    assert.ok(chunks[role] && fs.existsSync(chunks[role]), `chunk for ${role} not found`);
    const names = up.parseExportNames(fs.readFileSync(chunks[role], "utf8"));
    for (const n of required) assert.ok(names.includes(n), `${role} chunk must export ${n}`);
  }
  assert.notStrictEqual(chunks.core, chunks.config);
});

test("lazy: requiring the broker modules imports nothing heavy and leaves the env alone", () => {
  const env = { ...process.env };
  for (const k of ["BROWSER_CDP_ENDPOINT_URL", "TELEMETRY_ENABLE", "BROWSER_CDP_OPEN_INSPECT", "TOOL_OUTPUT_SCHEMA_DISABLE"]) delete env[k];
  const script = `
    require(${JSON.stringify(path.join(REPO_ROOT, "src", "broker", "upstream-inproc.js"))});
    require(${JSON.stringify(path.join(REPO_ROOT, "src", "broker", "window-pages.js"))});
    const heavy = Object.keys(require.cache).filter((k) => /node_modules.(zod|playwright-core|playwright|@modelcontextprotocol|browser-devtools-mcp)./.test(k));
    process.stdout.write(JSON.stringify({ heavy, endpoint: process.env.BROWSER_CDP_ENDPOINT_URL ?? null, telemetry: process.env.TELEMETRY_ENABLE ?? null }));
  `;
  const r = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { heavy: [], endpoint: null, telemetry: null });
});

// ─────────────────── scopeRoutesToPage (fake session context) ───────────────────

// Same shape as upstream's BrowserToolSessionContext: a plain writable
// `browserContext` field and a `page` getter over `_page`.
class FakeSessionContext {
  constructor(browserContext, page) { this.browserContext = browserContext; this._page = page; }
  get page() { return this._page; }
}
function fakePage(name) {
  const calls = [];
  return {
    name, calls,
    route: async (...a) => { calls.push(["route", ...a]); return `${name}.route`; },
    unroute: async (...a) => { calls.push(["unroute", ...a]); return `${name}.unroute`; },
  };
}
function fakeContext(name) {
  const calls = [];
  const ctx = {
    name, calls,
    route: async (...a) => { calls.push(["route", ...a]); },
    unroute: async (...a) => { calls.push(["unroute", ...a]); },
    whoAmI() { return this === ctx ? `${name}:bound` : "unbound"; },
    plain: 42,
  };
  return ctx;
}

test("scopeRoutesToPage: route/unroute go to the session page, never the shared context", async () => {
  const real = fakeContext("real");
  const page = fakePage("p1");
  const ctx = new FakeSessionContext(real, page);
  up.scopeRoutesToPage(ctx);
  const handler = () => {};
  assert.strictEqual(await ctx.browserContext.route("**/*", handler, { times: 1 }), "p1.route");
  assert.strictEqual(await ctx.browserContext.unroute("**/*", handler), "p1.unroute");
  assert.deepStrictEqual(page.calls, [["route", "**/*", handler, { times: 1 }], ["unroute", "**/*", handler]]);
  assert.deepStrictEqual(real.calls, []);
});

test("scopeRoutesToPage: everything else passes through, methods bound to the real context", () => {
  const real = fakeContext("real");
  const ctx = new FakeSessionContext(real, fakePage("p1"));
  up.scopeRoutesToPage(ctx);
  assert.strictEqual(ctx.browserContext.whoAmI(), "real:bound");
  assert.strictEqual(ctx.browserContext.plain, 42);
});

test("scopeRoutesToPage: one stable object per page; a swapped page gets a fresh one", () => {
  // upstream keys its stub store by `context.browserContext` (WeakMap), so a
  // fresh object per page is what resets the store when the page is swapped.
  const ctx = new FakeSessionContext(fakeContext("real"), fakePage("p1"));
  up.scopeRoutesToPage(ctx);
  const first = ctx.browserContext;
  assert.strictEqual(ctx.browserContext, first, "same page => same object (store survives)");
  ctx._page = fakePage("p2");
  const second = ctx.browserContext;
  assert.notStrictEqual(second, first, "swapped page => new object (fresh store)");
  assert.strictEqual(ctx.browserContext, second);
});

test("scopeRoutesToPage: idempotent, and assigning browserContext replaces the real context", async () => {
  const page = fakePage("p1");
  const ctx = new FakeSessionContext(fakeContext("a"), page);
  up.scopeRoutesToPage(ctx);
  up.scopeRoutesToPage(ctx);
  await ctx.browserContext.route("x", () => {});
  assert.strictEqual(page.calls.length, 1, "double scoping must not double-route");
  ctx.browserContext = fakeContext("b");
  assert.strictEqual(ctx.browserContext.whoAmI(), "b:bound");
  await ctx.browserContext.route("y", () => {});
  assert.strictEqual(page.calls.length, 2, "replacement context is still page-scoped");
});

test("scopeRoutesToPage: refuses a context whose browserContext is no longer a writable field", () => {
  const ctx = new FakeSessionContext(fakeContext("a"), fakePage("p1"));
  Object.defineProperty(ctx, "browserContext", { value: fakeContext("a"), writable: false, configurable: true });
  assert.throws(() => up.scopeRoutesToPage(ctx), /browserContext is no longer a writable field/);
});

// ─────────────────── loadUpstream: failure path (before any successful load) ───────────────────

test("loadUpstream: a failed load is not cached, so a retry can succeed", async () => {
  process.env.BROWSER_RELAY_UPSTREAM_PATH = path.join(os.tmpdir(), "bmr-no-such-upstream", "dist", "index.js");
  try {
    await assert.rejects(up.loadUpstream({ cdpUrl: DUMMY_CDP_URL }), /BROWSER_RELAY_UPSTREAM_PATH/);
  } finally {
    delete process.env.BROWSER_RELAY_UPSTREAM_PATH;
  }
  // the next call (inside the live/static block below) must load for real
});

test("loadUpstream: rejects a missing or malformed cdpUrl", async () => {
  await assert.rejects(up.loadUpstream({}), /cdpUrl/);
  await assert.rejects(up.loadUpstream({ cdpUrl: "127.0.0.1:9222" }), /cdpUrl/);
});

// ─────────────────── loadUpstream against the installed dist ───────────────────

test.describe("loadUpstream (installed dist)", () => {
  let brave = null;
  let upstream;
  let cdpUrl = DUMMY_CDP_URL;

  test.before(async () => {
    // One upstream per process: its CDP endpoint is read once at import, so
    // launch the browser (if any) first and bind upstream to it.
    if (braveAvailable()) {
      brave = await launchTempBrave({ label: "contract" });
      cdpUrl = brave.cdpUrl;
    }
    upstream = await up.loadUpstream({ cdpUrl });
  });
  test.after(async () => {
    if (brave) {
      await brave.close(); // graceful Browser.close, kill fallback, profile removed
    }
  });

  test("version is the pinned upstream version", () => {
    assert.strictEqual(upstream.version, PINNED_UPSTREAM_VERSION);
  });

  test("memoized for the same cdpUrl; a different cdpUrl is refused", async () => {
    assert.strictEqual(await up.loadUpstream({ cdpUrl }), upstream);
    await assert.rejects(up.loadUpstream({ cdpUrl: "http://127.0.0.1:1" }), /already bound to/);
  });

  test("forces the upstream env from the design (§3) and strips BROWSER_PERSISTENT_*", () => {
    assert.strictEqual(process.env.TELEMETRY_ENABLE, "false");
    assert.strictEqual(process.env.BROWSER_CDP_OPEN_INSPECT, "false");
    assert.strictEqual(process.env.TOOL_OUTPUT_SCHEMA_DISABLE, "true");
    assert.strictEqual(process.env.BROWSER_CDP_ENDPOINT_URL, cdpUrl);
    assert.deepStrictEqual(Object.keys(process.env).filter((k) => k.startsWith("BROWSER_PERSISTENT_")), []);
  });

  test("forced env reached upstream's import-time config constants", async () => {
    const { pathToFileURL } = require("node:url");
    const cfg = await import(pathToFileURL(up.locateUpstreamChunks(UPSTREAM_DIST).config).href);
    assert.strictEqual(cfg.BROWSER_CDP_CONNECT_URL, cdpUrl);
    assert.strictEqual(cfg.BROWSER_CDP_OPEN_INSPECT, false);
    assert.strictEqual(cfg.TOOL_OUTPUT_SCHEMA_DISABLE, true);
    assert.strictEqual(cfg.BROWSER_PERSISTENT_ENABLE, false);
  });

  test("exposes the Execute and ScenarioRun classes, wired into tools", () => {
    assert.strictEqual(typeof upstream.Execute, "function");
    assert.strictEqual(typeof upstream.ScenarioRun, "function");
    const exec = upstream.tools.find((t) => t.name === "execute");
    const run = upstream.tools.find((t) => t.name === "scenario-run");
    assert.ok(exec && exec.tool instanceof upstream.Execute);
    assert.ok(run && run.tool instanceof upstream.ScenarioRun);
    assert.strictEqual(exec.tool.toolRegistry, run.tool._toolRegistry, "one registry shared by execute + scenario-run");
    assert.ok(exec.tool.toolRegistry.tools.has("navigation_go-to"), "execute can callTool upstream tools");
    assert.ok(exec.tool.toolRegistry.tools.has("execute"), "scenario scripts can callTool execute (upstream wiring)");
  });

  test("tools: pinned count, unique names, {name, description, inputShape, tool}", () => {
    assert.strictEqual(upstream.tools.length, EXPECTED_TOOL_COUNT);
    const names = upstream.tools.map((t) => t.name);
    assert.strictEqual(new Set(names).size, names.length);
    for (const t of upstream.tools) {
      assert.strictEqual(typeof t.name, "string");
      assert.ok(typeof t.description === "string" && t.description.length > 0, `${t.name} description`);
      assert.ok(t.inputShape && typeof t.inputShape === "object", `${t.name} inputShape`);
      assert.strictEqual(typeof t.tool.handle, "function", `${t.name} tool.handle`);
      assert.strictEqual(typeof t.tool.name, "function", `${t.name} tool.name()`);
    }
    for (const n of ["navigation_go-to", "content_get-as-text", "stub_mock-http-response", "stub_list", "execute", "scenario-run"]) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
  });

  test("inputShape: zod v3 throughout (the SDK rejects mixed v3/v4 shapes)", () => {
    for (const t of upstream.tools) {
      for (const [k, v] of Object.entries(t.inputShape)) assert.ok(isZ3(v), `${t.name}.${k} is not a zod v3 schema`);
    }
  });

  test("inputShape: optional string tabId on page tools only; no upstream tool declares its own", () => {
    const sessionless = upstream.tools.filter((t) => !t.pageTool).map((t) => t.name).sort();
    assert.deepStrictEqual(sessionless, [...EXPECTED_SESSIONLESS].sort());
    for (const t of upstream.tools) {
      assert.strictEqual(Object.hasOwn(t.tool.inputSchema(), "tabId"), false, `${t.name} declares tabId upstream`);
      if (t.pageTool) {
        assert.ok(t.inputShape.tabId, `${t.name} lacks tabId`);
        assert.strictEqual(t.inputShape.tabId._def.typeName, "ZodOptional");
        assert.strictEqual(t.inputShape.tabId._def.innerType._def.typeName, "ZodString");
        assert.strictEqual(t.inputShape.tabId.safeParse(undefined).success, true);
        assert.match(t.inputShape.tabId.description || "", /tabs_new/);
      } else {
        assert.strictEqual(t.inputShape.tabId, undefined, `${t.name} is session-less and must not take tabId`);
      }
    }
  });

  test("parity: names, descriptions and input schemas match upstream's own stdio tools/list", async (t) => {
    const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
    const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
    const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

    // ours, through the SDK (also proves McpServer accepts every shape)
    const server = new McpServer({ name: "w2b-parity", version: "0" }, { capabilities: { tools: {} } });
    for (const e of upstream.tools) {
      server.registerTool(e.name, { description: e.description, inputSchema: e.inputShape }, async () => ({ content: [] }));
    }
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const ours = new Client({ name: "w2b", version: "0" });
    await server.connect(st);
    await ours.connect(ct);
    const mine = (await ours.listTools()).tools;
    await ours.close();

    // theirs: a throwaway upstream stdio server (dummy CDP URL: no browser),
    // with its home redirected so it can't touch the real ~/.browser-devtools-mcp
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-parity-home-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const env = { ...process.env, TELEMETRY_ENABLE: "false", BROWSER_CDP_OPEN_INSPECT: "false", TOOL_OUTPUT_SCHEMA_DISABLE: "true", BROWSER_CDP_ENDPOINT_URL: DUMMY_CDP_URL, USERPROFILE: home, HOME: home };
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(UPSTREAM_DIST, "index.js")], env, stderr: "ignore" });
    const theirsClient = new Client({ name: "w2b", version: "0" });
    await theirsClient.connect(transport);
    let theirs;
    try { theirs = (await theirsClient.listTools()).tools; } finally { await theirsClient.close(); }

    assert.deepStrictEqual(mine.map((x) => x.name), theirs.map((x) => x.name));
    const byName = new Map(theirs.map((x) => [x.name, x]));
    for (const m of mine) {
      const u = byName.get(m.name);
      assert.strictEqual(m.description, u.description, `${m.name} description drifted`);
      const schema = JSON.parse(JSON.stringify(m.inputSchema));
      if (schema.properties && schema.properties.tabId) {
        assert.strictEqual(schema.properties.tabId.type, "string");
        assert.ok(!(schema.required || []).includes("tabId"));
        delete schema.properties.tabId;
        // The SDK serializes an empty upstream shape without
        // additionalProperties:false; with tabId added ours is non-empty.
        if (Object.keys(u.inputSchema.properties || {}).length === 0) delete schema.additionalProperties;
      }
      assert.deepStrictEqual(schema, u.inputSchema, `${m.name} inputSchema drifted`);
    }
  });

  test("execute: runs through upstream's executor and never forwards tabId", async () => {
    let opened = 0;
    const ctx = { ensureSessionPageOpen: async () => { opened++; } };
    let seen;
    const tool = { name: () => "w2b_probe", handle: async (c, args) => { seen = { c, args }; return { ok: true }; } };
    const r = await upstream.execute(ctx, tool, { tabId: "sub1", a: 1 });
    assert.deepStrictEqual(r, { ok: true });
    assert.strictEqual(opened, 1, "executor re-opens a closed session page first");
    assert.strictEqual(seen.c, ctx);
    assert.deepStrictEqual(seen.args, { a: 1 });
  });

  // ─────────── live: real Brave, real upstream session contexts ───────────

  test.describe("live session contexts", { skip: braveAvailable() ? false : "Brave not installed" }, () => {
    let site;
    let siteUrl;
    let harness;

    test.before(async () => {
      site = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        if (u.pathname === "/api/ping") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ real: "pong" }));
          return;
        }
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body><h1>page-${u.searchParams.get("tag") || "none"}</h1></body></html>`);
      });
      await new Promise((r) => site.listen(0, "127.0.0.1", r));
      siteUrl = `http://127.0.0.1:${site.address().port}`;
      harness = await makeHarness(); // creates no session context until a tool call
    });
    test.after(async () => {
      if (harness) await harness.close();
      if (site) await new Promise((r) => site.close(r));
    });

    test("concurrent first createContext calls share one CDP connection", async () => {
      // upstream caches its CDP connection check-then-set; three concurrent
      // first calls would otherwise open three connections to one Brave.
      const ctxs = await Promise.all([1, 2, 3].map((i) => upstream.createContext(`race:${i}`)));
      try {
        assert.strictEqual(new Set(ctxs.map((c) => c.browserContext.browser())).size, 1);
      } finally {
        for (const c of ctxs) await c.close();
      }
    });

    test("ctx contract: fields and methods the broker relies on", async () => {
      const ctx = await upstream.createContext("fields:1");
      try {
        assert.strictEqual(ctx.sessionId(), "fields:1");
        const pageDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ctx), "page");
        assert.ok(pageDesc && typeof pageDesc.get === "function", "page must be a prototype getter");
        for (const m of ["close", "ensureSessionPageOpen", "scenarioDepth", "executionContext"]) {
          assert.strictEqual(typeof ctx[m], "function", `ctx.${m}()`);
        }
        assert.strictEqual(ctx.executionContext().page, ctx.page);
        const bcDesc = Object.getOwnPropertyDescriptor(ctx, "browserContext");
        assert.strictEqual(typeof bcDesc.get, "function", "createContext must return a page-scoped ctx");
        assert.strictEqual(ctx.browserContext.browser().isConnected(), true);
        assert.strictEqual(ctx.page.context(), ctx.browserContext.browser().contexts()[0], "CDP attach uses the default context");
      } finally {
        await ctx.close();
      }
    });

    async function makeHarness() {
      const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
      const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
      // a minimal stand-in for W2A's SessionRegistry: one ctx per tabId
      const ctxs = new Map();
      const getCtx = (tabKey) => {
        if (!ctxs.has(tabKey)) ctxs.set(tabKey, upstream.createContext(`harness:${tabKey}`));
        return ctxs.get(tabKey);
      };
      const server = new McpServer({ name: "w2b-live", version: "0" }, { capabilities: { tools: {} } });
      for (const e of upstream.tools) {
        server.registerTool(e.name, { description: e.description, inputSchema: e.inputShape }, async (args) => {
          try {
            const ctx = await getCtx(args.tabId || "main");
            const r = await upstream.execute(ctx, e.tool, args);
            if (r && r.image) delete r.image;
            return { content: [{ type: "text", text: JSON.stringify(r) }] };
          } catch (err) {
            return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
          }
        });
      }
      const [ct, st] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "w2b", version: "0" });
      await server.connect(st);
      await client.connect(ct);
      const call = async (name, args = {}) => {
        const r = await client.callTool({ name, arguments: args });
        const text = (r.content || []).map((c) => c.text || "").join("\n");
        if (r.isError) throw new Error(`${name}: ${text}`);
        return text;
      };
      const close = async () => {
        await client.close();
        for (const p of ctxs.values()) { try { await (await p).close(); } catch {} }
      };
      return { call, getCtx, close };
    }

    const mock = (tabId, tag) => harness.call("stub_mock-http-response", {
      tabId,
      pattern: "**/api/ping",
      response: { status: 200, body: JSON.stringify({ mocked: tag }), headers: { "content-type": "application/json" } },
    });
    const pingText = async (tabId) => {
      await harness.call("navigation_go-to", { url: `${siteUrl}/api/ping`, tabId });
      return harness.call("content_get-as-text", { tabId });
    };
    const stubCount = async (tabId) => JSON.parse(await harness.call("stub_list", { tabId })).stubs.length;

    test("same page: an own-tool's DOM change on ctx.page is what upstream tools see", async () => {
      const { call, getCtx } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=A`, tabId: "same-a" });
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=B`, tabId: "same-b" });
      const ctxA = await getCtx("same-a");
      await ctxA.page.evaluate(() => {
        const p = document.createElement("p");
        p.textContent = "MARK-alpha";
        document.body.appendChild(p);
      });
      assert.match(await call("content_get-as-text", { tabId: "same-a" }), /MARK-alpha/);
      const textB = await call("content_get-as-text", { tabId: "same-b" });
      assert.match(textB, /page-B/);
      assert.doesNotMatch(textB, /MARK-alpha/);
    });

    test("stubs are page-scoped: A's mock is not served to, or listed in, B", async () => {
      await mock("stub-a", "byA");
      assert.match(await pingText("stub-a"), /byA/);
      const b = await pingText("stub-b");
      assert.match(b, /pong/);
      assert.doesNotMatch(b, /byA/);
      assert.strictEqual(await stubCount("stub-b"), 0);
      assert.strictEqual(await stubCount("stub-a"), 1);
    });

    test("page swap: upstream re-opens a closed page with a fresh stub store that routes", async () => {
      await mock("swap", "beforeSwap");
      assert.match(await pingText("swap"), /beforeSwap/);
      const ctx = await harness.getCtx("swap");
      const old = ctx.page;
      await old.close();
      assert.strictEqual(await stubCount("swap"), 0, "stubs routed on the closed page must not be listed for the new one");
      assert.notStrictEqual(ctx.page, old);
      await mock("swap", "afterSwap");
      assert.match(await pingText("swap"), /afterSwap/, "a stub added after the swap must route on the new page");
    });

    test("execute and scenario-run run against the caller's session", async () => {
      const { call } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=EXEC`, tabId: "exec" });
      const r = JSON.parse(await call("execute", {
        tabId: "exec",
        code: "await callTool('content_get-as-text', {}, true); return 'done';",
      }));
      assert.ok(!r.error, r.error);
      assert.strictEqual(r.result, "done");
      assert.match(JSON.stringify(r.toolOutputs), /page-EXEC/);
      const s = JSON.parse(await call("scenario-run", { tabId: "exec", name: "w2b-no-such-scenario" }));
      assert.strictEqual(s.scenarioName, "w2b-no-such-scenario");
      assert.match(s.error || "", /not found/i);
    });

    test("ctx.close() closes only that session's page", async () => {
      const { call, getCtx } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=KEEP`, tabId: "keep" });
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=GONE`, tabId: "gone" });
      const gone = await getCtx("gone");
      const browser = gone.browserContext.browser();
      await gone.close();
      assert.strictEqual(gone.page.isClosed(), true);
      assert.strictEqual(browser.isConnected(), true);
      assert.match(await call("content_get-as-text", { tabId: "keep" }), /page-KEEP/);
    });
  });
});
