// pipe-server.js — where the broker listens, and the single-instance claim.
//
// One broker per user and per Brave profile, reached over a Windows named
// pipe (elsewhere a unix socket in a private per-user dir):
//
//   \\.\pipe\browser-mcp-relay-<user>-<sha256(user, profileDir)[:12]>
//   <tmpdir>/browser-mcp-relay-<uid>/<sha256(user, profileDir)[:12]>.sock
//
// The pipe IS the lock: a second broker's listen() fails with EADDRINUSE and
// that broker exits. Only EADDRINUSE means "another broker owns it"; any
// other error (EACCES from a mangled name, say) is a real failure. A browser
// can't reach a pipe, so there is no port, token or Origin check to get wrong.
//
// Light on purpose (node built-ins only): the shim requires this on every
// Claude session start.

"use strict";

const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const PIPE_PREFIX = "browser-mcp-relay";

function currentUser() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USERNAME || process.env.USER || "user";
  }
}

const currentUid = () => (typeof process.getuid === "function" ? process.getuid() : -1);

/** Per-user root for broker state (profile, logs). */
function brokerHome(env = process.env, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32") {
    return p.join(env.LOCALAPPDATA || p.join(os.homedir(), "AppData", "Local"), PIPE_PREFIX, "broker");
  }
  if (platform === "darwin") return p.join(os.homedir(), "Library", "Application Support", PIPE_PREFIX, "broker");
  return p.join(env.XDG_STATE_HOME || p.join(os.homedir(), ".local", "state"), PIPE_PREFIX, "broker");
}

/** The pipe (or socket path) for this user's broker on this profile. */
function pipeNameFor({ profileDir, user = currentUser(), uid = currentUid(), platform = process.platform, tmpdir = os.tmpdir() }) {
  let dir = platform === "win32" ? path.win32.resolve(profileDir) : path.posix.resolve(profileDir);
  // Windows paths are case-insensitive: C:\X and c:/x/ are one profile
  if (platform === "win32") dir = dir.toLowerCase();
  const hash = crypto.createHash("sha256").update(`${user}\n${dir}`).digest("hex").slice(0, 12);
  if (platform !== "win32") {
    // in a private per-user dir: loose in a shared /tmp, another user could
    // squat the name. Short file name: sun_path is ~104 bytes on macOS.
    return path.posix.join(tmpdir, `${PIPE_PREFIX}-${uid}`, `${hash}.sock`);
  }
  const safeUser = String(user).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40) || "user";
  return `\\\\.\\pipe\\${PIPE_PREFIX}-${safeUser}-${hash}`;
}

/**
 * Pipe + profile the broker for this env uses. Env overrides:
 * BROWSER_RELAY_BROKER_PROFILE_DIR, BROWSER_RELAY_BROKER_PIPE.
 * @returns {{pipe: string, profileDir: string}}
 */
function resolveEndpoint(env = process.env, { user, platform = process.platform } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const profileDir = env.BROWSER_RELAY_BROKER_PROFILE_DIR
    ? p.resolve(env.BROWSER_RELAY_BROKER_PROFILE_DIR)
    : p.join(brokerHome(env, platform), "profile");
  const pipe = env.BROWSER_RELAY_BROKER_PIPE || pipeNameFor({ profileDir, user, platform });
  return { pipe, profileDir };
}

function listen(server, pipe) {
  return new Promise((resolve, reject) => {
    const onError = (e) => { server.removeListener("listening", onListening); reject(e); };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(pipe);
  });
}

/**
 * Unix only: why `dir` is not fit to hold the broker's socket (not a real
 * dir, not ours, group/other access), or null. A missing dir is fine here
 * (the broker creates it). Shared with the shim, which must not talk to a
 * socket another local user could have put there.
 */
function privateDirProblem(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  if (!st.isDirectory()) return `socket dir ${dir} is not a directory (or is a symlink)`;
  if (st.uid !== currentUid()) return `socket dir ${dir} is owned by uid ${st.uid}, not ${currentUid()}`;
  if ((st.mode & 0o077) !== 0) return `socket dir ${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)})`;
  return null;
}

/** Unix only: create the socket dir 0700 if needed, then insist it is private. */
function ensurePrivateDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const problem = privateDirProblem(dir);
  if (problem) {
    throw Object.assign(new Error(`[broker] ${problem}: not private (want a dir owned by uid ${currentUid()}, mode 0700)`), { code: "EACCES" });
  }
}

/** Unix only: a socket file nobody answers on is a crashed broker's leftover. */
function isStaleSocket(pipe) {
  return new Promise((resolve) => {
    const c = net.connect(pipe);
    c.once("connect", () => { c.destroy(); resolve(false); });
    c.once("error", (e) => resolve(e.code === "ECONNREFUSED" || e.code === "ENOENT"));
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

const RETRY = Symbol("retry");

/**
 * Unix only: replace a crashed broker's socket file. The stale check → rm →
 * listen runs under an O_EXCL lock file: unserialized, a second broker could
 * rm the first one's fresh socket, and libuv unlinks a socket's path when its
 * server closes, so the loser idling out later would unlink the winner's.
 * Resolves the server, null (another broker owns or is taking the pipe), or
 * RETRY (a dead broker's lock was removed).
 */
async function reclaimStale(server, pipe) {
  const lock = `${pipe}.lock`;
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let holder = NaN;
    try { holder = Number(fs.readFileSync(lock, "utf8")); } catch { return RETRY; } // released meanwhile
    // an empty lock was just created and not written yet: its holder is alive
    if (!holder || pidAlive(holder)) return null;
    fs.rmSync(lock, { force: true }); // left by a broker that died mid-reclaim
    return RETRY;
  }
  try {
    fs.writeSync(fd, String(process.pid));
    if (!(await isStaleSocket(pipe))) return null; // someone took it before we locked
    fs.rmSync(pipe, { force: true });
    try {
      await listen(server, pipe);
    } catch (e) {
      if (e.code === "EADDRINUSE") return null;
      throw e;
    }
    return server;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Claim the pipe. Resolves the listening net.Server, or null when another
 * broker already owns it. Rejects on any other error.
 */
async function claimPipe(pipe) {
  if (process.platform !== "win32") ensurePrivateDir(path.dirname(pipe));
  const server = net.createServer();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await listen(server, pipe);
      return server;
    } catch (e) {
      if (e.code !== "EADDRINUSE") {
        e.message = `[broker] cannot listen on ${pipe}: ${e.code || e.message}`;
        throw e;
      }
    }
    if (process.platform === "win32" || !(await isStaleSocket(pipe))) return null;
    const won = await reclaimStale(server, pipe);
    if (won !== RETRY) return won;
  }
  return null;
}

// ── Who's on the other end ───────────────────────────────────────────────
//
// A pipe name is predictable, so something else could create it first (on
// Windows any local process can create any pipe name). A squatter would get
// every tool argument (passwords, cookies) and could feed results to agents.
// So the shim talks only to a broker that proves it knows this user's key:
//
//   shim   → {"bmr":"hello","v":1,"nonce":<hex>,"settings":<HMAC of settings>,"reconnect":bool}
//   broker → {"bmr":"hello","v":1,"mac":HMAC-SHA256(key, "broker:" + nonce)[,"warning":<text>]}
//
// before anything else is sent. The key lives in a user-private file under
// brokerHome (the shim passes its path to the broker it starts).

const HELLO_TIMEOUT_MS = 5000;
const HELLO_MAX_BYTES = 4096; // a handshake line is ~200 bytes: don't buffer a flood
const MAX_WARNING_CHARS = 1500;

/** The key file next to the broker's other state. */
function keyFileFor(env = process.env) {
  return path.join(brokerHome(env), "broker.key");
}

/** Publish `hex` as the key file unless one exists (tmp + link: atomic). True if we wrote it. */
function publishKey(file, hex) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, hex, { mode: 0o600 });
  try {
    fs.linkSync(tmp, file);
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * The broker's side: if its key file vanished while it runs (a cleanup, a
 * reset profile), write it back, so new sessions keep matching this broker.
 * True if it was restored.
 */
function restoreKeyFile(file, key) {
  if (fs.existsSync(file)) return false;
  return publishKey(file, key.toString("hex"));
}

/** The 32-byte key in `file`, or null when there is none (malformed: EKEY). */
function readKey(file) {
  try {
    const hex = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    throw Object.assign(new Error(`[broker] key file ${file} is malformed; delete it and restart`), { code: "EKEY" });
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Read the 32-byte key, creating it if missing. Published atomically
 * (tmp file + link), so a concurrent reader never sees a half-written key.
 * @returns {Buffer}
 */
function loadOrCreateKey(file) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const key = readKey(file);
    if (key) return key;
    publishKey(file, crypto.randomBytes(32).toString("hex")); // if another process published first, read theirs
  }
  throw new Error(`[broker] could not read or create the key file ${file}`);
}

const helloMac = (key, nonce) => crypto.createHmac("sha256", key).update(`broker:${nonce}`).digest("hex");

/** Timing-safe: is `got` (untrusted) the 64-hex-digit MAC `want`? */
function macEquals(got, want) {
  if (typeof got !== "string" || !/^[0-9a-f]{64}$/.test(got)) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"));
}

/** Connect to `pipe`; rejects with the connect error (ENOENT / ECONNREFUSED: nobody listens). */
function connectPipe(pipe) {
  const sock = net.connect(pipe);
  return new Promise((resolve, reject) => {
    sock.once("error", reject);
    sock.once("connect", () => { sock.removeListener("error", reject); resolve(sock); });
  });
}

/**
 * Read one line from `sock` (the first message of a handshake; a control
 * answer passes a larger maxBytes). Resolves { line, rest } with any bytes
 * after it, or rejects on close / timeout / a line over maxBytes. A paused
 * socket must be resumed by the caller.
 */
function readLine(sock, timeoutMs = HELLO_TIMEOUT_MS, maxBytes = HELLO_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const done = (err, value) => {
      clearTimeout(timer);
      sock.removeListener("data", onData);
      sock.removeListener("close", onClose);
      sock.removeListener("error", onClose);
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const i = buf.indexOf(10);
      if (i < 0) {
        chunks.push(buf);
        size += buf.length;
        if (size > maxBytes) done(Object.assign(new Error(`handshake line over ${maxBytes} bytes`), { code: "EPROTO" }));
        return;
      }
      if (size + i > maxBytes) {
        done(Object.assign(new Error(`handshake line over ${maxBytes} bytes`), { code: "EPROTO" }));
        return;
      }
      sock.pause();
      chunks.push(buf.subarray(0, i));
      done(null, { line: Buffer.concat(chunks).toString("utf8").replace(/\r$/, ""), rest: buf.subarray(i + 1) });
    };
    // transient (e.g. a broker shutting down), unlike a wrong answer (EAUTH)
    const onClose = () => done(Object.assign(new Error("closed during the handshake"), { code: "ECONNRESET" }));
    const timer = setTimeout(() => done(Object.assign(new Error(`no handshake reply within ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
    sock.on("data", onData);
    sock.once("close", onClose);
    sock.once("error", onClose);
  });
}

/**
 * Client side: prove the pipe's owner knows `key`. Resolves { rest, warning }:
 * the bytes that followed the reply (normally none) and the broker's warning,
 * if any (trusted only once the mac checked out). Rejects with code EAUTH on
 * a wrong answer; ECONNRESET / ETIMEDOUT / EPROTO when there was none.
 * `fields(nonce)` adds fields to the hello (control.js: the control request).
 */
async function clientHello(sock, key, { settings = null, reconnect = false, timeoutMs = HELLO_TIMEOUT_MS, fields = null } = {}) {
  const nonce = crypto.randomBytes(16).toString("hex");
  sock.write(JSON.stringify({ ...(fields ? fields(nonce) : {}), bmr: "hello", v: 1, nonce, settings, reconnect }) + "\n");
  const { line, rest } = await readLine(sock, timeoutMs);
  let reply = null;
  try { reply = JSON.parse(line); } catch { /* not ours */ }
  if (!reply || reply.bmr !== "hello" || !macEquals(reply.mac, helloMac(key, nonce))) {
    throw Object.assign(new Error("the pipe's owner failed authentication (not this user's broker)"), { code: "EAUTH" });
  }
  const warning = typeof reply.warning === "string" && reply.warning ? reply.warning.slice(0, MAX_WARNING_CHARS) : null;
  return { rest, warning };
}

/**
 * Who owns `pipe`: "ok" (a broker that knows `key`), "bad" (it answered
 * wrong: not ours, squatted) or the error code when it could not be asked.
 */
async function verifyPipeOwner(pipe, key, timeoutMs = HELLO_TIMEOUT_MS) {
  let sock = null;
  try {
    sock = await connectPipe(pipe);
    await clientHello(sock, key, { timeoutMs });
    return "ok";
  } catch (e) {
    return e.code === "EAUTH" ? "bad" : e.code || "error";
  } finally {
    if (sock) sock.destroy();
  }
}

/**
 * Server side: answer a hello if the connection opens with one (with the
 * broker's warning, if any: a string, or a function of the hello for one
 * meant for that session only). Resolves { hello, rest } — hello null when
 * the first line was something else (it is then part of rest, untouched).
 * The socket is left paused.
 */
async function serverHello(sock, key, { warning = null, timeoutMs = HELLO_TIMEOUT_MS } = {}) {
  const { line, rest } = await readLine(sock, timeoutMs);
  let msg = null;
  try { msg = JSON.parse(line); } catch { /* not a hello */ }
  if (!msg || msg.bmr !== "hello" || typeof msg.nonce !== "string") {
    return { hello: null, rest: Buffer.concat([Buffer.from(line + "\n"), rest]) };
  }
  const reply = { bmr: "hello", v: 1, mac: helloMac(key, msg.nonce) };
  const text = typeof warning === "function" ? warning(msg) : warning;
  if (text) reply.warning = String(text).slice(0, MAX_WARNING_CHARS);
  sock.write(JSON.stringify(reply) + "\n");
  return { hello: msg, rest };
}

/**
 * HMAC (with this user's broker key) of the settings a broker is started
 * with (BROWSER_*, telemetry and upstream's catalog-shaping vars), so a
 * session can tell whether the broker it reached was started with different
 * ones. Keyed: it travels before the handshake completes and covers values
 * such as a proxy URL with credentials.
 */
const SETTINGS_KEY_RE = /^(?:BROWSER_.*|TELEMETRY_ENABLE|TOOL_NAME_PREFIX|AVAILABLE_TOOL_DOMAINS|TOOL_INPUT_METADATA_ENABLE|TOOL_OUTPUT_SCHEMA_DISABLE|PLATFORM|FIGMA_ACCESS_TOKEN)$/i;
function settingsHash(env, key) {
  const pairs = Object.entries(env)
    .filter(([k, v]) => SETTINGS_KEY_RE.test(k) && v !== undefined && v !== "" && !/^BROWSER_RELAY_BROKER_(?:PIPE|LOG|LAUNCH_WARNING)$/i.test(k))
    .map(([k, v]) => [k.toUpperCase(), String(v)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHmac("sha256", key).update(JSON.stringify(pairs)).digest("hex").slice(0, 32);
}

module.exports = {
  pipeNameFor, resolveEndpoint, brokerHome, claimPipe, privateDirProblem, PIPE_PREFIX,
  keyFileFor, readKey, loadOrCreateKey, restoreKeyFile, helloMac, macEquals, connectPipe, readLine, clientHello, serverHello, verifyPipeOwner, settingsHash, HELLO_TIMEOUT_MS, HELLO_MAX_BYTES,
};
