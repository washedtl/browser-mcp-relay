// framing.js — Chrome native messaging on stdio: each message is a 4-byte
// little-endian length followed by that many bytes of UTF-8 JSON. Chrome
// accepts at most 1 MB per message from the host and sends at most 64 MiB.

"use strict";

const MAX_TO_CHROME_BYTES = 1024 * 1024;
const MAX_FROM_CHROME_BYTES = 64 * 1024 * 1024;

/** One message for Chrome. Throws E2BIG past Chrome's 1 MB limit. */
function encodeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  if (body.length > MAX_TO_CHROME_BYTES) {
    throw Object.assign(new Error(`native message of ${body.length} bytes is over Chrome's ${MAX_TO_CHROME_BYTES}-byte limit`), { code: "E2BIG" });
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Incremental decoder for the stream Chrome writes to the host's stdin.
 * A frame that is not JSON is reported by its size only (its bytes may be
 * cookie values) and skipped; a length over maxBytes is fatal: the stream
 * can't be resynchronised after it.
 */
class MessageReader {
  constructor({ onMessage, onMalformed = () => {}, onFatal = () => {}, maxBytes = MAX_FROM_CHROME_BYTES }) {
    this._onMessage = onMessage;
    this._onMalformed = onMalformed;
    this._onFatal = onFatal;
    this._maxBytes = maxBytes;
    this._chunks = [];
    this._size = 0;
    this._len = null; // the current frame's length, once its header is in
    this._failed = false;
  }

  push(chunk) {
    if (this._failed) return;
    this._chunks.push(chunk);
    this._size += chunk.length;
    while (!this._failed && this._size >= 4) {
      if (this._len === null) {
        if (this._chunks[0].length < 4) this._chunks = [Buffer.concat(this._chunks)];
        this._len = this._chunks[0].readUInt32LE(0);
        if (this._len > this._maxBytes) {
          this._failed = true;
          this._chunks = [];
          this._size = 0;
          this._onFatal(Object.assign(new Error(`native message of ${this._len} bytes is over the ${this._maxBytes}-byte limit`), { code: "E2BIG" }));
          return;
        }
      }
      const len = this._len;
      if (this._size < 4 + len) return; // wait for the rest: no copying meanwhile
      const buf = this._chunks.length === 1 ? this._chunks[0] : Buffer.concat(this._chunks);
      this._len = null;
      const body = buf.subarray(4, 4 + len);
      const rest = buf.subarray(4 + len);
      this._chunks = rest.length ? [rest] : [];
      this._size = rest.length;
      let msg;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        this._onMalformed(len); // never the parse error: V8 quotes the input in it
        continue;
      }
      this._onMessage(msg);
    }
  }
}

module.exports = { encodeMessage, MessageReader, MAX_TO_CHROME_BYTES, MAX_FROM_CHROME_BYTES };
