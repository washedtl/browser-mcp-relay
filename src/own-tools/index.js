// own-tools/index.js — registry of all relay-owned tools (Phase C).
// Each tool module exports an object with shape:
//   { name, description, inputSchema, handler, needsBrave?, needsPage? }
// where handler is async (args, ctx) => mcpToolResult and ctx is
//   { page, context, sessionKey, registry, connId, cdpUrl, relay }:
//   • page / context — the session tab the call is routed to (args.tabId,
//     default "main") and its BrowserContext. Broker mode: the page upstream's
//     tools use for that tab. Legacy mode: _legacy-context.js.
//   • registry / connId — the caller's tabs (getCtx / listTabs / closeTab);
//     tabs_* use them, never another connection's tabs.
//   • cdpUrl — the browser's CDP endpoint (lighthouse_audit).
//   • relay — the RelayServer (toolsets).
// needsPage:false — the handler doesn't read ctx.page, so no tab is opened
// for it (it still gets context / registry / connId / cdpUrl).
// needsBrave:false — relay-local, ctx is just { relay }.
//
// Naming: matches upstream's verb_action style. Collision with upstream is
// detected at RelayServer.handleToolsList time (collisions throw on launch).

const modules = [
  require("./lighthouse-audit.js"),
  require("./memory-take-heap-snapshot.js"),
  require("./emulate-device.js"),
  require("./tabs-list.js"),
  require("./tabs-new.js"),
  require("./tabs-select.js"),
  require("./tabs-close.js"),
  require("./browser-show.js"),
  require("./dialog-handle.js"),
  require("./file-upload.js"),
  require("./form-fill.js"),
  require("./capture-xhr.js"),
  require("./cookies-export.js"),
  require("./cookies-import.js"),
  require("./stealth-apply.js"),
  require("./download-capture.js"),
  require("./extract-structured.js"),
  // Local / session storage — auth tokens for many modern SaaS apps
  // (Discord, Notion, Slack, Linear, Mercury…) live here, not in HTTP cookies.
  require("./storage-get-local.js"),
  require("./storage-set-local.js"),
  require("./storage-clear-local.js"),
  // Relay-local (no Brave): shows/hides the hidden-by-default tool groups.
  require("./toolsets.js").tool,
];

// Parallel subagents share their parent's MCP connection, so each needs its
// own tab: every tool that acts on a page takes an optional tabId.
const TAB_ID = {
  type: "string",
  description: "Optional: which of your tabs to act on (a tabId from tabs_new). Omit for your main tab. " +
    "Parallel subagents should each open their own tab and pass its tabId.",
};

function withTabId(tool) {
  if (tool.needsBrave === false || tool.needsPage === false) return tool;
  const { inputSchema } = tool;
  return { ...tool, inputSchema: { ...inputSchema, properties: { ...inputSchema.properties, tabId: TAB_ID } } };
}

const tools = modules.map(withTabId);

module.exports = { tools };
