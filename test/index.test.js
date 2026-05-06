const test = require("node:test");
const assert = require("node:assert");

test("index.js can be required without spawning anything", () => {
  // index.js exports main() but only calls it when require.main === module.
  // Requiring from a test file should not trigger the launch.
  const mod = require("../src/index.js");
  assert.strictEqual(typeof mod.main, "function");
});
