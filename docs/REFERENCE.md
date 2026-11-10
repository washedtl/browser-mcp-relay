# browser-mcp-relay — Reference

The slim README at the root of the repo is for getting up and running. This file is the deep-dive: every tool, every env var, every mode, every optional feature.

## Contents

- [Tool catalog](#tool-catalog)
  - [First-party tools (21)](#first-party-tools-21)
  - [Forwarded upstream tools (51)](#forwarded-upstream-tools-51)
  - [Results in broker mode](#results-in-broker-mode)
  - [Toolsets (hidden by default)](#toolsets)
- [Worked examples](#worked-examples)
- [Architecture](#architecture)
  - [Broker mode (default on Windows)](#broker-mode-default-on-windows)
  - [Legacy mode](#legacy-mode)
- [Configuration](#configuration)
  - [Broker settings](#broker-settings)
- [Modes](#modes)
- [Broker lifecycle](#broker-lifecycle)
- [Legacy mode: how the pool dance works](#legacy-mode-how-the-pool-dance-works)
- [Optional features](#optional-features)
  - [Proxy whitelist](#proxy-whitelist)
  - [Credential vault + autofill](#credential-vault--autofill)
  - [Cookie bridge](#cookie-bridge)
- [Stealth model](#stealth-model)
- [Inspector](#inspector)
- [Platform support](#platform-support)
- [Troubleshooting](#troubleshooting)
  - [Broker mode](#broker-mode)
- [Diagnostic recipes](#diagnostic-recipes)
- [Limitations](#limitations)
  - [Broker mode: known risks](#broker-mode-known-risks)

---

## Tool catalog

**72 tools total = 21 first-party (built into this relay) + 51 forwarded from [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp).** 22 of them are hidden by default until you enable their [toolset](#toolsets).

Both layers are merged into a single `tools/list` response, so to your MCP client they all just look like "tools the relay provides."

### First-party tools (21)

#### 🔬 Performance & diagnostics

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `lighthouse_audit` | Lighthouse audit against a URL (never resets storage: warm-cache scores) | `formFactor: "desktop"\|"mobile"` | Performance regression check on a deploy |
| `memory_take-heap-snapshot` | V8 heap snapshot via CDP | `outputPath`, `timeoutMs` | Memory-leak hunt on a long-running SPA |

#### 📱 Device emulation

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `emulate_device` | UA / viewport / network throttling (`reset: true` clears all overrides). A `userAgent` also sets Chrome-exact client hints + `navigator.platform` and reaches the tab's cross-origin iframes + dedicated workers (see [Stealth model](#stealth-model) for what it can't reach) | `network.downloadKbps` | Verify a layout on Slow 3G |

#### 📑 Multi-tab control

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `tabs_list` | List your tabs (this session only) with `tabId`, URL, title | — | "Where did I leave that page?" |
| `tabs_new` | Open a new tab and return its `tabId` | `url` | Give each parallel subagent its own tab |
| `tabs_select` | Bring one of your tabs to the front | `tabId` | Show the user a specific tab |
| `tabs_close` | Close one of your tabs | `tabId` | Tear down workflow tabs |
| `browser_show` | Bring your window on-screen and to the front (restores a minimized window, moves an off-screen one into view) | `tabId` | Let the user log in or pass 2FA by hand |

Tools that act on a page take an optional `tabId` (from `tabs_new`); without it they act on your main tab. Only `tabs_new` opens tabs: an unknown `tabId` is an error. Tabs belong to one MCP connection: another session's tabs are never listed, selected or closed, and `tabs_list` / `tabs_select` / `tabs_close` never open a tab or launch the browser. In legacy (per-session pool) mode only the relay's own tools take `tabId` (the `tabs_new` / `tabs_select` results say so); a forwarded upstream tool called with a `tabId` other than `"main"` returns an error (it would act on your main tab). Popups never become your main tab.

#### 📤 Forms, dialogs, files

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `dialog_handle` | Handle the next JS dialog; blocks until one appears (trigger it with a parallel call) | `action: "accept"\|"dismiss"` | Click a button that triggers `confirm()` |
| `file_upload` | Set files on a file input | `files: [absPath]` | Upload a file without an OS picker |
| `form_fill` | Fill many fields in one round-trip | `fields: [{selector, value}]` | Bulk-fill a long signup form |

#### 🌐 Network capture

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `capture_xhr` | Record XHR/fetch responses (compact by default: 2 KB bodies, ~100 KB total, headers opt-in) | `urlFilter` (regex), `outputPath` (full capture to a file) | Reverse-engineer a site API while logged in |

#### 🍪 Session & cookies

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `cookies_export` | Export cookies as JSON (one jar, shared by every tab and session). Cookies the [cookie bridge](#cookie-bridge) copied from Chrome come back with value `"[bridge-managed]"` (`execute` can still read non-HttpOnly values: it isn't a sandbox) | `urls`, `domains`, `names` (filters), `outputPath` (keeps values out of the transcript) | Save an authed session for later |
| `cookies_import` | Import cookies into the shared jar (skips `"[bridge-managed]"` placeholders) | `cookies` or `inputPath` (a file from `cookies_export`) | Restore an authed session |
| `stealth_apply` | Anti-detection patches (Tier 1), all your tabs, never another session's | `languages` | Defeat trivial bot checks + the bottom 70% of fingerprint surface |

#### 💾 Downloads

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `download_capture` | Wait for a download, save to disk (absolute `savePath`) | `clickSelector` | Trigger + save a CSV export |

#### 🗄️ Storage (added in v0.3.0)

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `storage_get-local` | Read `localStorage` / `sessionStorage` keys | `store: "local"\|"session"`, `keyFilter` (regex) | Inspect OAuth tokens on Discord, Notion, Slack, etc. (auth often lives in localStorage, not cookies) |
| `storage_set-local` | Write keys into `localStorage` / `sessionStorage` | `entries: { key: value }` | Restore an authed session after fresh navigation |
| `storage_clear-local` | Clear local/session storage on the active origin | `keys` (optional filter) | Test fresh-user flows without resetting the whole profile |

#### 🔍 Data extraction

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `extract_structured` | CSS-selector-based extraction | `schema` | Scrape an authed page that public scrapers can't reach |

#### 🧰 Relay control

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `toolsets` | List / enable / disable the hidden-by-default [toolsets](#toolsets). Never launches Brave. | `action`, `sets` | Turn on `debug` after the user agrees, for a source-mapped logpoint session |

> Source for each first-party tool lives at [`src/own-tools/<tool-name>.js`](../src/own-tools/).

---

### Forwarded upstream tools (51)

Provided by [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp) — the relay forwards `tools/call` requests for these to upstream. Broker mode changes a few arguments and results on the way: see the notes in the tables and [Results in broker mode](#results-in-broker-mode). Brief summaries below; full schemas come straight from upstream and are visible to your MCP client via `tools/list`.

#### ♿ Accessibility (2)

| Tool | Purpose |
|---|---|
| `a11y_take-aria-snapshot` | ARIA tree snapshot with refs (`e1`, `e2`, …) for downstream targeting |
| `a11y_take-ax-tree-snapshot` | Chromium AX tree + bounding boxes / visibility / viewport diagnostics |

#### 📄 Content extraction & capture (6)

| Tool | Purpose |
|---|---|
| `content_get-as-html` | Get the page's HTML |
| `content_get-as-text` | Get the page's visible text |
| `content_save-as-pdf` | Save current page as a PDF |
| `content_take-screenshot` | Screenshot the page, or one element with `selector` (CSS or a snapshot ref). In broker mode the image is that element; in legacy mode upstream returns the viewport (the whole page with `fullPage`) |
| `content_start-recording` | Start video recording |
| `content_stop-recording` | Stop recording and save the video file |

#### 🐛 Live debugging probes (11)

Hidden by default: `debug` [toolset](#toolsets).

| Tool | Purpose |
|---|---|
| `debug_status` | Status of the debug subsystem |
| `debug_resolve-source-location` | Resolve a source-map location |
| `debug_put-tracepoint` | Install a tracepoint at a source location |
| `debug_put-logpoint` | Install a logpoint (non-pausing console-style log) |
| `debug_put-exceptionpoint` | Install an exception breakpoint |
| `debug_add-watch` | Add a watch expression evaluated on each probe hit |
| `debug_list-probes` | List installed tracepoints / logpoints / watches |
| `debug_remove-probe` | Remove a probe by ID |
| `debug_clear-probes` | Bulk-remove probes by type |
| `debug_get-probe-snapshots` | Get captured snapshots from probes |
| `debug_clear-probe-snapshots` | Clear captured snapshots |

#### 🖱️ Page interaction (9)

| Tool | Purpose |
|---|---|
| `interaction_click` | Click an element (selector or ARIA ref) |
| `interaction_fill` | Fill an input |
| `interaction_select` | Select a dropdown option |
| `interaction_hover` | Hover an element |
| `interaction_drag` | Drag an element to a target |
| `interaction_press-key` | Press a keyboard key (with optional hold + repeat) |
| `interaction_scroll` | Scroll the viewport or a scrollable element |
| `interaction_resize-viewport` | Resize the page viewport (Playwright emulation) |
| `interaction_resize-window` | Resize the OS-level browser window via CDP |

#### 🧭 Navigation (3)

| Tool | Purpose |
|---|---|
| `navigation_go-to` | Navigate to a URL (with `navigation_reload` and `navigation_go-back-or-forward`, a 60 s default `timeout` in broker mode. Called inside `execute` or `scenario-run` they keep upstream's default of no timeout, and the script's `timeoutMs` ends the call: 30 s unless set, 120 s at most, and no limit at all with `timeoutMs: 0`) |
| `navigation_reload` | Reload the current page |
| `navigation_go-back-or-forward` | Browser history navigation. Broker mode turns off Chromium's back/forward cache, so the earlier page loads again |

#### 📈 Observability (6)

The three trace-context tools are hidden by default: `trace` [toolset](#toolsets).

| Tool | Purpose |
|---|---|
| `o11y_get-console-messages` | Page console output |
| `o11y_get-http-requests` | Captured HTTP requests. In broker mode a response body over 64 KB isn't kept, and a tab stops keeping them after 32 MB; `capture_xhr` can save them |
| `o11y_get-web-vitals` | LCP / INP / CLS / TTFB / FCP |
| `o11y_get-trace-context` | Current OpenTelemetry trace context |
| `o11y_set-trace-context` | Set / inject a trace context |
| `o11y_new-trace-id` | Mint a fresh trace ID |

#### ⚛️ React introspection (2)

Hidden by default: `react` [toolset](#toolsets).

| Tool | Purpose |
|---|---|
| `react_get-component-for-element` | Map a DOM element back to its React component via Fiber |
| `react_get-element-for-component` | Reverse — find the DOM element a component renders into |

#### 🔌 HTTP stubbing (4)

| Tool | Purpose |
|---|---|
| `stub_intercept-http-request` | Intercept matching outgoing requests |
| `stub_mock-http-response` | Mock responses for matching requests (picomatch glob) |
| `stub_list` | List currently installed stubs |
| `stub_clear` | Clear all stubs |

#### 🎬 Scenarios (6)

Hidden by default: `scenario` [toolset](#toolsets).

| Tool | Purpose |
|---|---|
| `scenario-add` | Save a reusable JS script that orchestrates other tools |
| `scenario-update` | Update a scenario's description / script |
| `scenario-delete` | Delete a scenario by name |
| `scenario-run` | Run a saved scenario by name |
| `scenario-list` | List all scenarios (project + global scope) |
| `scenario-search` | Search scenarios by query |

#### ⚡ Other (2)

| Tool | Purpose |
|---|---|
| `execute` | Batch-execute multiple tool calls in one request via custom JS — reduces round-trips |
| `sync_wait-for-network-idle` | Wait until in-flight requests ≤ N for `idleTimeMs`. In broker mode a request cut off by a navigation and an EventSource stream are not counted |

### Results in broker mode

What the broker changes in a forwarded tool's result before your MCP client gets it:

- **A result over 30,000 characters is cut, and saved in full.** When the length is in a few long fields (a snapshot, a page's HTML or text), the cut is made inside them, the result is still valid JSON, and the file holds the full text of the fields that were cut. Anything else, such as a list of many short records, dozens of long fields or text that is not JSON, is cut as plain text at the last line break before the limit (at the limit itself when that would show half of it or less), and the file holds the whole text. The file goes to `results/` in the [broker home](#broker-settings) and is kept for at least 24 hours (older files are removed when the next one is saved). It holds what the tool returned, as plain text: page content, and from the request tool the URLs, request bodies and any headers or response bodies you asked it to include. On Linux and macOS only your user can read it (mode 600); on Windows it is under your `%LOCALAPPDATA%`. A note after the result names the file, the line where the cut text continues (when the cut falls on a line break), and the arguments that return less next time:
  - navigation tools: `includeSnapshot: false`, or `snapshotOptions: {interactiveOnly: true}`
  - `a11y_take-aria-snapshot`, `content_get-as-html` and `content_get-as-text`: a `selector` for the part you need
  - console and request tools: `limit: {count: N}`

  The limit counts characters, not tokens, and applies to each text part of a result on its own (a forwarded tool normally returns one). Text that takes more tokens per character (Chinese, Japanese, Korean) can still pass your client's own limit, so ask for less with the arguments above.

  First-party tools are not cut. `capture_xhr`, `cookies_export`, `extract_structured` and `storage_get-local` have size limits of their own.
- **Snapshots come without the `refs` map.** The map listed each ref again with its role, name and selector. Every ref is in the snapshot text as `[ref=eN]`: pass one as the `selector` of an `interaction_*` tool or of `content_take-screenshot`, `"e12"` or `"@e12"` (any other tool's `selector` is CSS). The two tool descriptions that promised the map are reworded to match. A script inside `execute` still gets the map from `callTool`, and it is in the result if the script returns that output whole.
- **A screenshot with a `selector` is that element's image**, whatever `fullPage` says. The page is scrolled to bring the element into view and is left there. An element that is hidden or has no size fails after 5 seconds with `element is not visible`. Upstream alone checks that the element exists and returns the viewport, or the whole page with `fullPage`.
- **Output files are named per call**, also for calls made with `callTool` inside `execute`, so two screenshots in one second are two files.
- **Error text has no colour codes**, and neither do the lines an `execute` script logs. What the script returns is left as it is.

### Toolsets

22 forwarded tools are hidden from `tools/list` by default to save your MCP client's context (~15K chars of description + schema). They are grouped into toolsets:

| Toolset | Tools | What for |
|---|---|---|
| `debug` | `debug_*` (11) | JS debugger probes: tracepoints, logpoints, exception points, watches, snapshots |
| `react` | `react_*` (2) | Map DOM elements to React components and back |
| `scenario` | `scenario-*` (6) | Save / run multi-step tool scripts |
| `trace` | `o11y_get-trace-context`, `o11y_new-trace-id`, `o11y_set-trace-context` | OpenTelemetry trace-id context |

- **Your AI asks before enabling.** The `toolsets` tool's description, and the error a hidden tool returns when called, tell the agent to ask you first and enable a group only after you agree (`toolsets {"action":"enable","sets":["debug"]}`). `{"action":"list"}` shows every group and its tools; `disable` hides a group again.
- **You get a real prompt when your client supports it.** If the MCP client advertises the elicitation capability, `toolsets` enable shows you an approve/decline prompt naming the group, what it is for and how many tools it adds. Nothing is enabled unless you approve; on decline (or no answer within 55s) the agent is told to carry on without it. Clients without elicitation fall back to the ask-in-chat rule above.
- **How the change reaches your client.** Enabling or disabling sends the MCP `notifications/tools/list_changed` notification (when the entrypoint wires it; otherwise the response says a restart is needed). Claude Code re-fetches `tools/list` when it gets one ([docs](https://code.claude.com/docs/en/mcp)). A client that ignores the notification keeps its old list: set `BROWSER_RELAY_TOOLSETS` instead and restart the MCP server.
- **Pre-enable** with `BROWSER_RELAY_TOOLSETS=debug,react` (comma-separated, or `all`) in the relay's env or `local-config.json`. Unknown names are ignored with a stderr warning.
- Hiding saves context; it is not a security boundary. Upstream's `execute` tool can still call any upstream tool by name.

---

## Worked examples

Each example shows the raw JSON-RPC `tools/call` request your MCP client would send. Most clients (Claude Code, Cursor) wrap this in a higher-level "use tool X" UX — these payloads are useful when you're debugging or building your own client.

### `lighthouse_audit` — measure performance after a deploy

```jsonc
// Request
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "lighthouse_audit",
    "arguments": {
      "url": "https://example.com",
      "formFactor": "desktop"
    }
  }
}
```

```jsonc
// Response (truncated)
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\n  \"url\": \"https://example.com\",\n  \"formFactor\": \"desktop\",\n  \"categories\": {\n    \"performance\": { \"score\": 99, \"title\": \"Performance\" },\n    \"accessibility\": { \"score\": 92, \"title\": \"Accessibility\" },\n    \"best-practices\": { \"score\": 100, \"title\": \"Best Practices\" },\n    \"seo\": { \"score\": 91, \"title\": \"SEO\" }\n  },\n  \"finalUrl\": \"https://example.com/\",\n  \"fetchTime\": \"2026-01-01T00:00:00.000Z\"\n}"
    }]
  }
}
```

> Use it in CI to fail a deploy when Lighthouse drops below a threshold, or interactively when you want a one-line "is this page slow?" answer.

### `cookies_export` — save an authed session

```jsonc
// Request — capture only cookies that apply to amazon.com
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "cookies_export",
    "arguments": {
      "urls": ["https://www.amazon.com/"]
    }
  }
}
```

```jsonc
// Response (truncated)
{
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"count\":2,\"cookies\":[{\"name\":\"session-id\",\"value\":\"<...>\",\"domain\":\".amazon.com\",\"path\":\"/\",\"httpOnly\":true,\"secure\":true,\"sameSite\":\"Lax\"},{\"name\":\"ubid-main\",\"value\":\"<...>\",\"domain\":\".amazon.com\", ... }]}"
    }]
  }
}
```

> Pair with `cookies_import` to restore the session later — useful for testing multi-step authed flows without re-logging in each run. Prefer `outputPath` on export and `inputPath` on import so cookie values never pass through the model. Inline output is capped at `maxBytes` (default 50 KB) and flagged `truncated`.

### `extract_structured` — scrape an authed page

```jsonc
// Request
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "tools/call",
  "params": {
    "name": "extract_structured",
    "arguments": {
      "navigateToUrl": "https://example.com/product/123",
      "waitForSelector": "#productTitle",
      "schema": {
        "title":  { "selector": "#productTitle" },
        "price":  { "selector": "#priceblock" },
        "images": { "selector": "img.thumb", "attribute": "src", "multiple": true }
      }
    }
  }
}
```

```jsonc
// Response
{
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"url\":\"https://example.com/product/123\",\"data\":{\"title\":\"Example Product\",\"price\":\"$19.99\",\"images\":[\"https://.../1.jpg\",\"https://.../2.jpg\"]}}"
    }]
  }
}
```

> Use this when a page is behind a login or a captcha that public scrapers can't bypass — your relay's Brave is already authenticated.

---

## Architecture

### Broker mode (default on Windows)

```
Claude session 1 ── stdio ──▶ shim (node src/index.js, ~23 MB) ─┐
Claude session 2 ── stdio ──▶ shim ──────────────────────────────┼─▶ \\.\pipe\browser-mcp-relay-<user>-<hash>
Claude session N ── stdio ──▶ shim ──────────────────────────────┘          │ (one broker per user + profile)
                                                                             ▼
      ┌────────────── broker (node src/broker/main.js, detached, de-elevated) ──────────────┐
      │ one MCP server per connection (cached catalog, toolsets, elicitation per session)   │
      │ SessionRegistry: (connection, tabId) → upstream session context = one window        │
      │ browser-devtools-mcp IN-PROCESS (loaded on the first tools/call) + the 21 own-tools │
      │ BraveSupervisor: launch, PID, crash → relaunch, graceful close                      │
      │ CdpProxy: CDP for upstream + own-tools, ws://127.0.0.1:<port>/<secret>/…            │
      │ control channel (broker:status / broker:stop) · the one relay Inspector (optional)  │
      └───────────────── CDP over a pipe (fd 3/4): Brave has no TCP port ──────────────────┘
                                                                             ▼
                                  ONE Brave, ONE persistent profile (logins shared live, kept)
```

**How it works:**

- 📥 `node src/index.js` reads `BROWSER_RELAY_MODE` (env, then `local-config.json`; default `broker` on Windows, `legacy` elsewhere) and becomes the **shim**. The shim loads only Node built-ins and passes the session's newline-delimited JSON-RPC through to the broker's named pipe byte for byte. The `~/.claude.json` entry doesn't change.
- 🔑 Before forwarding anything, the shim checks that the pipe's owner knows this user's broker key (an HMAC over a nonce; the key is `broker.key` in the broker home). Something squatting the predictable pipe name gets nothing.
- 🚀 No broker yet? The shim starts one through a detached launcher, so killing the session's process tree can't reach it. When the session is elevated, the broker starts with the desktop shell's own (non-elevated) token, and so does its Brave. Shims racing a cold start all launch one, and the pipe lets exactly one win.
- 📋 `tools/list` comes from the cached upstream catalog, as in legacy mode, plus an optional `tabId` on every page tool. A session that never calls a tool costs the broker no upstream import and no Brave.
- ⚙️ `tools/call` runs in the broker. Upstream's tools run in-process, through upstream's own executor and zod schemas, and own-tools run on the same page objects. Stubs (`stub_*`) and debug probes are scoped to the session's page, not the shared context.
- 🪟 Every session tab is its **own Brave window**, cascaded and visible (`BROWSER_RELAY_BROKER_WINDOWS=offscreen` keeps them off-screen). A tab in the background of a shared window stalls screenshots; separate windows don't. A minimized window is restored before screenshot and interaction tools run.
- 🧵 **Parallel subagents share their parent session's MCP connection**, so without `tabId` they'd drive the same tab. Each should call `tabs_new` and pass the returned `tabId` on every call.
- 🍪 One persistent profile: a login in any session is live in every other one, and it survives restarts, because Brave itself wrote the cookies.

### Legacy mode

`BROWSER_RELAY_MODE=legacy` (the default on macOS and Linux): each MCP session runs its own relay, with its own Brave and its own upstream child, as before v0.4. Its Brave keeps an unauthenticated TCP debugging port (`9333 + slot - 1`) that upstream attaches to; broker mode has none (see *Broker mode: known risks*).

```
                    stdio JSON-RPC
   MCP client ───────────────────▶  browser-mcp-relay
   (Claude Code,                    (this repo)
    Cursor, …)                              │
                                            ├── stdio JSON-RPC
                                            ▼
                                    browser-devtools-mcp
                                       (upstream child)
                                            │
                                            │ CDP
                                            ▼
                                       ┌─────────┐
                                       │  Brave  │   ◀── one per relay process
                                       │ (one    │       (lazy: launched on
                                       │  per    │        first tools/call)
                                       │  relay) │
                                       └─────────┘
                                            ▲
                                            │ CDP (Playwright connectOverCDP)
                                            │
                                       relay's own-tools
                                       (this repo, 21 tools)
```

**How it works:**

- 📥 The relay receives MCP messages on stdin from your client.
- 📋 `tools/list` → serves the upstream catalog from a disk cache (`<repo>/.cache/upstream-catalog.json`, or a per-user cache dir if the repo is read-only) merged with the 21 own-tool definitions, minus hidden [toolsets](#toolsets). No Brave and no long-lived upstream child: the cache is rebuilt by a short-lived upstream spawn only when the upstream build, the bundle patch, or a catalog-shaping upstream env var changes. Upstream `outputSchema`s (~62K chars) are not sent.
- ⚙️ `tools/call` → either forwards to the upstream child (for the 51 forwarded tools) or runs an own-tool handler directly.
- 🔌 Both paths attach to the same Brave instance: the upstream uses `BROWSER_CDP_CONNECT_URL`, own-tools use Playwright's `chromium.connectOverCDP` against the same port.
- 🪶 One Brave per relay process. Brave is launched **lazily on the first `tools/call`**, not at startup.

**Legacy shutdown lifecycle (since v0.3.2):** orphan Brave processes are reaped at three points — `claimSlot` (lock-acquire), `ensureBrave` (pre-launch, `F1-16`), and `closeBrave` (shutdown via Playwright `context.close`). The pre-launch reap closes the lazy-launch gap where a previous-session Brave can squat on a claimed-but-not-yet-launched user-data-dir.

---

## Configuration

All paths the relay needs are auto-detected by default. Override them with these env vars or by editing `local-config.json` (gitignored, written by `npm run setup`).

| Env var | Default | Purpose |
|---|---|---|
| `BROWSER_RELAY_BRAVE_PATH` | auto-detect | Absolute path to `brave` / `brave.exe`. Auto-detect probes Brave Stable / Beta / Nightly / Dev install paths on Win/Mac/Linux + the Windows registry (HKLM + HKCU, all 4 channels). |
| `BROWSER_RELAY_UPSTREAM_PATH` | `require.resolve("browser-devtools-mcp/dist/index.js")` | Path to the upstream `browser-devtools-mcp` entry. Override to point at a custom build. |
| `BROWSER_RELAY_BRAVE_PROFILE_DIR` | unset | Optional profile dir hint used by detection / cookie snapshot. |
| `BROWSER_RELAY_POOL_DIR` | unset (standalone) | Opt-in: absolute path to a Brave user-data-dir to claim. Standalone mode uses `<repo>/.browser-data` (or a per-user cache dir if the repo is read-only — `~/.cache/browser-mcp-relay/browser-data` on Linux, `~/Library/Caches/browser-mcp-relay/browser-data` on macOS, `%LOCALAPPDATA%\browser-mcp-relay\Cache\browser-data` on Windows). |
| `BROWSER_RELAY_POOL_SLOT` | unset | Cosmetic slot index for the launch banner; also sets the CDP port (`9333 + slot - 1`) when using pool mode. |
| `BROWSER_HEADLESS_ENABLE` | `false` | Set `true` to launch Brave headless. |
| `BROWSER_LOAD_EXTENSIONS` | unset | Path to an unpacked Chrome extension to load. |
| `BROWSER_MCP_ROLE` | unset | Role-based slot filter (only meaningful with the optional pool wrapper). |
| `BROWSER_RELAY_PROXY_URL` | unset | Optional proxy for Brave's outbound traffic (`http`, `https`, `socks4`, `socks5`; `user:pass@` allowed; no scheme = `http://`). Useful with debug proxies (Charles, mitmproxy, powhttp). See [Proxy whitelist](#proxy-whitelist). |
| `BROWSER_RELAY_IGNORE_HTTPS_ERRORS` | `false` | Set `true` to accept any TLS certificate even without a relay proxy (e.g. a corporate MITM proxy set at the OS level). Weakens TLS for every page the relay opens. See [Proxy whitelist](#proxy-whitelist). |
| `BROWSER_RELAY_VAULT_FILES` | unset (autofill disabled) | Path-delimiter-separated paths to Brave/Chrome password CSV exports (`;` on Win, `:` on POSIX). Enables form-autofill on navigation. See [Credential vault](#credential-vault--autofill). |
| `BROWSER_RELAY_SNAPSHOT_INDEXEDDB` | `false` | Include IndexedDB in pool-mode profile snapshot (100+ MB typical). |
| `BROWSER_RELAY_INSPECTOR_PORT` | unset | When set, the relay boots the Inspector dashboard inline on this port and pipes its live MCP-traffic stream into the `/slot/N` Inspector pages. Without this, run the Inspector separately via `npm run inspector` (no live traffic). See [Inspector](#inspector). |
| `BROWSER_RELAY_INSPECTOR_BIND` | `127.0.0.1` | Bind address for the Inspector. Override only with care — the Inspector has no auth. |
| `BROWSER_RELAY_TOOLSETS` | unset (all hidden) | Comma-separated [toolsets](#toolsets) to show from startup: `debug`, `react`, `scenario`, `trace`, or `all`. |
| `BROWSER_RELAY_CATALOG_REFRESH` | unset | `true` ignores the cached upstream catalog, re-lists it from a fresh upstream spawn and rewrites the cache. `npm run smoke` and setup set it so they exercise the real upstream. |

**Precedence:** environment variable ▸ `local-config.json` ▸ auto-detect ▸ reasonable hard-coded defaults.

**Telemetry:** upstream `browser-devtools-mcp` reports usage to PostHog unless `TELEMETRY_ENABLE=false`. The relay sets that for every upstream it runs, in both modes, whatever the env says.

### Broker settings

| Env var | Default | Purpose |
|---|---|---|
| `BROWSER_RELAY_MODE` | `broker` on Windows, `legacy` elsewhere | `broker`: `src/index.js` is the shim and joins the shared broker. `legacy`: one relay + Brave + upstream per session (the pre-v0.4 model). On macOS and Linux the broker's unix-socket code is untested (never run), so legacy stays the default there. |
| `BROWSER_RELAY_BROKER_PROFILE_DIR` | `<broker home>/profile` | The broker's one persistent Brave profile. The pipe name is derived from it, so two profile dirs mean two brokers. |
| `BROWSER_RELAY_BROKER_PIPE` | `\\.\pipe\browser-mcp-relay-<user>-<hash of user + profile>` | Override the pipe (tests use a unique one). On unix (untested): `<tmpdir>/browser-mcp-relay-<uid>/<hash>.sock` in a private 0700 dir. |
| `BROWSER_RELAY_BROKER_WINDOWS` | `cascade` | `cascade`: visible, stepped windows, one per session tab. `offscreen`: windows left of every display; they still render at full speed, and `browser_show` brings one into view. |
| `BROWSER_RELAY_BROKER_IDLE_EXIT_MS` | `600000` (10 min) | The broker exits this long after its last session disconnected, closing Brave gracefully first. |
| `BROWSER_RELAY_BROKER_BROWSER_IDLE_MS` | `1200000` (20 min) | Brave closes gracefully after this long without any tool call, even with sessions connected. The next call relaunches it (~1-2 s), and its tabs answer with a reset notice. |
| `BROWSER_RELAY_BROKER_DEELEVATE` | on | `off` keeps a broker started from an elevated session elevated, and its Brave with it. Read by the launcher from the **process env only** (the MCP server's `env` block), not from `local-config.json`. |
| `BROWSER_RELAY_BROKER_WATCHDOG_MS` | `60000` | A watchdog thread stops the code blocking the broker's event loop after a third of this (e.g. a runaway `execute`; every other session keeps its tabs) and kills the broker if it is still blocked at this limit; the next tool call then starts a fresh one. Minimum 30 s; `0` turns it off. It is also off while Node's own debugger is attached. |
| `BROWSER_RELAY_BROKER_RECYCLE_RSS_MB` | `1024` | A broker whose memory (RSS) is above this restarts itself once no tool call has run for a minute and either no session is connected or Brave has idled out (no session loses an open tab). `0` turns it off. |
| `BROWSER_RELAY_BRIDGE_ALLOW` | unset | [Cookie bridge](#cookie-bridge), broker side only: comma-separated domains (each with its subdomains) or IPs the broker accepts even when the keyword guard would hold them. The extension still holds them until you turn them on in its review page, so it makes nothing sync on its own. Never lifts a denylisted category. |
| `BROWSER_RELAY_BROKER_LOG` | `<broker home>/broker.log` | The broker log (rotated once at startup past 1 MB). The launcher also writes its warnings there; it reads this from the process env only. |

The broker home is `%LOCALAPPDATA%\browser-mcp-relay\broker` on Windows, `~/Library/Application Support/browser-mcp-relay/broker` on macOS, and `$XDG_STATE_HOME/browser-mcp-relay/broker` (or `~/.local/state/…`) on Linux. It holds `broker.key`, `broker.log`, `profile/`, `work/` (the broker's working dir: relative output paths and project-scope scenarios land there) and `results/` (the full text of [results that were cut](#results-in-broker-mode), kept at least 24 hours), plus, with the [cookie bridge](#cookie-bridge), `cookie-bridge.log` and `cookie-bridge-<hash>.json`.

**Which settings apply in broker mode.** These work as before: `BROWSER_RELAY_BRAVE_PATH`, `BROWSER_RELAY_UPSTREAM_PATH`, `BROWSER_RELAY_PROXY_URL` (without credentials, see below), `BROWSER_RELAY_IGNORE_HTTPS_ERRORS`, `BROWSER_HEADLESS_ENABLE`, `BROWSER_LOAD_EXTENSIONS`, `BROWSER_RELAY_TOOLSETS` (the broker's starting set; each session then enables toolsets for itself), `BROWSER_RELAY_INSPECTOR_PORT` and `_BIND`, and `BROWSER_RELAY_CATALOG_REFRESH`. Legacy-only: `BROWSER_RELAY_POOL_DIR`, `BROWSER_RELAY_POOL_SLOT`, `BROWSER_MCP_ROLE` and `BROWSER_RELAY_SNAPSHOT_INDEXEDDB` (no pool), and `BROWSER_RELAY_VAULT_FILES` (not wired into the broker yet). TLS works as in legacy mode: certificates are verified unless `BROWSER_RELAY_IGNORE_HTTPS_ERRORS=true` or Brave actually runs through `BROWSER_RELAY_PROXY_URL` (so a debug proxy's MITM certificate works); the broker then turns the checks off after every Brave launch and logs it once.

The broker's settings are fixed when it starts, by whichever session starts it. A session whose browser settings differ is told so (on its stderr and in its first tool result, plus once in the broker log), and the broker keeps its own settings until it restarts: after `npm run broker:stop`, the next tool call starts a broker with the calling session's settings.

---

## Modes

### 🟣 Broker (default on Windows)

One broker per user and profile serves every session: one Brave, one persistent profile, one window per session tab. See [Broker lifecycle](#broker-lifecycle). Set `BROWSER_RELAY_MODE=legacy` for the two modes below.

### 🟢 Legacy standalone (legacy's default)

One Brave per relay process. Profile stored at `<repo>/.browser-data` (or a per-user cache dir if the repo is read-only — see `BROWSER_RELAY_POOL_DIR` above for platform-specific paths). No cookie snapshot. Each `npm run setup` produces this configuration. **Recommended for first-time users.**

### 🔵 Legacy pool (opt-in)

Set `BROWSER_RELAY_POOL_DIR` to an absolute path of a Brave user-data-dir to claim. Pool mode uses that single dir + the slot index from `BROWSER_RELAY_POOL_SLOT` for the launch banner + CDP port (`9333 + slot - 1`). **Useful when running multiple relay processes against pre-warmed Brave profiles** — each relay claims a different dir, each gets a deterministic port.

---

## Broker lifecycle

### Start and join

1. A session starts `node src/index.js`. In broker mode that is the shim, which connects to the broker's pipe right away, while the client is still starting.
2. **No pipe:** the shim spawns a detached launcher (`node src/shim.js --launch …`), which starts `src/broker/main.js` and exits. The broker therefore has no live parent, and a tree-kill of the session can't take it down. When the launcher is elevated, it starts the broker with the desktop shell's token (medium integrity, no window) and an exact allowlisted env: OS basics, `BROWSER_*` and upstream's catalog variables, never e.g. API tokens meant for Claude. If that fails, the broker starts elevated, and the warning goes to the broker log and to every session it serves.
3. **Single instance:** the pipe is the lock. A second broker's `listen` fails with `EADDRINUSE`, and it exits. Three shims racing a cold start leave exactly one broker (measured in `test/e2e-broker.test.js`).
4. **Handshake:** the shim sends a hello with a nonce, and the broker answers with `HMAC(broker key, nonce)`. Nothing of the session is sent before that check passes.
5. The broker serves `initialize` and `tools/list` from the cached catalog. Upstream is imported, and Brave launched, on the first `tools/call` (cold first call ≈ 2 s on a warm disk).

### Sessions, windows, tabs

- One MCP connection is one Claude session, and its subagents share it. The session's `main` tab is opened on its first page tool. `tabs_new` opens more, each in its own window, and returns a `tabId` that every page tool accepts. Only `tabs_new` creates tabs: an unknown `tabId` is an error.
- `tabs_list`, `tabs_select` and `tabs_close` see only the calling session's tabs. Cookies (`cookies_*`) are shared by design: there is one profile.
- A session's tabs close when it disconnects.

### Idle, crashes, restarts

| Event | What happens |
|---|---|
| No tool call for 20 min | Brave closes gracefully (cookies flushed). The next call relaunches it, and each tab's next result starts with a one-line *"This tab was reset because …"* notice. |
| No session for 10 min | The broker closes Brave gracefully and exits. The next session starts a new one. |
| Brave crashes or is killed | The broker sees the PID gone, drops every tab, and the next call relaunches Brave (measured ≈ 1.5 s) and answers with the reset notice. A hard kill can lose the last ~30 s of cookie changes; a graceful close loses nothing. |
| The broker dies | On Windows its Brave goes with it: Node keeps the processes it starts in a job object that is killed when the broker is (measured: Brave gone ≈ 30 ms after a hard kill of the broker). Should a Brave still be left on the broker profile, the next broker finds it by the profile's `lockfile` before launching, kills the processes whose `--user-data-dir` is exactly that profile (nothing else) and launches its own. A request that was in flight gets *"browser broker restarted; please retry the call"*. Each shim reconnects on its session's next message (not before, so a stopped broker stays stopped), restarting the broker if needed, and replays the session's `initialize`; the next call works (measured ≈ 4.5 s, including that retry). |
| Brave hung (process alive, about 45 s without answering CDP) | The supervisor kills it. Every tab gets a reset notice, and the next call relaunches Brave. |
| Event loop blocked ≥ 20 s | The watchdog stops the blocking code and the broker carries on. A call that still hasn't answered 2 minutes later gets an error. On Node 20/22, code frozen inside a timer or event callback still ends the broker at this point; the next tool call starts a fresh one. |
| Event loop still blocked at 60 s | The watchdog kills the broker, and the next tool call starts a fresh one. |
| Memory above 1 GB while idle | The broker restarts itself, but never under a session's open browser. |

**A graceful close** sends Brave `Browser.close` and waits up to 10 s for it to exit. Brave accepts at once (it closes its CDP pipe within ~6-55 ms) and then writes its cookies and settings, which took 6 s on a machine at 100% CPU. So once it has accepted, it gets up to 30 s in all before it is killed; one that ignores the close is killed at 10 s.

**Brave has no CDP port.** It runs with `--remote-debugging-pipe`: the broker talks to it over two pipes only it holds, and no Brave process listens on TCP (measured: 0 listening sockets on any of its processes). Upstream and the broker's own tools reach it through the broker's CDP proxy at `ws://127.0.0.1:<port>/<secret>/devtools/browser`, where `<secret>` is 256 random bits made at startup. The broker holds that port for its whole life, so a relaunched Brave sits behind the same URL. Without the exact secret path, the proxy refuses every request: all `/json/*` discovery (404), and any websocket upgrade with a wrong path, an `Origin` header (a web page) or a foreign `Host` (DNS rebinding) (403). While Brave is down it answers 503. Clients can't send `Browser.close`, `Browser.crash` or `Browser.crashGpuProcess` to the shared Brave. The old non-flat channel `Target.sendMessageToTarget` (which `emulate_device` uses to resume a tab's paused iframes and workers) works only on a session the client owns, and every message it wraps, however deep, must be JSON and not one of those three. The secret never leaves the broker: the log, `broker:status`, the relay Inspector and tool results show `<redacted>` in its place.

### Profile: seeded once, then Brave's own

On its first start, when the profile dir doesn't exist yet, the broker seeds it **once** from the legacy profile whose `Default/Network/Cookies` was written most recently: a pool slot, or, for a v0.3 standalone install, its `<repo>/.browser-data`. It skips profiles Brave runs on or a legacy relay holds. It copies `Default/` minus caches (`Cache`, `Code Cache`, `GPUCache`, `*ShaderCache`, `Dawn*Cache`, `Service Worker/CacheStorage` and `ScriptCache`, `*_crx_cache`) and old session tabs, plus `Local State` (the cookie key). The source is never modified. Brave's first launch waits for the copy, and the log names the source. Without a legacy profile that has cookies, the profile starts fresh: log in once in a session window (`browser_show` brings it forward), and the login sticks.

To pick the source yourself, or to see what would be copied:

```bash
npm run migrate-profile -- --dry-run                 # the slot the broker would pick, file count, size, skipped caches
npm run migrate-profile -- --from <profile dir>      # seed from that dir (refuses if the broker profile exists)
```

### Control and logs

```bash
npm run broker:status   # pid, uptime, pipe, profile, Brave up/pid, each session's tabs (tabId, state, URL), RSS, cookieBridge counts
npm run broker:stop     # close Brave gracefully and exit; it stays stopped until a session's next tool call starts a new one
```

Both authenticate with the broker key, the same way the shim does. `broker:stop` followed by any tool call is how to restart the broker, for example after changing its settings. The broker log is `<broker home>/broker.log`.

## Legacy mode: how the pool dance works

If you run multiple Cursor windows simultaneously, each spawns its own relay, each claims a pool slot, each launches its own Brave. Here's the full dance — useful for understanding what you're seeing in the Inspector and for debugging restart hangs.

### State per slot

Each pool dir has up to three pieces of state:

| File / process | Purpose |
|---|---|
| `<pool-dir>/.mcp-wrapper-lock` | Atomic lock file. JSON `{ pid, startedAt, host, relay: true }`. Created via `O_CREAT \| O_EXCL` (POSIX) or `wx` flag (Win). Mode `0o600` on POSIX so the file isn't world-readable. |
| `<pool-dir>/Default/...` | The actual Brave user-data — cookies, localStorage, history, etc. Read by every Brave attached to this dir. |
| Brave subtree | Main Brave process + 5–15 helper subprocesses (renderer / GPU / utility / crashpad), all with `--user-data-dir=<pool-dir>` in their command line. |

### Startup (no slot, no Brave)

A relay connects to its MCP client immediately and answers `tools/list` from the cached catalog — it claims no slot, copies no profile files, and spawns neither upstream nor Brave. An idle session costs one small Node process.

### Claim sequence (first tool call)

```
1. claimSlot() pass 1 — for each pool dir in order:
   a. mkdir -p <dir> (idempotent)
   b. Lock file present?
      - unparseable and older than 10 s → stale, unlink (younger = mid-write, leave it)
      - owner PID dead (signal-zero, no child process) → stale, unlink
      - owner PID alive → remember it, skip this dir
      (a lock is only unlinked if it still holds the content that was judged)
   c. fs.openSync(lockPath, "wx", 0o600) — atomic; EEXIST → skip
   d. Write the lock contents + fdatasync
   e. reapOrphansFor(dir) — kills Brave processes whose command line passes
      exactly this dir as --user-data-dir (whole-argument match: pool-1
      never matches pool-10)
2. Pass 2 (only if every dir looked taken): one batched start-time probe of
   the live lock PIDs. A PID whose process started after the lock's
   startedAt (+10 min slack for clock steps) was recycled → the lock is
   stale; reclaim that dir.
3. Still nothing free → the tool call fails with "pool exhausted"
4. Profile snapshot from the cookie source + vault load (pool mode). A
   failure here releases the claim; the next call starts over.
```

### Brave launch and recovery

```
1. ensureBrave(): pool.reapOrphansFor(dir) again (F1-16) — catches an
   orphan that appeared on this dir after the claim
2. launchBrave({ userDataDir: dir, port: 9333 + slot - 1, ... })
3. waitForCdpReady polls /json/version until 200 or timeout
4. attachAutofill listens on framenavigated for vault credentials
5. The upstream child is spawned on the first forwarded call, attached to
   this Brave over CDP
6. If Brave dies (context close / browser disconnect), the relay drops the
   bridge AND tears down the upstream child (upstream never reconnects on
   its own); the next tool call relaunches Brave and respawns upstream.
   An upstream crash alone is also respawned on the next call — it no
   longer exits the relay.
```

### Shutdown sequence

```
On SIGINT (exit 130) / SIGTERM (exit 143) / stdin EOF (exit 0):
  1. shutdownAsync() — memoized; the promise is visible before any step
     runs, so no new slot claim or Brave relaunch can start
  2. In PARALLEL, each capped at 1.5 s (the MCP SDK client gives a stdio
     server ~2 s between closing stdin and a hard kill on Windows):
     - closeBrave(bridge); on timeout, reapOrphansFor(slot dir) kills our
       Brave synchronously by user-data-dir
     - killProcessTree(upstream) — async taskkill /F /T on Windows
     - inspector close
  3. releasePool() LAST — the lock is never free while our Brave still
     holds the dir (a second Ctrl-C mid-shutdown still releases it via
     process.on("exit"); W0 clears dead/recycled locks anyway)

On Windows TerminateProcess (force-quit Cursor, blue screen, power loss):
  - Only process.on("exit") fires → shutdownSync() runs
  - closeBrave(bridge).catch(() => {}) is fire-and-forget — Playwright's
    context.close is async; the process exits before it resolves
  - Brave is reparented to System; the next relay's claimSlot reaps it
```

### Why you might see N+1 relays vs N Cursor windows

Cursor's bundled `cursor-browser-devtools-mcp-vscode-0.6.3-universal` extension runs its OWN MCP — separate process tree, separate user-data-dir (`.browser-data-mcp`, no `-pool-N` suffix). Distinguish:

| Process | Identifier in `Get-CimInstance Win32_Process` |
|---|---|
| **Your relay** | `node ...\browser-mcp-relay\src\index.js` — uses `.browser-data-mcp-pool-N` dirs |
| **Cursor's bundled MCP** | `node ...\.cursor\extensions\serkan-ozal.browser-devtools-mcp-vscode-...\node_modules\browser-devtools-mcp\dist\index.js --cursor-mcp-server` — uses `.browser-data-mcp` (no `-pool-` suffix) |

Both can be alive simultaneously. The relay's safety net (claim-time + pre-launch reap) only protects YOUR relay's pool dirs — Cursor's bundled MCP has its own lifecycle. If you only ever see Brave processes pinned to `.browser-data-mcp` (no `-pool-`), that's the bundled extension, not your relay.

---

## Optional features

### Proxy whitelist

Set `BROWSER_RELAY_PROXY_URL=http://127.0.0.1:8888` (or wherever your debug proxy listens) to route the relay's Brave traffic through a proxy you control. The relay passes it to Brave as a real `--proxy-server` (Playwright's `proxy` launch option — works on Windows too, where Chromium ignores `HTTP_PROXY`), keeps `localhost` / `127.0.0.1` / `[::1]` direct, and ignores TLS errors **while the proxy is in use** so the debug proxy's MITM certificate works. That lets you inspect the relay's HTTP traffic via Charles, mitmproxy, powhttp, etc. without affecting your main browser. Your system proxy stays untouched — only this launched Brave opts in. Credentials in the URL (`http://user:pass@host:port`) are handed to Playwright separately, never put on Brave's command line or in the log.

The proxy is checked **once, when Brave launches** (TCP connect, 1.5 s cap):

- **Local proxy (`127.x`, `localhost`, `::1`) not listening** → one warning, and Brave launches **direct** (no proxy, TLS verified). Start the proxy, then restart the relay to route through it — a proxy started later isn't picked up.
- **Remote proxy unreachable** → the proxy is **kept** and a loud warning is logged; requests fail until it's up. The relay never silently goes direct, which would expose your real IP.

`BROWSER_RELAY_IGNORE_HTTPS_ERRORS=true` (env or `local-config.json`) makes Brave accept any certificate even without a relay proxy — for a corporate MITM proxy configured at the OS level. Without it (the default), certificates are verified whenever no relay proxy is in use.

> ⚠️ **Security:** Only point this at HTTP proxies you control on **localhost**. The relay accepts any TLS cert while a proxy is in use (so MITM debug proxies "just work"), which means a hostile or compromised remote proxy can transparently MITM all of the relay's traffic — including pages you're authenticated to. If you don't fully control the proxy, leave this unset.

### Credential vault + autofill

The relay can auto-fill login forms when a saved credential matches the current page's origin. **Off by default.** To enable:

1. Export passwords from Brave (or Chrome): `brave://settings/passwords` → "Export passwords" → save as CSV
2. Set `BROWSER_RELAY_VAULT_FILES=/absolute/path/to/passwords.csv` as an env var **or** the same key in `local-config.json` (path-delimiter-separated for multiple paths — `;` on Win, `:` on POSIX)
3. Restart the relay

The vault loads CSVs at startup, indexes them by origin, and fills the first empty username + password fields on each main-frame `framenavigated`. **It does not auto-submit** — you click submit yourself.

A credential fills only when the page is **`https://`** and its **scheme + host + port exactly match** the URL the credential was saved under — the rule Chromium uses before filling without a click. There is **no subdomain fallback**: an entry saved for `https://www.example.com` doesn't fill on `https://signin.example.com`, and `https://mycompany.atlassian.net` never fills on `https://evil.atlassian.net`. `http://` pages never autofill. The injected script re-checks the page's origin before every fill attempt. It runs in the page's main world (Playwright `frame.evaluate`), not an isolated one — the origin match is the protection.

> ⚠️ **Security:** Passwords stay in memory only — never logged, never re-written. But anyone with read access to your relay process's memory could read them. Only point this at CSVs you trust. The vault is most useful when scraping authed sites that block Playwright's password manager (e.g. Brave 127+'s App-Bound Encryption).

### Cookie bridge

Copies your everyday **Chrome**'s cookies into the broker's Brave, live and one way (Chrome → Brave), so agents are signed in where you are. Windows and broker mode only; nothing happens until you install it and approve it in Chrome. Chrome's own cookie file can't be copied: Chrome holds it open while it runs, and app-bound encryption means only `chrome.exe` can decrypt it. So the bridge reads cookies through the `chrome.cookies` API in a small extension.

```
Chrome extension ──native messaging──▶ host.js ──broker pipe (HMAC challenge)──▶ broker ──CDP (secret URL)──▶ Brave
 (policy + review page)                (no port)                                 (policy again, snapshot)
```

- **Extension** (`extensions/cookie-bridge/`, MV3, ID `dfcccancdkogdddemhecnffcjllbjmba` from the fixed public `key` in its manifest). After you click **Approve & start sync** on its review page, it sends a full sync, then every `cookies.onChanged` change (additions, rotations, deletions). The review page lists what will sync and what's held back. You can turn any domain on or off there: a re-allowed denylisted or held domain's cookies carry `userOverride: true`. A held domain seen later waits there (badge on the icon). The extension never logs a cookie, and its stored state holds settings, domain names and counts, never values.
- **Native host** (`src/cookie-bridge/host.js`, started by Chrome through the `.bat` launcher). It opens no TCP port. It checks the broker pipe every ~5 s and never starts a broker. It authenticates with `broker.key`: the broker must prove the key first, then the host answers a fresh challenge (a squatter on the pipe gets no MAC, and a recorded answer can't be replayed). On every (re)connect it asks the extension for a full resync. Changes made while no broker runs are dropped; the next resync covers them. It logs to `<broker home>/cookie-bridge.log`, never a value.
- **Broker** (`src/cookie-bridge/importer.js`). It classifies every cookie again (its own domain and, for a partitioned cookie, the top-level site; a partition key without a valid top-level site is refused), refuses denylisted and held domains unless they carry `userOverride: true`, and keeps an in-memory snapshot. The snapshot is applied with `Storage.setCookies` over the broker's own CDP connection, the CdpProxy's secret URL handed over in-process (Brave has no debugging port). That happens at once while Brave runs, and again on every Brave launch, before any tool uses it: session cookies don't survive a restart. A deletion in Chrome expires the cookie in Brave, now or at the next launch. A deletion Brave may not have written to disk yet (Chromium writes cookies every ~30 s, so a crash can lose one) is applied again at the relaunch. Only one bridge connects at a time, and a bridge connection never keeps an idle broker alive. Errors sent back to the host go through the same redaction as the broker log.

**The policy** (`extensions/cookie-bridge/policy.js`, shared by the extension and the broker) ships generic categories only, no personal domains:

| Decision | What |
|---|---|
| deny | Built-in categories, on the domain and every subdomain: banking, credit unions, payments, crypto, brokerages, insurance and payroll; email and identity (Google incl. country domains, Microsoft, Apple, Proton, Yahoo, SSO providers); password managers; government, tax and health (incl. `*.gov`, `*.mil`, `gov.<cc>`-style suffixes, patient portals); cloud, hosting and registrar consoles. |
| hold | An unknown domain with a sensitive keyword (`bank`, `credit`, `financ`, `invest`, `wallet`, `pay`, `tax`, `health`, `insur`, `loan`, `crypto`, `password`, `mail`, …, or a label ending in `cu`), an IP address, a single-label host, or `.local` / `.lan` / `.internal` / `.home.arpa`. |
| allow | Everything else. |

A deny on a subdomain (`aws.amazon.com`) stops cookies set on that host, not cookies set on its parent (`.amazon.com`).

**Your always-allow list.** It's the review page: a domain you turn on there syncs, and stays on (the toggle is per domain, not its subdomains). The broker accepts it because the cookies carry `userOverride: true`. `BROWSER_RELAY_BRIDGE_ALLOW` is a broker-side list only: comma-separated domains (each covers its subdomains) or IP addresses, in the MCP server's `env` or `local-config.json`. For those, the broker skips the keyword hold on cookies that arrive without `userOverride`. The shipped extension never sends a held domain's cookies without that flag, so the setting makes nothing sync on its own. It never lifts a denylisted category, and never lets a Chrome deletion reach a cookie the bridge didn't put into Brave. Entries it can't use (a single label such as `com`, a malformed name) and denylisted entries are named once in the broker log. `broker:status` shows the list it read.

**Install / uninstall.** `npm run bridge:install` writes, under `%LOCALAPPDATA%\browser-mcp-relay\cookie-bridge\`, the host manifest `com.browser_mcp_relay.cookie_bridge.json` (its `allowed_origins` is exactly the extension's ID) and `cookie-bridge-host.bat` (this Node + `host.js`). It registers `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.browser_mcp_relay.cookie_bridge`, then prints the load-unpacked steps: `chrome://extensions` → Developer mode → **Load unpacked** → `<repo>/extensions/cookie-bridge` → check the ID → the options page → **Approve & start sync**. Re-run it after moving the repo or switching Node installs. `npm run bridge:uninstall` removes the registry key and exactly those two files; remove the extension in `chrome://extensions` yourself.

**Stop, undo, purge.** What each control does to the cookies already in Brave:

| You do | Syncing | Bridge cookies already in Brave |
|---|---|---|
| **Pause sync** (review page) | stops; un-pausing resyncs | stay |
| Turn a domain **off** (review page) | stops for that domain | that domain's are removed (while a broker runs) |
| Remove the extension, or clear its data (resets the approval; there is no separate "revoke approval" button) | stops | stay |
| `npm run bridge:uninstall` | Chrome can no longer start the host | stay |
| `npm run bridge:uninstall -- --purge` | as above | **all removed** |

`--purge` sends the running broker the authenticated control request `bridge-purge`. The broker refuses it while the extension is connected (it would sync everything straight back): remove or pause the extension first. Otherwise it expires, in Brave, every cookie the bridge has put there, including ones Chrome already deleted and ones from an earlier broker's state, launching Brave if needed. A Brave started just for the purge is closed again, which writes the deletions to disk; a running one writes them within ~30 s. The broker deletes its `cookie-bridge-<hash>.json`, and the script then deletes `cookie-bridge.log`. With no broker running it deletes nothing (that state file is what a purge needs): make any browser tool call, then run it again.

**Elevated broker.** A broker running elevated (`BROWSER_RELAY_BROKER_DEELEVATE=off`, or de-elevation failed) owns a pipe that the Chrome-started host can't open (EPERM). The host says so in `cookie-bridge.log` and the review page shows the fix: `npm run broker:stop`, then start your session again without `DEELEVATE=off`; `broker.log` says why de-elevation failed. The pipe's access isn't widened for it. `bridge:uninstall -- --purge` then has to run from an elevated terminal.

**Status and files.** `npm run broker:status` → `cookieBridge`: `bridges` (0 or 1), `cookies` and `domains` in the snapshot, `managed` (cookies the bridge put into Brave), `pendingDeletes` (deletions not sent to Brave yet), `lastSyncAt`, `allow`. These are counts only, never values. In the broker home: `cookie-bridge.log` (the host) and `cookie-bridge-<hash of the profile>.json`. That file holds the identities of the bridge-managed cookies and of the deletions not applied yet or not yet on Brave's disk (name, domain, path, flags; never a value; written atomically, user-private), so a full resync after a broker restart still deletes what Chrome no longer has. The broker's own lines in `broker.log` start with `cookie bridge:`.

**Values and tools.** `cookies_export` returns a cookie the bridge has put into Brave (one in that persisted set, or put there during this broker's life) with its name, domain, path and flags, and value `"[bridge-managed]"`, inline and in `outputPath` files (plus a `bridgeManaged` count). `cookies_import` skips that placeholder, so a masked export can't overwrite the real cookie. **This is not a sandbox:** pages run in the same Brave, so `execute`, `document.cookie` and page scripts read any non-HttpOnly cookie, and requests carry all of them.

**Risks you accept.** Installing the bridge means accepting these:
- Brave stores the synced cookies with DPAPI only (no App-Bound Encryption like Chrome's), so any process running as you can decrypt them from the broker profile on disk.
- Any process running as you can drive the broker (see *Pipe access is browser access* below), or rewrite the native host's `.bat` launcher or its HKCU registry key and so receive what the extension sends.
- Page scripts and `execute` can read synced values (non-HttpOnly cookies).
- Parent-domain cookies (e.g. `.amazon.com`) sync even where a subdomain is denied (`pay.amazon.com`, `aws.amazon.com`).
- Powerful but allowed domains (code hosting, package registries, AI accounts) sync unless you untick them on the review page.

**Limits.** Cookies only (no localStorage, sessionStorage or IndexedDB: a site that keeps its login token there still needs a login in Brave). Google sign-ins may not transfer (device-bound sessions), and Google accounts are denied anyway. One way: a login made in Brave never goes back to Chrome. One Chrome profile at a time. Chrome only: the host is registered for Google Chrome, not Edge or Brave.

---

## Stealth model

`stealth_apply` is an opt-in tool that injects anti-detection JavaScript patches into every page load of the calling session, never another session's pages. In legacy (per-session pool) mode that is the whole browser context, so pages opened later are covered too; in shared-broker mode it is each of your open tabs (call it again after `tabs_new`; popups a tab opens are not patched). **Off by default** — call the tool once per session to enable. The relay's intent is to be honest about what stealth covers and where the limits are, since pretending to defeat detection you don't is worse than not trying.

### Tier 1+2 — what's covered (v0.3.5)

**Tier 1** (v0.3.4):

| Patch | What it defeats |
|---|---|
| `navigator.webdriver = undefined` | Trivial `if (navigator.webdriver)` checks |
| `navigator.plugins` faked | Bot detection that flags empty plugins arrays |
| `navigator.languages` override | Mismatched-language flagging |
| `navigator.permissions.query` notifications fix | The `Notification.permission === 'denied'` headless tell |
| `navigator.userAgentData` replaced only when it contradicts the UA | Sec-CH-UA-* JS-side fingerprinting; same generator as `emulate_device`'s HTTP client hints; Brave's native object is kept when no UA override is active |
| `navigator.platform` replaced only when it contradicts the UA | A Mac / Android UA reporting `Win32`: a UA override set without CDP's `platform` (`emulate_device` sets it). Values are Chromium's reduced ones (`Win32`, `MacIntel`, `Linux x86_64`, `Linux armv81`, `iPhone` / `iPad`); a matching native value is kept. Not reachable in workers (see below) |
| `toString()` defense on patched getters | `Object.getOwnPropertyDescriptor(navigator, 'webdriver').get.toString()` returns native-looking output |
| AudioBuffer `getChannelData` / `copyFromChannel` stabilization | Audio-fingerprint hash detection on PerimeterX et al.; one seed per relay process, so every tab of the browser matches (< 1e-7), applied once per channel buffer, never cumulative or random per-call |

**Tier 2** (v0.3.5 — added 2026-05-10):

| Patch | What it defeats |
|---|---|
| **HTTP-side `Sec-CH-UA-*` headers via `userAgentMetadata`** | The Tier-1 JS-side `userAgentData` paired with HTTP-side `Sec-CH-UA-*` mismatch detection. `emulate_device` passes a synthesized `userAgentMetadata` (plus the matching `platform`) to CDP's `Network.setUserAgentOverride`. The brand list is Chromium's own: the GREASE brand, its version and the brand order are seeded by the major exactly as `components/embedder_support/user_agent_utils.cc` does (Chrome 131 → `"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"`), with `"Google Chrome"` for a Chrome UA (other Chromium browsers such as Edge / Opera get the unbranded Chromium list, never a wrong brand). A reduced UA (`Chrome/131.0.0.0`) gets a real stable build in `fullVersionList` / `uaFullVersion` / `Sec-CH-UA-Full-Version-List` (`131.0.6778.264`; table from chromiumdash, majors 100-157, later majors extrapolated). `fullVersion` and `formFactors` are always sent, since Chromium otherwise reports the host browser's own (Brave's `147.0.0.0`, `Desktop` on an Android UA). The override also reaches the tab's **cross-origin iframes and dedicated workers**: the page session auto-attaches to them (paused until overridden), since Chromium applies overrides per DevTools target. |
| **`window.chrome` runtime expansion** | Probes for `chrome.loadTimes()` / `chrome.csi()` / `chrome.app` namespace. Real Chrome ships all three; Tier 1's bare `runtime: {}` was a tell. Now populates plausible-shape stubs. |
| **Full permissions overrides** | Probes for `geolocation` / `clipboard-read` / `clipboard-write` / `camera` / `microphone` / `midi` / `push` / etc. Tier 1 only covered notifications; Tier 2 extends to the canonical 17 permission types with realistic states. |
| **WebGL renderer + vendor override** | `getParameter(UNMASKED_VENDOR_WEBGL)` / `getParameter(UNMASKED_RENDERER_WEBGL)` returning Playwright signature strings. UA-aware GPU strings on both `WebGLRenderingContext` and `WebGL2RenderingContext`. |

This covers trivial bot checks + the bottom ~85% of common fingerprint surface. **Verified by executing the injected script** in a fake-Chromium vm realm (`test/own-tools/stealth-apply.test.js`), client hints against real Chrome headers for several majors (`test/own-tools/client-hints.test.js`), CDP traffic incl. child targets (`test/own-tools/emulate-device.test.js`), and a live check in Brave 147 (2026-11-03: top page, cross-origin iframe, workers, HTTP headers).

### What it does NOT cover

The relay is honest about these limits — pretending otherwise misleads callers planning around what they think they have.

| Limit | Why | Workaround |
|---|---|---|
| **TLS / HTTP/2 fingerprint (JA3 / JA4)** | Server-side detection runs before any JS executes. Playwright's chromium has a recognizable TLS handshake. | Route through a TLS-mimicking proxy (`BROWSER_RELAY_PROXY_URL` + a tool like `tlspoof` or a real-Brave-attach pattern). |
| **`Function.prototype.toString` deep checks** | Sophisticated detectors examine the toString chain itself. Tier 1's getter-level toString defense doesn't reach this. | Tier 3 (deferred — see BACKLOG): rebrowser-patches at the chromium-binary level. |
| **`event.isTrusted` detection (press-and-hold, CAPTCHAs)** | Synthetic events from CDP fundamentally have `isTrusted=false`. This is by browser design — there's no JS-level fix. | Don't try to auto-solve press-and-hold CAPTCHAs; route the user through them manually. |
| **Behavioral fingerprinting** (mouse paths, typing rhythm, dwell time) | Uniform Bezier-zero clicks + uniform 0ms typing are non-human. | Tier 2.5 (deferred — see BACKLOG): `humanlike_click` + `humanlike_type` tools. Has an explicit ship gate (capture the detection signal first; design the humanizer to match the target's tolerance window). |
| **Where `emulate_device`'s UA override can't reach** | (1) **Service and shared workers** keep the browser's real UA, brands and platform: they are shared by every tab of an origin (other sessions' tabs too), and a service worker's `navigator.userAgent` ignores CDP overrides anyway (live check), so they are excluded from the auto-attach. (2) **`navigator.platform` inside any worker** (dedicated too) is always the host OS: Blink's `WorkerNavigator` has no override hook (`navigator_base.cc`), and `stealth_apply` can't patch workers. (3) **Popups** the tab opens are new tabs: call `emulate_device` on them. (4) In Brave, **`navigator.brave`** still exists (`isBrave()` → true) under an emulated Chrome UA. (5) Brand lists are exact for **Google Chrome 110+**; Chrome ≤ 109 used an earlier GREASE scheme, and an **Edge / Opera** UA gets Chromium's unbranded list (no `"Microsoft Edge"` / `"Opera"` brand, whose own full versions aren't known here). | Fingerprinters that compare a worker's `navigator.platform` (or a service worker's UA) with the page's will see the host OS: emulate a UA of the host's own OS when that matters. |

### Hard targets

For sites with sophisticated detection (Akamai, DataDome, advanced PerimeterX deployments), `stealth_apply` is **insufficient** — it's a starting point, not a finish line. Real wins for hard targets are:

- **Real-Brave-attach** (Tier 3, deferred — see BACKLOG): connect to a Brave instance the user is already running interactively, never spawn one. Eliminates the entire "Playwright launched it" fingerprint surface.
- **Residential proxies** (Bright Data, IPRoyal): TLS handshake from a residential IP gets a much higher trust score than data-center IPs. Set `BROWSER_RELAY_PROXY_URL`.
- **Warm session reuse** (`cookies_export` / `cookies_import` + the credential vault): a session with N days of authentic browsing history scores higher than a fresh login.

For the full deferred-work catalog (Tiers 2/3 + anti-patterns NOT to implement), see [`BACKLOG.md`](./BACKLOG.md).

---

## Inspector

A small web dashboard for peeking at the relay's runtime state — pool slot status (claimed / idle / orphan), cookie-source freshness, vault entry counts, tool counts, uptime, plus a per-slot **Inspector page** with live MCP-traffic streaming. **Off by default**, no auth, read-only.

![Inspector — Pool overview](./screenshots/01-pool-overview.png)

### Two modes

#### Standalone (no live traffic)

Start the Inspector separately. It still serves Pool / Tools / Activity / Settings / per-slot pages, but the **Activity feed on `/slot/N` will be empty** — there's no relay process to subscribe to. When the relay runs in broker mode (the Windows default), it reports mode `broker` and probes no legacy pool; for the broker's sessions and live traffic, let the broker host the Inspector (below), or run `npm run broker:status`.

```bash
npm run inspector
# Inspector running at http://127.0.0.1:9090
```

#### In-process (full live traffic)

Set `BROWSER_RELAY_INSPECTOR_PORT` in your MCP-client config (e.g. `~/.claude.json`) so the relay boots the Inspector inline. The Inspector then subscribes to the relay's traffic emitter and streams every `tools/call` request + response over a WebSocket to connected Inspector tabs.

```jsonc
// ~/.claude.json (excerpt)
{
  "mcpServers": {
    "browser-mcp-relay": {
      "command": "node",
      "args": ["<absolute-path-to-repo>/src/index.js"],
      "env": {
        "BROWSER_RELAY_INSPECTOR_PORT": "9091"
      }
    }
  }
}
```

After the next MCP connect, open `http://localhost:9091/slot/1` to see the per-slot Inspector page. The Activity feed populates in real time as your AI client makes tool calls.

#### Hosted by the broker (broker mode)

With `BROWSER_RELAY_INSPECTOR_PORT` set, the **broker** hosts the one Inspector. Legacy relays each raced for the port. The Activity feed shows every session's calls, upstream tools included, and each event carries a `conn` field naming its session. The home page gains a **Broker** section (Brave up/pid, sessions, each tab and its URL), and `GET /api/broker` returns the same JSON as `npm run broker:status`. `/api/status` reports mode `broker` and runs none of the legacy pool probes. The Host/Origin gates and the redaction rules below apply unchanged.

### Pages

| | |
|---|---|
| **Pool overview** (`/`) — slot grid (claimed / idle / orphan), cookie-source freshness card, vault summary. Orphan slots get a **Reap** button that clears the stale lock + kills any leftover Brave processes holding that user-data-dir. | ![Pool overview](./screenshots/01-pool-overview.png) |
| **Slot detail** (`/slot/N`) — per-slot live activity feed (request → response cards, last 100), click any event to see request JSON + response + timing in the Detail card. Empty in standalone mode; live in in-process mode. | ![Slot detail](./screenshots/02-slot-detail.png) |
| **Tools catalog** (`/tools`) — all 72 tools (21 first-party + 51 forwarded), filter + per-tool detail | ![Tools catalog](./screenshots/03-tools-catalog.png) |
| **Activity history** (`/activity`) — cross-slot ring buffer of the last ~200 MCP tool calls, with filter pills (All / Requests / Responses / Errors) and time-range picker (5m / 1h / 24h). Empty in standalone mode. | ![Activity history](./screenshots/04-activity-history.png) |
| **Settings** (`/settings`) — resolved config, env-var booleans, paste-ready `local-config.json` snippet | ![Settings](./screenshots/06-settings.png) |

**Host + Origin gate (DNS rebinding).** Every HTTP request and WebSocket upgrade must carry a `Host` of `localhost`, `127.0.0.1`, `[::1]` (or the IP the connection arrived on, for an explicit `BROWSER_RELAY_INSPECTOR_BIND`) **on the inspector's own port**; anything else gets 403. So a port-remapped SSH tunnel (`-L 9999:127.0.0.1:9091`), a LAN hostname (`http://mydesktop:9091`) or a reverse proxy is rejected — reach it by `localhost` / IP on the same port. A browser `Origin` must be the inspector's own origin (`http://localhost:<port>` or `http://127.0.0.1:<port>`); another local port is a different origin. The only mutating endpoint (`POST /api/slots/N/reap`) requires that Origin to be present — curl-style clients may call the read-only GETs without one. Reap decides from a fresh status, answers 409 if the slot's lock changed while it was being checked, removes the lock only if it is still the one judged stale, and reports `lockCleared` in its response.

> ⚠️ **Security:** The inspector binds to **`127.0.0.1` only by default** and has **no authentication**. Only the local user can reach it. Anyone with shell access to your machine — or any process running locally — can read pool state, vault file paths, and tool counts. The WebSocket streams every `tools/call` request + response; in-process mode means *anyone with localhost access can see what your AI is doing in real time*. **Treat the inspector port as if it had your bearer tokens on it** — `tools/call` arguments routinely contain auth tokens, URLs of authed sessions, the cookies your AI is sending, etc. Don't expose it via SSH tunnels, ngrok, or `BROWSER_RELAY_INSPECTOR_BIND=0.0.0.0` unless you know what you're doing. **Kill the server when you're done** (Ctrl+C). In the traffic feed, every string value in the args and results of `cookies_export`, `cookies_import`, `storage_*`, `form_fill` and `interaction_fill` is replaced with `[redacted]`, and for every tool the values of `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` and `Proxy-Authorization` (any case, any depth, including inside JSON result text) are redacted; everything else is recorded as-is. Defenses in place: localhost-only bind, Host allowlist on every request (DNS rebinding), exact own-origin check on the WS upgrade and on every mutating POST, `X-Frame-Options: DENY` + `frame-ancestors 'none'` (clickjacking gate), a CSP with no `'unsafe-inline'`, `Cache-Control: no-store` on every API response and the activity export, path-traversal hard stop, 64 KB WS frame cap + 1 MB back-pressure cap. The standalone inspector keeps only the vault's counts in memory, never the passwords.

#### Module API changes (2026-11)

For code that imports `src/inspector-server.js` (or `scripts/inspector.js`) directly:

- `buildStatus(seams)` and `buildSlotDetail(n, seams[, status])` are now **async** — they return Promises (the process probes no longer block the event loop). `await` them.
- `/api/status` and `/api/slot/:n` share one status build per 5 s (`statusCacheMs` option on `startInspector` / `createInspector`; `0` disables).
- `startInspector({ quietPortInUse: true })` rejects with `EADDRINUSE` without printing the port-in-use hint, for callers that retry the bind.
- `allowedOrigins`, when given, now matches origins exactly (it used to accept any port of a listed host).

---

## Platform support

| Platform | Status | Notes |
|---|---|---|
| 🪟 **Windows** | ✅ First-class | Tested daily. PowerShell + registry probes for Brave detection (HKLM + HKCU, all 4 channels). |
| 🍎 **macOS** | 🟡 Best-effort | Code paths are written portably (`process-shim.js`, `detect-browser.js`) but not yet maintainer-verified. Bug reports welcome. |
| 🐧 **Linux** | 🟡 Best-effort | Honors `XDG_CONFIG_HOME` for Brave profile detection + `XDG_CACHE_HOME` for the standalone-mode fallback dir. POSIX `kill -0` for liveness. Not yet maintainer-verified end-to-end. |

---

## Troubleshooting

### Broker mode

- **What is it doing?** Run `npm run broker:status`, or read the broker log (`%LOCALAPPDATA%\browser-mcp-relay\broker\broker.log` on Windows). Shim errors go to the session's MCP stderr, prefixed `[mcp-relay shim]`.
- **Restart it** (new settings, a wedged Brave): run `npm run broker:stop`. The next tool call in any session starts a fresh broker.
- **"the broker key file … is missing while a broker runs"**: `broker.key` was deleted while a broker runs. The broker writes it back within ~30 s: retry the call then. The session never makes a key of its own while a broker answers. If it persists, run `npm run broker:stop` (close sessions first) and retry.
- **"browser broker restarted; please retry the call"**: the broker died while that call was in flight. Retry it: the retry reconnects, starting a new broker if needed.
- **"This tab was reset because …"**: Brave was relaunched (crash, idle close, broker restart). The tab's URL, console and network buffers, element refs, stubs and emulation are gone. Navigate again.
- **"the pipe's owner failed authentication … the broker key changed or is missing"**: something other than your broker holds the pipe name: close it, or set `BROWSER_RELAY_BROKER_PIPE`. (Rarely, `broker.key` was replaced by hand while a broker runs: the broker restores only a *missing* key, so end that broker process and retry.)
- **"… is still locked by another browser … not launching on it"**: a browser the broker could not end holds its profile (an elevated one under a de-elevated broker, or one whose executable isn't the configured Brave). Close it, then retry the call. A Brave left by an earlier broker is ended automatically.
- **"the browser broker runs elevated"** warning: de-elevation failed (no desktop shell, or UAC off), so the broker and its Brave run as administrator. A process at medium integrity can then reach an elevated Brave through the pipe.
- **A session's settings are ignored**: the broker keeps the settings it started with (the session is told so). Run `npm run broker:stop`; the next tool call, from any session, starts a broker with that session's settings.
- **Logins missing after the switch**: the seed picks the freshest idle legacy profile (pool slot or `<repo>/.browser-data`), and the log says which. Log in once in a session window, or stop the broker, move `profile/` away and run `npm run migrate-profile -- --from <slot>`.
- **Navigation takes 5 s or more on one site**: the page keeps a request open (a streaming `fetch`, a long poll), so the wait for a quiet network runs to its limit. Pass `waitForTimeoutMs` (say `1000`) to the navigation tool to wait less, or `waitForNavigation: false` to skip the wait. An EventSource stream does not count.
- **Back to the old model**: set `BROWSER_RELAY_MODE=legacy` and restart the MCP client.

### "Brave not found"

Auto-detect couldn't find Brave at any of the standard locations. Either:

- Install Brave from [brave.com](https://brave.com/), OR
- Set `BROWSER_RELAY_BRAVE_PATH=/absolute/path/to/brave` and re-run `npm run setup`

### "Cannot find module 'browser-devtools-mcp'"

The upstream MCP isn't installed. Run:

```bash
npm install
```

…or, if you want a custom upstream build, set `BROWSER_RELAY_UPSTREAM_PATH=/absolute/path/to/dist/index.js` and re-run setup.

### `o11y_get-http-requests` rejects responses with "ping" / "prefetch" resourceType

**Fixed in v0.3.6.** Upstream `browser-devtools-mcp`'s bundled `HttpResourceType` enum is missing `ping` / `prefetch` / `signedexchange` / `cspviolationreport` / `preflight` / `fedcm`. Playwright's `request.resourceType()` does return those (Amazon affiliate links fire `<a ping="...">` beacons → `resourceType="ping"` → upstream's zod schema rejects). The relay now patches the upstream bundle file at startup via `scripts/patch-bdmcp-bundle.js` (idempotent, on-disk, survives ESM/CJS module systems). Look for a stderr line `[mcp-relay] patched browser-devtools-mcp HttpResourceType enum...` on first relay startup after `npm install`. Filed as F1-20 — see `docs/BACKLOG.md` for the upstream-issue tracking.

### Smoke test fails: "Brave not found"

`npm run smoke` resolves Brave the way the relay does (`BROWSER_RELAY_BRAVE_PATH` in the env or `local-config.json`, then auto-detect) before it checks anything else, because no tool call can work without it. Install Brave or set the path (see ["Brave not found"](#brave-not-found)). `npm run smoke -- --without-brave` checks the tool catalog alone (CI does this: its runner has no Brave).

### Smoke test fails: "tool count too low"

The relay started but returned fewer than 60 tools (smoke and setup run it with `BROWSER_RELAY_TOOLSETS=all`, so hidden toolsets count; on Windows they check broker mode, on a private pipe and an empty temp profile whose broker exits 2 s later, and legacy mode). Check the relay's stderr output for upstream catalog-fetch errors (`[mcp-relay] upstream catalog fetch failed`), or the smoke script's stderr tail.

### "Tools appear in `tools/list` but `tools/call` hangs"

Brave didn't launch successfully. Common causes:

- **Another Brave instance is holding the user-data-dir lock** (orphan from a previous session). Since v0.3.2, the relay reaps these automatically before launch. If you're on an older version, check for `brave.exe` processes pinned to your relay's user-data-dir and `taskkill /F /T /PID <them>`.
- Missing display server (Linux headless without xvfb) — try `BROWSER_HEADLESS_ENABLE=true`.
- Insufficient permissions.

### Cursor or Claude Code hangs on close + reopen

Most cases: orphaned Brave from a previous session was squatting on a pool slot's user-data-dir. v0.3.2's `F1-16` pre-launch reap fixes this — the new relay reaps any squatter before launch. If you're seeing this on v0.3.2+, please file an issue with the output of:

```powershell
Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object {
  $_.CommandLine -match 'browser-data-mcp'
} | Select-Object ProcessId, ParentProcessId, CommandLine
```

### Multiple relays from one machine

Each relay process needs its own user-data-dir. Use pool mode (`BROWSER_RELAY_POOL_DIR=/path/to/dir`, different per process) or run each relay in its own checkout.

---

## Diagnostic recipes

Drop-in PowerShell snippets for poking around when something feels off. All of these are **read-only** — they observe state without modifying anything. None require the Inspector to be running.

### Find orphan Brave subtrees pinned to a relay pool dir

The classic "Cursor restart hangs" symptom. Run this in PowerShell BEFORE reopening Cursor — anything returned is an orphan that the next relay's pre-launch reap (F1-16) should clean up automatically on v0.3.2+. Older relays will hang on launch.

```powershell
Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | Where-Object {
  $_.CommandLine -match 'browser-data-mcp' -and -not (Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue)
} | Select-Object ProcessId, ParentProcessId, @{
  N='Dir'; E={ if($_.CommandLine -match '--user-data-dir=("?)([^"]+?)\1'){$Matches[2]} }
}
```

Empty output = no orphans. Anything else = list of `(PID, dead-parent-PID, dir)` triples. Manual cleanup if needed: `taskkill /F /T /PID <orphan-main-pid>`.

### Inventory all Brave processes by pool dir

When you want to see which slots are actually in use vs. just lock-claimed.

```powershell
Get-CimInstance Win32_Process -Filter "Name='brave.exe'" | ForEach-Object {
  $dir = if ($_.CommandLine -match '--user-data-dir=("?)([^"]+?)\1') { $Matches[2] } else { '<unknown>' }
  $type = if ($_.CommandLine -match '--type=(\w+)') { $Matches[1] } else { 'main' }
  [PSCustomObject]@{ PID = $_.ProcessId; PPID = $_.ParentProcessId; Type = $type; Dir = $dir }
} | Group-Object Dir | Select-Object Name, Count | Sort-Object Name
```

### Show the live state of every pool slot lock

Which pool slots have valid locks vs. stale ones. The relay self-heals stale locks at next claim, but it's useful to see them yourself.

```powershell
1..16 | ForEach-Object {
  $lock = "$env:USERPROFILE\.browser-data-mcp-pool-$_\.mcp-wrapper-lock"
  if (Test-Path $lock) {
    $meta = Get-Content $lock | ConvertFrom-Json
    $alive = $null -ne (Get-Process -Id $meta.pid -ErrorAction SilentlyContinue)
    [PSCustomObject]@{ Slot = $_; PID = $meta.pid; Alive = $alive; Held = $meta.startedAt }
  }
} | Format-Table -AutoSize
```

### Check whether a relay is actually responding

If `tools/call` is hanging, this confirms whether the relay's CDP endpoint is reachable. Replace the port with the slot's CDP port (`9333 + slot - 1`). Legacy mode only: in broker mode Brave has no CDP port, so use `npm run broker:status`.

```powershell
Invoke-WebRequest -Uri "http://127.0.0.1:9333/json/version" -UseBasicParsing | Select-Object StatusCode, @{
  N='Browser'; E={ ($_.Content | ConvertFrom-Json).Browser }
}
```

200 + a Brave version → CDP is healthy; relay is responsive. Connection refused → Brave isn't running. Hangs → Brave is wedged (renderer crash, etc.) — `taskkill /F /T /PID <main-brave-pid>` and restart Cursor.

### Confirm which Cursor MCP is which

When you see 12+ MCP-related node processes alive simultaneously and want to distinguish "your relay" from "Cursor's bundled extension":

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -match 'browser-mcp-relay|browser-devtools-mcp'
} | Select-Object ProcessId, ParentProcessId, @{
  N='Identity'; E={
    if ($_.CommandLine -match 'browser-mcp-relay') { 'YOUR relay' }
    elseif ($_.CommandLine -match 'cursor-mcp-server') { 'Cursor bundled' }
    else { '<unknown>' }
  }
} | Format-Table -AutoSize
```

### Tail the relay's stderr from the inspector log file

The relay writes diagnostic stderr lines (autofill events, CDP errors, shutdown traces). Cursor swallows them; the inspector's in-process mode captures them in memory but doesn't persist them. For long-running diagnosis, redirect the relay's stderr to a file by tweaking your MCP-client config:

```jsonc
// ~/.claude.json (excerpt) — adds stderr file capture
{
  "mcpServers": {
    "browser-mcp-relay": {
      "command": "node",
      "args": ["<absolute-path>/src/index.js"],
      "stderr": "<absolute-path>/relay-stderr.log"
    }
  }
}
```

Then `Get-Content <absolute-path>/relay-stderr.log -Tail 50 -Wait` to follow it live.

---

## Limitations

- 📜 Upstream `browser-devtools-mcp` is licensed **Elastic-2.0** — permissive but **not OSI-approved-open-source**. See [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) for the full breakdown.
- 🦁 Requires **Brave** installed locally. Other Chromium browsers may work via `BROWSER_RELAY_BRAVE_PATH` but are untested.
- 🍪 **Standalone mode does not snapshot cookies** from another profile — first run hits login walls. Cookie snapshot is a pool-mode feature.
- 🧍 **Legacy mode: one Brave per relay process.** To run multiple Brave sessions in parallel there, run multiple relays (each on its own slot / profile dir).
- 📦 **One message from your MCP client is capped at 10 MB** (the MCP SDK's stdio limit). A bigger one fails the call: in broker mode the session reconnects on the next call, in legacy mode the relay exits.
- 🔐 **`npm audit` still lists advisories that have no compatible fix** (none critical). Don't run `npm audit fix --force`: it would downgrade `browser-devtools-mcp` to 0.1.1.
  - `lighthouse@11`'s tree: `@puppeteer/browsers` (`extract-zip`, `basic-ftp` via `proxy-agent`), `chromium-bidi`'s `zod@3`, `@sentry/node`'s `cookie`. Not reached: `lighthouse_audit` attaches to the relay's Brave over CDP, so Lighthouse never downloads a browser, speaks WebDriver BiDi or reports to Sentry. The fix is `lighthouse@13`, which needs Node ≥ 22.19 (see BACKLOG).
  - `browser-devtools-mcp@0.6.12`'s own `zod@3`. It validates tool arguments, which come only from your MCP client (which already drives the browser and runs JavaScript through `execute`), and in legacy mode upstream's own results, which upstream builds to match its schemas.
  - `browser-devtools-mcp@0.6.12`'s `sharp@0.34`, used only by `figma_compare-page-with-design` (off unless `FIGMA_ACCESS_TOKEN` is set), on Brave screenshots and Figma renders.
  - `@hono/node-server@1.19`'s `serveStatic` advisory. `npm audit` offers a fix, but it is 2.x only and `browser-devtools-mcp` needs 1.x. Nothing here serves static files through it.

### Broker mode: known risks

- **Shared blast radius.** One broker serves every session. A hung tool, a leak or a crash in it affects all sessions at once, where a legacy relay affected one. Mitigations: per-call timeouts on the data-out tools, `uncaughtException` is logged and the broker keeps serving, a watchdog for a blocked event loop, a recycle on high idle memory, and the next call reconnects within seconds.
- **`execute` runs in-process.** Upstream's `execute` (and `scenario-run`) evaluate agent-written JavaScript inside the broker process, shared by every session. A runaway script blocks all of them until the watchdog stops it (20 s), or restarts the broker if it can't.
- **Pipe access is browser access.** Any process of yours that can open the pipe drives the logged-in Brave. `broker.key` only stops a fake broker from impersonating the real one; it does not keep any client out. That is why the broker de-elevates; when it can't, it says so in the log and in every session.
- **CDP port: broker mode: none; legacy: unauthenticated port.** In broker mode Brave has no DevTools port (`--remote-debugging-pipe`), and CDP is served only behind the broker's secret URL (see *Idle, crashes, restarts*). A process that can read the broker's memory can find the secret, but a process running as you can likely read the profile on disk anyway (not measured). Legacy mode keeps an unauthenticated port: while its Brave is up, any local process can connect to the fixed `9333 + slot - 1` port (127.0.0.1 only), drive the logged-in Brave and read its cookies.
- **Cookie bridge: what it puts in Brave, every session can use.** With the [cookie bridge](#cookie-bridge) installed, your Chrome logins for every non-denylisted domain you approved are in the shared Brave, so any session (and any page script, `execute` included) can act as you there. Tool results hide those values (`cookies_export`), but nothing stops a page script from reading non-HttpOnly cookies. Anything holding `broker.key` can also push cookies into Brave over the pipe, and a cookie flagged `userOverride: true` passes the broker's policy. That adds little: `broker.key` already gives a session, which drives Brave fully.
- **Tab scoping is a convenience, not a security boundary.** `tabId` keeps parallel agents from stepping on each other's tabs, but all sessions share one browser: `execute` runs in the broker process, and any page's `page.context()` reaches every tab.
- **Upstream internals.** The broker imports `browser-devtools-mcp`'s bundled chunks by their export names (pinned to 0.6.12, asserted by `test/upstream-contract.test.js`). An upstream bump can break broker mode while legacy mode still works.
- **Not in broker mode yet:** credential-vault autofill (`BROWSER_RELAY_VAULT_FILES`) and authenticated proxies (a `user:pass@` proxy URL is used without its credentials, with a warning). Use legacy mode if you need these.
- **macOS and Linux:** the broker's unix-socket code (a socket in a private 0700 dir) ships but is **untested**: it has never been run. Legacy stays the default there; set `BROWSER_RELAY_MODE=broker` only to try it out.
