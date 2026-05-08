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

    readable.on("data", (chunk) => this._onData(chunk));
    readable.on("close", () => this._onClose());
    readable.on("error", (e) => this._onError(e));
  }

  _onData(chunk) {
    this.buffer += chunk.toString("utf8");
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
    if (!msg || typeof msg.id !== "number") return; // ignore notifications
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
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("upstream closed"));
    }
    this.pending.clear();
  }

  _onError(e) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
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
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("client closed"));
    }
    this.pending.clear();
  }
}

module.exports = { UpstreamClient };
