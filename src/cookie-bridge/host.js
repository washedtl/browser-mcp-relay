#!/usr/bin/env node
// host.js — the cookie bridge's native-messaging host (W2F).
//
// Chrome starts it (through the .bat launcher bridge-install.js writes) when
// the cookie-bridge extension in the owner's Chrome profile connects, and
// talks to it on stdio with native-messaging framing (framing.js):
//
//   extension → host  {t:"hello",v:1} · {t:"full",seq,cookies,last} · {t:"delta",seq,changes}
//   host → extension  {t:"status",broker:"up"|"down"} (on every change, and in answer to hello)
//                     {t:"resync"} (after every authenticated broker (re)connect: the extension
//                       sends cookies only then)
//                     {t:"ack",seq,applied,rejected:[{domain,reason,count}][,rejectedTruncated]
//                       [,dropped:true][,error:"…"]}
//   ack: applied = cookies/changes the broker accepted. dropped:true (applied 0) = no broker,
//   or its connection broke before it answered: nothing was synced, the next resync covers
//   it. error:"…" (applied 0) = the broker refused the request itself. Either one means
//   "not synced". rejected is capped at 500 entries (rejectedTruncated = how many more).
//
// The host forwards cookies to the broker over the broker's own named pipe:
// it polls the pipe every ~5 s while there is no broker (it never starts
// one), authenticates with the broker key (control.js openBridge: the HMAC
// hello flagged bridge:true), and on every (re)connect asks the extension
// for a full resync. Changes that arrive while the broker is down are
// dropped: the next resync covers them. It opens no TCP port, never writes
// anything but framed messages to stdout, and never logs a cookie value.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { encodeMessage, MessageReader } = require("./framing.js");

const DEFAULT_POLL_MS = 5000;
const AUTH_RETRY_MS = 30_000; // the pipe's owner refused us: not worth asking every 5 s
const MAX_REJECTED = 500; // keeps an ack far under Chrome's 1 MB
const LOG_ROTATE_BYTES = 1024 * 1024;

class NativeHost {
  /**
   * @param {object} opts
   * @param {NodeJS.ReadableStream} opts.input — Chrome → host (stdin)
   * @param {NodeJS.WritableStream} opts.output — host → Chrome (stdout)
   * @param {() => Promise<{request: Function, close: Function, on: Function, closed: boolean}>} opts.connectBroker
   * @param {number} [opts.pollMs]
   * @param {(msg: string) => void} [opts.log]
   * @param {(code: number) => void} [opts.exit]
   */
  constructor({ input, output, connectBroker, pollMs = DEFAULT_POLL_MS, log = () => {}, exit = () => {} }) {
    this._input = input;
    this._output = output;
    this._connectBroker = connectBroker;
    this._pollMs = pollMs;
    this._log = log;
    this._exit = exit;
    this._bridge = null;
    this._connecting = false;
    this._timer = null;
    this._stopped = false;
    this._lastStatus = null;
    this._lastFailure = null;
  }

  start() {
    const reader = new MessageReader({
      onMessage: (msg) => this._onMessage(msg),
      onMalformed: (bytes) => this._log(`malformed message from the extension (${bytes} bytes); skipped`),
      onFatal: (e) => {
        this._log(`${e.message}; stopping`);
        this.stop(1);
      },
    });
    this._input.on("data", (chunk) => reader.push(chunk));
    this._input.on("end", () => this.stop(0));
    this._input.on("error", () => this.stop(0));
    this._poll();
  }

  /** Chrome went away (or the stream broke): close the bridge, exit. */
  stop(code = 0) {
    if (this._stopped) return;
    this._stopped = true;
    clearTimeout(this._timer);
    if (this._bridge) this._bridge.close();
    this._log(`stopped (${code === 0 ? "Chrome disconnected" : "protocol error"})`);
    this._exit(code);
  }

  _send(msg) {
    try {
      this._output.write(encodeMessage(msg));
    } catch (e) {
      this._log(`could not send a ${msg.t} message to the extension: ${e.message}`);
    }
  }

  _status(broker, force = false) {
    if (!force && broker === this._lastStatus) return;
    this._lastStatus = broker;
    this._send({ t: "status", broker });
  }

  _schedule(ms) {
    clearTimeout(this._timer);
    if (!this._stopped) this._timer = setTimeout(() => this._poll(), ms);
  }

  async _poll() {
    if (this._stopped || this._bridge || this._connecting) return;
    this._connecting = true;
    let bridge;
    try {
      bridge = await this._connectBroker();
    } catch (e) {
      this._connecting = false;
      const code = e.code || "error";
      if (code !== this._lastFailure) {
        this._lastFailure = code;
        const every = `retrying every ${Math.round(this._pollMs / 1000)} s`;
        if (code === "EAUTH") this._log(`the broker pipe refused the bridge: ${e.message}`);
        else if (code === "EBUSY") this._log(`another cookie bridge is already connected to the broker (one Chrome profile syncs at a time); ${every}`);
        else this._log(`no broker (${code}); ${every}`);
      }
      this._status("down");
      this._schedule(code === "EAUTH" ? Math.max(AUTH_RETRY_MS, this._pollMs) : this._pollMs);
      return;
    }
    this._connecting = false;
    if (this._stopped) {
      bridge.close();
      return;
    }
    this._bridge = bridge;
    this._lastFailure = null;
    bridge.on("close", () => {
      if (this._bridge !== bridge) return;
      this._bridge = null;
      this._log("broker connection closed");
      this._status("down");
      this._schedule(this._pollMs);
    });
    this._log("connected to the broker; asking the extension for a full resync");
    this._status("up");
    this._send({ t: "resync" });
  }

  _onMessage(msg) {
    if (this._stopped || !msg || typeof msg !== "object") return;
    if (msg.t === "hello") {
      this._status(this._bridge ? "up" : "down", true);
    } else if (msg.t === "full") {
      this._forward(msg.seq, { ctl: "cookies.full", cookies: msg.cookies, last: msg.last !== false }, `full sync batch (${Array.isArray(msg.cookies) ? msg.cookies.length : 0} cookie(s))`);
    } else if (msg.t === "delta") {
      this._forward(msg.seq, { ctl: "cookies.delta", changes: msg.changes }, `delta (${Array.isArray(msg.changes) ? msg.changes.length : 0} change(s))`);
    } else {
      this._log(`ignored a message of type ${JSON.stringify(String(msg.t)).slice(0, 40)}`);
    }
  }

  async _forward(seq, request, what) {
    const bridge = this._bridge;
    if (!bridge) {
      this._send({ t: "ack", seq, applied: 0, rejected: [], dropped: true });
      return;
    }
    let reply;
    try {
      reply = await bridge.request(request);
    } catch (e) {
      this._log(`${what} dropped: ${e.code || e.message}`);
      this._send({ t: "ack", seq, applied: 0, rejected: [], dropped: true });
      return;
    }
    if (!reply.ok) {
      this._log(`${what}: the broker answered ${reply.error}`);
      this._send({ t: "ack", seq, applied: 0, rejected: [], error: String(reply.error || "error") });
      return;
    }
    const rejected = Array.isArray(reply.rejected) ? reply.rejected : [];
    const ack = { t: "ack", seq, applied: Number(reply.applied) || 0, rejected: rejected.slice(0, MAX_REJECTED) };
    if (rejected.length > MAX_REJECTED) ack.rejectedTruncated = rejected.length - MAX_REJECTED;
    this._log(`${what}: ${ack.applied} applied, ${rejected.length} refused`);
    this._send(ack);
  }
}

/** Append-only log next to the broker's (rotated once at startup past 1 MB). Never throws. */
function fileLogger(file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.statSync(file, { throwIfNoEntry: false })?.size > LOG_ROTATE_BYTES) fs.renameSync(file, `${file}.1`);
  } catch { /* logging is best-effort */ }
  return (msg) => {
    try { fs.appendFileSync(file, `${new Date().toISOString()} [cookie-bridge ${process.pid}] ${msg}\n`); } catch { /* ignore */ }
  };
}

function main(argv = process.argv.slice(2)) {
  const { applyLocalConfigToEnv } = require("../local-config.js");
  const pipeServer = require("../broker/pipe-server.js");
  const { openBridge } = require("../broker/control.js");
  const env = applyLocalConfigToEnv(process.env);
  const log = fileLogger(path.join(pipeServer.brokerHome(env), "cookie-bridge.log"));
  // stdout is the native-messaging stream: anything else written there breaks it
  for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => log(`console.${k}: ${a.map(String).join(" ").slice(0, 300)}`);
  process.on("uncaughtException", (e) => { log(`uncaughtException: ${e.message}`); process.exit(1); });
  process.on("unhandledRejection", (e) => log(`unhandledRejection: ${(e && e.message) || e}`));
  log(`started for ${String(argv[0] || "(no caller origin)").slice(0, 80)}`);

  const connectBroker = async () => {
    const { pipe } = pipeServer.resolveEndpoint(env);
    const key = pipeServer.readKey(pipeServer.keyFileFor(env)); // never created here: no key = no broker has run yet
    if (!key) throw Object.assign(new Error("no broker key yet"), { code: "ENOKEY" });
    return openBridge({ pipe, key });
  };
  new NativeHost({ input: process.stdin, output: process.stdout, connectBroker, log, exit: (code) => process.exit(code) }).start();
}

if (require.main === module) main();

module.exports = { NativeHost, main };
