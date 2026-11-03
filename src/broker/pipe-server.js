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

/** Unix only: the socket's dir must be ours alone (a real dir, our uid, no group/other access). */
function ensurePrivateDir(dir) {
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== currentUid() || (st.mode & 0o077) !== 0) {
    throw Object.assign(new Error(`[broker] socket dir ${dir} is not private (want a dir owned by uid ${currentUid()}, mode 0700)`), { code: "EACCES" });
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

/**
 * Claim the pipe. Resolves the listening net.Server, or null when another
 * broker already owns it. Rejects on any other error.
 */
async function claimPipe(pipe) {
  if (process.platform !== "win32") ensurePrivateDir(path.dirname(pipe));
  const server = net.createServer();
  try {
    await listen(server, pipe);
  } catch (e) {
    if (e.code !== "EADDRINUSE") {
      e.message = `[broker] cannot listen on ${pipe}: ${e.code || e.message}`;
      throw e;
    }
    if (process.platform === "win32" || !(await isStaleSocket(pipe))) return null;
    fs.rmSync(pipe, { force: true });
    try {
      await listen(server, pipe);
    } catch (e2) {
      if (e2.code === "EADDRINUSE") return null; // another broker won the reclaim
      throw e2;
    }
  }
  // owner-only on unix (the socket lives in a shared temp dir); Windows
  // pipes get libuv's default DACL (same user)
  if (process.platform !== "win32") fs.chmodSync(pipe, 0o600);
  return server;
}

module.exports = { pipeNameFor, resolveEndpoint, brokerHome, claimPipe, PIPE_PREFIX };
