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
