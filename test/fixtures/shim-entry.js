#!/usr/bin/env node
// shim-entry.js — the real shim (src/shim.js) on stdio, pointed at a test
// pipe and the fixture broker. What the tests spawn in place of Claude
// Code's `node src/index.js`.
//
// usage: node shim-entry.js <pipe> <markerDir> [exitMs]

"use strict";

const path = require("node:path");
const { Shim } = require("../../src/shim.js");

const [pipe, markerDir, exitMs = "60000"] = process.argv.slice(2);
new Shim({
  pipe,
  brokerEntry: path.join(__dirname, "broker-entry.js"),
  brokerArgs: ["--pipe", pipe, "--marker-dir", markerDir, "--exit-ms", exitMs],
}).start();
