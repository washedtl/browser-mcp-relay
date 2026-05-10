// upstream-client.js — JSON-RPC 2.0 client over a Readable/Writable pair.
// Used by relay-server.js to forward tool calls to the upstream
// browser-devtools-mcp child. Multiplexes by request id with timeouts.
//
// Protocol: newline-delimited JSON. Each request is one JSON object per line,
// each response is one JSON object per line. ids are integers monotonically
// increasing.

class UpstreamClient {
  constructor(readable, writable) {
    this.readable = readable;
    this.writable = writable;
    this.pending = new Map(); // id → { resolve, reject, timer }
    this.nextId = 1;
    this.buffer = "";
    this.closed = false;

    // setEncoding('utf8') makes the stream's internal StringDecoder buffer
    // partial multi-byte UTF-8 sequences across chunk boundaries. Without
    // this, an emoji / CJK / accented char that lands on a chunk boundary
    // would surface as U+FFFD replacement chars, corrupting the JSON line
    // and causing JSON.parse to throw on otherwise-valid upstream output.
    // (Listeners then get pre-decoded strings, so we drop the .toString call
    // in _onData.)
    if (readable && typeof readable.setEncoding === "function") {
      readable.setEncoding("utf8");
    }

    this._dataHandler = (chunk) => this._onData(chunk);
    this._closeHandler = () => this._onClose();
    this._errorHandler = (e) => this._onError(e);
    readable.on("data", this._dataHandler);
    readable.on("close", this._closeHandler);
    readable.on("error", this._errorHandler);
  }

  _onData(chunk) {
    // Stream is in object mode? defensive: coerce.
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        process.stderr.write(`[mcp-relay] upstream sent invalid JSON: ${line.slice(0, 100)}\n`);
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // JSON-RPC 2.0 id MAY be number, string, or null. Notifications have
    // no id at all (undefined). Treat any present id we have a pending
    // entry for as a response; ignore unknown ids and notifications.
    if (!msg || msg.id === undefined) return; // notification or malformed
    const pending = this.pending.get(msg.id);
    if (!pending) return; // unknown id; ignore
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`upstream error: ${msg.error.message || JSON.stringify(msg.error)}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  _onClose() {
    if (this.closed) return; // idempotent
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("upstream closed"));
    }
    this.pending.clear();
    this._removeListeners();
  }

  _onError(e) {
    // Set closed=true so subsequent request() calls reject fast instead of
    // queueing into a doomed pending Map and timing out at 180s.
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    this._removeListeners();
  }

  _removeListeners() {
    // Detach our handlers so a still-alive `readable` (e.g. piped from a
    // child whose stdout EOFs but is held by another consumer) doesn't
    // keep buffering chunks for us.
    if (!this.readable) return;
    try { this.readable.off("data", this._dataHandler); } catch { /* legacy stream */ }
    try { this.readable.off("close", this._closeHandler); } catch {}
    try { this.readable.off("error", this._errorHandler); } catch {}
  }

  /**
   * Send a JSON-RPC 2.0 request and await the matching response.
   *
   * V0-4: default timeout bumped from 30s → 180s. Forwarded calls like
   * `lighthouse_audit` and `content_save-as-pdf` regularly exceed 30s; the
   * old default surfaced as an upstream timeout error while the upstream
   * was still working — its eventual response was orphaned and dropped.
   * Callers that need a tighter ceiling can still pass an explicit
   * `timeoutMs`.
   *
   * @param {string} method
   * @param {object} [params]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>} the response's `result` field
   */
  request(method, params = {}, timeoutMs = 180000) {
    if (this.closed) return Promise.reject(new Error("upstream closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`upstream request timeout (${method}, ${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const req = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      try {
        this.writable.write(req);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    if (this.closed) return; // idempotent
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client closed"));
    }
    this.pending.clear();
    this._removeListeners();
  }
}

module.exports = { UpstreamClient };
