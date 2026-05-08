// inspector-forwarded-tools.js — hardcoded catalog of upstream
// browser-devtools-mcp tools surfaced on the Inspector's /tools page.
//
// We HARDCODE this list deliberately. Two earlier attempts at live
// introspection from the relay's parent process (W4 README dance + Stitch's
// mockup work) confirmed there's no reliable way to enumerate the upstream's
// `tools/list` from outside the relay's own JSON-RPC channel — and we don't
// want the inspector to depend on a running upstream process to render its
// catalog page. So: 51 tools, names + descriptions copied verbatim from the
// "Forwarded upstream tools" section of README.md, grouped by the upstream's
// own naming prefix (a11y_ → accessibility, content_ → content, ...).
//
// When upgrading the `browser-devtools-mcp` dep, re-sync this file with the
// updated README block — the tests assert total count = 51 so a missing /
// extra entry will be caught.

module.exports = {
  upstreamSource: "browser-devtools-mcp",
  // Update when bumping the upstream dep — purely informational on the UI.
  upstreamRepoUrl: "https://github.com/serkan-ozal/browser-devtools-mcp",
  tools: [
    // Accessibility (2)
    { name: "a11y_take-aria-snapshot", description: "ARIA tree snapshot with refs (e1, e2, ...) for downstream targeting", category: "accessibility" },
    { name: "a11y_take-ax-tree-snapshot", description: "Chromium AX tree + bounding boxes / visibility / viewport diagnostics", category: "accessibility" },

    // Content extraction & capture (6)
    { name: "content_get-as-html", description: "Get the page's HTML", category: "content" },
    { name: "content_get-as-text", description: "Get the page's visible text", category: "content" },
    { name: "content_save-as-pdf", description: "Save current page as a PDF", category: "content" },
    { name: "content_take-screenshot", description: "Screenshot the page or a specific element", category: "content" },
    { name: "content_start-recording", description: "Start video recording", category: "content" },
    { name: "content_stop-recording", description: "Stop recording and save the video file", category: "content" },

    // Live debugging probes (11)
    { name: "debug_status", description: "Status of the debug subsystem", category: "debug" },
    { name: "debug_resolve-source-location", description: "Resolve a source-map location", category: "debug" },
    { name: "debug_put-tracepoint", description: "Install a tracepoint at a source location", category: "debug" },
    { name: "debug_put-logpoint", description: "Install a logpoint (non-pausing console-style log)", category: "debug" },
    { name: "debug_put-exceptionpoint", description: "Install an exception breakpoint", category: "debug" },
    { name: "debug_add-watch", description: "Add a watch expression evaluated on each probe hit", category: "debug" },
    { name: "debug_list-probes", description: "List installed tracepoints / logpoints / watches", category: "debug" },
    { name: "debug_remove-probe", description: "Remove a probe by ID", category: "debug" },
    { name: "debug_clear-probes", description: "Bulk-remove probes by type", category: "debug" },
    { name: "debug_get-probe-snapshots", description: "Get captured snapshots from probes", category: "debug" },
    { name: "debug_clear-probe-snapshots", description: "Clear captured snapshots", category: "debug" },

    // Page interaction (9)
    { name: "interaction_click", description: "Click an element (selector or ARIA ref)", category: "interaction" },
    { name: "interaction_fill", description: "Fill an input", category: "interaction" },
    { name: "interaction_select", description: "Select a dropdown option", category: "interaction" },
    { name: "interaction_hover", description: "Hover an element", category: "interaction" },
    { name: "interaction_drag", description: "Drag an element to a target", category: "interaction" },
    { name: "interaction_press-key", description: "Press a keyboard key (with optional hold + repeat)", category: "interaction" },
    { name: "interaction_scroll", description: "Scroll the viewport or a scrollable element", category: "interaction" },
    { name: "interaction_resize-viewport", description: "Resize the page viewport (Playwright emulation)", category: "interaction" },
    { name: "interaction_resize-window", description: "Resize the OS-level browser window via CDP", category: "interaction" },

    // Navigation (3)
    { name: "navigation_go-to", description: "Navigate to a URL", category: "navigation" },
    { name: "navigation_reload", description: "Reload the current page", category: "navigation" },
    { name: "navigation_go-back-or-forward", description: "Move through history", category: "navigation" },

    // Observability (6)
    { name: "o11y_get-console-messages", description: "Console messages / logs with filtering", category: "observability" },
    { name: "o11y_get-http-requests", description: "HTTP requests with filtering", category: "observability" },
    { name: "o11y_get-web-vitals", description: "LCP / INP / CLS / TTFB / FCP with Google thresholds", category: "observability" },
    { name: "o11y_get-trace-context", description: "Get the OpenTelemetry trace context", category: "observability" },
    { name: "o11y_set-trace-context", description: "Set or clear the OTel trace context", category: "observability" },
    { name: "o11y_new-trace-id", description: "Generate + set a new OTel trace ID", category: "observability" },

    // React introspection (2)
    { name: "react_get-component-for-element", description: "Find React component(s) for a DOM element via Fiber", category: "react" },
    { name: "react_get-element-for-component", description: "Map a React component instance to its DOM footprint", category: "react" },

    // HTTP stubbing (4)
    { name: "stub_intercept-http-request", description: "Modify outgoing requests before they're sent", category: "stub" },
    { name: "stub_mock-http-response", description: "Mock responses for matching requests (picomatch glob)", category: "stub" },
    { name: "stub_list", description: "List currently installed stubs", category: "stub" },
    { name: "stub_clear", description: "Clear all stubs", category: "stub" },

    // Scenarios (6)
    { name: "scenario-add", description: "Save a reusable JS script that orchestrates other tools", category: "scenario" },
    { name: "scenario-update", description: "Update a scenario's description / script", category: "scenario" },
    { name: "scenario-delete", description: "Delete a scenario by name", category: "scenario" },
    { name: "scenario-run", description: "Run a saved scenario by name", category: "scenario" },
    { name: "scenario-list", description: "List all scenarios (project + global scope)", category: "scenario" },
    { name: "scenario-search", description: "Search scenarios by query", category: "scenario" },

    // Other (2)
    { name: "execute", description: "Batch-execute multiple tool calls in one request via custom JS — reduces round-trips", category: "execute" },
    { name: "sync_wait-for-network-idle", description: "Wait until in-flight requests ≤ N for idleMs", category: "sync" },
  ],
};
