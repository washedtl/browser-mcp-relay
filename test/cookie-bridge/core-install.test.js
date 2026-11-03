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

const { removeDir } = require("../fixtures/remove-dir.js");
const installer = require("../../scripts/bridge-install.js");
const { extensionIdFromKey, install, uninstall, HOST_NAME, REGISTRY_KEY } = installer;

const REPO = path.join(__dirname, "..", "..");

function tmp(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bmr-w2f-${tag}-`));
  // waits out Windows file locks (a just-exited node.exe copy stays locked briefly)
  t.after(() => removeDir(dir));
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

test("install: non-ASCII paths survive: the launcher switches cmd to UTF-8 (chcp 65001) before the node line, silently", (t) => {
  const m = fixtureManifest(t);
  const { result } = run(t, install, { args: { extensionManifest: m.file, nodePath: "C:\\Users\\Zoë Ünal\\node.exe" } });
  const lines = fs.readFileSync(result.launcherFile, "utf8").split("\r\n");
  assert.strictEqual(lines[0], "@echo off");
  const chcp = lines.findIndex((l) => /^chcp 65001 >nul 2>&1$/.test(l));
  const nodeLine = lines.findIndex((l) => l.includes("Zoë Ünal"));
  assert.ok(chcp > 0 && chcp < nodeLine, lines.join("\n"));
  assert.ok(!fs.readFileSync(result.launcherFile).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "no BOM: it would break @echo off");
});

test("install: the launcher really starts node from a non-ASCII directory (as Chrome runs it)", { skip: process.platform !== "win32" && "Windows launcher", timeout: 60_000 }, async (t) => {
  const { spawn } = require("node:child_process");
  const { encodeMessage, MessageReader } = require("../../src/cookie-bridge/framing.js");
  const dir = path.join(tmp(t, "nonascii"), "Zoë Ünal ✓");
  fs.mkdirSync(dir);
  const nodeCopy = path.join(dir, "node.exe");
  try { fs.linkSync(process.execPath, nodeCopy); } catch { fs.copyFileSync(process.execPath, nodeCopy); }
  const m = fixtureManifest(t);
  const home = tmp(t, "home");
  const { result } = run(t, install, { home, args: { extensionManifest: m.file, nodePath: nodeCopy } });
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${result.launcherFile}" chrome-extension://${referenceId(m.key)}/ --parent-window=0"`], {
    windowsVerbatimArguments: true,
    env: { ...process.env, LOCALAPPDATA: home, BROWSER_RELAY_BROKER_PIPE: `\\\\.\\pipe\\bmr-test-w2f-u8-${process.pid}` },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch { /* gone */ } });
  const got = [];
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });
  const reader = new MessageReader({ onMessage: (msg) => got.push(msg) });
  child.stdout.on("data", (c) => reader.push(c));
  child.stdin.write(encodeMessage({ t: "hello", v: 1 }));
  const t0 = Date.now();
  while (!got.length && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(got[0], { t: "status", broker: "down" }, `stderr: ${stderr}`);
  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
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

// ── V2-3: npm run bridge:uninstall -- --purge ──

/** A broker home with a key, a bridge state file for its profile, and the host's logs. */
function purgeHome(t, { key = true } = {}) {
  const home = tmp(t, "purge");
  const env = { LOCALAPPDATA: home, BROWSER_RELAY_BROKER_PIPE: String.raw`\\.\pipe\bmr-test-never-opened` };
  const pipeServer = require("../../src/broker/pipe-server.js");
  const { stateFileFor } = require("../../src/cookie-bridge/importer.js");
  const brokerHome = pipeServer.brokerHome(env, "win32");
  fs.mkdirSync(brokerHome, { recursive: true });
  if (key) pipeServer.loadOrCreateKey(pipeServer.keyFileFor(env));
  const { profileDir } = pipeServer.resolveEndpoint(env, { platform: "win32" });
  const files = {
    state: stateFileFor(brokerHome, profileDir),
    log: path.join(brokerHome, "cookie-bridge.log"),
    log1: path.join(brokerHome, "cookie-bridge.log.1"),
    other: path.join(brokerHome, "broker.log"),
  };
  for (const f of Object.values(files)) fs.writeFileSync(f, "x");
  return { env, files };
}

test("purge: the broker expires the cookies (authenticated bridge-purge), then the state file and the host's logs go, nothing else", async (t) => {
  const { env, files } = purgeHome(t);
  const asked = [];
  const lines = [];
  const r = await installer.purge({ env, platform: "win32", out: (l) => lines.push(l), request: async (o) => { asked.push(o); return { bmr: "ctl", ok: true, expired: 3, braveClosed: true }; } });
  assert.deepStrictEqual(asked.map((o) => [o.cmd, o.pipe, Buffer.isBuffer(o.key)]), [["bridge-purge", env.BROWSER_RELAY_BROKER_PIPE, true]]);
  assert.strictEqual(r.expired, 3);
  assert.deepStrictEqual(r.removed.sort(), [files.log, files.log1, files.state].sort());
  for (const f of [files.state, files.log, files.log1]) assert.ok(!fs.existsSync(f), f);
  assert.ok(fs.existsSync(files.other), "the broker's own log stays");
  assert.ok(lines.some((l) => /expired 3 bridge cookie/.test(l)));
});

test("purge: no broker running, the extension still connected, or an elevated broker → a clear error and NOTHING deleted", async (t) => {
  const cases = [
    [async () => { throw Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }); }, /no broker is running.*Make any browser tool call/],
    [async () => { throw Object.assign(new Error("connect EPERM"), { code: "EPERM" }); }, /running elevated.*elevated terminal/],
    [async () => ({ bmr: "ctl", ok: false, code: "EBUSY", error: "the cookie bridge extension is still connected" }), /still connected/],
  ];
  for (const [request, re] of cases) {
    const { env, files } = purgeHome(t);
    await assert.rejects(installer.purge({ env, platform: "win32", out: () => {}, request }), (e) => {
      assert.match(e.message, re);
      assert.match(e.message, /Nothing was deleted/);
      return true;
    });
    for (const f of Object.values(files)) assert.ok(fs.existsSync(f), `${f} kept`);
  }
});

test("purge: no broker key and no state file → nothing to expire; leftover host logs go", async (t) => {
  const { env, files } = purgeHome(t, { key: false });
  fs.rmSync(files.state);
  const r = await installer.purge({ env, platform: "win32", out: () => {}, request: async () => { throw new Error("must not be called"); } });
  assert.strictEqual(r.expired, 0);
  assert.ok(!fs.existsSync(files.log));
});

test("purge: main() runs it only with --purge, after the uninstall", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "bridge-install.js"), "utf8");
  assert.match(src, /argv\.includes\("--purge"\)/);
  assert.ok(src.indexOf("uninstall();") < src.indexOf("await purge("), "registry + host files go first");
});
