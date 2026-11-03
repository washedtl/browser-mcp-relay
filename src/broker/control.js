// control.js — the broker's control channel: `npm run broker:status` and
// `npm run broker:stop` (scripts/broker-ctl.js) over the broker's own pipe.
//
// A control client opens with the shim's hello (pipe-server.js) plus
//   ctl: "status" | "stop",  ctlMac: HMAC-SHA256(key, "ctl:<ctl>:<nonce>")
// so it proves it holds this user's broker key, and the broker proves the
// same back with its usual hello reply. The broker then sends one line,
// {"bmr":"ctl","ok":...}, and closes. A control connection is never an MCP
// session. Node built-ins only.

"use strict";

const net = require("node:net");
const crypto = require("node:crypto");
const { helloMac } = require("./pipe-server.js");

const CONTROL_TIMEOUT_MS = 10_000;

const ctlMac = (key, cmd, nonce) => crypto.createHmac("sha256", key).update(`ctl:${cmd}:${nonce}`).digest("hex");

function macMatches(got, want) {
  if (typeof got !== "string" || !/^[0-9a-f]{64}$/.test(got)) return false;
  return crypto.timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(want, "hex"));
}

/**
 * Broker side: answer the control request in `hello` on `sock`, then close it.
 * @param {{status: () => object, stop: () => void}} handlers — stop runs once the reply is sent
 */
function serveControl(sock, hello, key, { status, stop }) {
  const reply = (obj, then) => sock.end(`${JSON.stringify({ bmr: "ctl", ...obj })}\n`, then);
  if (!macMatches(hello.ctlMac, ctlMac(key, String(hello.ctl), String(hello.nonce)))) {
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

/** Resolve the first `n` lines `sock` sends; reject on close or timeout before that. */
function readLines(sock, n, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(Object.assign(new Error(`no answer within ${timeoutMs} ms`), { code: "ETIMEDOUT" })), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      if (lines.length > n) {
        clearTimeout(timer);
        resolve(lines.slice(0, n));
      }
    });
    sock.on("close", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("the broker closed the connection without answering"), { code: "ECONNRESET" }));
    });
  });
}

/**
 * Client side: send one control command and return the broker's answer
 * ({bmr:"ctl", ok, ...}). Rejects with the connect error's code (ENOENT /
 * ECONNREFUSED: no broker), EAUTH (the pipe's owner doesn't know the key) or
 * ETIMEDOUT.
 */
async function requestControl({ pipe, key, cmd, timeoutMs = CONTROL_TIMEOUT_MS }) {
  const sock = net.connect(pipe);
  try {
    await new Promise((resolve, reject) => { sock.once("connect", resolve); sock.once("error", reject); });
    sock.on("error", () => { /* 'close' follows */ });
    const nonce = crypto.randomBytes(16).toString("hex");
    const answer = readLines(sock, 2, timeoutMs);
    sock.write(`${JSON.stringify({ bmr: "hello", v: 1, nonce, ctl: cmd, ctlMac: ctlMac(key, cmd, nonce) })}\n`);
    const [helloLine, ctlLine] = await answer;
    let hello = null;
    try { hello = JSON.parse(helloLine); } catch { /* not ours */ }
    if (!hello || hello.bmr !== "hello" || !macMatches(hello.mac, helloMac(key, nonce))) {
      throw Object.assign(new Error("the pipe's owner failed authentication (not this user's broker)"), { code: "EAUTH" });
    }
    return JSON.parse(ctlLine);
  } finally {
    sock.destroy();
  }
}

module.exports = { serveControl, requestControl, ctlMac, CONTROL_TIMEOUT_MS };
