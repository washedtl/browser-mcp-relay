// core-framing.test.js — W2F: Chrome native-messaging framing
// (src/cookie-bridge/framing.js): 4-byte little-endian length + UTF-8 JSON.

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { encodeMessage, MessageReader, MAX_TO_CHROME_BYTES, MAX_FROM_CHROME_BYTES } = require("../../src/cookie-bridge/framing.js");

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

test("framing: encodeMessage writes a 4-byte little-endian length, then the UTF-8 JSON", () => {
  const buf = encodeMessage({ t: "status", broker: "up", s: "é" });
  const len = buf.readUInt32LE(0);
  assert.strictEqual(len, buf.length - 4);
  assert.deepStrictEqual(JSON.parse(buf.subarray(4).toString("utf8")), { t: "status", broker: "up", s: "é" });
});

test("framing: host → Chrome messages over 1 MB are refused (Chrome's limit)", () => {
  assert.strictEqual(MAX_TO_CHROME_BYTES, 1024 * 1024);
  assert.throws(() => encodeMessage({ big: "x".repeat(MAX_TO_CHROME_BYTES) }), (e) => e.code === "E2BIG");
});

test("framing: the reader reassembles messages split anywhere, and several per chunk", () => {
  const got = [];
  const r = new MessageReader({ onMessage: (m) => got.push(m) });
  const all = Buffer.concat([frame({ t: "hello", v: 1 }), frame({ t: "full", seq: 1, cookies: [], last: true }), frame({ t: "delta", seq: 2, changes: [] })]);
  // byte by byte
  for (let i = 0; i < all.length; i++) r.push(all.subarray(i, i + 1));
  // all at once
  r.push(all);
  assert.deepStrictEqual(got.map((m) => m.t), ["hello", "full", "delta", "hello", "full", "delta"]);
});

test("framing: a frame that isn't JSON is reported by size only, and the stream keeps going", () => {
  const got = [];
  const bad = [];
  const r = new MessageReader({ onMessage: (m) => got.push(m), onMalformed: (n) => bad.push(n) });
  const body = Buffer.from('{"value":"s3cret-cookie-value', "utf8"); // truncated JSON
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  r.push(Buffer.concat([head, body, frame({ t: "hello", v: 1 })]));
  assert.deepStrictEqual(bad, [body.length]);
  assert.deepStrictEqual(got, [{ t: "hello", v: 1 }]);
});

test("framing: a length over the inbound limit is fatal (the stream can't be resynced)", () => {
  let fatal = null;
  const r = new MessageReader({ onMessage: () => assert.fail("no message"), onFatal: (e) => { fatal = e; }, maxBytes: 1000 });
  const head = Buffer.alloc(4);
  head.writeUInt32LE(1001, 0);
  r.push(head);
  assert.ok(fatal && fatal.code === "E2BIG", String(fatal));
  r.push(frame({ t: "hello" })); // ignored after a fatal error
  assert.strictEqual(MAX_FROM_CHROME_BYTES, 64 * 1024 * 1024);
});
