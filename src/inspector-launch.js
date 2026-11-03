// inspector-launch.js — start the in-process relay Inspector (the web UI,
// not Node's debugger) for a legacy relay or the broker: one port parse, one
// bind warning, one retry loop. Light: inspector-server.js loads only when a
// port is configured.

"use strict";

const path = require("node:path");

// How often a busy port is retried, so a surviving relay takes over when
// the owner exits.
const INSPECTOR_RETRY_MS = 30_000;
const UI_ROOT = path.resolve(__dirname, "..", "scripts", "inspector-ui");

/** BROWSER_RELAY_INSPECTOR_PORT as a port, or null (unset; an invalid value is warned about). */
function inspectorPortFromEnv(env, log) {
  const raw = env.BROWSER_RELAY_INSPECTOR_PORT;
  if (!raw) return null;
  const port = Number(raw);
  if (Number.isInteger(port) && port >= 0 && port <= 65535) return port;
  log(`[mcp-relay] WARNING: BROWSER_RELAY_INSPECTOR_PORT="${raw}" is not a valid port; skipping the in-process inspector`);
  return null;
}

/**
 * Start the Inspector. Several relays share one configured port, so a busy
 * port is normal: log one line and retry every `retryMs` so this relay
 * takes over when the owner exits. Returns { handle, close() }.
 */
function startInspectorWithRetry({ start, port, bind, retryMs = INSPECTOR_RETRY_MS, log }) {
  let handle = null;
  let timer = null;
  let closed = false;
  let warned = false;

  async function attempt() {
    timer = null;
    try {
      const h = await start();
      if (closed) { await h.close(); return; } // closed while binding
      handle = h;
      log(`[mcp-relay] inspector running at http://${bind}:${h.port}`);
    } catch (e) {
      if (closed) return;
      if (e && e.code === "EADDRINUSE") {
        if (!warned) {
          warned = true;
          log(`[mcp-relay] inspector port ${port} is in use (another relay's inspector?); retrying every ${retryMs / 1000}s`);
        }
        timer = setTimeout(attempt, retryMs);
        timer.unref();
        return;
      }
      log(`[mcp-relay] inspector failed to start: ${e.stack || e.message}`);
    }
  }
  attempt();

  return {
    get handle() { return handle; },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (handle) await handle.close();
    },
  };
}

/**
 * Start the Inspector on `port`, bound per BROWSER_RELAY_INSPECTOR_BIND
 * (warned when not loopback: it has no auth). brokerStatus adds the broker
 * view (/api/broker) and drops the legacy pool probes from /api/status.
 * @param {{port: number, env: object, log: (msg: string) => void, trafficEmitter?: object, brokerStatus?: () => object}} opts
 * @returns {{handle: object|null, close: () => Promise<void>}}
 */
function launchInspector({ port, env, log, trafficEmitter, brokerStatus }) {
  const { startInspector, defaultBind } = require("./inspector-server.js");
  const bind = defaultBind(env);
  if (bind !== "127.0.0.1" && bind !== "localhost") {
    log(`[mcp-relay] WARNING: inspector binding to ${bind} (not 127.0.0.1). No auth: anyone reaching this address reads it, tool traffic included.`);
  }
  return startInspectorWithRetry({
    // startInspector's own "port in use" hint would repeat on every retry;
    // the retry loop logs once instead.
    start: () => startInspector({ port, bind, uiRoot: UI_ROOT, trafficEmitter, brokerStatus, quietPortInUse: true }),
    port,
    bind,
    log,
  });
}

module.exports = { inspectorPortFromEnv, startInspectorWithRetry, launchInspector, INSPECTOR_RETRY_MS };
