// temp-brave.js — throwaway Brave for broker tests (W2B).
//
// Launches Brave with a fresh --user-data-dir under <repo>/.tmp-profiles and
// an OS-assigned CDP port (--remote-debugging-port=0, read back from the
// DevToolsActivePort file Chromium writes into the profile). Never touches a
// real or pool profile. close() asks Brave to exit over CDP (Browser.close),
// falls back to taskkill / SIGKILL, then deletes the profile directory.
//
// Headless by default so a test run never steals the desktop's foreground
// window; BMR_TEST_HEADFUL=1 runs the same tests against real windows.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");
const { removeDir } = require("./remove-dir.js");
const { buildBraveArgs } = require("../../src/broker/brave-supervisor.js");

const BRAVE_PATH = "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe";
const PROFILES_ROOT = path.resolve(__dirname, "..", "..", ".tmp-profiles");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function braveAvailable() {
  return process.platform === "win32" && fs.existsSync(BRAVE_PATH);
}

function headfulRequested() {
  return process.env.BMR_TEST_HEADFUL === "1";
}

async function readDevToolsPort(profileDir, child, timeoutMs) {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`brave exited during launch (code ${child.exitCode})`);
    try {
      const port = Number(fs.readFileSync(file, "utf8").split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* not written yet */ }
    await sleep(50);
  }
  throw new Error(`brave did not write DevToolsActivePort within ${timeoutMs}ms`);
}

async function browserWsUrl(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
  const v = await res.json();
  if (!v.webSocketDebuggerUrl) throw new Error("no webSocketDebuggerUrl in /json/version");
  return v.webSocketDebuggerUrl;
}

function sendBrowserClose(wsUrl) {
  const WebSocket = require("ws");
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.terminate(); } catch {} done(); }, 5000);
    function done() { clearTimeout(timer); resolve(); }
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" })));
    ws.on("close", done);
    ws.on("error", done);
  });
}

async function waitExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(100);
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.headless] default: true unless BMR_TEST_HEADFUL=1
 * @param {string} [opts.label] folds into the profile dir name
 * @returns {Promise<{port:number, cdpUrl:string, pid:number, profileDir:string, close:() => Promise<{graceful:boolean}>}>}
 */
/** A fresh, empty directory under .tmp-profiles (remove it with removeProfile). */
function makeProfileDir(label) {
  const clean = String(label || "t").replace(/[^a-z0-9-]/gi, "");
  const dir = path.join(PROFILES_ROOT, `${clean}-${process.pid}-${Date.now()}`);
  if (!path.resolve(dir).startsWith(PROFILES_ROOT + path.sep)) throw new Error("temp profile must live under .tmp-profiles");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function launchTempBrave(opts = {}) {
  const headless = opts.headless ?? !headfulRequested();
  const profileDir = makeProfileDir(opts.label);
  // The broker's own flag set, so pages here behave as they do under the
  // broker; only the CDP transport differs (a port the test can connect to).
  const args = buildBraveArgs({ profileDir, headless }).map((a) => (a === "--remote-debugging-pipe" ? "--remote-debugging-port=0" : a));
  const child = spawn(BRAVE_PATH, args, { stdio: "ignore" });
  child.on("error", () => { /* surfaces as "exited during launch" / port timeout */ });
  let port;
  try {
    port = await readDevToolsPort(profileDir, child, 20000);
  } catch (e) {
    await forceStop(child, profileDir);
    throw e;
  }
  let closed = null;
  const close = () => {
    if (!closed) {
      closed = (async () => {
        let graceful = false;
        if (child.exitCode === null) {
          try { await sendBrowserClose(await browserWsUrl(port)); } catch { /* fall through to kill */ }
          graceful = await waitExit(child, 15000); // headful under load can take a while
        }
        await forceStop(child, profileDir);
        return { graceful };
      })();
    }
    return closed;
  };
  return { port, cdpUrl: `http://127.0.0.1:${port}`, pid: child.pid, profileDir, close };
}

async function forceStop(child, profileDir) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { stdio: "ignore" });
      else child.kill("SIGKILL");
    } catch { /* already gone */ }
    await waitExit(child, 5000);
  }
  await removeProfile(profileDir);
}

// Brave's helpers can hold profile files for a few seconds after the main
// process exits: removeDir waits that out.
async function removeProfile(profileDir) {
  await removeDir(profileDir);
  try { fs.rmdirSync(PROFILES_ROOT); } catch { /* other profiles still in use */ }
}

module.exports = { BRAVE_PATH, PROFILES_ROOT, braveAvailable, headfulRequested, launchTempBrave, makeProfileDir, removeProfile };
