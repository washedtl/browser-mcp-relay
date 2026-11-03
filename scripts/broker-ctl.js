#!/usr/bin/env node
// scripts/broker-ctl.js — talk to the running browser broker:
//
//   npm run broker:status   what it serves: sessions and their tabs, Brave
//                           (up, pid), pipe, profile, memory
//   npm run broker:stop     close Brave gracefully (cookies flushed) and exit;
//                           open Claude sessions start a fresh broker on
//                           their next call: this is how to restart it
//
// Same pipe and key as the shim (env and local-config.json); the request
// carries an HMAC of this user's broker key and the broker proves it back
// (src/broker/control.js).

"use strict";

const fs = require("node:fs");
const { applyLocalConfigToEnv } = require("../src/local-config.js");
const { resolveEndpoint, keyFileFor, loadOrCreateKey } = require("../src/broker/pipe-server.js");
const control = require("../src/broker/control.js");

const USAGE = "usage: npm run broker:status | npm run broker:stop   (node scripts/broker-ctl.js status|stop)";
// Brave gets 10 s to close before the broker kills it; then the broker exits.
const STOP_WAIT_MS = 30_000;

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** @returns {Promise<number>} exit code: 0 ok (incl. "not running"), 1 failed, 2 usage */
async function run({
  argv = process.argv.slice(2),
  env = applyLocalConfigToEnv(process.env),
  out = (line) => process.stdout.write(`${line}\n`),
  isPidAlive = defaultIsPidAlive,
  stopWaitMs = STOP_WAIT_MS,
} = {}) {
  const cmd = argv[0];
  if (argv.length !== 1 || !["status", "stop"].includes(cmd)) {
    out(USAGE);
    return 2;
  }
  const { pipe } = resolveEndpoint(env);
  const keyFile = keyFileFor(env);
  if (!fs.existsSync(keyFile)) {
    out(`browser broker: not running (no broker has run for this user yet: no ${keyFile})`);
    return 0;
  }
  let answer;
  try {
    answer = await control.requestControl({ pipe, key: loadOrCreateKey(keyFile), cmd });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
      out(`browser broker: not running (nothing on ${pipe})`);
      return 0;
    }
    out(`browser broker on ${pipe}: ${e.message}${e.code === "EAUTH" ? " (another program squatting the pipe name?)" : ""}`);
    return 1;
  }
  if (!answer.ok) {
    out(`browser broker refused: ${answer.error}`);
    return 1;
  }
  if (cmd === "status") {
    out(JSON.stringify(answer.status, null, 2));
    return 0;
  }
  out(`stopping browser broker pid ${answer.pid} (closing Brave gracefully)...`);
  const t0 = Date.now();
  while (isPidAlive(answer.pid)) {
    if (Date.now() - t0 > stopWaitMs) {
      out(`broker pid ${answer.pid} is still running after ${stopWaitMs / 1000} s; see its log (broker.log next to the broker profile)`);
      return 1;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  out(`stopped in ${Date.now() - t0} ms. Open sessions start a new broker on their next call.`);
  return 0;
}

if (require.main === module) {
  run().then((code) => process.exit(code), (e) => {
    process.stderr.write(`[broker-ctl] ${e.stack || e.message}\n`);
    process.exit(1);
  });
}

module.exports = { run };
