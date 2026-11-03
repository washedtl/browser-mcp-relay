// fake-pipe-browser.js — a browser on the far end of a CDP pipe (W2G), over
// in-memory streams: what BraveSupervisor hands the broker's CdpProxy
// ('pipe'), without a Brave. Records every message it gets and answers like
// Chromium (a reply carries the sessionId it was sent on):
//   Target.attachToBrowserTarget / attachToTarget → a new sessionId
//   Target.detachFromTarget → {} + Target.detachedFromTarget (on the parent)
//   Fake.emit {on, name, n} → an event `name` on session `on` (root when absent)
//   Fake.autoAttach → Target.attachedToTarget{sessionId: new} on the caller's session
//   anything else → {echo: method, on: sessionId|null}

"use strict";

const { PassThrough } = require("node:stream");
const { PipeConnection } = require("../../src/broker/cdp-proxy.js");

let seq = 0; // session ids are unique across fakes, as Chromium's are across launches

function fakePipeBrowser() {
  const toBrowser = new PassThrough();
  const fromBrowser = new PassThrough();
  const received = [];
  let buf = "";
  const send = (m) => fromBrowser.write(JSON.stringify(m) + "\0");
  toBrowser.setEncoding("utf8");
  toBrowser.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\0")) >= 0;) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      received.push(msg);
      handle(msg);
    }
  });
  function handle(msg) {
    const on = msg.sessionId ? { sessionId: msg.sessionId } : {};
    const reply = (result) => send({ id: msg.id, result, ...on });
    switch (msg.method) {
      case "Target.attachToBrowserTarget": return reply({ sessionId: `B${++seq}` });
      case "Target.attachToTarget": return reply({ sessionId: `P${++seq}` });
      case "Target.detachFromTarget":
        reply({});
        return send({ method: "Target.detachedFromTarget", params: { sessionId: msg.params.sessionId }, ...on });
      case "Fake.emit":
        reply({});
        return send({ method: msg.params.name, params: { n: msg.params.n }, ...(msg.params.on ? { sessionId: msg.params.on } : {}) });
      case "Fake.autoAttach": {
        const sessionId = `C${++seq}`;
        send({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { type: "page" } }, ...on });
        return reply({ sessionId });
      }
      default: return reply({ echo: msg.method, on: msg.sessionId || null });
    }
  }
  const pipe = new PipeConnection(toBrowser, fromBrowser);
  return {
    pipe,
    received,
    send,
    /** Brave dies: EOF on its side of the pipe. */
    crash: () => fromBrowser.end(),
    sent: (method) => received.filter((m) => m.method === method),
  };
}

module.exports = { fakePipeBrowser };
