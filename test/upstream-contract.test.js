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
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");

// Catalog-shaping env must not leak in from the developer's shell: a set
// FIGMA_ACCESS_TOKEN alone adds a tool. Each test file runs in its own
// process, so this only affects this file.
for (const k of ["FIGMA_ACCESS_TOKEN", "AVAILABLE_TOOL_DOMAINS", "TOOL_NAME_PREFIX", "TOOL_INPUT_METADATA_ENABLE", "BROWSER_RELAY_UPSTREAM_PATH",
  "BROWSER_ALLOWED_DOMAINS", "OTEL_ENABLE"]) {
  delete process.env[k];
}
// Hostile values loadUpstream must override or strip (asserted below).
Object.assign(process.env, {
  TELEMETRY_ENABLE: "true",
  BROWSER_CDP_OPEN_INSPECT: "true",
  TOOL_OUTPUT_SCHEMA_DISABLE: "false",
  PLATFORM: "node",
  BROWSER_PERSISTENT_ENABLE: "true",
  BROWSER_PERSISTENT_USER_DATA_DIR: path.join(os.tmpdir(), "bmr-should-never-be-used"),
});

const up = require("../src/broker/upstream-inproc.js");
const { brokerCallArgs, SERVER_INSTRUCTIONS, REFS_MAP_PROMISES, withoutRefsMapPromise } = require("../src/broker/main.js");
const { LESS_NEXT_TIME } = require("../src/broker/result-limit.js");
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

test("contract: the session context still reads response bodies through _safeReadResponseBody (capResponseBodies wraps it)", () => {
  const core = fs.readdirSync(UPSTREAM_DIST).filter((f) => /^core-.*\.js$/.test(f)).map((f) => fs.readFileSync(path.join(UPSTREAM_DIST, f), "utf8")).join("\n");
  assert.match(core, /async _safeReadResponseBody\(res\)/);
  assert.match(core, /await this\._safeReadResponseBody\(res\)/);
});

test("contract: the session context's browserContext is still a plain field (scopeRoutesToPage makes it an accessor)", () => {
  // scopeRoutesToPage refuses a context without the field at broker start; this catches a bump in CI, which has no Brave
  const core = fs.readdirSync(UPSTREAM_DIST).filter((f) => /^core-.*\.js$/.test(f)).map((f) => fs.readFileSync(path.join(UPSTREAM_DIST, f), "utf8")).join("\n");
  assert.match(core, /get page\(\)\{return this\._page\}constructor\(sessionId,browserContext,page,options\)\{this\._sessionId=sessionId,this\.browserContext=browserContext,/);
  assert.doesNotMatch(core, /[gs]et browserContext\(/);
});

const fakeResponse = (body, length) => ({ body, headers: () => (length === undefined ? {} : { "content-length": String(length) }) });

test("capResponseBodies: small bodies are kept; a big one of unknown size is cut; one declared over the limit is never read", async () => {
  const reads = [];
  const ctx = { _safeReadResponseBody: async function (res) { reads.push(this === ctx); return res.body; } };
  up.capResponseBodies(ctx);
  assert.strictEqual(await ctx._safeReadResponseBody(fakeResponse("small", 5)), "small");
  assert.strictEqual(await ctx._safeReadResponseBody(fakeResponse(undefined)), undefined);
  const big = "x".repeat(up.KEPT_BODY_CHARS + 500);
  const cut = await ctx._safeReadResponseBody(fakeResponse(big));
  assert.ok(cut.startsWith("x".repeat(up.KEPT_BODY_CHARS)));
  assert.ok(cut.length < big.length);
  assert.match(cut, /cut at \d+ of \d+ characters; capture_xhr/);
  const before = reads.length;
  const declared = up.KEPT_BODY_CHARS + 1;
  assert.strictEqual(await ctx._safeReadResponseBody(fakeResponse(big, declared)), `[response body not kept: ${declared} bytes; capture_xhr can save response bodies to a file]`);
  assert.strictEqual(reads.length, before, "reading it is what makes Playwright cache it for the page's lifetime");
  assert.ok(reads.every(Boolean), "the original runs with the context as this");
});

test("capResponseBodies: a tab stops reading bodies at its budget, per tab", async () => {
  let reads = 0;
  const makeCtx = () => ({ _safeReadResponseBody: async (res) => { reads++; return res.body; } });
  const [a, b] = [makeCtx(), makeCtx()];
  up.capResponseBodies(a);
  up.capResponseBodies(b);
  const chunk = fakeResponse("y".repeat(1024 * 1024));
  for (let i = 0; i < Math.ceil(up.READ_BUDGET_CHARS / (1024 * 1024)); i++) await a._safeReadResponseBody(chunk);
  const readSoFar = reads;
  assert.match(await a._safeReadResponseBody(chunk), /not kept: this tab has already read \d+ characters/);
  assert.strictEqual(reads, readSoFar);
  assert.ok((await b._safeReadResponseBody(fakeResponse("fine"))) === "fine", "another tab has its own budget");
});

test("contract: the tools the broker's call arguments apply to still exist with those arguments", () => {
  const core = fs.readdirSync(UPSTREAM_DIST).filter((f) => /^core-.*\.js$/.test(f)).map((f) => fs.readFileSync(path.join(UPSTREAM_DIST, f), "utf8")).join("\n");
  // each search stops at the next tool class, so a neighbour's keys can't satisfy it
  const inTool = `(?:(?!name\\(\\)\\{return")[\\s\\S])*?`;
  for (const tool of ["navigation_go-to", "navigation_reload", "navigation_go-back-or-forward"]) {
    assert.match(core, new RegExp(`name\\(\\)\\{return"${tool}"\\}${inTool}timeout:${inTool}includeScreenshot:${inTool}screenshotOptions:`), tool);
  }
  for (const tool of ["content_take-screenshot", "content_save-as-pdf", "content_start-recording"]) {
    assert.match(core, new RegExp(`name\\(\\)\\{return"${tool}"\\}${inTool}\\bname:`), tool);
  }
});

test("capResponseBodies: a context without the method is left alone", () => {
  const ctx = {};
  up.capResponseBodies(ctx);
  assert.deepStrictEqual(ctx, {});
});

test("contract: the session context still counts in-flight requests where trackInFlightRequests replaces the count", () => {
  const core = fs.readdirSync(UPSTREAM_DIST).filter((f) => /^core-.*\.js$/.test(f)).map((f) => fs.readFileSync(path.join(UPSTREAM_DIST, f), "utf8")).join("\n");
  // one method attaches the request listeners: to the first page in init(), and to a page re-created after a close
  assert.match(core, /_attachPageListeners\(page\)\{/);
  assert.match(core, /this\._attachPageListeners\(this\._page\),this\.options\.otelEnable/);
  assert.match(core, /this\._page=await this\.browserContext\.newPage\(\),this\._attachPageListeners\(this\._page\)/);
  // every reader goes through the accessor on the context: a direct read of the field would miss the replacement
  assert.match(core, /numOfInFlightRequests\(\)\{return this\._numOfInFlightRequests\}/);
  assert.strictEqual(core.match(/_numOfInFlightRequests/g).length, 6, "field, ++, two --, reset, accessor");
  assert.deepStrictEqual(core.match(/[\w.]*\.numOfInFlightRequests\(\)/g), Array(3).fill("context.numOfInFlightRequests()"));
  // upstream's count leaves its own telemetry posts out, by this rule on the context
  assert.match(core, /this\.otelController=new OTELController\(/);
  assert.match(core, /me\.otelController\.isOTELRequest\(req\)\|\|\(me\._numOfInFlightRequests\+\+/);
});

test("contract: Playwright's client still emits the per-frame event trackInFlightRequests listens to", () => {
  const client = path.join(path.dirname(createRequire(path.join(UPSTREAM_PKG_DIR, "package.json")).resolve("playwright-core/package.json")), "lib", "client");
  const frame = fs.readFileSync(path.join(client, "frame.js"), "utf8");
  // emitted for every navigation of the frame, before the public framenavigated, which is skipped on an error
  assert.match(frame, /this\._eventEmitter\.emit\("navigated", event\);\s*if \(!event\.error && this\._page\)\s*this\._page\.emit\([\w.]+\.FrameNavigated, this\)/);
  // a new document's request arrives as a channel, and Playwright itself reads the Request from it this way
  assert.match(frame, /navigatedEvent\.newDocument \? [\w.]+\.Request\.fromNullable\(navigatedEvent\.newDocument\.request\) : null/);
  assert.match(fs.readFileSync(path.join(client, "network.js"), "utf8"), /static from\(request\) \{\s*return request\._object;/);
});

function fakeRequest(frame, { type = "fetch" } = {}) {
  return {
    frame: () => { if (!frame) throw new Error("Service Worker requests do not have an associated frame."); return frame; },
    resourceType: () => type,
  };
}

const fakeFrame = () => ({ _eventEmitter: new EventEmitter() });
/** What Playwright's client emits on a frame that navigated; `request` as a channel, the way it arrives. */
const navigated = (frame, event) => frame._eventEmitter.emit("navigated", { url: "http://x/", ...event });
const newDocument = (request) => ({ newDocument: { request: request && { _object: request } } });

function fakeTrackedPage() {
  const page = new EventEmitter();
  const main = fakeFrame();
  page.frames = () => [main];
  return { page, main };
}

function trackedContext() {
  const { page, main } = fakeTrackedPage();
  const attached = [];
  const ctx = {
    page,
    _attachPageListeners(p) { attached.push([this, p]); },
    numOfInFlightRequests() { return -1; },
  };
  up.trackInFlightRequests(ctx);
  const attachFrame = () => { const f = fakeFrame(); page.emit("frameattached", f); return f; };
  return { ctx, page, main, attachFrame, attached };
}

test("trackInFlightRequests: a request counts until it finishes or fails", () => {
  const { ctx, page, main: frame } = trackedContext();
  const [a, b] = [fakeRequest(frame), fakeRequest(frame)];
  assert.strictEqual(ctx.numOfInFlightRequests(), 0);
  page.emit("request", a);
  page.emit("request", b);
  assert.strictEqual(ctx.numOfInFlightRequests(), 2);
  page.emit("requestfinished", a);
  assert.strictEqual(ctx.numOfInFlightRequests(), 1);
  page.emit("requestfailed", b);
  page.emit("requestfinished", a); // a second end event never takes the count below zero
  assert.strictEqual(ctx.numOfInFlightRequests(), 0);
});

test("trackInFlightRequests: a new document drops the old document's requests, which Playwright never ends", () => {
  const { ctx, page, main, attachFrame } = trackedContext();
  const inIframe = fakeRequest(attachFrame());
  for (const r of [fakeRequest(main), fakeRequest(main), inIframe]) page.emit("request", r);
  const nav = fakeRequest(main, { type: "document" });
  page.emit("request", nav);
  page.emit("request", fakeRequest(main)); // the old document can still start requests until the commit
  assert.strictEqual(ctx.numOfInFlightRequests(), 5);
  navigated(main, newDocument(nav));
  assert.strictEqual(ctx.numOfInFlightRequests(), 2, "the request that brought the document and the other frame's request stay");
  const fromNewDocument = fakeRequest(main);
  page.emit("request", fromNewDocument);
  page.emit("requestfinished", nav);
  assert.strictEqual(ctx.numOfInFlightRequests(), 2);
  page.emit("requestfinished", fromNewDocument);
  page.emit("requestfinished", inIframe);
  assert.strictEqual(ctx.numOfInFlightRequests(), 0);
});

test("trackInFlightRequests: a new document that no request brought (data:, about:blank, an error page) drops the old one's requests", () => {
  const { ctx, page, main } = trackedContext();
  page.emit("request", fakeRequest(main));
  page.emit("request", fakeRequest(main));
  navigated(main, newDocument(undefined));
  assert.strictEqual(ctx.numOfInFlightRequests(), 0);
});

test("trackInFlightRequests: a same-document navigation (pushState, #hash) keeps the document's requests", () => {
  const { ctx, page, main } = trackedContext();
  page.emit("request", fakeRequest(main));
  const nav = fakeRequest(main, { type: "document" });
  page.emit("request", nav); // even while a navigation to another document is on its way
  navigated(main, {});
  assert.strictEqual(ctx.numOfInFlightRequests(), 2);
});

test("trackInFlightRequests: a navigation that brought no document (204, download, refused) keeps the page's requests", () => {
  const { ctx, page, main } = trackedContext();
  page.emit("request", fakeRequest(main));
  const nav = fakeRequest(main, { type: "document" });
  page.emit("request", nav);
  navigated(main, { ...newDocument(nav), error: "net::ERR_ABORTED" }); // Playwright names the document it expected
  page.emit("requestfailed", nav);
  assert.strictEqual(ctx.numOfInFlightRequests(), 1);
});

test("trackInFlightRequests: an EventSource stream is never counted (it has no end)", () => {
  const { ctx, page, main } = trackedContext();
  const stream = fakeRequest(main, { type: "eventsource" });
  page.emit("request", stream);
  assert.strictEqual(ctx.numOfInFlightRequests(), 0);
  page.emit("requestfailed", stream);
  assert.strictEqual(ctx.numOfInFlightRequests(), 0);
});

test("trackInFlightRequests: a request upstream calls its own telemetry is never counted", () => {
  const { ctx, page, main } = trackedContext();
  const [telemetry, other] = [fakeRequest(main), fakeRequest(main)];
  ctx.otelController = { isOTELRequest: (req) => req === telemetry };
  page.emit("request", telemetry);
  page.emit("request", other);
  assert.strictEqual(ctx.numOfInFlightRequests(), 1);
});

test("trackInFlightRequests: a frame added later is watched too, and its new document drops only its own requests", () => {
  const { ctx, page, main, attachFrame } = trackedContext();
  const iframe = attachFrame();
  page.emit("request", fakeRequest(main));
  page.emit("request", fakeRequest(iframe));
  navigated(iframe, newDocument(undefined));
  assert.strictEqual(ctx.numOfInFlightRequests(), 1);
});

test("trackInFlightRequests: a detached frame's requests are dropped, other frames' stay", () => {
  const { ctx, page, main, attachFrame } = trackedContext();
  const iframe = attachFrame();
  page.emit("request", fakeRequest(main));
  page.emit("request", fakeRequest(iframe));
  page.emit("request", fakeRequest(iframe, { type: "document" }));
  page.emit("framedetached", iframe);
  assert.strictEqual(ctx.numOfInFlightRequests(), 1);
});

test("trackInFlightRequests: a request with no frame (service worker) is counted and survives a navigation", () => {
  const { ctx, page, main } = trackedContext();
  const noFrame = fakeRequest(null);
  page.emit("request", noFrame);
  const nav = fakeRequest(main, { type: "document" });
  page.emit("request", nav);
  navigated(main, newDocument(nav));
  assert.strictEqual(ctx.numOfInFlightRequests(), 2);
  page.emit("requestfinished", noFrame);
  assert.strictEqual(ctx.numOfInFlightRequests(), 1);
});

test("trackInFlightRequests: a page upstream re-creates starts from zero; upstream's own listeners still attach, once per page", () => {
  const { ctx, page, main, attached } = trackedContext();
  assert.deepStrictEqual(attached, [], "init() attached upstream's listeners to the first page already");
  page.emit("request", fakeRequest(main));
  assert.strictEqual(ctx.numOfInFlightRequests(), 1);
  const next = fakeTrackedPage();
  ctx._attachPageListeners(next.page); // what ensureSessionPageOpen() does after the page was closed
  assert.strictEqual(attached.length, 1);
  assert.ok(attached[0][0] === ctx && attached[0][1] === next.page, "upstream's method runs with the context as this");
  assert.strictEqual(ctx.numOfInFlightRequests(), 0);
  const onNext = fakeRequest(next.main);
  next.page.emit("request", onNext);
  page.emit("request", fakeRequest(main)); // a late event from the closed page
  assert.strictEqual(ctx.numOfInFlightRequests(), 1);
  navigated(next.main, newDocument(undefined)); // the new page's frames are watched as the first page's were
  assert.strictEqual(ctx.numOfInFlightRequests(), 0);
});

test("trackInFlightRequests: a context without the methods is left alone", () => {
  const ctx = {};
  up.trackInFlightRequests(ctx);
  assert.deepStrictEqual(ctx, {});
});

function shotContext() {
  const calls = [];
  const fakeShotPage = () => ({ async screenshot(...args) { calls.push(["page", this, ...args]); return "page"; } });
  const element = {
    async waitForElementState(...args) { calls.push(["wait", this, ...args]); },
    async screenshot(...args) { calls.push(["element", this, ...args]); return "element"; },
  };
  const attached = [];
  const ctx = { page: fakeShotPage(), _attachPageListeners(p) { attached.push([this, p]); } };
  up.screenshotTheElement(ctx);
  return { ctx, calls, element, attached, fakeShotPage };
}

test("screenshotTheElement: a page.screenshot() call that carries an element is taken from the element once it is visible, without fullPage", async () => {
  const { ctx, calls, element } = shotContext();
  assert.strictEqual(await ctx.page.screenshot({ type: "jpeg", fullPage: true, quality: 80, element }), "element");
  assert.deepStrictEqual(calls, [["wait", element, "visible", { timeout: 5000 }], ["element", element, { type: "jpeg", quality: 80 }]]);
});

test("screenshotTheElement: an element that does not become visible is not captured", async () => {
  const { ctx, calls, element } = shotContext();
  element.waitForElementState = async () => { throw new Error("element is not visible"); };
  await assert.rejects(ctx.page.screenshot({ element }), /element is not visible/);
  assert.deepStrictEqual(calls, []);
});

test("screenshotTheElement: any other page.screenshot() call reaches the page as it came", async () => {
  const { ctx, calls } = shotContext();
  const options = { type: "png", fullPage: true, element: null };
  assert.strictEqual(await ctx.page.screenshot(options), "page");
  assert.strictEqual(await ctx.page.screenshot(), "page");
  assert.strictEqual(calls.length, 2);
  assert.ok(calls[0][1] === ctx.page && calls[0][2] === options, "the page's own method, with the page as this and the caller's options");
  assert.deepStrictEqual(calls[1], ["page", ctx.page, undefined]);
});

test("screenshotTheElement: a page upstream re-creates is patched too; upstream's own listeners still attach", async () => {
  const { ctx, calls, element, attached, fakeShotPage } = shotContext();
  assert.deepStrictEqual(attached, [], "init() attached upstream's listeners to the first page already");
  const next = fakeShotPage();
  ctx._attachPageListeners(next); // what ensureSessionPageOpen() does after the page was closed
  assert.ok(attached.length === 1 && attached[0][0] === ctx && attached[0][1] === next, "upstream's method runs once, with the context as this");
  assert.strictEqual(await next.screenshot({ element }), "element");
  assert.strictEqual(await next.screenshot({}), "page");
  assert.deepStrictEqual(calls.map((c) => c[0]), ["wait", "element", "page"]);
});

test("screenshotTheElement: a context without the method is left alone", () => {
  const ctx = {};
  up.screenshotTheElement(ctx);
  assert.deepStrictEqual(ctx, {});
});

test("contract: upstream still passes the element to page.screenshot(), which has no such option; an element handle takes its own", () => {
  // screenshotTheElement turns the first call into the second. When either side changes, the shim can go.
  const core = fs.readdirSync(UPSTREAM_DIST).filter((f) => /^core-.*\.js$/.test(f)).map((f) => fs.readFileSync(path.join(UPSTREAM_DIST, f), "utf8")).join("\n");
  assert.match(core, /scopedElement&&\(screenshotOptions\.element=scopedElement\);let rawBuffer=await context\.page\.screenshot\(screenshotOptions\)/);
  assert.match(core, /scopedElement=await resolveSelectorOrRef\(context,options\.selector\)\.elementHandle\(/); // a handle, not a locator: only a handle has waitForElementState
  const client = path.join(path.dirname(createRequire(path.join(UPSTREAM_PKG_DIR, "package.json")).resolve("playwright-core/package.json")), "lib", "client");
  const [, body] = /\n {2}async screenshot\(options = \{\}\) \{([\s\S]*?)\n {2}\}/.exec(fs.readFileSync(path.join(client, "page.js"), "utf8")) || [];
  assert.ok(body, "page.screenshot() not found in Playwright's client");
  assert.doesNotMatch(body, /\.element\b/); // it sends its options on as they came, and the protocol has no `element`
  const handle = fs.readFileSync(path.join(client, "elementHandle.js"), "utf8");
  assert.match(handle, /\n {2}async screenshot\(options = \{\}\) \{/);
  assert.match(handle, /\n {2}async waitForElementState\(state, options = \{\}\) \{/); // the shim's own wait for a visible element
});

test("nestedTool: the result keeps only the keys the tool declares, and the broker's arguments are applied", async () => {
  const seen = [];
  const tool = {
    name: () => "upstream_name",
    inputSchema: () => ({ a: 1 }),
    outputSchema: () => ({ filePath: 1, image: 1 }),
    async handle(ctx, args) { seen.push([this === tool, ctx, args]); return { filePath: "f", image: { data: 1 }, _artifacts: [1], extra: 2 }; },
  };
  const nested = up.nestedTool(tool, "listed_name", (name, args) => ({ ...args, tagged: name }));
  assert.strictEqual(nested.name(), "upstream_name");
  assert.deepStrictEqual(nested.inputSchema(), { a: 1 });
  assert.deepStrictEqual(nested.outputSchema(), { filePath: 1, image: 1 });
  const ctx = {};
  assert.deepStrictEqual(await nested.handle(ctx, { x: 1 }), { filePath: "f", image: { data: 1 } });
  assert.deepStrictEqual(seen, [[true, ctx, { x: 1, tagged: "listed_name" }]]);
});

test("nestedTool: without nestedArgs the arguments pass through; a result that is not an object is returned as it is", async () => {
  let got;
  const tool = { name: () => "t", inputSchema: () => ({}), outputSchema: () => ({}), handle: async (ctx, args) => { got = args; return "text"; } };
  const args = { x: 1 };
  assert.strictEqual(await up.nestedTool(tool, "t").handle({}, args), "text");
  assert.strictEqual(got, args);
});

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

test("F1-20: loadUpstream patches the HttpResourceType enum before importing, idempotently (temp copy of the dist)", (t) => {
  // Never the junctioned node_modules (that's a live install): copy the
  // package under the repo so its bare imports still resolve through
  // <repo>/node_modules, and unpatch the copy.
  const patcher = require("../scripts/patch-bdmcp-bundle.js");
  const root = path.join(REPO_ROOT, ".tmp-profiles", `upstream-copy-${process.pid}`);
  const copyPkg = path.join(root, "browser-devtools-mcp");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(copyPkg, { recursive: true });
  fs.copyFileSync(path.join(UPSTREAM_PKG_DIR, "package.json"), path.join(copyPkg, "package.json"));
  fs.cpSync(UPSTREAM_DIST, path.join(copyPkg, "dist"), { recursive: true });
  fs.cpSync(path.join(UPSTREAM_PKG_DIR, "node_modules", "zod"), path.join(copyPkg, "node_modules", "zod"), { recursive: true });
  const core = patcher.findBundledCoreFile({ distDir: path.join(copyPkg, "dist") });
  let src = fs.readFileSync(core, "utf8");
  const m = patcher.MATCH_OTHER_ENTRY.exec(src);
  src = src.replace(m[1] + patcher.buildAdditions(m[1].split(".")[0]), m[1]);
  fs.writeFileSync(core, src);
  assert.ok(!src.includes('HttpResourceType2.PING="ping"'), "copy must start unpatched");

  const script = `
    require(${JSON.stringify(path.join(REPO_ROOT, "src", "broker", "upstream-inproc.js"))})
      .loadUpstream({ cdpUrl: ${JSON.stringify(DUMMY_CDP_URL)} })
      .then((u) => {
        let s = u.tools.find((e) => e.name === "o11y_get-http-requests").inputShape.resourceType;
        while (s && !s._def.values) s = s._def.innerType || s._def.schema;
        process.stdout.write(JSON.stringify(s ? s._def.values : null));
      }, (e) => { process.stderr.write(String(e && e.stack)); process.exit(1); });`;
  const env = { ...process.env, BROWSER_RELAY_UPSTREAM_PATH: path.join(copyPkg, "dist", "index.js") };
  const load = () => {
    const r = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };

  const values = load();
  assert.ok(fs.readFileSync(core, "utf8").includes('HttpResourceType2.PING="ping"'), "the copy's bundle was patched");
  assert.ok(values.some((v) => /^ping$/i.test(v)), `the imported enum must include ping (patched before import): ${values}`);
  const mtime = fs.statSync(core).mtimeMs;
  assert.deepStrictEqual(load(), values);
  assert.strictEqual(fs.statSync(core).mtimeMs, mtime, "already-patched bundle is not rewritten");
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

test("W2E/A8: loadUpstream resolves upstream from the env it is given (the broker's merged env), not process.env", async () => {
  delete process.env.BROWSER_RELAY_UPSTREAM_PATH;
  const missing = path.join(os.tmpdir(), "bmr-no-such-upstream-a8", "dist", "index.js");
  await assert.rejects(up.loadUpstream({ cdpUrl: DUMMY_CDP_URL, env: { BROWSER_RELAY_UPSTREAM_PATH: missing } }), /bmr-no-such-upstream-a8/);
  assert.strictEqual(process.env.BROWSER_RELAY_UPSTREAM_PATH, undefined, "nothing copied into process.env");
});

test("W2G: loadUpstream's two URL-printing errors never print a CDP URL's secret (already bound; imported with another URL)", () => {
  // Each in its own process: one upstream per process. Upstream connects
  // lazily, so neither needs a browser.
  const inproc = JSON.stringify(path.join(REPO_ROOT, "src", "broker", "upstream-inproc.js"));
  const A = `ws://127.0.0.1:1/${"a".repeat(64)}/devtools/browser`;
  const B = `ws://127.0.0.1:2/${"b".repeat(64)}/devtools/browser`;
  const scripts = {
    "already bound": `
      const up = require(${inproc});
      (async () => {
        await up.loadUpstream({ cdpUrl: ${JSON.stringify(A)} });
        await up.loadUpstream({ cdpUrl: ${JSON.stringify(B)} }).then(() => process.stdout.write("RESOLVED"), (e) => process.stdout.write(e.message));
      })();`,
    "imported with another URL": `
      const up = require(${inproc});
      const { pathToFileURL } = require("node:url");
      (async () => {
        Object.assign(process.env, up.FORCED_UPSTREAM_ENV, { BROWSER_CDP_ENDPOINT_URL: ${JSON.stringify(A)} });
        await import(pathToFileURL(up.locateUpstreamChunks(up.resolveUpstreamPackage(process.env).distDir).config).href);
        await up.loadUpstream({ cdpUrl: ${JSON.stringify(B)} }).then(() => process.stdout.write("RESOLVED"), (e) => process.stdout.write(e.message));
      })();`,
  };
  const env = { ...process.env };
  delete env.BROWSER_CDP_ENDPOINT_URL;
  delete env.BROWSER_RELAY_UPSTREAM_PATH;
  for (const [what, script] of Object.entries(scripts)) {
    const r = spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 60000 });
    assert.strictEqual(r.status, 0, `${what}: ${r.stderr}`);
    const msg = r.stdout;
    assert.match(msg, what === "already bound" ? /already bound to/ : /BROWSER_CDP_CONNECT_URL is/, `${what}: ${msg}`);
    assert.ok(!msg.includes("a".repeat(64)) && !msg.includes("b".repeat(64)), `${what} printed a secret: ${msg}`);
    assert.ok(msg.includes("ws://127.0.0.1:1/<redacted>/devtools/browser") && msg.includes("ws://127.0.0.1:2/<redacted>/devtools/browser"), `${what}: ${msg}`);
  }
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
    // nested calls get the arguments the broker gives them (src/broker/main.js)
    let nestedSeq = 0;
    upstream = await up.loadUpstream({ cdpUrl, nestedArgs: (name, args) => brokerCallArgs(name, args, args, `x${++nestedSeq}`) });
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

  test("forces the upstream env and strips BROWSER_PERSISTENT_*", () => {
    assert.strictEqual(process.env.TELEMETRY_ENABLE, "false");
    assert.strictEqual(process.env.BROWSER_CDP_OPEN_INSPECT, "false");
    assert.strictEqual(process.env.TOOL_OUTPUT_SCHEMA_DISABLE, "true");
    assert.strictEqual(process.env.PLATFORM, "browser");
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
    assert.strictEqual(cfg.PLATFORM, "browser");
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

  test("nested calls go through nestedTool; tools/call gets the tools themselves", () => {
    const exec = upstream.tools.find((t) => t.name === "execute");
    const registered = exec.tool.toolRegistry.tools;
    for (const e of upstream.tools) {
      if (e.name === "execute" || e.name === "scenario-run") continue;
      const nested = registered.get(e.tool.name());
      assert.ok(nested, `${e.name} is not callable from execute`);
      assert.notStrictEqual(nested.tool, e.tool, `${e.name} is registered unwrapped`);
      assert.strictEqual(nested.tool.name(), e.tool.name());
    }
    assert.strictEqual(registered.get("execute").tool, exec.tool);
  });

  test("contract: upstream's registry rejects a result with keys the tool does not declare; through nestedTool it passes", async () => {
    // content_take-screenshot and the navigation tools return `_artifacts`
    // without declaring it, so execute's callTool failed on them.
    const Registry = upstream.tools.find((t) => t.name === "execute").tool.toolRegistry.constructor;
    const z = up.resolveUpstreamPackage().require("zod");
    const tool = {
      name: () => "probe_tool",
      inputSchema: () => ({ label: z.string().default("shot") }),
      outputSchema: () => ({ filePath: z.string() }),
      handle: async (ctx, args) => ({ filePath: `${args.label}.png`, _artifacts: [{ type: "IMAGE" }] }),
    };
    const unwrapped = new Registry();
    unwrapped.addTool(tool);
    await assert.rejects(unwrapped.runTool({}, "probe_tool", {}), /Unrecognized key/, "upstream accepts undeclared keys now: nestedTool's filter can go");
    const wrapped = new Registry();
    wrapped.addTool(up.nestedTool(tool, "probe_tool", (name, args) => ({ ...args, label: `${args.label}-${name}` })));
    assert.deepStrictEqual(await wrapped.runTool({}, "probe_tool", {}), { filePath: "shot-probe_tool.png" }, "nestedArgs gets the parsed arguments, defaults filled in");
  });

  test("drift: the tools and arguments the broker's instructions and size advice name still exist", async () => {
    const { normalizeObjectSchema, safeParseAsync } = require("@modelcontextprotocol/sdk/server/zod-compat.js");
    const byName = new Map(upstream.tools.map((e) => [e.name, e]));
    const ownNames = new Set(require("../src/own-tools/index.js").tools.map((t) => t.name));
    const toolsIn = (text) => text.match(/\b[a-z0-9]+_[a-z][a-z0-9-]*[a-z0-9]\b/g) || [];
    for (const [name, hint] of Object.entries(LESS_NEXT_TIME)) {
      for (const n of [name, ...toolsIn(hint)]) assert.ok(byName.has(n), `LESS_NEXT_TIME names ${n}, which upstream no longer has`);
    }
    const named = toolsIn(SERVER_INSTRUCTIONS);
    assert.ok(named.length >= 6, `expected tool names in the instructions, found ${named}`);
    for (const name of [...named, "execute", "toolsets"]) assert.ok(byName.has(name) || ownNames.has(name), `the instructions name ${name}, which is not a tool`);

    // zod drops an unknown key without an error, so each given key must come back out
    const keysKept = (given, parsed, where) => {
      for (const [k, v] of Object.entries(given)) {
        assert.ok(parsed && Object.hasOwn(parsed, k), `${where}.${k} is no longer an argument`);
        if (v && typeof v === "object") keysKept(v, parsed[k], `${where}.${k}`);
      }
    };
    const snapshotLess = { includeSnapshot: false, snapshotOptions: { interactiveOnly: true } };
    const examples = {
      "navigation_go-to": { url: "https://example.com/", ...snapshotLess },
      "navigation_reload": snapshotLess,
      "navigation_go-back-or-forward": { direction: "back", ...snapshotLess },
      "a11y_take-aria-snapshot": { selector: "main", interactiveOnly: true, maxDepth: 3 },
      "content_get-as-html": { selector: "main", maxLength: 1000 },
      "content_get-as-text": { selector: "main", maxLength: 1000 },
      "o11y_get-console-messages": { limit: { count: 5 }, type: "error", search: "x" },
      "o11y_get-http-requests": { limit: { count: 5 }, resourceType: "fetch", status: { min: 400, max: 599 } },
      "execute": { code: "return 1;", timeoutMs: 1000 },
      "content_take-screenshot": { name: "x", selector: "e12" },
      "interaction_resize-viewport": { width: 390, height: 844 },
      "interaction_click": { selector: "e12" },
    };
    for (const name of Object.keys(LESS_NEXT_TIME)) assert.ok(examples[name], `no example arguments for ${name}`);
    for (const [name, args] of Object.entries(examples)) {
      const parsed = await safeParseAsync(normalizeObjectSchema(byName.get(name).inputShape), args);
      assert.ok(parsed.success, `${name} rejects ${JSON.stringify(args)}`);
      keysKept(args, parsed.data, name);
    }

    // The examples are only a guard if they hold every argument the texts name: `backticked`, camelCase, or written key:value.
    const notArguments = new Set(["output", "refs", "page", "callTool", "execute", "toolsets", "tabId"]); // result fields, a script's globals, tools, the broker's own argument
    const argsNamed = (text) => new Set([...text.matchAll(/`([A-Za-z]\w*)`|\b([a-z]{2,}(?:[A-Z][a-z0-9]+)+)\b|\b([a-z][A-Za-z]*):(?=[{\w])/g)]
      .map((m) => m[1] || m[2] || m[3]).filter((n) => !notArguments.has(n)));
    const deepKeys = (v) => (v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...deepKeys(x)]) : []);
    const inInstructions = argsNamed(SERVER_INSTRUCTIONS);
    assert.ok(inInstructions.size >= 3, `expected argument names in the instructions, found ${[...inInstructions]}`);
    const anyExample = new Set(Object.values(examples).flatMap(deepKeys));
    for (const arg of inInstructions) assert.ok(anyExample.has(arg), `the instructions name the argument ${arg}: add it to an example above, so it is checked against upstream`);
    for (const [name, hint] of Object.entries(LESS_NEXT_TIME)) {
      const known = new Set([name, ...toolsIn(hint)].flatMap((n) => deepKeys(examples[n]))); // the tool's own, and those of a tool the advice sends the caller to
      for (const arg of argsNamed(hint)) assert.ok(known.has(arg), `the advice for ${name} names the argument ${arg}: add it to that tool's example above`);
    }
  });

  test("drift: the descriptions that promise a refs map are the ones the broker rewords, and nothing it serves still promises one", () => {
    for (const [from] of REFS_MAP_PROMISES) {
      const holders = upstream.tools.filter((t) => t.description.includes(from)).map((t) => t.name);
      assert.strictEqual(holders.length, 1, `"${from}" is in ${holders.length} upstream descriptions (${holders}): upstream reworded it, update REFS_MAP_PROMISES`);
    }
    for (const t of upstream.tools) {
      const served = withoutRefsMapPromise({ name: t.name, description: t.description }).description;
      assert.doesNotMatch(served, /and `refs`|refs map/, `${t.name} still promises the refs map the broker leaves out`);
    }
  });

  test("drift: an argument the Inspector's tool list names is still that tool's argument", () => {
    const byName = new Map(upstream.tools.map((e) => [e.name, e]));
    let checked = 0;
    for (const { name, description } of require("../scripts/inspector-forwarded-tools.js").tools) {
      for (const [arg] of description.matchAll(/\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b/g)) { // camelCase: an argument name
        assert.ok(Object.hasOwn(byName.get(name).inputShape, arg), `the Inspector describes ${name} with ${arg}, which is not one of its arguments`);
        checked++;
      }
    }
    assert.ok(checked >= 1, "no argument name found in the Inspector's descriptions: this test checks nothing");
  });

  test("contract: execute's timeoutMs is 30 s by default and 120 s at most, and 0 is accepted", async () => {
    // docs/REFERENCE.md and the nestedArgs comment in main.js give these figures
    const { normalizeObjectSchema, safeParseAsync } = require("@modelcontextprotocol/sdk/server/zod-compat.js");
    const schema = normalizeObjectSchema(upstream.tools.find((t) => t.name === "execute").inputShape);
    const parse = (timeoutMs) => safeParseAsync(schema, { code: "return 1;", timeoutMs });
    assert.strictEqual((await parse(undefined)).data.timeoutMs, 30_000);
    assert.strictEqual((await parse(0)).data.timeoutMs, 0);
    assert.strictEqual((await parse(120_000)).success, true);
    assert.strictEqual((await parse(120_001)).success, false);
  });

  test("contract: execute's callTool gives the script the output without a third argument", () => {
    // the instructions teach the two-argument form; the size advice for execute says what the third one adds
    const { description } = upstream.tools.find((t) => t.name === "execute");
    assert.match(description, /Returns the tool output for in-code use\.\s+returnOutput=true also includes it in the response toolOutputs array; false \(default\) omits it\./);
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

  test("execute: session-less (scenario store) tools run with ctx = null, no page or browser", async (t) => {
    // scenario store "global" scope lives under os.homedir(): point it at a temp dir
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-scenario-home-"));
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    process.env.USERPROFILE = process.env.HOME = home;
    t.after(() => {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      fs.rmSync(home, { recursive: true, force: true });
    });
    const tool = (n) => upstream.tools.find((e) => e.name === n);
    assert.strictEqual(tool("scenario-add").pageTool, false);
    await upstream.execute(null, tool("scenario-add").tool, { name: "w2b-probe", description: "d", script: "return 1;", scope: "global" });
    const listed = await upstream.execute(null, tool("scenario-list").tool, { scope: "global" });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(listed)).scenarios.map((s) => s.name), ["w2b-probe"]);
    assert.ok(fs.existsSync(path.join(home, ".browser-devtools-mcp", "scenarios.json")), "wrote to the redirected home, not the real one");
  });

  test("stub_* and debug_* keep their stores by context.browserContext (so the per-page Proxy isolates them)", () => {
    // upstream: STORE_BY_CONTEXT2.get(ctx) for stubs, STORE_BY_CONTEXT.get(ctx)
    // for debug probes, with ctx = context.browserContext. If a bump re-keys
    // either store (e.g. by sessionId or a module global), isolation breaks.
    const scoped = upstream.tools.filter((e) => /^(stub|debug)_/.test(e.name));
    assert.strictEqual(scoped.length, 15, "4 stub_* + 11 debug_* tools in 0.6.12");
    for (const e of scoped) {
      assert.match(e.tool.handle.toString(), /context\.browserContext\b/, `${e.name} no longer keys its store by context.browserContext`);
    }
  });

  // ─────────── live: real Brave, real upstream session contexts ───────────

  test.describe("live session contexts", { skip: braveAvailable() ? false : "Brave not installed" }, () => {
    let site;
    let siteUrl;
    let harness;
    let sseOpened = 0;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    async function until(cond, what, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (!(await cond())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await sleep(25);
      }
    }

    test.before(async () => {
      site = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        if (u.pathname === "/api/ping") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ real: "pong" }));
          return;
        }
        if (u.pathname === "/slow") return; // never answered
        if (u.pathname === "/204") {
          res.writeHead(204);
          res.end();
          return;
        }
        if (u.pathname === "/sse") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          res.write(": open\n\n"); // and never ended
          sseOpened++;
          return;
        }
        if (u.pathname === "/r1" || u.pathname === "/r2") {
          res.writeHead(302, { location: u.pathname === "/r1" ? "/r2" : "/page?tag=REDIR" });
          res.end();
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
      if (site) {
        const closed = new Promise((r) => site.close(r));
        site.closeAllConnections(); // /slow and /sse hold theirs open
        await closed;
      }
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

    test("debug probes are per session: A's watch is not listed in B", async () => {
      const { call } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=DA`, tabId: "dbg-a" });
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=DB`, tabId: "dbg-b" });
      await call("debug_add-watch", { expression: "document.title", tabId: "dbg-a" });
      const watches = async (tabId) => JSON.parse(await call("debug_list-probes", { tabId, types: ["watch"] })).watches.length;
      assert.strictEqual(await watches("dbg-a"), 1);
      assert.strictEqual(await watches("dbg-b"), 0, "B must not see (or share the debugger of) A's page");
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

    test("in-flight count: requests a navigation cut off are not counted on the next page", async () => {
      // Playwright reports neither requestfinished nor requestfailed for them,
      // so upstream's own count only grew and every later wait ran to its limit.
      const { call, getCtx } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=LEAK-A`, tabId: "leak" });
      const ctx = await getCtx("leak");
      await ctx.page.evaluate(() => { for (let i = 0; i < 3; i++) fetch(`/slow?i=${i}`).catch(() => {}); });
      await until(() => ctx.numOfInFlightRequests() === 3, "three open requests");
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=LEAK-B`, tabId: "leak" });
      assert.strictEqual(ctx.numOfInFlightRequests(), 0);
      await call("sync_wait-for-network-idle", { tabId: "leak", timeoutMs: 3000 });
    });

    test("in-flight count: an open EventSource does not keep the page busy", async () => {
      const { call, getCtx } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=SSE`, tabId: "sse" });
      const ctx = await getCtx("sse");
      const before = sseOpened;
      await ctx.page.evaluate(() => new Promise((resolve, reject) => {
        window.__es = new EventSource("/sse");
        window.__es.onopen = () => resolve();
        window.__es.onerror = () => reject(new Error("EventSource failed"));
      }));
      assert.strictEqual(sseOpened, before + 1);
      assert.strictEqual(ctx.numOfInFlightRequests(), 0);
      await call("sync_wait-for-network-idle", { tabId: "sse", timeoutMs: 3000 });
    });

    test("in-flight count: a redirect chain ends on the last page with nothing counted", async () => {
      const { call, getCtx } = harness;
      assert.match(await call("navigation_go-to", { url: `${siteUrl}/r1`, tabId: "redir" }), /page-REDIR/);
      assert.strictEqual((await getCtx("redir")).numOfInFlightRequests(), 0);
    });

    test("in-flight count: a document that comes without a request (data:, about:blank, an error page) drops the old one's requests", async () => {
      const { call, getCtx } = harness;
      const closed = http.createServer();
      await new Promise((r) => closed.listen(0, "127.0.0.1", r));
      const refused = `http://127.0.0.1:${closed.address().port}/`;
      await new Promise((r) => closed.close(r));
      const ctx = await getCtx("norequest");
      for (const target of ["data:text/html,<h1>page-DATA</h1>", "about:blank", refused]) {
        await call("navigation_go-to", { url: `${siteUrl}/page?tag=NOREQ`, tabId: "norequest" });
        await ctx.page.evaluate(() => { fetch("/slow").catch(() => {}); });
        await until(() => ctx.numOfInFlightRequests() === 1, "one open request");
        const went = call("navigation_go-to", { url: target, tabId: "norequest", includeSnapshot: false, waitForNavigation: false });
        if (target === refused) await assert.rejects(went, /ERR_CONNECTION_REFUSED/);
        else await went;
        await until(() => ctx.numOfInFlightRequests() === 0, `nothing counted after ${target}`, 2000);
      }
    });

    test("in-flight count: a navigation that brings no new document (204, pushState, #hash) keeps the page's requests", async () => {
      const { call, getCtx } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=STAY`, tabId: "stay" });
      const ctx = await getCtx("stay");
      await ctx.page.evaluate(() => { fetch("/slow").catch(() => {}); });
      await until(() => ctx.numOfInFlightRequests() === 1, "one open request");
      await assert.rejects(call("navigation_go-to", { url: `${siteUrl}/204`, tabId: "stay", waitForNavigation: false }), /ERR_ABORTED/);
      assert.strictEqual(ctx.numOfInFlightRequests(), 1, "after a 204");
      await ctx.page.evaluate(() => { history.pushState({}, "", "/pushed"); location.hash = "x"; });
      assert.match(ctx.page.url(), /\/pushed#x$/);
      assert.strictEqual(ctx.numOfInFlightRequests(), 1, "after pushState and #hash");
    });

    test("going back returns once the earlier page is showing", async () => {
      // With the back/forward cache on, the restored page fires no load event
      // over CDP and the call ran to its timeout (brave-supervisor.js).
      const { call } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=BACK-A`, tabId: "back" });
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=BACK-B`, tabId: "back" });
      assert.match(await call("navigation_go-back-or-forward", { direction: "back", timeout: 8000, tabId: "back" }), /page-BACK-A/);
    });

    test("execute: screenshots at two widths in one call are two files", async () => {
      const { call } = harness;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-shots-"));
      try {
        await call("navigation_go-to", { url: `${siteUrl}/page?tag=SHOT`, tabId: "shot" });
        const r = JSON.parse(await call("execute", {
          tabId: "shot",
          code: `const files = [];
            for (const width of [800, 400]) {
              await callTool('interaction_resize-viewport', { width, height: 600 });
              const shot = await callTool('content_take-screenshot', { outputPath: ${JSON.stringify(dir)}, name: 'w', type: 'png', fullPage: false });
              files.push(shot.filePath);
            }
            return files;`,
        }));
        assert.ok(!r.error, r.error);
        const [wide, narrow] = r.result;
        assert.notStrictEqual(wide, narrow, "the second screenshot overwrote the first");
        const pngWidth = (file) => fs.readFileSync(file).readUInt32BE(16);
        assert.ok(pngWidth(wide) > pngWidth(narrow), `${pngWidth(wide)} px then ${pngWidth(narrow)} px`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("execute: a nested navigation returns its screenshot file", async () => {
      const { call } = harness;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-shots-"));
      try {
        const args = { url: `${siteUrl}/page?tag=NAVSHOT`, includeSnapshot: false, includeScreenshot: true, screenshotOptions: { outputPath: dir } };
        const r = JSON.parse(await call("execute", {
          tabId: "navshot",
          code: `return (await callTool('navigation_go-to', ${JSON.stringify(args)})).screenshotFilePath;`,
        }));
        assert.ok(!r.error, r.error);
        assert.ok(fs.existsSync(r.result), `no screenshot at ${r.result}`);
        assert.strictEqual(path.dirname(r.result), dir);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("execute: timeoutMs 0 is no time limit, not an instant one", async () => {
      const r = JSON.parse(await harness.call("execute", { tabId: "nolimit", timeoutMs: 0, code: "await page.waitForTimeout(200); return 'done';" }));
      assert.ok(!r.error, r.error);
      assert.strictEqual(r.result, "done");
    });

    test("content_take-screenshot with a selector, a snapshot ref or CSS, is that element's image", async () => {
      // the broker's instructions say a ref works here; upstream alone returned the viewport
      const { call, getCtx } = harness;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bmr-shots-"));
      try {
        const open = async () => {
          const page = JSON.parse(await call("navigation_go-to", { url: `${siteUrl}/page?tag=REFSHOT`, tabId: "refshot" }));
          const [, ref] = /page-REFSHOT.*\[ref=(e\d+)\]/.exec(page.output) || [];
          assert.ok(ref, `no ref for the heading in ${page.output}`);
          return ref;
        };
        const shot = async (name, more) => {
          const r = JSON.parse(await call("content_take-screenshot", { tabId: "refshot", outputPath: dir, name, type: "png", ...more }));
          return { height: fs.readFileSync(r.filePath).readUInt32BE(20), annotations: r.annotations };
        };
        const ref = await open();
        const viewport = (await shot("viewport")).height;
        const byRef = (await shot("by-ref", { selector: ref })).height;
        assert.ok(byRef < viewport / 2, `the heading's screenshot is ${byRef} px high, the viewport's ${viewport} px`);
        assert.strictEqual((await shot("by-css", { selector: "h1", fullPage: true })).height, byRef, "a CSS selector gives the same image, with fullPage or without");
        const marked = await shot("marked", { selector: ref, annotate: true });
        assert.strictEqual(marked.height, byRef);
        assert.deepStrictEqual(marked.annotations.map((a) => [a.ref, a.box.x, a.box.y]), [[ref, 0, 0]], "upstream's annotation boxes are relative to the element");

        await (await getCtx("refshot")).page.close(); // upstream opens a new page on the next call
        assert.strictEqual((await shot("reopened", { selector: await open() })).height, byRef, "on a page upstream re-created");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("content_take-screenshot of an element that is not visible fails within seconds and says so", async () => {
      // an element's screenshot waits for the element to be visible: Playwright's default would be 30 s
      const { call, getCtx } = harness;
      await call("navigation_go-to", { url: `${siteUrl}/page?tag=HIDDEN`, tabId: "hidden" });
      const { page } = await getCtx("hidden");
      for (const css of ["display:none", "height:0;overflow:hidden"]) {
        await page.evaluate((style) => { document.querySelector("h1").style.cssText = style; }, css);
        const started = Date.now();
        await assert.rejects(call("content_take-screenshot", { tabId: "hidden", selector: "h1", type: "png" }), /Timeout 5000ms exceeded[\s\S]*element is not visible/, css);
        const took = Date.now() - started;
        assert.ok(took < 10_000, `${css}: failed after ${took} ms`);
      }
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
