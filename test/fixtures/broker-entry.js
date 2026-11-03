#!/usr/bin/env node
// broker-entry.js — a real broker process (src/broker/main.js startBroker,
// real pipe, real MCP servers, real watchdog) with fake Brave / upstream /
// windows, for the process-level shim tests. Writes marker files so tests
// can count brokers:
//   <markerDir>/started-<pid>, then winner-<pid> (owns the pipe) or loser-<pid>.
//
// usage: node broker-entry.js --pipe <p> --marker-dir <d> --key-file <k>
//          [--exit-ms <n>] [--watchdog-ms <n>] [--env-file <f>]

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const pipe = arg("--pipe");
const markerDir = arg("--marker-dir");
const keyFile = arg("--key-file");
const exitMs = Number(arg("--exit-ms", "60000"));
const watchdogMs = Number(arg("--watchdog-ms", "0"));
const envFile = arg("--env-file");
const mark = (kind) => fs.writeFileSync(path.join(markerDir, `${kind}-${process.pid}`), String(Date.now()));
mark("started");

const { startBroker, applyEnvFile } = require("../../src/broker/main.js");
const fakes = require("./broker-fakes.js");

if (envFile) applyEnvFile(envFile);

const logFile = path.join(markerDir, "broker.log");
const log = (m) => { try { fs.appendFileSync(logFile, `${process.pid} ${m}\n`); } catch { /* ignore */ } };
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const fixtureTools = [
  { name: "fixture_pid", description: "broker pid", inputSchema: { type: "object" }, needsBrave: false, handler: async () => text({ pid: process.pid }) },
  {
    name: "fixture_sleep",
    description: "sleeps ms",
    inputSchema: { type: "object", properties: { ms: { type: "number" } } },
    needsBrave: false,
    handler: async ({ ms }) => { await new Promise((r) => setTimeout(r, ms)); return text({ slept: ms }); },
  },
  {
    // what a runaway `execute` does to the event loop
    name: "fixture_spin",
    description: "blocks the event loop forever",
    inputSchema: { type: "object" },
    needsBrave: false,
    handler: async () => { await new Promise((r) => setTimeout(r, 1)); for (;;) { /* spin */ } },
  },
  {
    name: "fixture_whoami",
    description: "this broker's integrity level and launch env mark",
    inputSchema: { type: "object" },
    needsBrave: false,
    handler: async () => {
      let integrity = null;
      if (process.platform === "win32") {
        const out = execFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), ["/groups"], { encoding: "utf8", windowsHide: true });
        integrity = (out.match(/Mandatory Label\\(\S+) Mandatory Level/) || [])[1] || null;
      }
      return text({ pid: process.pid, integrity, mark: process.env.BROWSER_RELAY_TEST_MARK || null, secret: process.env.NOT_ALLOWLISTED_SECRET || null });
    },
  },
];

startBroker({
  pipe,
  profileDir: path.join(markerDir, "profile-unused"),
  env: {},
  log,
  keyFile,
  idle: { exitMs, browserMs: 60_000 },
  watchdog: watchdogMs ? { timeoutMs: watchdogMs, logFile } : null,
  onExit: () => process.exit(0),
  deps: {
    createSupervisor: (opts) => fakes.fakeSupervisor(opts),
    upstreamModule: () => fakes.fakeUpstreamModule(),
    windowPages: () => fakes.fakeWindowPages(),
    ownTools: () => [fakes.probeOwnTool, fakes.tabsNewTool, fakes.toolsetsTool, ...fixtureTools],
    toolContext: fakes.fakeToolContextModule,
    loadCatalog: async () => fakes.FAKE_CATALOG,
  },
}).then((handle) => {
  if (!handle) { mark("loser"); process.exit(0); }
  mark("winner");
}, (e) => { log(`fatal ${e.stack}`); process.exit(1); });
