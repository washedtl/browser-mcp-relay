// control.js — the broker's control channel: `npm run broker:status` and
// `npm run broker:stop` (scripts/broker-ctl.js) over the broker's own pipe.
//
//   client → the shim's hello (pipe-server.js) plus  ctl: "status" | "stop"
//   broker → its usual hello reply (proves the broker), then
//            {"bmr":"ctl","challenge":<fresh nonce>}
//   client → {"bmr":"ctl","mac":HMAC-SHA256(key, "ctl:<ctl>:<challenge>")}
//   broker → {"bmr":"ctl","ok":...}, and closes
//
// The broker picks the challenge, so a recorded request can't be replayed.
// A control connection is never an MCP session.

"use strict";

const crypto = require("node:crypto");
const { macEquals, connectPipe, clientHello, readLine, HELLO_TIMEOUT_MS } = require("./pipe-server.js");

// a status lists every session's tabs and URLs: more than a handshake line
const MAX_ANSWER_BYTES = 1024 * 1024;

const ctlMac = (key, cmd, challenge) => crypto.createHmac("sha256", key).update(`ctl:${cmd}:${challenge}`).digest("hex");

/** The next line on a socket a handshake left paused (any bytes after it are put back). */
async function nextLine(sock, timeoutMs, maxBytes) {
  const pending = readLine(sock, timeoutMs, maxBytes);
  sock.resume();
  const { line, rest } = await pending;
  if (rest.length) sock.unshift(rest);
  return line;
}

const parse = (line) => { try { return JSON.parse(line); } catch { return null; } };

/**
 * Broker side: challenge the control request in `hello`, answer it, close.
 * @param {Buffer} rest — bytes that followed the hello
 * @param {{status: () => object, stop: () => void}} handlers — stop runs once the reply is sent
 */
async function serveControl(sock, hello, key, { status, stop }, rest = Buffer.alloc(0)) {
  const reply = (obj, then) => sock.end(`${JSON.stringify({ bmr: "ctl", ...obj })}\n`, then);
  const cmd = String(hello.ctl);
  const challenge = crypto.randomBytes(16).toString("hex");
  if (rest.length) sock.unshift(rest);
  sock.write(`${JSON.stringify({ bmr: "ctl", challenge })}\n`);
  let answer;
  try {
    answer = parse(await nextLine(sock, HELLO_TIMEOUT_MS));
  } catch {
    sock.destroy();
    return;
  }
  if (!answer || !macEquals(answer.mac, ctlMac(key, cmd, challenge))) {
    reply({ ok: false, error: "control request not authenticated" });
  } else if (cmd === "status") {
    try {
      reply({ ok: true, status: status() });
    } catch (e) {
      reply({ ok: false, error: `status failed: ${e.message}` });
    }
  } else if (cmd === "stop") {
    reply({ ok: true, stopping: true, pid: process.pid }, () => stop());
  } else {
    reply({ ok: false, error: `unknown control command ${JSON.stringify(cmd)}` });
  }
}

/**
 * Client side: send one control command and return the broker's answer
 * ({bmr:"ctl", ok, ...}). Rejects with the connect error's code (ENOENT /
 * ECONNREFUSED: no broker), EAUTH (the pipe's owner doesn't know the key),
 * EPROTO (no challenge), ECONNRESET or ETIMEDOUT.
 */
async function requestControl({ pipe, key, cmd, timeoutMs = HELLO_TIMEOUT_MS }) {
  const sock = await connectPipe(pipe);
  try {
    const { rest } = await clientHello(sock, key, { timeoutMs, fields: () => ({ ctl: cmd }) });
    if (rest.length) sock.unshift(rest);
    const challenge = parse(await nextLine(sock, timeoutMs));
    if (!challenge || challenge.bmr !== "ctl" || typeof challenge.challenge !== "string" || !/^[0-9a-f]{32}$/.test(challenge.challenge)) {
      throw Object.assign(new Error("the broker sent no control challenge (an older broker?)"), { code: "EPROTO" });
    }
    sock.write(`${JSON.stringify({ bmr: "ctl", mac: ctlMac(key, cmd, challenge.challenge) })}\n`);
    return JSON.parse(await nextLine(sock, timeoutMs, MAX_ANSWER_BYTES));
  } finally {
    sock.destroy();
  }
}

module.exports = { serveControl, requestControl, ctlMac };

// ── W2F cookie bridge ─────────────────────────────────────────────────────
//
// The cookie bridge's native host (src/cookie-bridge/host.js) keeps ONE
// long-lived connection, opened with the shim's hello plus
//   bridge: true,  bridgeMac: HMAC-SHA256(key, "bridge:<nonce>")
// The broker answers {"bmr":"ctl","ok":true,"bridge":"ready"}, then one
// reply line per request line, in order:
//   {id, ctl:"cookies.full", cookies, last} | {id, ctl:"cookies.delta", changes}
//   → {"bmr":"ctl", id, ok:true, applied, rejected:[{domain, reason, count}]} | {…, ok:false, error}
// A bridge connection is never an MCP session (main.js). Cookie values are
// never echoed back.

const BRIDGE_COMMANDS = Object.freeze(["cookies.full", "cookies.delta"]);

const bridgeMac = (key, nonce) => crypto.createHmac("sha256", key).update(`bridge:${nonce}`).digest("hex");

/**
 * Broker side: serve the bridge connection whose hello is `hello`.
 * @param {object} handlers — importer.handlers(id): {"cookies.full": fn, "cookies.delta": fn, close: fn}
 */
function serveBridge(sock, hello, rest, key, handlers) {
  const { readLines } = require("../cookie-bridge/line-channel.js");
  const reply = (obj) => { if (!sock.destroyed) sock.write(`${JSON.stringify({ bmr: "ctl", ...obj })}\n`); };
  sock.once("close", () => handlers.close());
  if (!macEquals(hello.bridgeMac, bridgeMac(key, String(hello.nonce)))) {
    sock.end(`${JSON.stringify({ bmr: "ctl", ok: false, error: "bridge not authenticated" })}\n`);
    return;
  }
  reply({ ok: true, bridge: "ready" });
  let chain = Promise.resolve();
  const dispatch = async (msg) => {
    const id = msg && typeof msg === "object" ? msg.id : undefined;
    const cmd = msg && typeof msg === "object" ? msg.ctl : undefined;
    if (!BRIDGE_COMMANDS.includes(cmd)) {
      reply({ id, ok: false, error: `unknown bridge command ${JSON.stringify(String(cmd)).slice(0, 60)}` });
      return;
    }
    try {
      reply({ id, ok: true, ...(await handlers[cmd](msg)) });
    } catch (e) {
      reply({ id, ok: false, error: e.message });
    }
  };
  readLines(sock, rest, {
    onLine: (msg) => { chain = chain.then(() => dispatch(msg)); },
    onMalformed: (bytes) => { chain = chain.then(() => reply({ ok: false, error: `malformed request line (${bytes} bytes)` })); },
  });
}

/**
 * Client side (the native host): open an authenticated bridge connection.
 * Resolves a BridgeClient; rejects with the connect error's code, EAUTH
 * (not this user's broker, or it refused the bridge), ECONNRESET, ETIMEDOUT.
 */
async function openBridge({ pipe, key, timeoutMs = HELLO_TIMEOUT_MS, requestTimeoutMs }) {
  const { BridgeClient } = require("../cookie-bridge/line-channel.js");
  const sock = await connectPipe(pipe);
  try {
    const { rest } = await clientHello(sock, key, { timeoutMs, fields: (nonce) => ({ bridge: true, bridgeMac: bridgeMac(key, nonce) }) });
    if (rest.length) sock.unshift(rest);
    const readyLine = readLine(sock, timeoutMs);
    sock.resume(); // the handshake left it paused
    const ready = await readyLine;
    let msg = null;
    try { msg = JSON.parse(ready.line); } catch { /* not ours */ }
    if (!msg || msg.ok !== true || msg.bridge !== "ready") {
      throw Object.assign(new Error(`the broker refused the cookie bridge${msg && msg.error ? `: ${msg.error}` : ""}`), { code: "EAUTH" });
    }
    return new BridgeClient(sock, ready.rest, { requestTimeoutMs });
  } catch (e) {
    sock.destroy();
    throw e;
  }
}

Object.assign(module.exports, { BRIDGE_COMMANDS, bridgeMac, serveBridge, openBridge });
