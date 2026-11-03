// control.js — the broker's control channel: `npm run broker:status` and
// `npm run broker:stop` (scripts/broker-ctl.js) over the broker's own pipe.
//
// A control client opens with the shim's hello (pipe-server.js) plus
//   ctl: "status" | "stop",  ctlMac: HMAC-SHA256(key, "ctl:<ctl>:<nonce>")
// so it proves it holds this user's broker key, and the broker proves the
// same back with its usual hello reply. The broker then sends one line,
// {"bmr":"ctl","ok":...}, and closes. A control connection is never an MCP
// session.

"use strict";

const crypto = require("node:crypto");
const { macEquals, connectPipe, clientHello, readLine, HELLO_TIMEOUT_MS } = require("./pipe-server.js");

// a status lists every session's tabs and URLs: more than a handshake line
const MAX_ANSWER_BYTES = 1024 * 1024;

const ctlMac = (key, cmd, nonce) => crypto.createHmac("sha256", key).update(`ctl:${cmd}:${nonce}`).digest("hex");

/**
 * Broker side: answer the control request in `hello` on `sock`, then close it.
 * @param {{status: () => object, stop: () => void}} handlers — stop runs once the reply is sent
 */
function serveControl(sock, hello, key, { status, stop }) {
  const reply = (obj, then) => sock.end(`${JSON.stringify({ bmr: "ctl", ...obj })}\n`, then);
  if (!macEquals(hello.ctlMac, ctlMac(key, String(hello.ctl), String(hello.nonce)))) {
    reply({ ok: false, error: "control request not authenticated" });
  } else if (hello.ctl === "status") {
    try {
      reply({ ok: true, status: status() });
    } catch (e) {
      reply({ ok: false, error: `status failed: ${e.message}` });
    }
  } else if (hello.ctl === "stop") {
    reply({ ok: true, stopping: true, pid: process.pid }, () => stop());
  } else {
    reply({ ok: false, error: `unknown control command ${JSON.stringify(hello.ctl)}` });
  }
}

/**
 * Client side: send one control command and return the broker's answer
 * ({bmr:"ctl", ok, ...}). Rejects with the connect error's code (ENOENT /
 * ECONNREFUSED: no broker), EAUTH (the pipe's owner doesn't know the key),
 * ECONNRESET or ETIMEDOUT.
 */
async function requestControl({ pipe, key, cmd, timeoutMs = HELLO_TIMEOUT_MS }) {
  const sock = await connectPipe(pipe);
  try {
    const { rest } = await clientHello(sock, key, { timeoutMs, fields: (nonce) => ({ ctl: cmd, ctlMac: ctlMac(key, cmd, nonce) }) });
    if (rest.length) sock.unshift(rest);
    const answer = readLine(sock, timeoutMs, MAX_ANSWER_BYTES);
    sock.resume(); // the handshake left it paused
    return JSON.parse((await answer).line);
  } finally {
    sock.destroy();
  }
}

module.exports = { serveControl, requestControl, ctlMac };
