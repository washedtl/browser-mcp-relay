#!/usr/bin/env node
// scripts/migrate-profile.js — seed the broker's Brave profile from a legacy
// pool profile, once:
//
//   npm run migrate-profile -- [--from <dir>] [--dry-run]
//
// The broker does this by itself on its first start (src/broker/profile-seed.js,
// freshest idle pool slot). This is the inspectable, hand-picked version:
// --from chooses the source, --dry-run prints what would be copied and how
// much. Copies Default/ minus caches and old session tabs, plus Local State;
// never modifies the source. Refuses when the broker profile already exists
// (npm run broker:stop, then move it away) or the source is in use.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { applyLocalConfigToEnv } = require("../src/local-config.js");
const { resolveEndpoint } = require("../src/broker/pipe-server.js");
const seed = require("../src/broker/profile-seed.js");

const USAGE = "usage: npm run migrate-profile -- [--from <profile dir>] [--dry-run]";
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function parseArgs(argv) {
  const out = { from: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") out.dryRun = true;
    else if (argv[i] === "--from" && argv[i + 1]) out.from = path.resolve(argv[++i]);
    else return null;
  }
  return out;
}

/**
 * @returns {Promise<number>} exit code: 0 done (or dry run), 1 refused, 2 usage
 */
async function run({
  argv = process.argv.slice(2),
  env = applyLocalConfigToEnv(process.env),
  pool = require("../src/pool-shared.js"),
  listBraveCommands = () => require("../src/process-shim.js").listProcessesByCommand(pool.braveNeedle(process.platform)).map((p) => p.command),
  isSlotClaimed = (dir) => {
    const lock = pool.readLockState(path.join(dir, ".mcp-wrapper-lock"));
    return Boolean(lock && lock.state !== "dead");
  },
  out = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  const args = parseArgs(argv);
  if (!args) {
    out(USAGE);
    return 2;
  }
  const target = resolveEndpoint(env).profileDir;
  const targetExists = fs.existsSync(target);
  if (targetExists && !args.dryRun) {
    out(`The broker profile ${target} already exists. To replace it: npm run broker:stop, move or delete that dir, then run this again.`);
    return 1;
  }

  const candidates = args.from ? [args.from] : (pool.CONFIG.standalone ? [] : pool.CONFIG.poolDirs);
  if (args.from && !fs.existsSync(path.join(args.from, "Default"))) {
    out(`${args.from} is not a Brave profile (no Default/ dir).`);
    return 1;
  }
  if (!candidates.length) {
    out("No legacy pool configured to pick a source from; name one with --from <profile dir>.");
    return 1;
  }
  const pick = seed.pickSeedSource({ poolDirs: candidates, braveCommands: listBraveCommands(), isSlotClaimed });
  for (const s of pick.skipped) out(`not using ${s.dir}: ${s.why}${args.from ? " (close the session or Brave using it first)" : ""}`);
  if (!pick.dir) {
    out(args.from ? "Nothing copied." : "No idle pool slot with cookies; name one with --from <profile dir>.");
    return 1;
  }

  const plan = await seed.planSeed(pick.dir, { measureExcluded: args.dryRun });
  out(`source:  ${pick.dir} (cookies written ${new Date(pick.cookiesMtimeMs).toISOString()})`);
  out(`target:  ${target}${targetExists ? " (exists: a real run would refuse)" : ""}`);
  out(`copy:    ${plan.files.length} files, ${mb(plan.bytes)} (Default/ minus caches and old session tabs, plus Local State)`);
  if (args.dryRun) {
    if (plan.excluded.length) out(`skip:    ${plan.excluded.map((e) => `${e.rel} (${mb(e.bytes)})`).join(", ")}`);
    out("dry run: nothing copied");
    return 0;
  }
  const t0 = Date.now();
  const r = await seed.copySeed(pick.dir, target);
  out(`seeded ${r.files} files (${mb(r.bytes)}) in ${Date.now() - t0} ms. The broker uses it from its next start.`);
  return 0;
}

if (require.main === module) {
  run().then((code) => process.exit(code), (e) => {
    process.stderr.write(`[migrate-profile] ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { run, parseArgs };
