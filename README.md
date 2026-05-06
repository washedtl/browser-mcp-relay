<div align="center">

# 🌉 browser-mcp-relay

**A Model Context Protocol (MCP) server that wraps [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp) and adds 16 first-party browser tools — without forking the upstream.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#)
[![Tests](https://img.shields.io/badge/tests-139%20passing-brightgreen.svg)](#)
[![Tools](https://img.shields.io/badge/tools-67%20%2851%20forwarded%20%2B%2016%20own%29-blue.svg)](#tool-catalog)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-informational.svg)](#platform-support)
[![MCP](https://img.shields.io/badge/MCP-stdio-orange.svg)](https://modelcontextprotocol.io/)

```
MCP client (Claude Code, Cursor) ── stdio ──▶ relay ──▶ upstream child + own-tools ──▶ Brave (1 per relay)
```

</div>

---

## 📑 Contents

- [Overview](#-overview)
- [Highlights](#-highlights)
- [Quick start](#-quick-start)
- [Tool catalog](#%EF%B8%8F-tool-catalog)
- [Worked examples](#-worked-examples)
- [Architecture](#%EF%B8%8F-architecture)
- [Configuration](#%EF%B8%8F-configuration)
- [Modes](#-modes)
- [Platform support](#%EF%B8%8F-platform-support)
- [Troubleshooting](#-troubleshooting)
- [Limitations](#%EF%B8%8F-limitations)
- [Contributing](#-contributing)
- [License](#-license)
- [Credits](#-credits)

---

## 🌐 Overview

`browser-mcp-relay` spawns [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp) as a child process, forwards its **41 upstream tools** verbatim over JSON-RPC, and adds **16 first-party tools** of its own. Both layers attach to the *same* Brave browser instance over CDP, so the merged `tools/list` looks (to the MCP client) like one bigger MCP — **67 tools total**.

You add a tool by dropping a file in `src/own-tools/`. No upstream fork, no patch maintenance, no contribution-back blocker.

---

## ✨ Highlights

| | |
|---|---|
| 🧰 **Bigger toolbox** | 16 first-party tools beyond what upstream ships — Lighthouse, heap snapshots, device emulation, multi-tab, cookie export/import, structured extraction, and more. |
| 🪶 **Lazy backend** | Brave is launched on the *first* `tools/call`, not at startup. Idle MCP connections cost ~50 MB. |
| 🛡️ **Privacy-first** | Cookies, browsing data, and `local-config.json` never leave the machine. The relay does not phone home. |
| 🏠 **Own the surface** | Adding a tool is one new file + one registry entry. Friends fork freely; no upstream gatekeeping. |
| 🌍 **Cross-platform** | Auto-detects Brave + profile dir on Windows / macOS / Linux. Process management uses platform-native primitives. |
| 🤝 **Multi-session safe** | One Brave per relay process; opt-in pool mode for power users juggling multiple sessions. |

---

## 🚀 Quick start

```bash
git clone https://github.com/washedtl/browser-mcp-relay.git
cd browser-mcp-relay
npm install
npm run setup
```

The interactive setup wizard:

1. 🔍 Auto-detects your Brave install + profile dir + the upstream MCP
2. 📝 Writes `local-config.json` (gitignored — never committed)
3. 🧪 Runs a smoke test that spawns the relay + counts tools (expects ≥50)
4. 📋 Prints a paste-ready MCP registration snippet

Paste the printed snippet into the `mcpServers` section of your MCP client's config (e.g. `~/.claude.json` for Claude Code; `mcp.json` for Cursor) and restart the client. **The whole thing takes under two minutes on a clean machine.**

> 💡 The wizard **never** modifies your client's config file directly — it only prints a snippet. You stay in control of where it lands.

To re-verify the relay anytime:

```bash
npm run smoke
# → ✓ Relay healthy. 67 tools available (≥50). 2.4s
```

---

## 🛠️ Tool catalog

The 16 first-party tools, grouped by category:

### 🔬 Performance & diagnostics

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `lighthouse_audit` | Lighthouse audit against a URL | `formFactor: "desktop"\|"mobile"` | Performance regression check on a deploy |
| `memory_take-heap-snapshot` | V8 heap snapshot via CDP | `outputPath` | Memory-leak hunt on a long-running SPA |

### 📱 Device emulation

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `emulate_device` | UA / viewport / network throttling | `network.downloadKbps` | Verify a layout on Slow 3G |

### 📑 Multi-tab control

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `tabs_list` | List open tabs by index + URL | — | "Where did I leave that page?" |
| `tabs_new` | Open a new tab | `url` | Spawn a side-panel comparison |
| `tabs_select` | Bring a tab to front | `index` | Switch to a specific tab before interacting |
| `tabs_close` | Close a tab by index | `index` | Tear down workflow tabs |

### 📤 Forms, dialogs, files

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `dialog_handle` | Auto-handle the next JS dialog | `action: "accept"\|"dismiss"` | Click a button that triggers `confirm()` |
| `file_upload` | Set files on a file input | `files: [absPath]` | Upload a file without an OS picker |
| `form_fill` | Fill many fields in one round-trip | `fields: [{selector, value}]` | Bulk-fill a long signup form |

### 🌐 Network capture

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `capture_xhr` | Record XHR/fetch responses | `urlFilter` (regex) | Reverse-engineer a site API while logged in |

### 🍪 Session & cookies

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `cookies_export` | Export cookies as JSON | `urls` (filter) | Save an authed session for later |
| `cookies_import` | Import cookies into the context | `cookies` | Restore an authed session |
| `stealth_apply` | Anti-detection patches | `languages` | Defeat trivial bot checks |

### 💾 Downloads

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `download_capture` | Wait for a download, save to disk | `clickSelector` | Trigger + save a CSV export |

### 🔍 Data extraction

| Tool | Purpose | Notable arg | Example use case |
|---|---|---|---|
| `extract_structured` | CSS-selector-based extraction | `schema` | Scrape an authed page that firecrawl can't reach |

> Source for each tool lives at [`src/own-tools/<tool-name>.js`](./src/own-tools/). All 41 upstream tools are forwarded verbatim — see [serkan-ozal/browser-devtools-mcp](https://github.com/serkan-ozal/browser-devtools-mcp) for that catalog.

---

## 💡 Worked examples

Each example shows the raw JSON-RPC `tools/call` request your MCP client would send. Most clients (Claude Code, Cursor) wrap this in a higher-level "use tool X" UX — these payloads are useful when you're debugging or building your own client.

### 🔬 `lighthouse_audit` — measure performance after a deploy

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
      "text": "{\n  \"url\": \"https://example.com\",\n  \"formFactor\": \"desktop\",\n  \"scores\": {\n    \"performance\": 0.99,\n    \"accessibility\": 0.92,\n    \"best-practices\": 1.0,\n    \"seo\": 0.91\n  }\n}"
    }]
  }
}
```

> Use it in CI to fail a deploy when Lighthouse drops below a threshold, or interactively when you want a one-line "is this page slow?" answer.

### 🍪 `cookies_export` — save an authed session

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
      "text": "[\n  { \"name\": \"session-id\", \"value\": \"<...>\", \"domain\": \".amazon.com\", \"path\": \"/\", \"httpOnly\": true, \"secure\": true, \"sameSite\": \"Lax\" },\n  { \"name\": \"ubid-main\", \"value\": \"<...>\", \"domain\": \".amazon.com\", ... }\n]"
    }]
  }
}
```

> Pair with `cookies_import` to restore the session later — useful for testing multi-step authed flows without re-logging in each run.

### 🔍 `extract_structured` — scrape an authed page

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
      "text": "{\n  \"title\": \"Example Product\",\n  \"price\": \"$19.99\",\n  \"images\": [\"https://.../1.jpg\", \"https://.../2.jpg\"]\n}"
    }]
  }
}
```

> Use this when a page is behind a login or a captcha that public scrapers can't bypass — your relay's Brave is already authenticated.

---

## 🏗️ Architecture

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
                                       (this repo, 16 tools)
```

**How it works:**

- 📥 The relay receives MCP messages on stdin from your client.
- 📋 `tools/list` → merges the upstream's catalog with the 16 own-tool definitions and returns one combined list.
- ⚙️ `tools/call` → either forwards to the upstream child (for the 41 forwarded tools) or runs an own-tool handler directly.
- 🔌 Both paths attach to the same Brave instance: the upstream uses `BROWSER_CDP_CONNECT_URL`, own-tools use Playwright's `chromium.connectOverCDP` against the same port.
- 🪶 One Brave per relay process. Brave is launched **lazily on the first `tools/call`**, not at startup.

---

## ⚙️ Configuration

All paths the relay needs are auto-detected by default. Override them with these env vars or by editing `local-config.json` (gitignored, written by `npm run setup`).

| Env var | Default | Purpose |
|---|---|---|
| `BROWSER_RELAY_BRAVE_PATH` | auto-detect | Absolute path to `brave` / `brave.exe`. Auto-detect probes standard install locations on Win/Mac/Linux + the Windows registry. |
| `BROWSER_RELAY_UPSTREAM_PATH` | `require.resolve("browser-devtools-mcp/dist/index.js")` | Path to the upstream `browser-devtools-mcp` entry. Override to point at a custom build. |
| `BROWSER_RELAY_BRAVE_PROFILE_DIR` | unset | Optional profile dir hint used by detection / cookie snapshot. |
| `BROWSER_RELAY_POOL_DIR` | unset (standalone) | Opt-in: absolute path to a Brave user-data-dir to claim. Standalone mode uses `<repo>/.browser-data`. |
| `BROWSER_RELAY_POOL_SLOT` | unset | Cosmetic slot index for the launch banner; also sets the CDP port (`9333 + slot - 1`) when using pool mode. |
| `BROWSER_HEADLESS_ENABLE` | `false` | Set `true` to launch Brave headless. |
| `BROWSER_LOAD_EXTENSIONS` | unset | Path to an unpacked Chrome extension to load. |
| `BROWSER_MCP_ROLE` | unset | Role-based slot filter (only meaningful with the optional pool wrapper). |

**Precedence:** environment variable ▸ `local-config.json` ▸ auto-detect ▸ reasonable hard-coded defaults.

---

## 🔀 Modes

### 🟢 Standalone (default)

One Brave per relay process, profile stored at `<repo>/.browser-data`. No cookie snapshot. Each `npm run setup` produces this configuration. **Recommended for first-time users.**

### 🔵 Pool (opt-in)

Set `BROWSER_RELAY_POOL_DIR` to a profile dir managed elsewhere. If a `wrap-browser-devtools-mcp.js` file is present two directories above this repo, its richer config (multi-slot pool, cookie snapshot from a dedicated source profile, slot roles) is reused. Otherwise pool mode behaves like standalone with a custom dir. **Useful when running multiple relay processes against pre-warmed Brave profiles.**

---

## 🖥️ Platform support

| Platform | Status | Notes |
|---|---|---|
| 🪟 **Windows** | ✅ First-class | Tested daily. PowerShell + registry probes for Brave detection. |
| 🍎 **macOS** | 🟡 Best-effort | Code paths are written portably (`process-shim.js`, `detect-browser.js`) but not yet maintainer-verified. Bug reports welcome. |
| 🐧 **Linux** | 🟡 Best-effort | Honors `XDG_CONFIG_HOME` for Brave profile detection. POSIX `kill -0` for liveness. Not yet maintainer-verified end-to-end. |

---

## 🔧 Troubleshooting

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

### Smoke test fails: "tool count too low"

The relay started but returned fewer than 50 tools. Check the relay's stderr output for upstream-spawn errors, or the smoke script's stderr tail.

### "Tools appear in `tools/list` but `tools/call` hangs"

Brave didn't launch successfully. Common causes: another Brave instance holding the user-data-dir lock, missing display server (Linux headless without xvfb), or insufficient permissions. Try `BROWSER_HEADLESS_ENABLE=true`.

### Multiple relays from one machine

Each relay process needs its own user-data-dir. Use pool mode (`BROWSER_RELAY_POOL_DIR=/path/to/dir`, different per process) or run each relay in its own checkout.

---

## ⚠️ Limitations

- 📜 Upstream `browser-devtools-mcp` is licensed **Elastic-2.0** — permissive but **not OSI-approved-open-source**. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for the full breakdown.
- 🦁 Requires **Brave** installed locally. Other Chromium browsers may work via `BROWSER_RELAY_BRAVE_PATH` but are untested.
- 🍪 **Standalone mode does not snapshot cookies** from another profile — first run hits login walls. Cookie snapshot is a pool-mode feature.
- 🧍 **One Brave per relay process.** To run multiple Brave sessions in parallel, run multiple relays (each on its own slot / profile dir).

---

## 🤝 Contributing

Bug reports and PRs welcome! See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for:

- 🗺️ Quick orientation tour of the codebase
- ⚡ The "add an own-tool in 5 minutes" walkthrough
- 🎨 Code-style notes (CommonJS, no TypeScript, JSDoc for public APIs)
- 🧪 Test conventions and the test-seam pattern

---

## 📄 License

MIT — see [`LICENSE`](./LICENSE).

Direct-dependency licenses, including the Elastic-2.0 callout for the upstream `browser-devtools-mcp`, are documented in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

---

## 🙏 Credits

Built on top of [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp) by **Serkan Ozal**. The upstream provides the 41 forwarded tools that make this relay useful out of the box.

The MCP protocol itself is defined by Anthropic — see [modelcontextprotocol.io](https://modelcontextprotocol.io/).

---

<div align="center">

**Found a bug? [Open an issue](https://github.com/washedtl/browser-mcp-relay/issues).**
**Want to add a tool? [Read CONTRIBUTING.md](./CONTRIBUTING.md).**

</div>
