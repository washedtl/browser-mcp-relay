// core-install.test.js — W2F: `npm run bridge:install` / `bridge:uninstall`
// (scripts/bridge-install.js). The registry writer is injected: these tests
// never touch the real HKCU key, the real %LOCALAPPDATA% or Chrome. The
// extension manifest is a fixture with a freshly generated public key.

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const installer = require("../../scripts/bridge-install.js");
const { extensionIdFromKey, install, uninstall, HOST_NAME, REGISTRY_KEY } = installer;

const REPO = path.join(__dirname, "..", "..");

function tmp(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bmr-w2f-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A base64 SubjectPublicKeyInfo DER, the form manifest.json's "key" takes. */
function freshKey() {
  const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return publicKey.export({ type: "spki", format: "der" }).toString("base64");
}

/** The extension ID Chrome derives from `key`, computed the long way round. */
function referenceId(key) {
  const hex = crypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join("");
}

function fixtureManifest(t, extra = {}) {
  const dir = tmp(t, "ext");
  const key = freshKey();
  const file = path.join(dir, "manifest.json");
  fs.writeFileSync(file, JSON.stringify({ manifest_version: 3, name: "fixture", version: "1.0", key, ...extra }));
  return { file, key, dir };
}

function fakeReg() {
  const calls = [];
  const runReg = (args) => { calls.push(args); return ""; };
  return { calls, runReg };
}

function run(t, fn, opts = {}) {
  const lines = [];
  const home = opts.home || tmp(t, "home");
  const reg = opts.reg || fakeReg();
  const result = fn({ env: { LOCALAPPDATA: home }, platform: "win32", runReg: reg.runReg, out: (l) => lines.push(l), nodePath: "C:\\Program Files\\nodejs\\node.exe", ...opts.args });
  return { result, lines, home, reg };
}

test("install: extension ID = first 32 hex of sha256(public key DER), 0-f mapped to a-p", () => {
  const key = freshKey();
  const id = extensionIdFromKey(key);
  assert.match(id, /^[a-p]{32}$/);
  assert.strictEqual(id, referenceId(key));
  assert.throws(() => extensionIdFromKey(""), /key/);
  assert.throws(() => extensionIdFromKey("not base64 !!"), /key/);
});

test("install: writes the host manifest (stdio, allowed_origins from the key) and a .bat launcher; registers HKCU", (t) => {
  const m = fixtureManifest(t);
  const { result, lines, home, reg } = run(t, install, { args: { extensionManifest: m.file } });
  const id = referenceId(m.key);
  assert.strictEqual(HOST_NAME, "com.browser_mcp_relay.cookie_bridge");
  assert.strictEqual(REGISTRY_KEY, "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.browser_mcp_relay.cookie_bridge");

  const dir = path.join(home, "browser-mcp-relay", "cookie-bridge");
  assert.strictEqual(result.manifestFile, path.join(dir, `${HOST_NAME}.json`));
  const manifest = JSON.parse(fs.readFileSync(result.manifestFile, "utf8"));
  assert.deepStrictEqual(manifest, {
    name: HOST_NAME,
    description: manifest.description,
    path: result.launcherFile,
    type: "stdio",
    allowed_origins: [`chrome-extension://${id}/`],
  });
  assert.ok(manifest.description.length > 10);

  const bat = fs.readFileSync(result.launcherFile, "utf8");
  assert.match(bat, /^@echo off\r\n/);
  assert.ok(bat.includes(`"C:\\Program Files\\nodejs\\node.exe" "${path.join(REPO, "src", "cookie-bridge", "host.js")}" %*`), bat);
  assert.ok(bat.endsWith("\r\n"));

  assert.deepStrictEqual(reg.calls, [["add", REGISTRY_KEY, "/ve", "/t", "REG_SZ", "/d", result.manifestFile, "/f"]]);
  const text = lines.join("\n");
  assert.ok(text.includes(id), "prints the extension ID");
  assert.ok(text.includes("chrome://extensions") && /Load unpacked/.test(text) && /Developer mode/.test(text));
  assert.ok(text.includes(path.join(REPO, "extensions", "cookie-bridge")));
  assert.ok(/Approve & start sync/.test(text), "says nothing syncs before the owner approves");
});

test("install: '%' in a path is escaped for cmd", (t) => {
  const m = fixtureManifest(t);
  const { result } = run(t, install, { args: { extensionManifest: m.file, nodePath: "C:\\odd%dir\\node.exe" } });
  assert.ok(fs.readFileSync(result.launcherFile, "utf8").includes('"C:\\odd%%dir\\node.exe"'));
});

test("install: running it again replaces the files and the value (idempotent)", (t) => {
  const m = fixtureManifest(t);
  const reg = fakeReg();
  const home = tmp(t, "home");
  run(t, install, { home, reg, args: { extensionManifest: m.file } });
  const { result } = run(t, install, { home, reg, args: { extensionManifest: m.file } });
  assert.strictEqual(reg.calls.length, 2);
  assert.ok(fs.existsSync(result.manifestFile) && fs.existsSync(result.launcherFile));
});

test("install: a missing extension manifest, or one without a key, fails before anything is written", (t) => {
  for (const extensionManifest of [path.join(tmp(t, "none"), "manifest.json"), fixtureManifest(t, { key: undefined }).file]) {
    const reg = fakeReg();
    const home = tmp(t, "home");
    assert.throws(() => run(t, install, { home, reg, args: { extensionManifest } }), /manifest\.json|"key"/);
    assert.deepStrictEqual(reg.calls, []);
    assert.ok(!fs.existsSync(path.join(home, "browser-mcp-relay", "cookie-bridge")));
  }
});

test("install: Windows only for now (other platforms get a clear error, nothing written)", (t) => {
  const m = fixtureManifest(t);
  const reg = fakeReg();
  assert.throws(() => run(t, install, { reg, args: { extensionManifest: m.file, platform: "linux" } }), /Windows/);
  assert.deepStrictEqual(reg.calls, []);
});

test("install: a failing registry write leaves no host files behind", (t) => {
  const m = fixtureManifest(t);
  const home = tmp(t, "home");
  const reg = { calls: [], runReg: () => { throw new Error("ERROR: Access is denied."); } };
  assert.throws(() => run(t, install, { home, reg, args: { extensionManifest: m.file } }), /registry/i);
  assert.deepStrictEqual(fs.readdirSync(path.join(home, "browser-mcp-relay", "cookie-bridge")), []);
});

test("uninstall: deletes the registry key and exactly the two files it wrote (nothing else)", (t) => {
  const m = fixtureManifest(t);
  const home = tmp(t, "home");
  const reg = fakeReg();
  const { result } = run(t, install, { home, reg, args: { extensionManifest: m.file } });
  const dir = path.dirname(result.manifestFile);
  fs.writeFileSync(path.join(dir, "keep-me.txt"), "user file");
  const { lines } = run(t, uninstall, { home, reg });
  assert.deepStrictEqual(reg.calls.at(-1), ["delete", REGISTRY_KEY, "/f"]);
  assert.ok(!fs.existsSync(result.manifestFile) && !fs.existsSync(result.launcherFile));
  assert.deepStrictEqual(fs.readdirSync(dir), ["keep-me.txt"]);
  assert.ok(/chrome:\/\/extensions/.test(lines.join("\n")), "tells the owner to remove the extension too");
});

test("uninstall: nothing installed → succeeds quietly (registry 'not found' is fine)", (t) => {
  const reg = { calls: [], runReg: (args) => { reg.calls.push(args); throw Object.assign(new Error("ERROR: The system was unable to find the specified registry key or value."), { status: 1 }); } };
  const { lines } = run(t, uninstall, { reg });
  assert.strictEqual(reg.calls.length, 1);
  assert.ok(lines.length > 0);
});

test("install: the .bat launcher starts the host the way Chrome does (cmd /d /s /c), stdout = framed messages only", { skip: process.platform !== "win32" && "Windows launcher", timeout: 30_000 }, async (t) => {
  const { spawn } = require("node:child_process");
  const { encodeMessage, MessageReader } = require("../../src/cookie-bridge/framing.js");
  const m = fixtureManifest(t);
  const home = tmp(t, "home");
  const { result } = run(t, install, { home, args: { extensionManifest: m.file, nodePath: process.execPath } });
  // Chromium's native_process_launcher_win.cc: %COMSPEC% /d /s /c ""<host path>" <args>"
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${result.launcherFile}" chrome-extension://${referenceId(m.key)}/ --parent-window=0"`], {
    windowsVerbatimArguments: true,
    env: { ...process.env, LOCALAPPDATA: home, BROWSER_RELAY_BROKER_PIPE: `\\\\.\\pipe\\bmr-test-w2f-bat-${process.pid}` },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const got = [];
  let malformed = 0;
  const reader = new MessageReader({ onMessage: (msg) => got.push(msg), onMalformed: () => { malformed++; }, onFatal: () => { malformed++; } });
  child.stdout.on("data", (c) => reader.push(c));
  child.stdin.write(encodeMessage({ t: "hello", v: 1 }));
  const t0 = Date.now();
  while (!got.length && Date.now() - t0 < 15_000) await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(got[0], { t: "status", broker: "down" });
  assert.strictEqual(malformed, 0, "the launcher wrote non-frame bytes to stdout");
  child.stdin.end();
  assert.strictEqual(await new Promise((r) => child.once("exit", r)), 0);
});

test("install: package.json wires bridge:install / bridge:uninstall to this script", () => {
  const pkg = require("../../package.json");
  assert.strictEqual(pkg.scripts["bridge:install"], "node scripts/bridge-install.js install");
  assert.strictEqual(pkg.scripts["bridge:uninstall"], "node scripts/bridge-install.js uninstall");
});

test("install: the real extension manifest's key gives the pinned extension ID (once W2F-ext's manifest.json is in)", { skip: !fs.existsSync(path.join(REPO, "extensions", "cookie-bridge", "manifest.json")) && "extensions/cookie-bridge/manifest.json not in this branch yet" }, () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, "extensions", "cookie-bridge", "manifest.json"), "utf8"));
  assert.ok(typeof manifest.key === "string" && manifest.key.length > 100, "manifest.json has a public key");
  // pinned: a new key changes the ID, so every installed host manifest's allowed_origins
  // goes stale (re-run npm run bridge:install) — change this deliberately
  assert.strictEqual(extensionIdFromKey(manifest.key), "dfcccancdkogdddemhecnffcjllbjmba");
});
