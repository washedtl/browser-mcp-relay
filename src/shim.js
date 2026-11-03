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
//     broker win and the rest exit (EADDRINUSE).
//   - Broker connection lost (crash, kill): reconnect (restarting the broker
//     if needed), replay the client's initialize + notifications/initialized
//     under the shim's own id and swallow that reply, then tell the client
//     tools/list_changed. Requests that were in flight get a JSON-RPC error
//     ("browser broker restarted; please retry the call"); an initialize
//     still in flight is re-sent instead.
//   - Broker unreachable: queued requests get an error; the shim stays up and
//     tries again on the next message, so the session's MCP server survives.
//
// Launcher mode: node shim.js --launch <brokerEntry> [brokerArgs...]

"use strict";

const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SHIM_FILE = __filename;
const BROKER_MAIN = path.join(__dirname, "broker", "main.js");
const CONNECT_TIMEOUT_MS = 30_000; // a cold broker under load needs a few seconds at most
const RESPAWN_AFTER_MS = 5_000; // pipe still missing this long after a launch: launch again
const EXIT_GRACE_MS = 2_000;
const RESTARTED = "browser broker restarted; please retry the call";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

/** argv for the launcher process (node <shim> --launch <entry> ...args). */
function launcherArgs(brokerEntry, brokerArgs = []) {
  return [SHIM_FILE, "--launch", brokerEntry, ...brokerArgs];
}

function defaultSpawnLauncher(args) {
  spawn(process.execPath, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

/** Launcher process: start the broker detached and hidden, then exit. */
function runLauncher(argv, { spawnFn = spawn, exit = process.exit } = {}) {
  const [brokerEntry, ...brokerArgs] = argv;
  spawnFn(process.execPath, [brokerEntry, ...brokerArgs], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  exit(0);
}

/** Splits a utf8 stream into lines (CRLF tolerated). */
function onLines(stream, fn) {
  if (typeof stream.setEncoding === "function") stream.setEncoding("utf8");
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk;
    for (let i; (i = buf.indexOf("\n")) >= 0;) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      if (line) fn(line);
    }
  });
}

class Shim {
  /**
   * @param {object} opts
   * @param {string} opts.pipe
   * @param {string} opts.brokerEntry — script the launcher starts
   * @param {string[]} [opts.brokerArgs]
   * @param {import("stream").Readable} [opts.input] — client → shim (stdin)
   * @param {import("stream").Writable} [opts.output] — shim → client (stdout)
   * @param {(msg: string) => void} [opts.log] — default: stderr
   * @param {(code: number) => void} [opts.exit]
   * @param {(pipe: string) => import("net").Socket} [opts.connect]
   * @param {(args: string[]) => void} [opts.spawnLauncher]
   * @param {number} [opts.connectTimeoutMs]
   * @param {number} [opts.respawnAfterMs]
   */
  constructor({
    pipe, brokerEntry, brokerArgs = [],
    input = process.stdin, output = process.stdout,
    log = (m) => { try { process.stderr.write(`[mcp-relay shim] ${m}\n`); } catch { /* stderr gone */ } },
    exit = (code) => process.exit(code),
    connect = (p) => net.connect(p),
    spawnLauncher = defaultSpawnLauncher,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    respawnAfterMs = RESPAWN_AFTER_MS,
  }) {
    Object.assign(this, { pipe, brokerEntry, brokerArgs, input, output, log, exitFn: exit, connectFn: connect, spawnLauncher, connectTimeoutMs, respawnAfterMs });
    this.sock = null;
    this.connecting = null;
    this.queue = []; // client lines waiting for a broker connection
    this.inflight = new Map(); // client request id → method
    this.initMsg = null; // the client's initialize, for replay
    this.initializedMsg = null;
    this.resendInit = false; // initialize was in flight when the broker died
    this.replayId = null;
    this.replays = 0;
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
      this.inflight.delete(msg.id);
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
    for (let attempt = 0; Date.now() - t0 < this.connectTimeoutMs; attempt++) {
      if (this.closed) throw new Error("shim closed");
      try {
        return await this._connectOnce();
      } catch (e) {
        lastErr = e;
        const missing = e.code === "ENOENT" || e.code === "ECONNREFUSED";
        if (missing && Date.now() - lastLaunch >= this.respawnAfterMs) {
          lastLaunch = Date.now();
          this.log(`no broker on ${this.pipe}; starting one`);
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

  _connectOnce() {
    return new Promise((resolve, reject) => {
      const s = this.connectFn(this.pipe);
      const onError = (e) => { s.destroy(); reject(e); };
      s.once("error", onError);
      s.once("connect", () => { s.removeListener("error", onError); resolve(s); });
    });
  }

  _attach(sock) {
    this.sock = sock;
    onLines(sock, (line) => this._fromBroker(line));
    sock.on("error", () => { /* 'close' follows */ });
    sock.on("close", () => this._brokerGone(sock));
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
    this._connect();
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

/** Pipe, broker entry and broker args for this env (same derivation as the broker's). */
function resolveShimOptions(env) {
  const { resolveEndpoint } = require("./broker/pipe-server.js");
  const { pipe, profileDir } = resolveEndpoint(env);
  return { pipe, brokerEntry: BROKER_MAIN, brokerArgs: ["--pipe", pipe, "--profile-dir", profileDir] };
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

module.exports = { Shim, runLauncher, launcherArgs, resolveShimOptions, main, SHIM_FILE, BROKER_MAIN, RESTARTED };
