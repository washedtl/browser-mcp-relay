# browser-mcp-relay

A Model Context Protocol (MCP) server that wraps `browser-devtools-mcp` and adds 16 first-party browser tools alongside it — without forking the upstream.

## What it is

`browser-mcp-relay` is an MCP server that spawns [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp) as a child process, forwards its 41 tools verbatim, and adds 16 of its own. Both layers attach to the *same* Brave browser instance over CDP, so the merged tools/list looks (to the MCP client) like one bigger MCP. The 16 own-tools are:

- `lighthouse_audit` — run a Lighthouse audit against a URL
- `memory_take-heap-snapshot` — capture a V8 .heapsnapshot file
- `emulate_device` — apply UA / viewport / network throttling
- `tabs_list` — list open tabs by index + URL
- `tabs_new` — open a new tab, optionally navigating
- `tabs_select` — bring a tab to the front by index
- `tabs_close` — close a tab by index
- `dialog_handle` — accept/dismiss the next JS dialog
- `file_upload` — set files on a file input (no OS picker)
- `form_fill` — fill many form fields in one call
- `capture_xhr` — record XHR/fetch responses during a window
- `cookies_export` — export the active context's cookies as JSON
- `cookies_import` — import cookies into the active context
- `stealth_apply` — apply anti-detection patches to future pages
- `download_capture` — wait for a download and save it to disk
- `extract_structured` — pull structured data via a CSS-selector schema

## Why

- **Own the surface for new tools.** Adding a tool is one new file in `src/own-tools/` plus a one-line registry entry — no upstream fork, no patch maintenance.
- **Multi-session safe via lazy backend.** The relay only launches Brave on the first `tools/call`, so an MCP client that connects but never calls a tool stays at ~50 MB total.
- **Privacy.** Your browser session, cookies, and local-config never leave the machine. The relay does not phone home.

## Quick start

```bash
git clone https://github.com/<your-fork>/browser-mcp-relay.git
cd browser-mcp-relay
npm install
npm run setup
```

The interactive setup wizard auto-detects your Brave install, writes a `local-config.json` (gitignored), runs a smoke test, and prints a paste-ready MCP registration snippet. Paste that snippet into the `mcpServers` section of your MCP client's config (e.g. `~/.claude.json` for Claude Code; `mcp.json` for Cursor) and restart your client. The whole thing takes under two minutes on a clean machine.

To re-verify the relay anytime: `npm run smoke`.

## Tool catalog

| Tool | Purpose | Notable arg | Example use case |
| --- | --- | --- | --- |
| `lighthouse_audit` | Lighthouse audit against a URL | `formFactor: "desktop"\|"mobile"` | Performance regression check on a deploy |
| `memory_take-heap-snapshot` | V8 heap snapshot via CDP | `outputPath` | Memory-leak hunt on a long-running SPA |
| `emulate_device` | UA / viewport / network throttling | `network.downloadKbps` | Verify a layout on Slow 3G |
| `tabs_list` | List open tabs | — | "Where did I leave that page?" |
| `tabs_new` | Open a new tab | `url` | Spawn a side-panel comparison |
| `tabs_select` | Bring a tab to front | `index` | Switch to a specific tab before interacting |
| `tabs_close` | Close a tab | `index` | Tear down workflow tabs |
| `dialog_handle` | Auto-handle the next JS dialog | `action: "accept"\|"dismiss"` | Click a button that triggers `confirm()` |
| `file_upload` | Set files on a file input | `files: [absPath]` | Upload a file without an OS picker |
| `form_fill` | Fill many fields in one round-trip | `fields: [{selector,value}]` | Bulk-fill a long signup form |
| `capture_xhr` | Record XHR/fetch responses | `urlFilter` (regex) | Reverse-engineer a site API while logged in |
| `cookies_export` | Export cookies as JSON | `urls` (filter) | Save an authed session for later |
| `cookies_import` | Import cookies into the context | `cookies` | Restore an authed session |
| `stealth_apply` | Anti-detection patches | `languages` | Defeat trivial bot checks |
| `download_capture` | Wait for a download, save to disk | `clickSelector` | Trigger + save a CSV export |
| `extract_structured` | CSS-selector-based extraction | `schema` | Scrape an authed page that firecrawl can't reach |

Source for each lives at `src/own-tools/<tool-name>.js`.

## Three worked examples

### `lighthouse_audit`

```jsonc
// MCP tools/call request
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "lighthouse_audit",
    "arguments": { "url": "https://example.com", "formFactor": "desktop" }
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
      "text": "{\n  \"url\": \"https://example.com\",\n  \"formFactor\": \"desktop\",\n  \"scores\": {\n    \"performance\": 0.99,\n    \"accessibility\": 0.92,\n    \"best-practices\": 1.0,\n    \"seo\": 0.91\n  }\n}"
    }]
  }
}
```

### `cookies_export`

```jsonc
// Capture only cookies that apply to amazon.com
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "tools/call",
  "params": {
    "name": "cookies_export",
    "arguments": { "urls": ["https://www.amazon.com/"] }
  }
}
```

```jsonc
// Response (truncated)
{
  "result": {
    "content": [{
      "type": "text",
      "text": "[\n  { \"name\": \"session-id\", \"value\": \"<...>\", \"domain\": \".amazon.com\", \"path\": \"/\", \"httpOnly\": true, \"secure\": true, \"sameSite\": \"Lax\" },\n  { \"name\": \"ubid-main\", \"value\": \"<...>\", \"domain\": \".amazon.com\", ... }\n]"
    }]
  }
}
```

### `extract_structured`

```jsonc
// Scrape product attributes from a page already loaded in the browser
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
      "text": "{\n  \"title\": \"Example Product\",\n  \"price\": \"$19.99\",\n  \"images\": [\"https://.../1.jpg\", \"https://.../2.jpg\"]\n}"
    }]
  }
}
```

## Architecture

```
            ┌──────────────────────┐  stdio JSON-RPC
MCP client →│   browser-mcp-relay  │←────────────┐
(Claude     │      (this repo)     │             │
 Code,      └──────────┬───────────┘             │
 Cursor)               │                         │
                       │ stdio JSON-RPC          │
                       ▼                         │
            ┌──────────────────────┐             │
            │ browser-devtools-mcp │ ─── CDP ───┐│
            │   (upstream child)   │            ▼▼
            └──────────────────────┘    ┌──────────────┐
                                        │  Brave (one  │
            relay's own-tools ── CDP ──→│  per relay   │
            (Playwright direct)         │  process)    │
                                        └──────────────┘
```

- The relay receives MCP calls on stdin.
- `tools/list` is answered by merging the upstream's catalog with the 16 own-tool definitions.
- `tools/call` either forwards to the upstream child (for the 41 forwarded tools) or runs an own-tool handler directly. Both paths attach to the same Brave instance: the upstream attaches over CDP via `BROWSER_CDP_CONNECT_URL`; own-tools use Playwright's `chromium.connectOverCDP` against the same port.
- One Brave per relay process. Brave is launched lazily on the first `tools/call`, not at startup.

## Configuration

All paths the relay needs are auto-detected by default. Override them with these env vars or by editing `local-config.json` (gitignored, written by `npm run setup`).

| Env var | Default | Purpose |
| --- | --- | --- |
| `BROWSER_RELAY_BRAVE_PATH` | auto-detect | Absolute path to `brave` / `brave.exe`. Auto-detect probes standard install locations on Win/Mac/Linux + the Windows registry. |
| `BROWSER_RELAY_UPSTREAM_PATH` | `require.resolve("browser-devtools-mcp/dist/index.js")` | Path to the upstream `browser-devtools-mcp` entry. Override to point at a custom build. |
| `BROWSER_RELAY_BRAVE_PROFILE_DIR` | unset | Optional profile dir hint used by detection / cookie snapshot. |
| `BROWSER_RELAY_POOL_DIR` | unset (standalone) | Opt-in: absolute path to a Brave user-data-dir to claim. Standalone mode uses `<repo>/.browser-data`. |
| `BROWSER_RELAY_POOL_SLOT` | unset | Cosmetic slot index for the launch banner; also sets the CDP port (`9333 + slot - 1`) when using pool mode. |
| `BROWSER_HEADLESS_ENABLE` | `false` | Set `true` to launch Brave headless. |
| `BROWSER_LOAD_EXTENSIONS` | unset | Path to an unpacked Chrome extension to load. |
| `BROWSER_MCP_ROLE` | unset | Role-based slot filter (only meaningful with the optional pool wrapper). |

**Precedence:** environment variable wins over `local-config.json`, which wins over auto-detect, which wins over reasonable hard-coded defaults.

## Modes

- **Standalone (default).** One Brave per relay process, profile stored at `<repo>/.browser-data`. No cookie snapshot. Each `npm run setup` produces this configuration.
- **Pool (opt-in).** Set `BROWSER_RELAY_POOL_DIR` to a profile dir managed elsewhere. If a `wrap-browser-devtools-mcp.js` file is present two directories above this repo, its richer config (multi-slot pool, cookie snapshot from a dedicated source profile, slot roles) is reused. Otherwise pool mode behaves like standalone with a custom dir.

## Platform support

- **Windows** — first-class. Tested daily.
- **macOS / Linux** — best-effort. The cross-platform process / browser-detection / cookie-path layers (`src/process-shim.js`, `src/detect-browser.js`) are written to be portable but have not yet been exercised end-to-end by the maintainers. Bug reports welcome.

## Limitations

- Upstream `browser-devtools-mcp` is licensed Elastic-2.0 — permissive but **not OSI-approved-open-source**. See `THIRD_PARTY_NOTICES.md`.
- Requires Brave installed locally. Other Chromium browsers may work via `BROWSER_RELAY_BRAVE_PATH` but are untested.
- Standalone mode does not snapshot cookies from another profile — first run hits login walls. Cookie snapshot is a pool-mode feature.
- One Brave instance per relay process. To run multiple Brave sessions in parallel, run multiple relays (each on its own slot / profile dir).

## Contributing

Bug reports and PRs welcome. See `CONTRIBUTING.md` for the orientation tour, the "add an own-tool in 5 minutes" walkthrough, code-style notes, and the test convention.

## License

MIT — see `LICENSE`.

## Acknowledgements

Built on top of `browser-devtools-mcp` by Serkan Ozal. Direct-dep license details and a supply-chain note live in `THIRD_PARTY_NOTICES.md`.
