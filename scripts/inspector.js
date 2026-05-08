#!/usr/bin/env node
/**
 * inspector.js — standalone entry for the local read-only Inspector
 * dashboard. Off by default. Run with `npm run inspector`.
 *
 * The bulk of the inspector logic lives in `src/inspector-server.js` so the
 * relay can boot the same module in-process for live MCP traffic capture
 * (see src/index.js — when BROWSER_RELAY_INSPECTOR_PORT is set on the relay
 * process, the relay starts the inspector inline and pipes its traffic
 * emitter in). Standalone mode (this file) doesn't have a trafficEmitter,
 * so the Activity feed shows the "Inspector running standalone — live
 * traffic only available when launched in-process" message.
 *
 * Hard rules (carried over from W7-W9):
 *   - Bind 127.0.0.1 by default; LAN exposure requires explicit
 *     BROWSER_RELAY_INSPECTOR_BIND override (with a printed warning).
 *   - GET-only on the HTTP side. WS endpoint /ws/traffic is read-only.
 *   - User-facing UI never leaks absolute Windows paths.
 *
 * Re-exports the module's public surface so existing tests
 * (test/inspector-server.test.js) that import from "../scripts/inspector.js"
 * keep working without churn.
 */

const path = require("node:path");
const inspectorServer = require("../src/inspector-server.js");

const {
  startInspector,
  createInspector,
  buildStatus,
  buildSettings,
  buildSpecialty,
  buildToolsCatalog,
  buildSlotDetail,
  makeHandler,
  defaultPort,
  defaultBind,
  redactPath,
  formatDuration,
  truncate,
  inputSchemaPreview,
  TRACKED_ENV_VARS,
  OWN_TOOL_META,
} = inspectorServer;

// Run-as-script entrypoint.
if (require.main === module) {
  const port = defaultPort();
  const bind = defaultBind();

  if (bind !== "127.0.0.1" && bind !== "localhost") {
    process.stderr.write(
      `[mcp-relay-inspector] WARNING: binding to ${bind} (not 127.0.0.1). ` +
      `The inspector has no auth — anyone who can reach this address can read pool state.\n`,
    );
  }

  const uiRoot = path.join(__dirname, "inspector-ui");

  startInspector({
    port,
    bind,
    uiRoot,
    // No trafficEmitter — Activity feed will show the standalone message.
  })
    .then((handle) => {
      process.stdout.write(
        `Inspector running at http://${bind === "0.0.0.0" ? "localhost" : bind}:${handle.port}\n`,
      );
      for (const sig of ["SIGINT", "SIGTERM"]) {
        process.on(sig, async () => {
          try { await handle.close(); } catch { /* noop */ }
          process.exit(0);
        });
      }
    })
    .catch((e) => {
      process.stderr.write(`[mcp-relay-inspector] failed to start: ${e.stack || e.message}\n`);
      process.exit(1);
    });
}

module.exports = {
  startInspector,
  createInspector,
  buildStatus,
  buildSettings,
  buildSpecialty,
  buildToolsCatalog,
  buildSlotDetail,
  makeHandler,
  defaultPort,
  defaultBind,
  redactPath,
  formatDuration,
  truncate,
  inputSchemaPreview,
  TRACKED_ENV_VARS,
  OWN_TOOL_META,
};
