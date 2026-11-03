// line-channel.js — newline-delimited JSON on a broker pipe connection, for
// the cookie bridge's long-lived connection (control.js serveBridge on the
// broker, BridgeClient in the native host). Bounded: a line over maxBytes
// closes the connection. A line that isn't JSON is reported by size only
// (it may hold cookie values; V8's parse errors quote their input).

"use strict";

const { EventEmitter } = require("node:events");

/** Max bytes of one bridge line: Chrome sends the host at most 64 MiB per message. */
const BRIDGE_MAX_LINE_BYTES = 64 * 1024 * 1024 + 4096;

/**
 * Read `sock` line by line, starting with `rest` (bytes that followed the
 * handshake). The socket is resumed here.
 */
function readLines(sock, rest, { maxBytes = BRIDGE_MAX_LINE_BYTES, onLine, onMalformed = () => {}, onOverflow = () => {} }) {
  let chunks = [];
  let size = 0;
  let dead = false;
  const take = (buf) => {
    if (dead) return;
    let start = 0;
    for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, start)) {
      if (size + (i - start) > maxBytes) break;
      chunks.push(buf.subarray(start, i));
      const line = Buffer.concat(chunks).toString("utf8").replace(/\r$/, "");
      chunks = [];
      size = 0;
      start = i + 1;
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        onMalformed(Buffer.byteLength(line));
        continue;
      }
      onLine(msg);
      if (dead) return;
    }
    const tail = buf.subarray(start);
    size += tail.length;
    if (size > maxBytes) {
      dead = true;
      chunks = [];
      onOverflow();
      sock.destroy();
      return;
    }
    if (tail.length) chunks.push(tail);
  };
  if (rest && rest.length) take(rest);
  sock.on("data", (chunk) => take(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  sock.resume();
  return { stop: () => { dead = true; } };
}

/**
 * The host's side of a bridge connection: request(obj) sends one line with
 * an id and resolves the broker's reply carrying that id. Emits 'close' once.
 */
class BridgeClient extends EventEmitter {
  constructor(sock, rest, { requestTimeoutMs = 60_000 } = {}) {
    super();
    this._sock = sock;
    this._nextId = 1;
    this._pending = new Map();
    this._requestTimeoutMs = requestTimeoutMs;
    this.closed = false;
    readLines(sock, rest, {
      onLine: (msg) => {
        const p = msg && this._pending.get(msg.id);
        if (!p) return;
        this._pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg);
      },
      onOverflow: () => {},
    });
    const onClose = () => this._shut();
    sock.on("close", onClose);
    sock.on("error", () => { /* 'close' follows */ });
  }

  /** Resolves the reply ({bmr:"ctl", id, ok, ...}); rejects ECONNRESET / ETIMEDOUT. */
  request(obj) {
    if (this.closed) return Promise.reject(Object.assign(new Error("the bridge connection is closed"), { code: "ECONNRESET" }));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(Object.assign(new Error(`no reply from the broker within ${this._requestTimeoutMs} ms`), { code: "ETIMEDOUT" }));
        this.close(); // a broker that stopped answering: reconnect
      }, this._requestTimeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._sock.write(`${JSON.stringify({ ...obj, id })}\n`);
    });
  }

  close() {
    this._sock.destroy();
    this._shut();
  }

  _shut() {
    if (this.closed) return;
    this.closed = true;
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      this._pending.delete(id);
      p.reject(Object.assign(new Error("the bridge connection closed"), { code: "ECONNRESET" }));
    }
    this.emit("close");
  }
}

module.exports = { readLines, BridgeClient, BRIDGE_MAX_LINE_BYTES };
