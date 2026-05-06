// own-tools/index.js — registry of all relay-owned tools (Phase C).
// Each tool module exports an object with shape:
//   { name, description, inputSchema, handler }
// where handler is async (args) => mcpToolResult.
//
// Handlers access the shared Brave instance via globalThis.__relayBridge,
// which is populated by index.js after launchBrave() succeeds:
//   globalThis.__relayBridge = { context, cdpConnectUrl, port }
//
// Naming: matches upstream's verb_action style. Collision with upstream is
// detected at RelayServer.handleToolsList time (collisions throw on launch).

const tools = [
  require("./lighthouse-audit.js"),
  require("./memory-take-heap-snapshot.js"),
  require("./emulate-device.js"),
  require("./tabs-list.js"),
  require("./tabs-new.js"),
  require("./tabs-select.js"),
  require("./tabs-close.js"),
  require("./dialog-handle.js"),
  require("./file-upload.js"),
  require("./form-fill.js"),
  require("./capture-xhr.js"),
  require("./cookies-export.js"),
  require("./cookies-import.js"),
  require("./stealth-apply.js"),
  require("./download-capture.js"),
  require("./extract-structured.js"),
];

module.exports = { tools };
