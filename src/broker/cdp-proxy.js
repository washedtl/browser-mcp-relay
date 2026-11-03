// cdp-proxy.js — the broker's only CDP endpoint (W2G).
//
// The broker's Brave runs with --remote-debugging-pipe, so it opens NO TCP
// port: on a --remote-debugging-port, any local process could drive the
// logged-in Brave and read its cookies (no authentication; Node clients send
// no Origin, so --remote-allow-origins doesn't help). Measured on Brave 147
// (2026-11-03, test/cdp-lockdown.test.js): 0 LISTEN sockets on any of its
// processes and no DevToolsActivePort file.
//
//   PipeConnection  NUL-delimited JSON on the child's fd 3 (we write) and
//                   fd 4 (we read). Its call() is the pipe's ROOT session:
//                   the supervisor's (readiness, PID check, certificates,
//                   Browser.close). No ws client can reach it.
//   CdpProxy        serves every other CDP client (upstream's Playwright,
//                   Lighthouse's puppeteer, own-tools) on
//                   ws://127.0.0.1:<port>/<64-hex secret>/devtools/browser.
//                   Each client gets its own browser session
//                   (Target.attachToBrowserTarget, flat mode), so clients are
//                   as independent as separate connections to a port.
//
// The listener is bound once, for the broker's life, and outlives Brave:
// setPipe() puts a relaunched Brave behind the same URL (upstream reads its
// CDP URL once per process). While Brave is down an upgrade gets 503.
//
// Refused: every plain HTTP request (no /json/*: discovery would hand out
// the URL), any upgrade whose path is not exactly /<secret>/devtools/browser
// (timing-safe compare), any upgrade with an Origin header (a web page; Node
// clients send none) or a Host other than 127.0.0.1/localhost:<port> (DNS
// rebinding), and the methods in BLOCKED_CLIENT_METHODS.
//
// The secret is a bearer token: it leaks through error text (Playwright's
// call log and upstream's "[CDP connect] … endpoint:" both print the URL), so
// the broker passes logs, status and tool results through redact().
//
// Routing (one pipe, many clients):
//   client → browser  ids remapped to the pipe's counter; no sessionId → the
//                     client's browser session; a sessionId must be owned by
//                     that client, else -32001 and nothing is sent.
//   browser → client  replies: id mapped back, sessionId dropped when it is
//                     the client's browser session. Events: by sessionId owner.
//   ownership         a session belongs to the client whose Target.attachTo*
//                     reply or Target.attachedToTarget event announced it.

"use strict";

const { EventEmitter } = require("node:events");
const crypto = require("node:crypto");
const http = require("node:http");

const REDACTED = "<redacted>";

// A shared Brave must not be closed or crashed by one of its clients
// (Playwright's browser.close() on a connectOverCDP browser only disconnects;
// puppeteer's browser.close() sends Browser.close). sendMessageToTarget is
// the deprecated non-flat channel: it would carry Browser.close past this
// check inside a string. A footgun guard, not a security boundary: a holder
// of the secret already drives the whole browser.
const BLOCKED_CLIENT_METHODS = Object.freeze(new Set(["Browser.close", "Browser.crash", "Browser.crashGpuProcess", "Target.sendMessageToTarget"]));

// Largest message a client may send. Big ones are legitimate: page.route's
// fulfil of a large body (base64, Fetch.fulfillRequest), a long
// Runtime.evaluate. Replies from Brave are not limited (a 64 MB one was
// measured through the proxy).
const MAX_CLIENT_MESSAGE_BYTES = 256 * 1024 * 1024;
const LOGGED_REFUSALS = 20;

// Secrets of the proxies listening in this process (redact() removes them all).
const liveSecrets = new Set();

/** `text` with every live proxy's secret replaced by REDACTED. */
function redact(text) {
  let out = String(text);
  for (const s of liveSecrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}

/** A CDP URL without its secret path segment (for messages that print one). */
function redactCdpUrl(url) {
  return String(url).replace(/\/[0-9a-f]{64}(?=\/|$)/gi, `/${REDACTED}`);
}

class PipeConnection extends EventEmitter {
  /**
   * @param {import('stream').Writable} out — the child's stdio[3] (Brave reads it)
   * @param {import('stream').Readable} inp — the child's stdio[4] (Brave writes it)
   * Emits 'message' (every message that is not a reply to call()) and 'close' (reason), once.
   */
  constructor(out, inp) {
    super();
    this._out = out;
    this._inp = inp;
    this._chunks = [];
    this._nextId = 1;
    this._calls = new Map(); // id → {resolve, timer}: the root session's own calls
    this.closed = false;
    inp.on("data", (buf) => this._onData(buf));
    inp.on("end", () => this._onClose("end"));
    inp.on("close", () => this._onClose("close"));
    inp.on("error", (e) => this._onClose(`error ${e.code || e.message}`));
    out.on("error", (e) => this._onClose(`write error ${e.code || e.message}`));
  }

  /** A message id no other user of this pipe has. */
  allocId() {
    return this._nextId++;
  }

  /** @returns {boolean} false once the pipe is closed */
  send(msg) {
    if (this.closed) return false;
    this._out.write(JSON.stringify(msg) + "\0");
    return true;
  }

  /**
   * One CDP call on the root session (or `sessionId`): resolves its reply
   * ({result} or {error}), or null on timeout / close.
   */
  call(method, params, { timeoutMs = 5000, sessionId } = {}) {
    return new Promise((resolve) => {
      const id = this.allocId();
      const timer = setTimeout(() => { this._calls.delete(id); resolve(null); }, timeoutMs);
      this._calls.set(id, { resolve, timer });
      const msg = { id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) };
      if (!this.send(msg)) {
        clearTimeout(timer);
        this._calls.delete(id);
        resolve(null);
      }
    });
  }

  /** End our side (Brave sees EOF); fires 'close'. */
  close() {
    if (this.closed) return;
    try { this._out.end(); } catch { /* already gone */ }
    try { this._inp.destroy(); } catch { /* already gone */ }
    this._onClose("closed by the broker");
  }

  _onData(buf) {
    let start = 0;
    for (let i = buf.indexOf(0); i !== -1; i = buf.indexOf(0, start)) {
      this._chunks.push(buf.subarray(start, i));
      const text = Buffer.concat(this._chunks).toString("utf8");
      this._chunks = [];
      start = i + 1;
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      this._onMessage(msg);
    }
    if (start < buf.length) this._chunks.push(buf.subarray(start));
  }

  _onMessage(msg) {
    const call = msg.id !== undefined && this._calls.get(msg.id);
    if (call) {
      this._calls.delete(msg.id);
      clearTimeout(call.timer);
      call.resolve(msg);
      return;
    }
    this.emit("message", msg);
  }

  _onClose(why) {
    if (this.closed) return;
    this.closed = true;
    for (const [id, c] of this._calls) {
      clearTimeout(c.timer);
      c.resolve(null);
      this._calls.delete(id);
    }
    this.emit("close", why);
  }
}

class CdpProxy extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {(msg: string) => void} [opts.log]
   * @param {number} [opts.maxPayload] — largest client message (test seam)
   */
  constructor({ log = () => {}, maxPayload = MAX_CLIENT_MESSAGE_BYTES } = {}) {
    super();
    this._log = log;
    this._maxPayload = maxPayload;
    this._pipe = null;
    this._pending = new Map(); // pipe id → {client, origId, method, routed}
    this._owner = new Map(); // sessionId → client
    this._clients = new Set();
    this._server = null;
    this._refusals = 0;
    this.secret = crypto.randomBytes(32).toString("hex"); // 256 bits
    this.port = null;
    this.wsUrl = null;
  }

  /** @returns {Promise<{wsUrl: string, port: number}>} */
  listen({ host = "127.0.0.1", port = 0 } = {}) {
    const { WebSocketServer } = require("ws");
    const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: this._maxPayload });
    const server = http.createServer((req, res) => {
      this._refuse(req, "plain HTTP");
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found\n");
    });
    server.on("upgrade", (req, socket, head) => {
      socket.on("error", () => {});
      const why = this._checkUpgrade(req);
      if (why) {
        this._refuse(req, why);
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      if (!this._pipe || this._pipe.closed) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this._onClient(ws));
    });
    server.on("clientError", (_e, socket) => socket.destroy());
    this._server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host, port, exclusive: true }, () => {
        server.off("error", reject);
        server.on("error", (e) => this._log(`cdp proxy: server error ${e.message}`));
        const p = server.address().port;
        this.port = p;
        this._allowedHosts = new Set([`127.0.0.1:${p}`, `localhost:${p}`]);
        this._path = Buffer.from(`/${this.secret}/devtools/browser`);
        this.wsUrl = `ws://127.0.0.1:${p}/${this.secret}/devtools/browser`;
        liveSecrets.add(this.secret);
        resolve({ wsUrl: this.wsUrl, port: p });
      });
    });
  }

  /**
   * Serve the Brave behind `pipe` (a verified launch of ours). The URL stays
   * the same; sessions of an earlier Brave were dropped when its pipe closed.
   * @param {PipeConnection} pipe
   */
  setPipe(pipe) {
    this._pipe = pipe;
    pipe.on("message", (m) => { if (this._pipe === pipe) this._fromBrowser(m); });
    pipe.on("close", () => { if (this._pipe === pipe) this._onPipeClose(); });
    if (pipe.closed) this._onPipeClose();
  }

  close() {
    liveSecrets.delete(this.secret);
    for (const c of [...this._clients]) c.ws.terminate();
    this._clients.clear();
    if (!this._server) return Promise.resolve();
    const server = this._server;
    this._server = null;
    return new Promise((resolve) => server.close(() => resolve()));
  }

  _checkUpgrade(req) {
    const got = Buffer.from(req.url || "");
    if (got.length !== this._path.length || !crypto.timingSafeEqual(got, this._path)) return "wrong path";
    if (!this._allowedHosts.has(String(req.headers.host || "").toLowerCase())) return "foreign Host";
    // Node clients (Playwright, puppeteer, ws) send no Origin; a web page always does.
    if (req.headers.origin !== undefined) return "Origin present";
    return null;
  }

  _refuse(req, why) {
    const n = ++this._refusals;
    if (n > LOGGED_REFUSALS + 1) return;
    if (n === LOGGED_REFUSALS + 1) {
      this._log(`cdp proxy: further refusals are not logged`);
      return;
    }
    const url = redact(String(req.url || "")).slice(0, 200);
    this._log(`cdp proxy: refused ${req.method} ${JSON.stringify(url)} (${why})`);
  }

  async _onClient(ws) {
    const client = { ws, browserSession: null, queue: [], sessions: new Set(), closed: false };
    this._clients.add(client);
    const pipe = this._pipe;
    ws.on("message", (data) => {
      if (client.closed) return;
      if (!client.browserSession) client.queue.push(data);
      else this._fromClient(client, data);
    });
    ws.on("close", () => this._onClientClose(client));
    ws.on("error", () => { /* 'close' follows */ });
    const r = await pipe.call("Target.attachToBrowserTarget");
    if (!r || !r.result || !r.result.sessionId) {
      if (!client.closed) this._log(`cdp proxy: Target.attachToBrowserTarget failed: ${JSON.stringify(r && r.error)}`);
      this._dropClient(client, 1011, "browser session attach failed");
      return;
    }
    client.browserSession = r.result.sessionId;
    if (client.closed || this._pipe !== pipe) {
      if (!pipe.closed) pipe.call("Target.detachFromTarget", { sessionId: client.browserSession });
      return;
    }
    this._own(client.browserSession, client);
    for (const d of client.queue.splice(0)) this._fromClient(client, d);
  }

  _own(sessionId, client) {
    this._owner.set(sessionId, client);
    client.sessions.add(sessionId);
  }

  _disown(sessionId) {
    const c = this._owner.get(sessionId);
    if (c) c.sessions.delete(sessionId);
    this._owner.delete(sessionId);
  }

  _fromClient(client, data) {
    if (client.closed) return;
    let msg;
    try { msg = JSON.parse(data); } catch { this._dropClient(client, 1007, "bad json"); return; }
    if (!msg || typeof msg.id !== "number" || typeof msg.method !== "string" || (msg.sessionId !== undefined && typeof msg.sessionId !== "string")) {
      this._dropClient(client, 1007, "bad message");
      return;
    }
    if (BLOCKED_CLIENT_METHODS.has(msg.method)) {
      this._toClient(client, {
        id: msg.id,
        error: { code: -32000, message: `${msg.method} is not allowed through the broker's CDP proxy (the browser is shared)` },
        ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
      });
      return;
    }
    let target = client.browserSession;
    if (msg.sessionId !== undefined) {
      if (this._owner.get(msg.sessionId) !== client) {
        this._toClient(client, { id: msg.id, error: { code: -32001, message: "Session with given id not found." }, sessionId: msg.sessionId });
        return;
      }
      target = msg.sessionId;
    }
    const id = this._pipe.allocId();
    this._pending.set(id, { client, origId: msg.id, method: msg.method, routed: msg.sessionId });
    this._pipe.send({ ...msg, id, sessionId: target });
  }

  _fromBrowser(msg) {
    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (!p) return;
      this._pending.delete(msg.id);
      const sid = msg.result && msg.result.sessionId;
      if (sid && !p.client.closed && (p.method === "Target.attachToTarget" || p.method === "Target.attachToBrowserTarget")) this._own(sid, p.client);
      const reply = { id: p.origId };
      if (msg.error) reply.error = msg.error; else reply.result = msg.result;
      if (p.routed !== undefined) reply.sessionId = p.routed;
      this._toClient(p.client, reply);
      return;
    }
    if (msg.sessionId === undefined) {
      // Root-session events are the supervisor's; the one that matters here
      // is Brave detaching a client's browser session.
      if (msg.method === "Target.detachedFromTarget" && msg.params) {
        const c = this._owner.get(msg.params.sessionId);
        if (c && c.browserSession === msg.params.sessionId) this._dropClient(c, 1011, "browser session detached", { detached: true });
      }
      return;
    }
    const client = this._owner.get(msg.sessionId);
    if (!client) return; // a session whose client already left
    if (msg.method === "Target.attachedToTarget" && msg.params && msg.params.sessionId) this._own(msg.params.sessionId, client);
    const out = { ...msg };
    if (msg.sessionId === client.browserSession) delete out.sessionId;
    this._toClient(client, out);
    if (msg.method === "Target.detachedFromTarget" && msg.params && msg.params.sessionId) this._disown(msg.params.sessionId);
  }

  _toClient(client, msg) {
    if (client.closed || client.ws.readyState !== 1) return;
    client.ws.send(JSON.stringify(msg));
  }

  /** Close one client's ws now and forget it (its 'close' then finds it gone). */
  _dropClient(client, code, reason, opts) {
    this._onClientClose(client, opts);
    try { client.ws.close(code, reason); } catch { client.ws.terminate(); }
  }

  _onClientClose(client, { detached = false } = {}) {
    if (client.closed) return;
    client.closed = true;
    this._clients.delete(client);
    for (const s of client.sessions) this._owner.delete(s);
    client.sessions.clear();
    for (const [id, p] of this._pending) if (p.client === client) this._pending.delete(id);
    // Detaching its browser session takes the client's child sessions with it.
    if (client.browserSession && !detached && this._pipe && !this._pipe.closed) {
      this._pipe.call("Target.detachFromTarget", { sessionId: client.browserSession });
    }
  }

  _onPipeClose() {
    this._pending.clear();
    // Every session died with this Brave: forget them now (synchronously), so
    // a relaunched Brave behind the same URL never sees the old ids.
    for (const c of [...this._clients]) {
      c.closed = true;
      this._clients.delete(c);
      for (const s of c.sessions) this._owner.delete(s);
      try { c.ws.close(1011, "browser closed"); } catch { c.ws.terminate(); }
    }
    this._owner.clear();
  }
}

module.exports = { PipeConnection, CdpProxy, redact, redactCdpUrl, BLOCKED_CLIENT_METHODS, MAX_CLIENT_MESSAGE_BYTES, REDACTED };
