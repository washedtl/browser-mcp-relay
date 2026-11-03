// run-tests.test.js — drift guards for scripts/run-tests.js (`npm test`).

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const runner = require("../scripts/run-tests.js");

test("run-tests: every SERIAL_FILES entry exists; the two phases cover every test file exactly once", () => {
  const all = runner.findTestFiles();
  const { unit, serial } = runner.partition(all);
  assert.strictEqual(serial.length, runner.SERIAL_FILES.length);
  assert.deepStrictEqual([...unit, ...serial].sort(), all);
  assert.ok(all.includes(__filename), "this file is found");
});

test("run-tests: a missing SERIAL_FILES entry is an error, not a silently skipped file", () => {
  assert.throws(() => runner.partition([]), /SERIAL_FILES lists test[\\/]\S+, which does not exist/);
});

test("run-tests: every test file that drives a real Brave runs in the serial phase", () => {
  const serial = new Set(runner.SERIAL_FILES);
  const real = runner.findTestFiles()
    .filter((f) => /fixtures\/temp-brave\.js|detectBravePath\(\)/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(__dirname, f).split(path.sep).join("/"));
  assert.ok(real.includes("e2e-broker.test.js"), "the detection itself still works");
  assert.deepStrictEqual(real.filter((f) => !serial.has(f)), []);
});

test("run-tests: reads Node's own tests total from the spec and tap summaries, colored or not", () => {
  assert.strictEqual(runner.testsCount("✔ a (1ms)\nℹ tests 1125\nℹ suites 3\nℹ pass 1121\n"), 1125);
  assert.strictEqual(runner.testsCount("ok 1 - a\n1..1\n# tests 7\n# pass 7\n"), 7);
  assert.strictEqual(runner.testsCount("\x1b[34mℹ tests 42\x1b[39m\n"), 42);
  assert.strictEqual(runner.testsCount("no summary"), null);
});

test("run-tests: the README carries the test badge the runner checks and rewrites", () => {
  const n = runner.readBadge();
  assert.ok(Number.isInteger(n) && n > 0, "README has a tests-N%20passing badge");
  assert.strictEqual(runner.readBadge("[![Tests](https://img.shields.io/badge/tests-12%20passing-brightgreen.svg)](#)"), 12);
});

test("run-tests: package.json's test script is this runner", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.strictEqual(pkg.scripts.test, "node scripts/run-tests.js");
});
