#!/usr/bin/env node
// shim.js — what Claude Code runs per session in broker mode (~20 MB).
//
// Bridges the session's stdio to the shared broker's named pipe
// (src/broker/main.js), byte-for-byte newline-delimited JSON-RPC. It only
// needs node built-ins: no MCP SDK, no Playwright, no upstream.
//
//   - Broker not running (pipe missing): start it through a detached
//     launcher that exits at once (shim → launcher → broker). With the
//     launcher gone, the broker has no live parent, so a tree-kill of the
//     shim (taskkill /T, Claude Code closing the session) can't reach it.
//     Several shims racing a cold start each launch one; the pipe lets one
//     broker win and the rest exit (EADDRINUSE). The broker gets an
//     allowlisted env; an elevated launcher starts it de-elevated
//     (broker/deelevate.js), and if that fails, elevated with a warning the
//     broker passes on to every session (stderr + its first tool result).
//   - Before forwarding anything, the shim checks that the pipe's owner knows
//     this user's broker key (HMAC over a nonce, broker/pipe-server.js): a
//     squatter on the predictable pipe name gets nothing.
//   - Broker connection lost (crash, kill, broker:stop): requests that were
//     in flight get a JSON-RPC error ("browser broker restarted; please
//     retry the call"). The shim reconnects LAZILY, on the client's next
//     message (restarting the broker if needed, with this session's env), so
//     a stopped broker stays stopped; only an initialize still waiting for
//     its answer reconnects at once (it is re-sent). On reconnect it replays
//     the client's initialize + notifications/initialized under its own id,
//     swallows that reply, and tells the client tools/list_changed.
//   - Broker unreachable: queued requests get an error; the shim stays up and
//     tries again on the next message, so the session's MCP server survives.
//
// Launcher mode: node shim.js --launch <brokerEntry> [brokerArgs...]

"use strict";

const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const pipeServer = require("./broker/pipe-server.js");

const SHIM_FILE = __filename;
const BROKER_MAIN = path.join(__dirname, "broker", "main.js");
const CONNECT_TIMEOUT_MS = 30_000; // a cold broker under load needs a few seconds at most
const RESPAWN_AFTER_MS = 5_000; // pipe still missing this long after a launch: launch again
const EXIT_GRACE_MS = 2_000;
const RESTARTED = "browser broker restarted; please retry the call";
// The broker reads us with the MCP SDK's stdio buffer, which drops the whole
// connection on a message over STDIO_DEFAULT_MAX_BUFFER_SIZE (drift-guarded in
// test/shim.test.js). Reject such a message here with the real reason instead
// of letting it surface as RESTARTED, which invites the client to retry it.
const MAX_CLIENT_MESSAGE_BYTES = 10 * 1024 * 1024;
// the one answer to a key the pipe's owner doesn't match (main.js restores a deleted key file every 30 s)
const KEY_ADVICE = "the broker key changed or is missing: the running broker restores a missing key file within ~30 s, so retry then; " +
  "if it persists, run `npm run broker:stop` (close sessions first) and retry. (Or another program holds the pipe name: set BROWSER_RELAY_BROKER_PIPE.)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** argv for the launcher process (node <shim> --launch <entry> ...args). */
function launcherArgs(brokerEntry, brokerArgs = []) {
  return [SHIM_FILE, "--launch", brokerEntry, ...brokerArgs];
}

/** Unix: a socket in a dir another local user controls must not be trusted. */
function defaultPipeDirProblem(pipe) {
  if (process.platform === "win32") return null; // named pipes: libuv's default DACL (same user)
  return pipeServer.privateDirProblem(path.dirname(pipe));
}

function defaultSpawnLauncher(args) {
  spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

// The broker serves every session, so it gets only what it needs from the
// session that happened to start it: OS basics, the relay's own settings and
// upstream's catalog-shaping vars (never e.g. API tokens meant for Claude).
const OS_ENV_KEYS = new Set([
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "USERNAME", "USERDOMAIN",
  "HOMEDRIVE", "HOMEPATH", "HOME", "USER", "LOGNAME", "SHELL", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)",
  "PROGRAMW6432", "PROGRAMDATA", "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "COMPUTERNAME", "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE", "OS", "SYSTEMDRIVE", "LANG", "TZ", "DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
]);
const ENV_ALLOW_RE = /^(?:BROWSER_.*|TELEMETRY_ENABLE|TOOL_NAME_PREFIX|AVAILABLE_TOOL_DOMAINS|TOOL_INPUT_METADATA_ENABLE|TOOL_OUTPUT_SCHEMA_DISABLE|PLATFORM|FIGMA_ACCESS_TOKEN|LC_.*|XDG_.*)$/i;

/** The env a launched broker gets. */
function launchEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    // set by the launcher itself, never taken from a session (it would be forgeable)
    if (/^BROWSER_RELAY_BROKER_LAUNCH_WARNING$/i.test(k)) continue;
    if (v !== undefined && (OS_ENV_KEYS.has(k.toUpperCase()) || ENV_ALLOW_RE.test(k))) out[k] = v;
  }
  return out;
}

const brokerLogFile = (env) => env.BROWSER_RELAY_BROKER_LOG || path.join(pipeServer.brokerHome(env), "broker.log");

function appendLog(file, msg) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${new Date().toISOString()} [launcher ${process.pid}] ${msg}\n`);
  } catch { /* best-effort */ }
}

/**
 * Launcher process: start the broker detached and hidden, then exit. When
 * this process is elevated (Windows), the broker starts de-elevated through
 * the desktop shell's token with exactly the allowlisted env; if that fails
 * it starts elevated as before, and the warning goes to the broker log and
 * (BROWSER_RELAY_BROKER_LAUNCH_WARNING) to every session it serves.
 * BROWSER_RELAY_BROKER_DEELEVATE=off keeps an elevated launch elevated.
 */
function runLauncher(argv, {
  spawnFn = spawn,
  exit = process.exit,
  env = process.env,
  isElevated = () => require("./broker/deelevate.js").isElevated(env),
  launchDeelevated = (opts) => require("./broker/deelevate.js").launchDeelevated(opts),
  log = (msg) => appendLog(brokerLogFile(env), msg),
} = {}) {
  const [brokerEntry, ...brokerArgs] = argv;
  // The watchdog stops frozen code with Runtime.terminateExecution; landing
  // in a timer or event callback, that trips Node's async-hook stack check,
  // which aborts the process (measured). Without the check the broker lives
  // (Node 24+: before that AsyncLocalStorage turns the check back on, and such
  // a freeze still ends the broker, as it did at the watchdog's limit).
  const nodeArgs = ["--no-force-async-hooks-checks", brokerEntry, ...brokerArgs];
  const childEnv = launchEnv(env);
  if (String(env.BROWSER_RELAY_BROKER_DEELEVATE || "").toLowerCase() !== "off" && isElevated()) {
    try {
      const home = pipeServer.brokerHome(env);
      fs.mkdirSync(home, { recursive: true }); // its working dir
      launchDeelevated({ args: nodeArgs, cwd: home, childEnv, env });
      exit(0);
      return;
    } catch (e) {
      const warning = `the browser broker runs elevated (as administrator), and so does its Brave: starting it de-elevated failed (${e.message})`;
      log(`WARNING: ${warning}`);
      childEnv.BROWSER_RELAY_BROKER_LAUNCH_WARNING = warning;
    }
  }
  spawnFn(process.execPath, nodeArgs, { detached: true, stdio: "ignore", windowsHide: true, env: childEnv }).unref();
  exit(0);
}

/** Splits a utf8 stream into lines (CRLF tolerated); scans each chunk once. */
function onLines(stream, fn) {
  if (typeof stream.setEncoding === "function") stream.setEncoding("utf8");
  let parts = [];
  stream.on("data", (chunk) => {
    let start = 0;
    for (let i; (i = chunk.indexOf("\n", start)) >= 0; start = i + 1) {
      parts.push(chunk.slice(start, i));
      const line = (parts.length === 1 ? parts[0] : parts.join("")).replace(/\r$/, "");
      parts = [];
      if (line) fn(line);
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  });
}

class Shim {
  /**
   * @param {object} opts
   * @param {string} opts.pipe
   * @param {string} opts.brokerEntry — script the launcher starts
   * @param {string[]} [opts.brokerArgs]
   * @param {string} opts.keyFile — this user's broker key (created if missing)
   * @param {object|null} [opts.settingsEnv] — this session's env; its keyed settingsHash goes in the hello
   * @param {import("stream").Readable} [opts.input] — client → shim (stdin)
   * @param {import("stream").Writable} [opts.output] — shim → client (stdout)
   * @param {(msg: string) => void} [opts.log] — default: stderr
   * @param {(code: number) => void} [opts.exit]
   * @param {(pipe: string) => import("net").Socket} [opts.connect]
   * @param {(args: string[]) => void} [opts.spawnLauncher]
   * @param {(pipe: string) => string|null} [opts.pipeDirProblem] — why the socket's dir can't be trusted, or null
   * @param {number} [opts.connectTimeoutMs]
   * @param {number} [opts.respawnAfterMs]
   */
  constructor({
    pipe, brokerEntry, brokerArgs = [], keyFile, settingsEnv = null,
    input = process.stdin, output = process.stdout,
    log = (m) => { try { process.stderr.write(`[mcp-relay shim] ${m}\n`); } catch { /* stderr gone */ } },
    exit = (code) => process.exit(code),
    connect = (p) => net.connect(p),
    spawnLauncher = defaultSpawnLauncher,
    pipeDirProblem = defaultPipeDirProblem,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    respawnAfterMs = RESPAWN_AFTER_MS,
  }) {
    Object.assign(this, {
      pipe, brokerEntry, brokerArgs, keyFile, settingsEnv, input, output, log, exitFn: exit, connectFn: connect,
      spawnLauncher, pipeDirProblem, connectTimeoutMs, respawnAfterMs,
    });
    this.key = null;
    this.warning = null; // from the broker's hello: shown once (stderr + first tool result)
    this.warningShown = false;
    this.sock = null;
    this.connecting = null;
    this.queue = []; // client lines waiting for a broker connection
    this.inflight = new Map(); // client request id → method
    this.initMsg = null; // the client's initialize, for replay
    this.initializedMsg = null;
    this.resendInit = false; // initialize was in flight when the broker died
    this.replayId = null;
    this.replays = 0;
    this.everAttached = false; // a later connection is to a restarted broker
    this.ending = false; // the client went away
    this.closed = false;
    this.exited = false;
  }

  start() {
    onLines(this.input, (line) => this._fromClient(line));
    this.input.on("end", () => this._clientGone());
    this.input.on("close", () => this._clientGone());
    if (typeof this.output.on === "function") this.output.on("error", () => this._clientGone());
    this._connect(); // eagerly: a cold broker starts while the client is still starting
  }

  /** Stop without exiting (tests). */
  close() {
    this.closed = true;
    this.ending = true;
    this.exited = true;
    if (this.sock) this.sock.destroy();
  }

  _toClient(obj) {
    try { this.output.write(JSON.stringify(obj) + "\n"); } catch { /* client gone */ }
  }

  _fromClient(line) {
    if (this.ending) return;
    if (Buffer.byteLength(line) + 1 > MAX_CLIENT_MESSAGE_BYTES) {
      const msg = tryParse(line);
      const mb = (Buffer.byteLength(line) / 1048576).toFixed(1);
      this.log(`dropped a ${mb} MB message from the client (limit 10 MB)`);
      if (msg && msg.id !== undefined && msg.method) {
        this._toClient({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32600, message: `message too large (${mb} MB; the limit is 10 MB). Send smaller arguments, e.g. write the data to a file and pass its path.` },
        });
      }
      return;
    }
    if (this.sock && !this.connecting) {
      this._toBroker(line);
      return;
    }
    this.queue.push(line);
    this._connect();
  }

  _toBroker(line) {
    const msg = tryParse(line);
    if (msg) {
      if (msg.method === "initialize") this.initMsg = msg;
      else if (msg.method === "notifications/initialized") this.initializedMsg = msg;
      if (msg.id !== undefined && msg.method) this.inflight.set(msg.id, msg.method);
      // a cancelled request gets no answer: no bogus "restarted" error for it later
      else if (msg.method === "notifications/cancelled" && msg.params) this.inflight.delete(msg.params.requestId);
    }
    this.sock.write(line + "\n");
  }

  _fromBroker(line) {
    const msg = tryParse(line);
    if (msg && msg.id !== undefined && !msg.method) {
      if (this.replayId !== null && msg.id === this.replayId) {
        this.replayId = null; // our replayed initialize: the client already has its reply
        return;
      }
      const method = this.inflight.get(msg.id);
      this.inflight.delete(msg.id);
      if (method === "tools/call" && this.warning && !this.warningShown && msg.result && Array.isArray(msg.result.content)) {
        this.warningShown = true;
        msg.result.content.unshift({ type: "text", text: `[browser-mcp-relay] WARNING: ${this.warning}` });
        line = JSON.stringify(msg);
      }
    }
    try { this.output.write(line + "\n"); } catch { /* client gone */ }
  }

  _connect() {
    if (this.connecting || this.sock || this.closed) return;
    this.connecting = this._connectOrStart().then(
      (sock) => {
        this.connecting = null;
        if (this.closed) { sock.destroy(); return; }
        this._attach(sock);
      },
      (e) => {
        this.connecting = null;
        this._unavailable(e);
      },
    );
  }

  async _connectOrStart() {
    const t0 = Date.now();
    let lastLaunch = 0;
    let lastErr = null;
    let keyReloaded = false;
    for (let attempt = 0; Date.now() - t0 < this.connectTimeoutMs; attempt++) {
      if (this.closed) throw new Error("shim closed");
      // waiting won't fix it, and launching a broker there would be refused too
      const problem = this.pipeDirProblem(this.pipe);
      if (problem) throw new Error(`refusing ${this.pipe}: ${problem} (not private)`);
      try {
        return await this._connectOnce();
      } catch (e) {
        if (e.code === "EKEY") throw e;
        if (e.code === "EAUTH" && !keyReloaded) {
          // our cached key may be stale (the key file was recreated): read it again, once
          keyReloaded = true;
          this.key = null;
          continue;
        }
        if (e.code === "EAUTH" || e.code === "ENOKEY") throw new Error(`${e.message}; ${KEY_ADVICE}`);
        lastErr = e;
        const missing = e.code === "ENOENT" || e.code === "ECONNREFUSED";
        if (missing && Date.now() - lastLaunch >= this.respawnAfterMs) {
          lastLaunch = Date.now();
          this.log(`no broker on ${this.pipe}; starting one`);
          // the only place a key is made: the broker started now reads it
          if (!this.key) this.key = this._keyFileOp(() => pipeServer.loadOrCreateKey(this.keyFile));
          try {
            this.spawnLauncher(launcherArgs(this.brokerEntry, this.brokerArgs));
          } catch (se) {
            this.log(`could not start the broker launcher: ${se.message}`);
          }
        }
        await sleep(Math.min(25 + attempt * 10, 200));
      }
    }
    throw new Error(`no broker answered on ${this.pipe} within ${this.connectTimeoutMs} ms (${lastErr ? lastErr.code || lastErr.message : "timeout"})`);
  }

  _keyFileOp(fn) {
    try {
      return fn();
    } catch (e) {
      throw Object.assign(new Error(`cannot use the broker key file ${this.keyFile}: ${e.message}`), { code: "EKEY" });
    }
  }

  /** This user's broker key, or null while its file is missing (a key is only made before a launch). */
  _loadKey() {
    if (!this.key) this.key = this._keyFileOp(() => pipeServer.readKey(this.keyFile));
    return this.key;
  }

  async _connectOnce() {
    const key = this._loadKey();
    const s = await new Promise((resolve, reject) => {
      const sock = this.connectFn(this.pipe);
      const onError = (e) => { sock.destroy(); reject(e); };
      sock.once("error", onError);
      sock.once("connect", () => { sock.removeListener("error", onError); resolve(sock); });
    });
    if (!key) {
      // a broker answers, but this user's key file is gone. The broker puts
      // it back; a key made here would not be the broker's.
      s.destroy();
      throw Object.assign(new Error(`the broker key file ${this.keyFile} is missing while a broker runs on ${this.pipe}`), { code: "ENOKEY" });
    }
    try {
      // nothing of the session's goes out before the owner proves it is ours
      const settings = this.settingsEnv ? pipeServer.settingsHash(this.settingsEnv, key) : null;
      const { rest, warning } = await pipeServer.clientHello(s, key, { settings, reconnect: this.everAttached });
      if (rest.length) s.unshift(rest);
      // per broker: a reconnect to one without a warning clears it
      if (warning !== this.warning) {
        this.warning = warning;
        this.warningShown = false;
        if (warning) this.log(`WARNING: ${warning}`);
      }
      return s;
    } catch (e) {
      s.destroy();
      throw e;
    }
  }

  _attach(sock) {
    this.sock = sock;
    this.everAttached = true;
    onLines(sock, (line) => this._fromBroker(line));
    sock.on("error", () => { /* 'close' follows */ });
    sock.on("close", () => this._brokerGone(sock));
    sock.resume(); // the handshake left it paused
    if (this.initMsg) {
      if (this.resendInit) {
        this.resendInit = false;
        this._toBroker(JSON.stringify(this.initMsg)); // under the client's id: its reply is the client's
      } else {
        this.replayId = `__shim_replay_${process.pid}_${++this.replays}`;
        sock.write(JSON.stringify({ ...this.initMsg, id: this.replayId }) + "\n");
        if (this.initializedMsg) sock.write(JSON.stringify(this.initializedMsg) + "\n");
        // the new broker's per-session state (e.g. enabled toolsets) starts fresh
        this._toClient({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
    }
    for (const line of this.queue.splice(0)) this._toBroker(line);
  }

  _brokerGone(sock) {
    if (this.sock !== sock) return;
    this.sock = null;
    this.replayId = null;
    if (this.ending) {
      this._exit(0);
      return;
    }
    this.log(`broker connection lost; ${this.inflight.size} request(s) in flight`);
    for (const [id, method] of this.inflight) {
      if (method === "initialize") this.resendInit = true;
      else this._toClient({ jsonrpc: "2.0", id, error: { code: -32603, message: RESTARTED } });
    }
    this.inflight.clear();
    // lazily: the client's next message reconnects (_fromClient). An
    // initialize waiting for its answer sends nothing more: re-send it now.
    if (this.resendInit) this._connect();
  }

  _unavailable(e) {
    if (this.closed) return;
    this.log(`browser broker unavailable: ${e.message}`);
    const fail = (id) => this._toClient({ jsonrpc: "2.0", id, error: { code: -32603, message: `browser broker unavailable (${e.message}); retry the call` } });
    // an initialize lost with the old broker can't be re-sent now: answer it
    if (this.resendInit) fail(this.initMsg.id);
    this.resendInit = false;
    for (const line of this.queue.splice(0)) {
      const msg = tryParse(line);
      if (msg && msg.id !== undefined && msg.method) fail(msg.id);
    }
  }

  _clientGone() {
    if (this.ending) return;
    this.ending = true;
    this.queue.length = 0;
    if (!this.sock) {
      this.closed = true;
      this._exit(0);
      return;
    }
    this.sock.end();
    const t = setTimeout(() => this._exit(0), EXIT_GRACE_MS);
    if (t.unref) t.unref();
  }

  _exit(code) {
    if (this.exited) return;
    this.exited = true;
    this.closed = true;
    this.exitFn(code);
  }
}

/** Pipe, key, broker entry and broker args for this env (same derivation as the broker's). */
function resolveShimOptions(env) {
  const { pipe, profileDir } = pipeServer.resolveEndpoint(env);
  const keyFile = pipeServer.keyFileFor(env);
  return {
    pipe,
    keyFile,
    settingsEnv: env,
    brokerEntry: BROKER_MAIN,
    brokerArgs: ["--pipe", pipe, "--profile-dir", profileDir, "--key-file", keyFile],
  };
}

function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--launch") {
    runLauncher(argv.slice(1));
    return;
  }
  const { applyLocalConfigToEnv } = require("./local-config.js");
  new Shim(resolveShimOptions(applyLocalConfigToEnv(process.env))).start();
}

if (require.main === module) main();

module.exports = { Shim, runLauncher, launchEnv, launcherArgs, resolveShimOptions, onLines, main, SHIM_FILE, BROKER_MAIN, RESTARTED, MAX_CLIENT_MESSAGE_BYTES };
