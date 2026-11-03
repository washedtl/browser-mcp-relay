// package.json / package-lock.json invariants.

const test = require("node:test");
const assert = require("node:assert");

const pkg = require("../package.json");
const lock = require("../package-lock.json");

/** [major, minor, patch] of the lowest version a range like "^8.21.3" allows. */
function floor(range) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  assert.ok(m, `unparseable range ${range}`);
  return m.slice(1).map(Number);
}
function gte(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

test("lighthouse is an optional dependency (lighthouse_audit reports a clear error when it's missing)", () => {
  assert.strictEqual(pkg.dependencies.lighthouse, undefined, "lighthouse must not be a hard dependency");
  assert.ok(pkg.optionalDependencies && pkg.optionalDependencies.lighthouse, "lighthouse in optionalDependencies");
  assert.strictEqual(lock.packages["node_modules/lighthouse"].optional, true, "lockfile marks lighthouse optional");
});

test("ws is at or above 8.21.0 (GHSA-96hv-2xvq-fx4p, GHSA-58qx-3vcg-4xpx)", () => {
  assert.ok(gte(floor(pkg.dependencies.ws), [8, 21, 0]), `package.json ws range ${pkg.dependencies.ws}`);
  assert.ok(gte(floor(lock.packages["node_modules/ws"].version), [8, 21, 0]),
    `locked ws ${lock.packages["node_modules/ws"].version}`);
});

test("@modelcontextprotocol/sdk is at or above 1.32.0 (GHSA-22jm-h49p-29qw, GHSA-46jr-4wx8-v453 and 4 more)", () => {
  const range = pkg.dependencies["@modelcontextprotocol/sdk"];
  assert.ok(gte(floor(range), [1, 32, 0]), `package.json @modelcontextprotocol/sdk range ${range}`);
  const locked = lock.packages["node_modules/@modelcontextprotocol/sdk"].version;
  assert.ok(gte(floor(locked), [1, 32, 0]), `locked @modelcontextprotocol/sdk ${locked}`);
});

test("one @modelcontextprotocol/sdk in the tree: the relay and upstream (in-process or child) run the same patched copy", () => {
  const copies = Object.keys(lock.packages).filter((k) => k.endsWith("node_modules/@modelcontextprotocol/sdk"));
  assert.deepStrictEqual(copies, ["node_modules/@modelcontextprotocol/sdk"]);
});

// Transitive packages, floored at the first release that fixes every advisory
// npm audit reported for them. A package is checked while it is in the tree.
// Not floored: browser-devtools-mcp's own zod@3 and sharp@0.34, @hono/node-server's
// serveStatic advisory (no 1.x fix), and lighthouse@11's tree (needs lighthouse@13).
const LOCKED_FLOORS = [
  ["node_modules/proxy-addr", [2, 0, 8], "GHSA-jqcg-44mw-7w3h"],
  ["node_modules/hono", [4, 13, 11], "GHSA-5r4p-p66f-jhc7 and 20 more"],
  ["node_modules/@hono/node-server", [1, 19, 15], "GHSA-frvp-7c67-39w9"],
  ["node_modules/body-parser", [2, 4, 0], "GHSA-27r3-jxmh-p828, GHSA-v422-hmwv-36x6"],
  ["node_modules/qs", [6, 16, 1], "GHSA-6pq8-jhm2-2vcw and 3 more"],
  ["node_modules/fast-uri", [3, 1, 9], "GHSA-w74x-v6f9-j3xg and 10 more"],
  ["node_modules/ip-address", [10, 7, 4], "GHSA-rxp7-6hxx-x8q5 and 7 more"],
  ["node_modules/zod", [4, 6, 6], "GHSA-mrhx-c7xc-m3w5"],
  ["node_modules/@opentelemetry/core", [2, 8, 0], "GHSA-8988-4f7v-96qf"],
  ["node_modules/lighthouse/node_modules/ws", [7, 5, 11], "GHSA-96hv-2xvq-fx4p"],
];

test("locked transitive packages are at or above their advisory fixes", () => {
  for (const [key, min, advisories] of LOCKED_FLOORS) {
    const entry = lock.packages[key];
    if (!entry) continue;
    assert.ok(gte(floor(entry.version), min), `${key} ${entry.version} < ${min.join(".")} (${advisories})`);
  }
});

test("package-lock.json root mirrors package.json (lock regenerated after manifest edits)", () => {
  const root = lock.packages[""];
  assert.strictEqual(root.version, pkg.version);
  assert.deepStrictEqual(root.dependencies, pkg.dependencies);
  assert.deepStrictEqual(root.optionalDependencies, pkg.optionalDependencies);
});
