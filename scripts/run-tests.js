#!/usr/bin/env node
// scripts/run-tests.js — `npm test`: the cross-shell, two-phase test runner.
//
// The glob is expanded here, in JS: PowerShell (the CI shell) passes
// `test/*.test.js` to node literally.
//
//   1. unit:   every test file except SERIAL_FILES, in one `node --test`
//              (files run in parallel).
//   2. serial: SERIAL_FILES, one `node --test <file>` at a time. They launch
//              real Brave, real brokers and shims, and time process races; run
//              next to each other (or next to phase 1) on a loaded machine
//              they starve each other into timeouts.
//
// Then the README test badge is checked against the total the two phases
// counted (Node's own "tests" figure, subtests included). Real-Brave suites
// only register their subtests when Brave is installed, so the badge is the
// count WITH Brave and is checked only when the real-Brave tests ran;
// `npm test -- --update-badge` rewrites it. The check is skipped when extra
// node flags (e.g. --test-name-pattern) or a reporter are passed.
//
// Usage: node scripts/run-tests.js [--update-badge] [node --test flags...]

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const TEST_DIR = path.join(REPO, "test");
const README = path.join(REPO, "README.md");

/** Run one at a time, after the unit phase (paths relative to test/). */
const SERIAL_FILES = [
  "brave-supervisor.test.js",
  "cdp-bridge.test.js",
  "cdp-lockdown.test.js",
  "cookie-bridge/core-e2e.test.js",
  "cookie-bridge/core-real-brave.test.js",
  "e2e-broker.test.js",
  "emulate-device-proxy.test.js",
  "shim.test.js",
  "upstream-contract.test.js",
  "window-pages.test.js",
];

const BADGE_RE = /tests-(\d+)%20passing/;

function findTestFiles(dir = TEST_DIR) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) out.push(full);
  }
  return out.sort();
}

/** {unit, serial}: absolute paths; throws if a SERIAL_FILES entry is missing. */
function partition(files = findTestFiles()) {
  const serial = SERIAL_FILES.map((f) => path.join(TEST_DIR, f));
  for (const f of serial) if (!files.includes(f)) throw new Error(`[run-tests] SERIAL_FILES lists ${path.relative(REPO, f)}, which does not exist`);
  return { unit: files.filter((f) => !serial.includes(f)), serial };
}

/** Node's summary line "ℹ tests N" (spec) or "# tests N" (tap), or null. */
function testsCount(output) {
  const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
  const m = /^(?:ℹ|#) tests (\d+)\s*$/m.exec(plain);
  return m ? Number(m[1]) : null;
}

/** One `node --test` run, its output passed through. Resolves {code, tests}. */
function runNodeTest(nodeArgs, files) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", ...nodeArgs, ...files], {
      stdio: ["inherit", "pipe", "inherit"],
      env: process.stdout.isTTY ? { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR || "1" } : process.env,
    });
    // decoded across chunk boundaries; only the tail (the summary) is kept
    child.stdout.setEncoding("utf8");
    let out = "";
    child.stdout.on("data", (d) => {
      out = (out + d).slice(-8192);
      process.stdout.write(d);
    });
    child.on("error", (e) => {
      process.stderr.write(`[run-tests] failed to spawn node --test: ${e.message}\n`);
      resolve({ code: 1, tests: null });
    });
    child.on("close", (code, signal) => resolve({ code: signal ? 1 : code ?? 1, tests: testsCount(out) }));
  });
}

function readBadge(readme = fs.readFileSync(README, "utf8")) {
  const m = BADGE_RE.exec(readme);
  return m ? Number(m[1]) : null;
}

async function main(argv = process.argv.slice(2)) {
  const updateBadge = argv.includes("--update-badge");
  const nodeArgs = argv.filter((a) => a !== "--update-badge");
  const customReporter = nodeArgs.some((a) => a.startsWith("--test-reporter"));
  const reporterArgs = customReporter ? [] : ["--test-reporter=spec"];
  const { unit, serial } = partition();

  const results = [];
  process.stdout.write(`[run-tests] phase 1/2: ${unit.length} unit test files in parallel\n`);
  results.push(await runNodeTest([...reporterArgs, ...nodeArgs], unit));
  for (const [i, file] of serial.entries()) {
    process.stdout.write(`\n[run-tests] phase 2/2 (${i + 1}/${serial.length}, one at a time): ${path.relative(REPO, file)}\n`);
    results.push(await runNodeTest([...reporterArgs, ...nodeArgs], [file]));
  }

  const failed = results.filter((r) => r.code !== 0).length;
  const counts = results.map((r) => r.tests);
  const total = counts.every((n) => Number.isInteger(n)) ? counts.reduce((a, b) => a + b, 0) : null;
  process.stdout.write(`\n[run-tests] ${total ?? "?"} tests in ${results.length} runs; ${failed ? `${failed} run(s) FAILED` : "all runs passed"}\n`);

  let badgeOk = true;
  if (total !== null && nodeArgs.length === 0) {
    const readme = fs.readFileSync(README, "utf8");
    const badge = readBadge(readme);
    // the real-Brave suites register their subtests only where Brave is found
    if (!require("../test/fixtures/temp-brave.js").braveAvailable()) {
      process.stdout.write(`[run-tests] README test badge not ${updateBadge ? "updated" : "checked"}: the real-Brave tests were skipped (Brave not installed)\n`);
    } else if (updateBadge) {
      if (failed) process.stdout.write("[run-tests] not updating the README badge: some tests failed\n");
      else if (badge !== total) {
        fs.writeFileSync(README, readme.replace(BADGE_RE, `tests-${total}%20passing`));
        process.stdout.write(`[run-tests] README test badge: ${badge} → ${total}\n`);
      }
    } else if (badge !== total) {
      badgeOk = false;
      process.stdout.write(`[run-tests] README test badge says ${badge}, this run counted ${total}: run \`npm test -- --update-badge\`\n`);
    }
  }
  return failed || !badgeOk ? 1 : 0;
}

if (require.main === module) main().then((code) => process.exit(code));

module.exports = { SERIAL_FILES, BADGE_RE, findTestFiles, partition, testsCount, readBadge };
