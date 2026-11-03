// relay-server.js — the MCP server that Cursor talks to. Forwards tools/call
// to upstream OR to our own-tool handlers based on the tool name. Merges
// upstream's tools/list with our own tool list.
//
// Upstream tools run through callUpstream(name, args) when the caller
// injects one (the broker: upstream in-process, routed by tabId).
// Otherwise (legacy) through two async dependencies injected by the entrypoint:
//   - getUpstream(): returns the upstream MCP client. Called ONLY by
//     tools/call for forwarded tools (~50MB node process once spawned).
//   - ensureBrave(): launches our Brave instance via Playwright. Slow
//     (~3-5s, ~250MB). Called ONLY by tools/call (own-tools get their ctx
//     from the bridge it resolves; forwarded tools need Brave running so
//     upstream's lazy `chromium.connectOverCDP` succeeds when its tool
//     handler runs). peekBrave() returns the running bridge or null, for
//     tools that must never launch Brave (needsBrave:false).
//
// tools/list (every client's first call at MCP connect) is answered from
// the cached upstream catalog (tool-catalog.js) + own-tool definitions, so
// it spawns neither upstream nor Brave.
//
// W10: trafficEmitter — every handleToolsCall fires `request` and `response`
// events. The in-process Inspector subscribes to these for live traffic
// streaming. Standalone Inspector ignores it (no subscriber). The emitter
// also keeps a 200-event ring buffer so new WS subscribers can backfill
// without missing context. With recordTraffic=false (no in-process
// Inspector) none of this runs. Events for secret-bearing tools (cookies,
// storage, form fills) are redacted before they are recorded, and
// credential headers are redacted in every event.

const { EventEmitter } = require("node:events");
const toolCatalog = require("./tool-catalog.js");
const { applyLocalConfigToEnv } = require("./local-config.js");
const { toolsetOf, parseToolsets, hiddenToolMessage } = require("./own-tools/toolsets.js");
const { toolContext } = require("./own-tools/_tool-context.js");
const { legacyRegistry, LEGACY_CONN } = require("./own-tools/_legacy-context.js");

// Cap each emitted event's response body at this size (in JSON-stringified
// chars). capture_xhr / lighthouse_audit can return MB-scale responses;
// streaming those over WS to N subscribers + holding them in the 200-event
// ring buffer would balloon memory. The full body is still returned to the
// MCP client — this cap only affects what the Inspector sees.
const MAX_TRAFFIC_BODY_CHARS = 10_000;
// Ring-buffer capacity. 200 events ~= 2-3 minutes of normal use.
const TRAFFIC_RING_CAPACITY = 200;
const TRUNCATED_MARKER = "[truncated]";

/** Truncate a JSON-serializable value's stringified form to MAX chars. We
 *  serialize, slice, then return either the original (if short) or a string
 *  with the truncation marker. The Inspector renders this verbatim — no
 *  re-parse. */
function truncateForEmit(value, max = MAX_TRAFFIC_BODY_CHARS) {
  if (value == null) return value;
  let s;
  try { s = JSON.stringify(value); }
  catch { return { error: "[unserializable]" }; }
  if (s.length <= max) return value;
  return s.slice(0, max - TRUNCATED_MARKER.length) + TRUNCATED_MARKER;
}

// Tools whose args/results carry secrets (cookie values, storage tokens,
// typed passwords). Their traffic events keep the structure and numbers /
// booleans; every string becomes "[redacted]".
const SENSITIVE_TOOL_RE = /^(?:cookies_export|cookies_import|form_fill|interaction_fill|storage_.+)$/;
const REDACTED = "[redacted]";

// Credential headers, redacted in EVERY recorded event: as object keys at
// any depth (any case) and as "key": "value" pairs inside JSON text (tool
// results usually carry their data as JSON in content[].text).
const SECRET_HEADERS = ["authorization", "cookie", "set-cookie", "x-api-key", "proxy-authorization"];
const SECRET_HEADER_SET = new Set(SECRET_HEADERS);
// The value may end mid-string (a string cut to the event's budget): an
// unterminated value at the end is redacted too, never left as a prefix.
const SECRET_HEADER_IN_TEXT_RE = new RegExp(`("(?:${SECRET_HEADERS.join("|")})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*(?:"|$)`, "gi");

/**
 * What an event records of `value`: every string "[redacted]" for a
 * sensitive tool, credential headers redacted for the rest, image data
 * summarized, and strings cut to `max` chars in total WHILE walking, so a
 * multi-MB screenshot or capture is never scanned, copied or serialized
 * whole. A string is cut before the header regex runs on it.
 */
function redactForEmit(value, sensitive, max = MAX_TRAFFIC_BODY_CHARS) {
  let budget = max;
  const str = (v) => {
    if (budget <= 0) return TRUNCATED_MARKER;
    if (sensitive) {
      budget -= REDACTED.length;
      return REDACTED;
    }
    const cut = v.length > budget;
    const part = cut ? v.slice(0, budget) : v;
    budget -= part.length;
    return part.replace(SECRET_HEADER_IN_TEXT_RE, `$1"${REDACTED}"`) + (cut ? TRUNCATED_MARKER : "");
  };
  const walk = (v) => {
    if (typeof v === "string") return str(v);
    if (Array.isArray(v)) {
      const out = [];
      for (const x of v) {
        if (budget <= 0) { out.push(TRUNCATED_MARKER); break; }
        out.push(walk(x));
      }
      return out;
    }
    if (v && typeof v === "object") {
      const image = v.type === "image" && typeof v.data === "string";
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (budget <= 0) { out[TRUNCATED_MARKER] = true; break; }
        if (image && k === "data") out[k] = `[image data: ${x.length} chars]`;
        else if (!sensitive && SECRET_HEADER_SET.has(k.toLowerCase())) out[k] = REDACTED;
        else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return walk(value);
}

// Our own deadline for an elicitation prompt — under the MCP SDK's 60s
// default request timeout, so a slow user ends up as "no answer" (nothing
// enabled) rather than as an SDK error (which means "client can't prompt").
const ELICIT_TIMEOUT_MS = 55_000;

function logStderr(msg) {
  try { process.stderr.write(msg + "\n"); } catch { /* stderr itself is gone */ }
}

class TrafficEmitter extends EventEmitter {
  constructor({ capacity = TRAFFIC_RING_CAPACITY } = {}) {
    super();
    // Lift the default listener cap so multiple WS subscribers don't trip
    // Node's "MaxListenersExceededWarning". 50 is plenty for an inspector
    // that only ever has one or two browser tabs open.
    this.setMaxListeners(50);
    this.capacity = capacity;
    this._ring = []; // ordered oldest → newest
    this._nextId = 1;
  }
  nextId() { return this._nextId++; }
  push(evt) {
    this._ring.push(evt);
    if (this._ring.length > this.capacity) {
      this._ring.splice(0, this._ring.length - this.capacity);
    }
  }
  getRecent() { return this._ring.slice(); }
}

class RelayServer {
  /**
   * @param {object} opts
   * @param {() => Promise<object>} [opts.getUpstream] — legacy: the upstream child's client
   * @param {(name: string, args: object|undefined) => Promise<object>} [opts.callUpstream] — runs an
   *   upstream tool and returns its CallToolResult (the broker's in-process path); one of the two is required
   * @param {() => Promise<unknown>} [opts.ensureBrave]
   * @param {() => object|null} [opts.peekBrave] — the running bridge, without launching
   * @param {TrafficEmitter} [opts.trafficEmitter]
   * @param {() => Promise<object[]>} [opts.loadUpstreamCatalog] — raw upstream tools (test seam)
   * @param {() => unknown} [opts.notifyToolsChanged] — sends MCP notifications/tools/list_changed
   * @param {(params: {message: string, requestedSchema: object}, opts: {signal: AbortSignal}) => Promise<object|null>} [opts.elicit]
   *        — MCP elicitation (user prompt); resolves null when the client can't prompt
   * @param {number} [opts.elicitTimeoutMs]
   * @param {boolean} [opts.recordTraffic=true] — false: no traffic ring buffer / events (no Inspector)
   * @param {string} [opts.trafficConn] — tags this server's request events (`conn`): the broker's
   *   sessions share one emitter
   * @param {object} [opts.env] — reads BROWSER_RELAY_TOOLSETS (default: process.env + local-config.json)
   */
  constructor({
    getUpstream, callUpstream, ensureBrave, peekBrave, trafficEmitter, loadUpstreamCatalog, notifyToolsChanged,
    elicit, elicitTimeoutMs = ELICIT_TIMEOUT_MS, recordTraffic = true, trafficConn, env,
  } = {}) {
    if (typeof getUpstream !== "function" && typeof callUpstream !== "function") {
      throw new Error("RelayServer: constructor expects { getUpstream } (legacy stdio upstream) or { callUpstream } async function");
    }
    if (ensureBrave != null && typeof ensureBrave !== "function") {
      throw new Error("RelayServer: ensureBrave, if provided, must be an async function");
    }
    this.getUpstream = getUpstream;
    this.callUpstream = callUpstream || ((name, args) => this._callStdioUpstream(name, args));
    this.ensureBrave = ensureBrave || null;
    this.peekBrave = peekBrave || (() => null);
    this.env = env || applyLocalConfigToEnv(process.env);
    // Raw upstream tools (disk-cached; test seam). Loaded once, on first use.
    this.loadUpstreamCatalog = loadUpstreamCatalog || toolCatalog.loadUpstreamCatalog;
    this._catalogPromise = null;
    // canNotify: whether a tools/list_changed can actually reach the client.
    this.canNotify = typeof notifyToolsChanged === "function";
    this.notifyToolsChanged = this.canNotify ? notifyToolsChanged : () => {};
    this.elicit = typeof elicit === "function" ? elicit : null;
    this.elicitTimeoutMs = elicitTimeoutMs;
    // Hidden-by-default tool groups (own-tools/toolsets.js) the user enabled.
    const { sets, unknown } = parseToolsets(this.env.BROWSER_RELAY_TOOLSETS);
    if (unknown.length) logStderr(`[mcp-relay] BROWSER_RELAY_TOOLSETS: ignoring unknown toolset(s) ${unknown.join(", ")}`);
    this.enabledToolsets = new Set(sets);
    this.ownTools = new Map(); // name → { name, description, inputSchema, handler, needsBrave, needsPage }
    // The emitter always exists (callers subscribe to it unconditionally);
    // recordTraffic decides whether handleToolsCall feeds it at all.
    this.trafficEmitter = trafficEmitter || new TrafficEmitter();
    this.recordTraffic = Boolean(recordTraffic);
    this.trafficConn = trafficConn;
  }

  // needsBrave / needsPage: see own-tools/index.js.
  registerOwnTool({ name, description, inputSchema, handler, needsBrave = true, needsPage = true }) {
    if (this.ownTools.has(name)) {
      throw new Error(`relay: tool "${name}" already registered`);
    }
    if (typeof handler !== "function") {
      throw new Error(`relay: tool "${name}" handler must be a function`);
    }
    this.ownTools.set(name, { name, description, inputSchema, handler, needsBrave, needsPage });
  }

  /** Name of the disabled toolset `toolName` belongs to, or null if it's visible. */
  hiddenToolsetFor(toolName) {
    const set = toolsetOf(toolName);
    return set && !this.enabledToolsets.has(set) ? set : null;
  }

  /** Enable/disable toolsets; returns the ones that changed and, if any did,
   *  tells the client to re-fetch tools/list. */
  setToolsetsEnabled(sets, enabled) {
    const changed = sets.filter((s) => this.enabledToolsets.has(s) !== enabled);
    for (const s of changed) {
      if (enabled) this.enabledToolsets.add(s);
      else this.enabledToolsets.delete(s);
    }
    if (changed.length) {
      // Best-effort: a client that never gets the notification still sees
      // the change on its next tools/list.
      Promise.resolve()
        .then(() => this.notifyToolsChanged())
        .catch((e) => logStderr(`[mcp-relay] tools/list_changed notification failed: ${e.message}`));
    }
    return changed;
  }

  /**
   * Show the user an approve/decline prompt via MCP elicitation.
   * Resolves the client's result ({ action: "accept" | "decline" | "cancel" }),
   * { action: "timeout" } when nobody answered in time (the request is
   * aborted), or null when no prompt is possible (no elicit option, the
   * client lacks the capability, or elicit threw).
   */
  async askUser(params) {
    if (!this.elicit) return null;
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ action: "timeout" }); }, this.elicitTimeoutMs);
    });
    try {
      const answer = await Promise.race([
        Promise.resolve().then(() => this.elicit(params, { signal: controller.signal })),
        timedOut,
      ]);
      return answer || null;
    } catch (e) {
      logStderr(`[mcp-relay] elicitation unavailable (${e.message}); falling back to ask-in-chat`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Upstream tools as served on the wire (trimmed). Memoized; a failed load is retried. */
  upstreamCatalog() {
    if (!this._catalogPromise) {
      this._catalogPromise = Promise.resolve()
        .then(() => this.loadUpstreamCatalog({ env: this.env }))
        .then((tools) => tools.map(toolCatalog.servedTool))
        .catch((e) => { this._catalogPromise = null; throw e; });
    }
    return this._catalogPromise;
  }

  async handleToolsList() {
    // Neither Brave nor the upstream child: upstream's catalog comes from the
    // disk cache, own-tool definitions are static.
    const upstreamTools = await this.upstreamCatalog();
    const ownTools = Array.from(this.ownTools.values()).map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    }));
    for (const ours of ownTools) {
      if (upstreamTools.some((u) => u.name === ours.name)) {
        throw new Error(
          `relay: tool name collision — upstream and relay both expose "${ours.name}". Rename the relay tool or remove the upstream one.`,
        );
      }
    }
    const visible = (t) => !this.hiddenToolsetFor(t.name);
    return { tools: [...upstreamTools.filter(visible), ...ownTools.filter(visible)] };
  }

  /** Push + emit one traffic event. emit() rethrows a listener's throw; a
   *  busted Inspector subscriber must not take out a tool call (V1-5: log it). */
  _emitTraffic(kind, evt) {
    this.trafficEmitter.push(evt);
    try { this.trafficEmitter.emit(kind, evt); }
    catch (emitErr) {
      logStderr(`[mcp-relay] traffic-emitter "${kind}" subscriber threw: ${emitErr.stack || emitErr.message}`);
    }
  }

  /**
   * Run one tools/call (`run` returns its result), recorded as a request and
   * a response traffic event when recordTraffic is on. `source` is "own" or
   * "upstream".
   */
  async _recordCall(name, args, source, run) {
    // recordTraffic=false (no Inspector): no ids, events or per-call serialization.
    if (!this.recordTraffic) return run();
    const sensitive = SENSITIVE_TOOL_RE.test(name);
    const forEmit = (v) => truncateForEmit(redactForEmit(v, sensitive));
    const id = this.trafficEmitter.nextId();
    const startHr = process.hrtime.bigint();
    const recordResponse = (status, body) => {
      this._emitTraffic("response", {
        id,
        time: new Date().toISOString(),
        status,
        durationMs: Number(process.hrtime.bigint() - startHr) / 1_000_000,
        response: forEmit(body),
      });
    };

    // Emit `request` BEFORE forwarding/handling. Inspector buffers this so
    // the activity feed can show "in-flight" until the response lands.
    this._emitTraffic("request", {
      id,
      time: new Date().toISOString(),
      method: "tools/call",
      name,
      args: forEmit(args),
      source,
      ...(this.trafficConn ? { conn: this.trafficConn } : {}),
    });

    let response;
    try {
      response = await run();
    } catch (e) {
      // Forwarded-path failures bubble up as caller errors. Record + rethrow.
      recordResponse("error", { error: e.message });
      throw e;
    }
    recordResponse(response && response.isError ? "error" : "ok", response);
    return response;
  }

  async handleToolsCall({ name, arguments: args }) {
    const callArgs = args || {};
    const own = this.ownTools.get(name);
    return this._recordCall(name, callArgs, own ? "own" : "upstream", () => this._dispatch(name, args, callArgs, own));
  }

  async _dispatch(name, args, callArgs, own) {
    const hiddenSet = this.hiddenToolsetFor(name);
    if (hiddenSet) {
      // Owner rule: the agent asks the user before enabling a toolset.
      return { content: [{ type: "text", text: hiddenToolMessage(name, hiddenSet) }], isError: true };
    }
    if (own) {
      // Legacy mode: tabs are pages of this relay's own Brave (LegacyTabs).
      // needsBrave:false tools never launch it: without a running Brave
      // they get just the relay.
      const bridge = own.needsBrave ? (this.ensureBrave && await this.ensureBrave()) : this.peekBrave();
      try {
        const ctx = bridge
          ? await toolContext(legacyRegistry(bridge.context), LEGACY_CONN, own, callArgs,
            { context: bridge.context, cdpUrl: bridge.cdpConnectUrl, relay: this })
          : { relay: this };
        return await own.handler(callArgs, ctx);
      } catch (e) {
        return {
          content: [{ type: "text", text: `[mcp-relay] tool "${name}" failed: ${e.message}` }],
          isError: true,
        };
      }
    }
    return this.callUpstream(name, args);
  }

  /** Legacy: upstream is the child process getUpstream() returns. */
  async _callStdioUpstream(name, args) {
    const callArgs = args || {};
    if (callArgs.tabId != null && callArgs.tabId !== "main") {
      // Upstream runs in its own process here and its schemas drop tabId,
      // so the call would silently act on the main tab.
      return {
        content: [{ type: "text", text: `${name}: tabId is only supported for relay tools in this mode (upstream tools act on your main tab); omit tabId` }],
        isError: true,
      };
    }
    // Forwarded — upstream lazily attaches via CDP. Brave must be up first.
    if (this.ensureBrave) await this.ensureBrave();
    const upstream = await this.getUpstream();
    // tabId "main" is where upstream acts anyway; don't pass it on.
    let forwardArgs = args;
    if (callArgs.tabId != null) {
      forwardArgs = { ...callArgs };
      delete forwardArgs.tabId;
    }
    return upstream.request("tools/call", { name, arguments: forwardArgs });
  }
}

module.exports = { RelayServer, TrafficEmitter, truncateForEmit, MAX_TRAFFIC_BODY_CHARS, TRAFFIC_RING_CAPACITY };
