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

test("package-lock.json root mirrors package.json (lock regenerated after manifest edits)", () => {
  const root = lock.packages[""];
  assert.strictEqual(root.version, pkg.version);
  assert.deepStrictEqual(root.dependencies, pkg.dependencies);
  assert.deepStrictEqual(root.optionalDependencies, pkg.optionalDependencies);
});
