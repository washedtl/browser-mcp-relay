#!/usr/bin/env node
// scripts/bridge-install.js — `npm run bridge:install` / `npm run bridge:uninstall`.
//
// Registers the cookie bridge's native-messaging host with Chrome (Windows):
//   %LOCALAPPDATA%\browser-mcp-relay\cookie-bridge\
//     com.browser_mcp_relay.cookie_bridge.json   the host manifest (stdio; allowed_origins = the extension)
//     cookie-bridge-host.bat                     runs src/cookie-bridge/host.js with this node
//   HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser_mcp_relay.cookie_bridge = <manifest path>
// allowed_origins comes from extensions/cookie-bridge/manifest.json's "key"
// (the extension ID Chrome derives from it), so only that extension can
// start the host. Then it prints the "load unpacked" steps. Uninstall
// removes the registry key and exactly those two files.
//
// `npm run bridge:uninstall -- --purge` also asks the running broker
// (authenticated control request "bridge-purge") to expire in Brave every
// cookie the bridge put there, then deletes the bridge's state file and the
// host's log. Without a running broker (or with the extension still
// connected) it changes nothing and says what to do: the state file is what
// a later purge needs.
//
// Re-run it after moving the repo or switching Node installs: the launcher
// holds both absolute paths.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const REPO = path.resolve(__dirname, "..");
const HOST_NAME = "com.browser_mcp_relay.cookie_bridge";
const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;
const LAUNCHER_NAME = "cookie-bridge-host.bat";
const EXTENSION_DIR = path.join(REPO, "extensions", "cookie-bridge");

/** Chrome's extension ID for a manifest "key": sha256(public key DER)[:32 hex], 0-f → a-p. */
function extensionIdFromKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(key.replace(/\s+/g, ""))) {
    throw new Error('the extension manifest\'s "key" is missing or not base64');
  }
  const der = Buffer.from(key.replace(/\s+/g, ""), "base64");
  if (der.length < 32) throw new Error('the extension manifest\'s "key" is too short to be a public key');
  const hex = crypto.createHash("sha256").update(der).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

function readExtensionId(manifestFile) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (e) {
    throw new Error(`cannot read the extension's manifest.json (${manifestFile}): ${e.code || e.message}`);
  }
  if (!manifest || typeof manifest.key !== "string") {
    throw new Error(`${manifestFile} has no "key": the extension needs a fixed public key so its ID (and the host's allowed_origins) is stable`);
  }
  return extensionIdFromKey(manifest.key);
}

function hostDir(env, platform) {
  const { brokerHome } = require("../src/broker/pipe-server.js");
  const p = platform === "win32" ? path.win32 : path.posix;
  return p.join(p.dirname(brokerHome(env, platform)), "cookie-bridge");
}

const defaultRunReg = (args) => execFileSync("reg", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

function requireWindows(platform) {
  if (platform !== "win32") {
    throw new Error("the cookie bridge installer supports Windows only for now (Chrome's native-messaging host is registered under HKCU)");
  }
}

/**
 * @param {object} [opts] — test seams: env, platform, runReg(args), out(line), nodePath, extensionManifest
 * @returns {{id: string, manifestFile: string, launcherFile: string}}
 */
function install({ env = process.env, platform = process.platform, runReg = defaultRunReg, out = console.log, nodePath = process.execPath, extensionManifest = path.join(EXTENSION_DIR, "manifest.json") } = {}) {
  requireWindows(platform);
  const id = readExtensionId(extensionManifest);
  const dir = hostDir(env, platform);
  const manifestFile = path.join(dir, `${HOST_NAME}.json`);
  const launcherFile = path.join(dir, LAUNCHER_NAME);
  const hostScript = path.join(REPO, "src", "cookie-bridge", "host.js");
  const cmdQuote = (s) => `"${String(s).replace(/%/g, "%%")}"`;

  fs.mkdirSync(dir, { recursive: true });
  // UTF-8 without a BOM; chcp makes cmd read the lines after it as UTF-8 (non-ASCII paths)
  fs.writeFileSync(launcherFile, [
    "@echo off",
    "rem browser-mcp-relay cookie bridge: Chrome starts this native-messaging host (npm run bridge:install wrote it)",
    "chcp 65001 >nul 2>&1",
    `${cmdQuote(nodePath)} ${cmdQuote(hostScript)} %*`,
    "",
  ].join("\r\n"));
  fs.writeFileSync(manifestFile, `${JSON.stringify({
    name: HOST_NAME,
    description: "browser-mcp-relay cookie bridge: copies allowed cookies from this Chrome profile into the agents' broker browser",
    path: launcherFile,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  }, null, 2)}\n`);
  try {
    runReg(["add", REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", manifestFile, "/f"]);
  } catch (e) {
    fs.rmSync(manifestFile, { force: true });
    fs.rmSync(launcherFile, { force: true });
    throw new Error(`could not write the registry key ${REGISTRY_KEY}: ${String(e.stderr || e.message).trim()}`);
  }

  out("Cookie bridge native host installed for Chrome:");
  out(`  host manifest  ${manifestFile}`);
  out(`  launcher       ${launcherFile}`);
  out(`  registry       ${REGISTRY_KEY}`);
  out(`  extension ID   ${id}  (from extensions/cookie-bridge/manifest.json "key")`);
  out("");
  out("Next, in the Chrome profile whose logins the agents should share:");
  out("  1. Open chrome://extensions and turn on Developer mode (top right).");
  out(`  2. Click "Load unpacked" and pick ${EXTENSION_DIR}`);
  out(`  3. Check that the extension's ID is ${id}.`);
  out('  4. Open the extension\'s options page (Details > Extension options), review which domains will sync and which are held back, then click "Approve & start sync".');
  out("Nothing syncs before step 4. Banking, email/identity, password-manager, government/tax/health and cloud-console domains never sync unless you re-allow them there.");
  out("Cookies flow while a browser-mcp-relay broker runs (any Claude session starts one); the extension resyncs whenever a broker comes up.");
  out("To remove: npm run bridge:uninstall, then remove the extension in chrome://extensions.");
  return { id, manifestFile, launcherFile };
}

/** Removes the registry key and the two files install wrote (nothing else). */
function uninstall({ env = process.env, platform = process.platform, runReg = defaultRunReg, out = console.log } = {}) {
  requireWindows(platform);
  const dir = hostDir(env, platform);
  try {
    runReg(["delete", REGISTRY_KEY, "/f"]);
    out(`removed ${REGISTRY_KEY}`);
  } catch (e) {
    if (!/unable to find/i.test(String(e.stderr || "") + String(e.message))) {
      throw new Error(`could not remove the registry key ${REGISTRY_KEY}: ${String(e.stderr || e.message).trim()}`);
    }
    out(`no registry key ${REGISTRY_KEY} (not installed)`);
  }
  for (const f of [path.join(dir, `${HOST_NAME}.json`), path.join(dir, LAUNCHER_NAME)]) {
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true });
      out(`removed ${f}`);
    }
  }
  try { fs.rmdirSync(dir); } catch { /* not empty, or not there */ }
  out('Also remove the extension in chrome://extensions ("Remove" on the cookie bridge).');
}

const defaultRequest = (opts) => require("../src/broker/control.js").requestControl(opts);

/**
 * The --purge half of uninstall: the broker expires every bridge cookie in
 * Brave and deletes its state file; then the state file (if still there) and
 * the host's log go. Throws, deleting nothing, when no broker answers or it
 * refuses (the extension still connected).
 * @param {object} [opts] — test seams: env (local-config merged), platform, out(line), request(opts)
 * @returns {Promise<{expired: number, removed: string[]}>}
 */
async function purge({ env = process.env, platform = process.platform, out = console.log, request = defaultRequest } = {}) {
  requireWindows(platform);
  const pipeServer = require("../src/broker/pipe-server.js");
  const { stateFileFor } = require("../src/cookie-bridge/importer.js");
  const { pipe, profileDir } = pipeServer.resolveEndpoint(env, { platform });
  const home = pipeServer.brokerHome(env, platform);
  const stateFile = stateFileFor(home, profileDir);
  const logFile = path.join(home, "cookie-bridge.log");
  const files = [stateFile, logFile, `${logFile}.1`];
  const removeFiles = () => files.filter((file) => {
    if (!fs.existsSync(file)) return false;
    fs.rmSync(file, { force: true });
    out(`removed ${file}`);
    return true;
  });
  const key = pipeServer.readKey(pipeServer.keyFileFor(env));
  if (!key) {
    if (fs.existsSync(stateFile)) throw new Error(`${stateFile} exists but there is no broker key: start the broker once (any browser tool call), then purge again`);
    out("no broker has run here, so the bridge never put a cookie into Brave");
    return { expired: 0, removed: removeFiles() };
  }
  let answer;
  try {
    answer = await request({ pipe, key, cmd: "bridge-purge", timeoutMs: 90_000 });
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
      throw new Error("no broker is running, so the bridge's cookies are still in Brave's profile. Make any browser tool call from an agent session (that starts the broker), then run npm run bridge:uninstall -- --purge again. Nothing was deleted.");
    }
    if (e.code === "EPERM" || e.code === "EACCES") {
      throw new Error("the broker is running elevated (as administrator): run npm run bridge:uninstall -- --purge from an elevated terminal. Nothing was deleted.");
    }
    throw new Error(`could not reach the broker (${e.code || e.message}). Nothing was deleted.`);
  }
  if (!answer || answer.ok !== true) {
    throw new Error(`the broker didn't purge: ${(answer && answer.error) || "no answer"}. Nothing was deleted.`);
  }
  out(`expired ${answer.expired} bridge cookie(s) in Brave${answer.braveClosed ? " (Brave was started for it and closed again, which writes them to disk)" : " (Brave writes them to disk within ~30 s)"}`);
  return { expired: answer.expired, removed: removeFiles() };
}

async function main(argv = process.argv.slice(2)) {
  const cmd = argv[0];
  try {
    if (cmd === "install") install();
    else if (cmd === "uninstall") {
      uninstall();
      if (argv.includes("--purge")) {
        const { applyLocalConfigToEnv } = require("../src/local-config.js");
        await purge({ env: applyLocalConfigToEnv(process.env) });
      } else {
        console.log("The cookies the bridge copied are still in the broker's Brave: npm run bridge:uninstall -- --purge removes them.");
      }
    } else {
      console.error("usage: node scripts/bridge-install.js install | uninstall [--purge]");
      process.exitCode = 2;
    }
  } catch (e) {
    console.error(`bridge:${cmd} failed: ${e.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { install, uninstall, purge, extensionIdFromKey, readExtensionId, HOST_NAME, REGISTRY_KEY, main };
