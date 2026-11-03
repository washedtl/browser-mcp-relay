#!/usr/bin/env node
// scripts/migrate-profile.js — seed the broker's Brave profile from a legacy
// pool profile, once:
//
//   npm run migrate-profile -- [--from <dir>] [--dry-run]
//
// The broker does this by itself on its first start (src/broker/profile-seed.js,
// freshest idle pool slot). This is the inspectable, hand-picked version:
// --from chooses the source, --dry-run prints what would be copied and how
// much. Copies Default/ minus caches and old session tabs, plus Local State,
// holding the slot's relay lock meanwhile; never modifies the source.
// Refuses when the broker profile already exists (npm run broker:stop, then
// move it away), the source is in use, or Default / Local State is a link.

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
 * @param {object} [opts] — all test seams; probes are findSeedSource's process probes
 * @returns {Promise<number>} exit code: 0 done (or dry run), 1 refused, 2 usage
 */
async function run({
  argv = process.argv.slice(2),
  env = applyLocalConfigToEnv(process.env),
  pool = require("../src/pool-shared.js"),
  probes,
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
  if (args.from && !fs.existsSync(path.join(args.from, "Default"))) {
    out(`${args.from} is not a Brave profile (no Default/ dir).`);
    return 1;
  }
  const dirs = args.from ? [args.from] : seed.poolCandidates(pool);
  if (!dirs.length) {
    out("No legacy pool configured to pick a source from; name one with --from <profile dir>.");
    return 1;
  }
  const { candidates, skipped } = await seed.findSeedSource({ pool, dirs, probes });
  const why = args.from ? " (close the session or Brave using it first)" : "";
  for (const s of skipped) out(`not using ${s.dir}: ${s.why}${why}`);
  // freshest first; a slot that can't be copied (link, changed meanwhile) → the next
  for (const cand of candidates) {
    let plan;
    try {
      plan = await seed.planSeed(cand.dir, { measureExcluded: args.dryRun });
    } catch (e) {
      out(`not using ${cand.dir}: ${e.message}`);
      continue;
    }
    out(`source:  ${cand.dir} (cookies written ${new Date(cand.cookiesMtimeMs).toISOString()})`);
    out(`target:  ${target}${targetExists ? " (exists: a real run would refuse)" : ""}`);
    out(`copy:    ${plan.files.length} files, ${mb(plan.bytes)} (Default/ minus caches and old session tabs, plus Local State)`);
    if (args.dryRun) {
      if (plan.excluded.length) out(`skip:    ${plan.excluded.map((e) => `${e.rel} (${mb(e.bytes)})`).join(", ")}`);
      out("dry run: nothing copied");
      return 0;
    }
    const t0 = Date.now();
    try {
      const r = await seed.copyFromSlot(pool, cand, target);
      out(`seeded ${r.files} files (${mb(plan.bytes)}) in ${Date.now() - t0} ms. The broker uses it from its next start.`);
      return 0;
    } catch (e) {
      out(`not using ${cand.dir}: ${e.message}`);
    }
  }
  out(args.from ? "Nothing copied." : "No idle pool slot with cookies could be copied; name one with --from <profile dir>.");
  return 1;
}

if (require.main === module) {
  run().then((code) => process.exit(code), (e) => {
    process.stderr.write(`[migrate-profile] ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { run };
