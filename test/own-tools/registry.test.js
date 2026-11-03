// registry.test.js — src/own-tools/index.js: what the relay registers.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { tools } = require("../../src/own-tools/index.js");

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const routed = (t) => t.needsBrave !== false && t.needsPage !== false;

test("W2D: browser_show is registered", () => {
  assert.ok(byName.browser_show);
});

test("W2D: every page-routed own-tool advertises an optional string tabId", () => {
  const names = tools.filter(routed).map((t) => t.name);
  assert.ok(names.includes("capture_xhr") && names.includes("browser_show") && names.includes("stealth_apply"));
  for (const t of tools.filter(routed)) {
    assert.strictEqual(t.inputSchema.properties.tabId.type, "string", t.name);
    assert.match(t.inputSchema.properties.tabId.description, /tabs_new/, t.name);
    // Repeated in every routed schema; the long guidance lives in tabs_new.
    assert.ok(t.inputSchema.properties.tabId.description.length <= 60, t.name);
    assert.ok(!(t.inputSchema.required || []).includes("tabId"), `${t.name}: tabId must stay optional`);
  }
});

test("W2D: page-less tools don't get the routing tabId (tabs_select / tabs_close keep their own selector)", () => {
  for (const name of ["toolsets", "tabs_new", "tabs_list", "cookies_export", "cookies_import", "lighthouse_audit"]) {
    assert.ok(!("tabId" in byName[name].inputSchema.properties), name);
  }
  for (const name of ["tabs_select", "tabs_close"]) {
    assert.match(byName[name].inputSchema.properties.tabId.description, /from tabs_new \/ tabs_list/, name);
  }
});

test("W2D: adding tabId leaves the tool modules themselves untouched", () => {
  assert.ok(!("tabId" in require("../../src/own-tools/capture-xhr.js").inputSchema.properties));
  assert.strictEqual(byName.capture_xhr.handler, require("../../src/own-tools/capture-xhr.js").handler);
});

// Drift guard: own-tools get their page from ctx; the old globals are gone.
test("W2D: no own-tool reads globalThis.__relayBridge / __relayUpstream or the removed active-page helpers", () => {
  const dir = path.resolve(__dirname, "..", "..", "src", "own-tools");
  const offenders = [];
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    if (/globalThis\.__relay(Bridge|Upstream)|_active-page|_propagate-active-page/.test(src)) offenders.push(f);
  }
  assert.deepStrictEqual(offenders, []);
  assert.ok(!fs.existsSync(path.join(dir, "_active-page.js")));
  assert.ok(!fs.existsSync(path.join(dir, "_propagate-active-page.js")));
});
