<div align="center">

<img src="docs/hero.png" alt="browser-mcp-relay Inspector showing the Tools catalog with lighthouse_audit selected" width="100%" />

# browser-mcp-relay

**Give your AI a real browser.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](#)
[![Tests](https://img.shields.io/badge/tests-1465%20passing-brightgreen.svg)](#)
[![Tools](https://img.shields.io/badge/tools-72%20%2851%20forwarded%20%2B%2021%20own%29-blue.svg)](docs/REFERENCE.md#tool-catalog)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-informational.svg)](docs/REFERENCE.md#platform-support)

</div>

---

## What this is

When you ask Claude or Cursor to *"check what's on this page"*, *"fill out this form"*, or *"run Lighthouse on production"* — your AI doesn't actually have a browser. It needs a tool that drives one.

`browser-mcp-relay` is that tool. It launches a real Brave browser on your computer, listens for instructions from your AI via the [Model Context Protocol](https://modelcontextprotocol.io/), and turns them into actual browser actions. Your AI gets **72 commands** ("tools") it can call; the relay does the work behind the scenes.

## What you can ask your AI to do

| | |
|---|---|
| 📸 **See pages** | Screenshots, full HTML, visible text, PDF export, ARIA tree |
| 🖱️ **Click around** | Buttons, links, dropdowns, drag-and-drop, hover, scroll, type |
| 📝 **Fill forms** | Single fields or 20 at once. File uploads with no OS picker. |
| 🔬 **Measure performance** | Lighthouse audits, Web Vitals, V8 heap snapshots |
| 📊 **Capture traffic** | Console logs, HTTP requests, XHR/fetch responses |
| 🍪 **Reuse your sessions** | Saved cookies + optional autofill, so logged-in pages just work |
| 💾 **Save outputs** | Capture downloads, record video, save heap snapshots |
| 🔍 **Extract data** | CSS-selector schema → JSON, even from authed pages |

For the full 72-tool catalog, see [`docs/REFERENCE.md`](docs/REFERENCE.md).

**22 specialist tools are hidden by default** to keep your AI's context lean: `debug` (JS debugger probes), `react` (component ↔ DOM lookup), `scenario` (saved multi-step scripts) and `trace` (OpenTelemetry trace ids). When a task would clearly benefit from one, your AI asks you first (clients with MCP elicitation also show you an approve/decline prompt), then turns it on with the `toolsets` tool. To keep a group on, set `BROWSER_RELAY_TOOLSETS=debug,react` (or `all`) in the relay's env or `local-config.json`. Details: [`docs/REFERENCE.md#toolsets`](docs/REFERENCE.md#toolsets).

## Quick start

```bash
git clone https://github.com/washedtl/browser-mcp-relay.git
cd browser-mcp-relay
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install   # PowerShell: $env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1; npm install
npm run setup
```

The relay drives your installed Brave. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` stops a dependency from downloading ~1.2 GB of Playwright browsers (Chromium, Firefox, WebKit) that the relay never uses. Without it, `npm install` takes much longer, and fails where that download is blocked.

The setup wizard:

1. Auto-detects your Brave install + profile dir
2. Asks for the mode: broker (the Windows default) or legacy standalone / pool
3. Writes a gitignored `local-config.json`
4. Runs a smoke test (spawns the relay with every toolset on, expects ≥60 tools; on Windows in broker mode, on a private pipe, and in legacy mode)
5. Prints a paste-ready snippet for your MCP client config

Paste the printed snippet into your MCP client's config file (`~/.claude.json` for Claude Code; `mcp.json` for Cursor) and restart the client. **Under two minutes on a clean machine.**

> 💡 The wizard never modifies your client's config directly — it only prints a snippet. You stay in control of where it lands.

To re-verify anytime:

```bash
npm run smoke
# → [smoke] Brave: C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe
# → ✓ Relay healthy. 72 tools available (≥60). [broker, 3.5s]
# → ✓ Relay healthy. 72 tools available (≥60). [legacy, 2.2s]
```

## The Inspector

Optional read-only web UI at `localhost:9090` showing the relay's live state (legacy pool slots, or the broker's sessions and tabs), the tool catalog, and a real-time feed of every `tools/call` your AI makes.

```bash
npm run inspector
```

In broker mode, set `BROWSER_RELAY_INSPECTOR_PORT` and the broker hosts the one Inspector for every session: live traffic from all of them, plus a **Broker** section with sessions, tabs and Brave.

| Page | What you see |
|---|---|
| **Pool overview** | Slot grid (claimed / idle / orphan), cookie freshness, vault summary |
| **Tools catalog** | All 72 tools with filter + per-tool detail |
| **Slot detail** | Live request/response feed with timing, args, and full payloads |
| **Activity history** | Cross-slot ring buffer of the last ~200 tool calls |
| **Settings** | Resolved config + paste-ready `local-config.json` snippet |

> ⚠️ **Treat the inspector port like it has your bearer tokens on it.** It binds to localhost only by default and has no auth. Tool-call payloads routinely contain auth tokens and authed-session URLs. Don't expose it via SSH tunnels or `0.0.0.0` unless you know what you're doing.

For inspector details (in-process vs standalone modes, security defenses, screenshot tour), see [`docs/REFERENCE.md#inspector`](docs/REFERENCE.md#inspector).

## How it works (in 30 seconds)

```
   Claude session 1 ──stdio──▶ shim ─┐
   Claude session 2 ──stdio──▶ shim ─┼─ named pipe ─▶ broker ──▶ ONE Brave, ONE profile
   Claude session N ──stdio──▶ shim ─┘                (51 forwarded + 21 own tools, one window per session)
```

**Broker mode is the default on Windows.** In 5 lines:

1. Each MCP session runs `node src/index.js`, which is now a ~23 MB shim.
2. The first shim starts a shared **broker** in the background, de-elevated when the session is elevated. The others join it over a per-user named pipe.
3. The broker runs one Brave on one persistent profile. Logins persist, and every session shares them live.
4. Each session gets its own window. Parallel subagents call `tabs_new` and pass the returned `tabId` so they don't share a tab.
5. If Brave crashes, the next call relaunches it. If the broker dies, the next call starts a new one. Both happen without restarting the client. Brave closes after 20 idle minutes, and the broker exits 10 minutes after its last session.

**Upgrading from v0.3:** nothing to change in your MCP config. On first start, the broker profile is seeded once from your freshest legacy profile (a pool slot, or v0.3's standalone `.browser-data`), so your logins carry over.

**Recovery:**
- `npm run broker:status` shows sessions, tabs and Brave.
- `npm run broker:stop` closes Brave cleanly and stops the broker. It stays stopped until a session's next tool call starts a fresh one, with that session's settings.
- The log is `%LOCALAPPDATA%\browser-mcp-relay\broker\broker.log`.
- **Fallback:** set `BROWSER_RELAY_MODE=legacy` (in the MCP server's `env`, or in `local-config.json`) to get the old one-relay-and-one-Brave-per-session model back. On macOS and Linux, legacy stays the default: the broker's unix-socket code ships but is untested.

The relay merges **51 upstream tools** from [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp) with **21 of its own** into a single 72-tool MCP. Your AI doesn't know or care where each tool comes from — to it, it's just one MCP server.

For the full architecture deep-dive, configuration env vars, modes, optional features (proxy whitelist, credential vault, autofill, cookie bridge), troubleshooting, and worked examples, see [`docs/REFERENCE.md`](docs/REFERENCE.md).

## Cookie bridge (optional)

The cookie bridge copies the logins (cookies) of the Chrome you use every day into the broker's Brave, so your AI is signed in where you are without logging in again there. It keeps up live: a new login, a rotated session or a logout in Chrome follows into Brave within seconds. It's **Chrome only** (Windows, broker mode) and **off until you install it**.

- **What syncs:** everything except a built-in denylist: banking, credit unions, payments, crypto, brokerages, insurance and payroll; email and identity (Google, Microsoft and Apple accounts, Proton, Yahoo, single sign-on providers); password managers; government, tax and health; cloud, hosting and domain-registrar consoles. An unknown domain that looks sensitive (a keyword such as `bank`, `pay`, `tax`, `health` or `wallet`, an IP address, a `.local` or single-label host) is **held** until you approve it.
- **The review page** (the extension's options page): nothing syncs until you click **Approve & start sync**. It lists what will sync and what's held back. You can turn any domain on or off there, including a denylisted one. A newly seen held domain waits there, with a badge on the extension icon.
- **Your always-allow list is the review page:** a held or denylisted domain you turn on there syncs, and stays on. The broker checks every cookie again against the same policy, and accepts the ones you turned on. `BROWSER_RELAY_BRIDGE_ALLOW` (comma-separated domains, in the MCP server's `env` or `local-config.json`) is a broker-side list only: the broker accepts those domains and their subdomains even when the keyword guard would hold them. The extension still holds them until you turn them on, so **the setting makes nothing sync on its own**. It never lifts a denylisted category.

**Install** (once, from the repo):

```bash
npm run bridge:install     # registers the native-messaging host for Chrome (HKCU) and prints these steps
```

1. In Chrome, open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `<repo>/extensions/cookie-bridge`.
3. Check that the extension ID is `dfcccancdkogdddemhecnffcjllbjmba`.
4. Open the extension's options page (click its icon), review the lists, and click **Approve & start sync**.

**Stop, undo, uninstall:**
- **Pause sync** (on the review page) stops syncing. Nothing already in Brave is removed, and un-pausing resyncs.
- Turning a domain **off** on the review page removes that domain's bridge cookies from Brave while a broker runs.
- There is no separate "revoke approval" button: removing the extension (or clearing its data) resets the approval. That stops syncing, but it doesn't remove anything from Brave either.
- `npm run bridge:uninstall` removes the registry key and the two files `bridge:install` wrote.
- **`npm run bridge:uninstall -- --purge`** also takes the synced logins back out. Remove (or pause) the extension first, so it can't sync them straight back. The running broker then expires, in Brave, every cookie the bridge put there, and the bridge's state file and log are deleted. With no broker running, or the extension still connected, it changes nothing and says what to do.

Re-run `bridge:install` after moving the repo or switching Node installs. If the broker runs elevated (as administrator, e.g. `BROWSER_RELAY_BROKER_DEELEVATE=off`), the bridge can't connect to it: the extension's review page and `cookie-bridge.log` say so.

**Check it:** `npm run broker:status` has a `cookieBridge` block (`bridges` connected, `cookies`, `domains`, `managed`, `pendingDeletes`, `lastSyncAt`, and the `allow` list it read). These are counts only, never a value. The native host logs to `%LOCALAPPDATA%\browser-mcp-relay\broker\cookie-bridge.log`. The broker's lines in `broker.log` start with `cookie bridge:`. Next to `broker.key`, a `cookie-bridge-<hash>.json` keeps the identities (name, domain, path, flags; never a value) of the cookies the bridge put into Brave and of the deletions Brave may not have yet, so a deletion in Chrome reaches Brave even across broker restarts.

**Values stay out of tool results:** `cookies_export` returns the cookies the bridge has put into Brave with value `"[bridge-managed]"`, and `cookies_import` skips that placeholder. This is not a sandbox: a page script (`execute`, `document.cookie`) can still read any cookie that isn't HttpOnly.

**Risks you accept** by installing it:
- Brave stores the synced cookies with DPAPI only (no App-Bound Encryption like Chrome's), so any process running as you can decrypt them from the broker profile on disk.
- Any process running as you can drive the broker, or rewrite the native host's launcher or its HKCU registry key.
- Page scripts and `execute` can read synced values (non-HttpOnly cookies).
- Parent-domain cookies (e.g. `.amazon.com`) sync even where a subdomain is denied (`pay.amazon.com`).
- Powerful but allowed domains (code hosting, package registries, AI accounts) sync unless you untick them on the review page.

**Limits:**
- Cookies only: no localStorage, sessionStorage or IndexedDB. A site that keeps its login token there still needs a login in Brave.
- Google sign-ins may not transfer (device-bound sessions), and Google accounts are on the denylist anyway.
- One way, Chrome → Brave: a login made in Brave doesn't go back to Chrome.
- One Chrome profile at a time. Changes made while no broker runs are caught up by a full resync when one starts.

## Platform support

| | |
|---|---|
| 🪟 **Windows** | ✅ First-class — tested daily |
| 🍎 **macOS** | 🟡 Best-effort — written portably, not yet maintainer-verified |
| 🐧 **Linux** | 🟡 Best-effort — honors XDG, not yet maintainer-verified end-to-end |

## Limitations

- 📜 Upstream `browser-devtools-mcp` is **Elastic-2.0** licensed — permissive but not OSI-open-source. See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
- 🦁 Requires Brave installed locally. Other Chromium browsers may work via `BROWSER_RELAY_BRAVE_PATH` but are untested.
- 🤝 **One broker serves every session** (broker mode): a hung tool or a crash affects all of them for a moment, and `execute` runs agent JavaScript inside that shared broker process. See [the known risks](docs/REFERENCE.md#broker-mode-known-risks).
- 🚧 Not in broker mode yet: the credential vault's autofill and authenticated proxies (`user:pass@`). Use `BROWSER_RELAY_MODE=legacy` if you need them.
- 🍪 The [cookie bridge](#cookie-bridge-optional) is Chrome → Brave, cookies only, Windows and broker mode only.

## Contributing

Bug reports and PRs welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Adding a tool is one new file in `src/own-tools/` plus one registry entry; no upstream fork, no patch maintenance.

## License

MIT — see [`LICENSE`](./LICENSE). Direct-dependency licenses (including the Elastic-2.0 callout for upstream) are in [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## Credits

Built on top of [`browser-devtools-mcp`](https://github.com/serkan-ozal/browser-devtools-mcp) by **Serkan Ozal** — the upstream that provides the 51 forwarded tools.

MCP itself is defined by Anthropic — see [modelcontextprotocol.io](https://modelcontextprotocol.io/).

---

<div align="center">

**Found a bug? [Open an issue](https://github.com/washedtl/browser-mcp-relay/issues).**

</div>
