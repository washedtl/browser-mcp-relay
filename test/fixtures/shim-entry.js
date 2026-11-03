#!/usr/bin/env node
// shim-entry.js — the real shim (src/shim.js) on stdio, pointed at a test
// pipe, a test key and the fixture broker. What the tests spawn in place of
// Claude Code's `node src/index.js`. The real launcher (src/shim.js --launch)
// starts the broker, so its env allowlist and de-elevation apply.
//
// usage: node shim-entry.js <pipe> <markerDir> [exitMs] [watchdogMs]

"use strict";

const path = require("node:path");
const { Shim } = require("../../src/shim.js");

const [pipe, markerDir, exitMs = "60000", watchdogMs = "0"] = process.argv.slice(2);
const keyFile = path.join(markerDir, "broker.key");
new Shim({
  pipe,
  keyFile,
  brokerEntry: path.join(__dirname, "broker-entry.js"),
  brokerArgs: ["--pipe", pipe, "--marker-dir", markerDir, "--key-file", keyFile, "--exit-ms", exitMs, "--watchdog-ms", watchdogMs],
}).start();
