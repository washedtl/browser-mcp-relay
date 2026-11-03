// own-tools/index.js — registry of all relay-owned tools (Phase C).
//
// THE own-tool contract (other files point here). Each tool module exports
//   { name, description, inputSchema, handler, needsBrave?, needsPage? }
// where handler is async (args, ctx) => mcpToolResult and ctx, built by
// toolContext() in _tool-context.js, is
//   { page, context, sessionKey, registry, connId, cdpUrl, relay, bridgeManagedMatcher }:
//   • page / context / sessionKey — the tab the call is routed to (args.tabId,
//     default "main"; an unknown tabId is an error, only tabs_new opens
//     tabs), its BrowserContext and "<connId>:<tabKey>". Broker mode: the
//     page upstream's tools use for that tab. Legacy mode: LegacyTabs.
//   • registry / connId — the caller's tabs: getCtx(connId, tabKey) →
//     { page, browserContext } with an OPEN page (broker: upstream's session
//     context after ensureSessionPageOpen, which re-creates a closed page),
//     listTabs(connId) → [{ tabKey, page|null }] (never creates anything),
//     closeTab(connId, tabKey). Another connection's tabs are never reachable.
//     registry.scope: "context" (legacy: the caller's session owns the whole
//     registry.context — stealth_apply patches it, tabs_new/tabs_select say
//     upstream tools ignore tabId); otherwise per-connection (broker: the
//     BrowserContext is shared, so only the connection's own tabs are touched).
//   • cdpUrl — the browser's CDP endpoint (lighthouse_audit). Broker mode: the
//     broker's proxy, ws://127.0.0.1:<port>/<secret>/devtools/browser (no
//     /json/*; never print it: the broker redacts results, logs and errors).
//     Legacy mode: http://127.0.0.1:<port> (cdp-bridge.js).
//   • relay — an object toolsets can drive: upstreamCatalog(),
//     enabledToolsets (Set), setToolsetsEnabled(sets, on), askUser(params),
//     canNotify (the RelayServer has all of these).
//   • bridgeManagedMatcher — broker mode with the cookie bridge (W2F): () →
//     (cookie) => boolean, true for a cookie the bridge copied from the
//     owner's Chrome (cookies_export hides its value). null in legacy mode.
// needsPage:false — the handler doesn't read ctx.page: no tab is routed or
//   opened (ctx keeps context / registry / connId / cdpUrl / relay /
//   bridgeManagedMatcher; context then comes from the provider).
// needsBrave:false — never launches the browser, never routed: ctx has the
//   registry & co. only while a browser runs, else just { relay }.
//
// Naming: matches upstream's verb_action style. Collision with upstream is
// detected at RelayServer.handleToolsList time (collisions throw on launch).

const { isRouted } = require("./_tool-context.js");

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

// Every routed tool takes an optional tabId (kept short: it is in every
// one of their schemas; the parallel-subagent guidance lives in tabs_new).
const TAB_ID = { type: "string", description: "Tab from tabs_new; omit for your main tab." };

function withTabId(tool) {
  if (!isRouted(tool)) return tool;
  const { inputSchema } = tool;
  return { ...tool, inputSchema: { ...inputSchema, properties: { ...inputSchema.properties, tabId: TAB_ID } } };
}

const tools = modules.map(withTabId);

module.exports = { tools };
