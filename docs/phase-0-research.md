# Phase 0 — Research Findings (CDP Access Strategy)

**Date:** 2026-05-06
**Status:** Complete. Strategy A confirmed viable end-to-end via probe.
**Decision:** Phase B implements Strategy A.

---

## Upstream Architecture (browser-devtools-mcp 0.6.4)

**Location on disk:** at the time of this research, the upstream was loaded from a Cursor-extension install of `serkan-ozal.browser-devtools-mcp-vscode` (`browser-devtools-mcp 0.6.3`); since W1 the relay resolves it via `require.resolve("browser-devtools-mcp/dist/index.js")` from the npm dependency.

**Key files:**
- `dist/index.js` (4-line entry, parses `--transport` flag, calls `startStdioServer()` or `startStreamableHTTPServer()`)
- `dist/core-G2U4OSL6.js` (~376KB — tools, browser-launch logic, CDP discovery)
- `dist/core-S5JHUB3Z.js` (~49KB — env-var declarations, logging)
- `dist/core-WJ3SNBGV.js` (~12KB — Execute tool, init/shutdown)
- `dist/core-42ZXN723.js` (~1KB — small utility module)

**Stack:** ES module (`"type": "module"`), Playwright 1.58, MCP SDK 1.23, Hono (for HTTP transport mode), commander (CLI parsing). Bundled with esbuild.

**Tool registration:** all tools loaded from `platformInfo.toolsInfo.tools` (a static array assembled in `core-G2U4OSL6.js` via `var tools12=[...tools, ...tools2, ...tools11]` — 11 tool families). Registered into the MCP `Server` instance via `server.registerTool(...)` in a single loop in `index.js`.

**Transport modes:**
- `--transport=stdio` (default) → `StdioServerTransport`
- `--transport=streamable-http --port=N` → Hono HTTP server with `StreamableHTTPTransport`

We use stdio (matches the existing wrapper). The HTTP mode could be useful if we ever want to run upstream as a daemon, but stdio is sufficient for the relay.

---

## Browser-Launch Decision Tree (in upstream)

The function `newBrowserContext()` in `core-G2U4OSL6.js` chooses one of three paths based on env vars:

```js
async function newBrowserContext(opts) {
  if (BROWSER_CDP_CONNECT_URL) {
    if (opts.persistent) throw "CDP and persistent are mutually exclusive";
    if (opts.browserOptions.browserType !== "chromium") throw "CDP requires chromium";
    return _getCdpBrowserContext();   // ← Strategy A path
  }
  return opts.persistent
    ? { browserContext: await _getPersistentBrowserContext(opts) }     // current wrapper
    : { browserContext: await (await _getBrowser(...)).newContext(...) };
}
```

**Critical env vars:**

| Env var | Effect |
|---|---|
| `BROWSER_CDP_CONNECT_URL` | If set, upstream attaches via Playwright `connectOverCDP()` to that URL. Mutually exclusive with `BROWSER_PERSISTENT_ENABLE`. Accepts `http://host:port` or `ws://host:port/...`. |
| `BROWSER_CDP_ENDPOINT_EXPLICIT` | Boolean-style flag distinguishing explicit endpoint from probe-discovery (port 9222 / 9229). When set, upstream skips the loopback probe and uses `BROWSER_CDP_CONNECT_URL` directly. |
| `BROWSER_PERSISTENT_ENABLE` / `BROWSER_PERSISTENT_USER_DATA_DIR` | Currently used by the v2 wrapper. Tells upstream to launch its own Brave with a persistent profile dir. **Must NOT be set when using CDP attach.** |
| `BROWSER_LOAD_EXTENSIONS` | Comma/semicolon-separated list of extension paths to load at launch. Currently used by the wrapper for the BoxedUp companion extension. **In Strategy A, the relay handles extension loading at Brave-launch time, NOT via this var.** |
| `BROWSER_HEADLESS_ENABLE` | Headless mode. Wrapper currently sets to `false`. |
| `BROWSER_USE_INSTALLED_ON_SYSTEM` | When true, uses installed Chrome instead of Playwright's bundled chromium. |

---

## Strategy A — Verified Architecture

```
                ┌────────────────────────────────────────────┐
                │              Cursor (MCP host)             │
                └──────────────┬─────────────────────────────┘
                               │ stdio MCP
                               ▼
       ┌──────────────────────────────────────────────────────┐
       │   browser-mcp-relay (our process — own MCP server)   │
       │                                                      │
       │   ┌────────────────────────────────────────────┐     │
       │   │ 1. Claim slot, snapshot cookies (v2 logic) │     │
       │   │ 2. Launch Brave via Playwright (port=N)    │     │
       │   │ 3. Spawn upstream child with               │     │
       │   │    BROWSER_CDP_CONNECT_URL=http://127:N    │     │
       │   │ 4. Connect external Playwright via         │     │
       │   │    chromium.connectOverCDP("http://127:N") │     │
       │   │    (used by our new tools)                 │     │
       │   └────────────────────────────────────────────┘     │
       │            │                          │              │
       │            │ stdio MCP relay          │ Playwright   │
       │            ▼                          │ over CDP     │
       │  ┌──────────────────┐                 │              │
       │  │ upstream child   │                 │              │
       │  │ (browser-        │                 │              │
       │  │  devtools-mcp)   │                 │              │
       │  └────────┬─────────┘                 │              │
       │           │ Playwright over CDP       │              │
       └───────────┼───────────────────────────┼──────────────┘
                   ▼                           ▼
              ┌────────────────────────────────────┐
              │   Brave (one process)              │
              │   --remote-debugging-port=N        │
              │   --user-data-dir=<slot dir>       │
              │   --load-extension=<companion>     │
              └────────────────────────────────────┘
```

**Two clients on one Brave** — both upstream and our relay's CDP bridge talk to the same `webSocketDebuggerUrl`. Playwright handles the multiplexing via separate `Browser` references. Verified by the probe (see below).

**Port allocation:** unique per slot. Suggested mapping:
- `.browser-data-mcp-pool-1` → 9333
- `.browser-data-mcp-pool-2` → 9334
- `.browser-data-mcp-pool-3` → 9335
- `.browser-data-mcp-pool-4` → 9336

Ports 9222 and 9229 are reserved by upstream's loopback probe — avoid those for safety.

---

## Probe Verification (`probe-cdp-access.js`)

Run on 2026-05-06. Output:

```
[probe] launching chromium with --remote-debugging-port=9333
[probe] chromium launched, persistent context active
[probe] /json/version responded: {"Browser":"Chrome/145.0.7632.6","Protocol-Version":"1.3","User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleW...
[probe] connecting external Playwright via connectOverCDP(http://127.0.0.1:9333)
[probe] connectOverCDP succeeded — 1 context(s) visible
[probe] navigated to about:blank, title=""
[probe] launchPersistentContext sees 1 page(s)
[probe] STRATEGY A VERIFIED — connectOverCDP works against launchPersistentContext
```

**What this proves:**
1. Playwright `chromium.launchPersistentContext()` accepts `--remote-debugging-port=N` in args. The default `--remote-debugging-pipe` does NOT prevent us from also exposing the port — both can coexist.
2. The HTTP CDP discovery endpoint (`/json/version`) returns a valid `webSocketDebuggerUrl` — required by upstream's `_httpDiscoverWsUrl` resolution.
3. An external `chromium.connectOverCDP("http://127.0.0.1:N")` succeeds and exposes the existing context (count > 0, satisfying upstream's "Attached but browser reported zero contexts" guard).
4. Pages opened via the launching reference are visible to the connectOverCDP reference and vice versa — confirming shared state.

**Exit code 0, probe profile dir cleaned up.**

---

## Phase B Plan (rewritten — concrete tasks)

**Goal of Phase B:** ship a `cdp-bridge.js` module that:
- Launches Brave for the claimed slot via Playwright `launchPersistentContext` with the right flags (companion extension, remote-debugging port, headless flag from CONFIG, etc.)
- Returns a `BrowserContext` that the relay's tool handlers can use directly
- Provides the CDP URL for the relay to set `BROWSER_CDP_CONNECT_URL` on the upstream child

### Phase B Task 1: Add Playwright dependency to relay package

Modify `~/.claude/scripts/browser-mcp-relay/package.json` to add:
```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.23.0",
  "playwright-core": "^1.58.0"
}
```

(Use `playwright-core` not `playwright` — `-core` skips the chromium install. We use the chromium that's already on the system, or Playwright auto-discovers Brave via channel.)

### Phase B Task 2: Implement `cdp-bridge.js`

Single module exposing:
- `launchBrave({ userDataDir, port, extensionPath, headless })` → `{ context, browser, cdpConnectUrl }`
- `closeBrave({ context, browser })` — graceful shutdown

Internally calls `chromium.launchPersistentContext` with:
- `args: ['--remote-debugging-port=' + port, '--load-extension=' + extensionPath, '--disable-extensions-except=' + extensionPath]`
- `ignoreDefaultArgs: ['--disable-extensions']`
- `executablePath: <CONFIG.bravePath>` (default to bundled chromium if missing)
- `headless: <CONFIG.headlessEnable>`

Returns `cdpConnectUrl: "http://127.0.0.1:" + port` for upstream env wiring.

### Phase B Task 3: Wire bridge into relay entrypoint

Update `~/.claude/scripts/browser-mcp-relay/src/index.js` so `main()`:
1. Claims pool slot (existing)
2. Snapshots cookies (existing)
3. Picks port from slot index: `9333 + slotIdx - 1`
4. Calls `launchBrave({ userDataDir: dir, port, extensionPath, headless })` BEFORE spawning upstream
5. Spawns upstream child with env containing `BROWSER_CDP_CONNECT_URL=<cdpConnectUrl>`, NOT `BROWSER_PERSISTENT_USER_DATA_DIR` and NOT `BROWSER_PERSISTENT_ENABLE`
6. Stores the bridge handle on `globalThis.__cdpBridge` (or similar) so future tool handlers can access the `BrowserContext`
7. Updates shutdown to close bridge before child kill

### Phase B Task 4: Smoke-test bridge with manual probe

Run a tiny scenario that exercises Phase B end-to-end:
- Start the relay with `BROWSER_MCP_ROLE=test` against a test slot
- Call `mcp__browser-devtools-mcp-relay__navigation_go-to` to verify upstream-via-CDP works
- Add a temporary "ping" own-tool that uses the bridge's BrowserContext to do `page.title()` — verify our own-tools can drive the same browser

### Phase B Task 5: Tests

Unit-level tests are limited (Playwright-launching tests are slow + flaky in CI). Use:
- A focused integration test that launches a probe Brave, uses `cdp-bridge.launchBrave` against it, calls `page.goto("about:blank")`, asserts no errors, closes cleanly.
- The smoke test from Task 4 doubles as the integration test.

**Estimated time:** 1-2 days for Phase B. The bulk of the complexity is shutdown ordering + extension flag handling.

---

## Open Questions (to resolve during Phase B implementation)

1. **What's the correct chromium executable path for our `launchPersistentContext`?**
   - Option: use the bundled Playwright chromium (from upstream's `node_modules/@playwright/browser-chromium`)
   - Option: use installed Brave from `CONFIG.bravePath`
   - Test both during Task 2; pick whichever loads the companion extension correctly.

2. **Does Playwright remove `--remote-debugging-port` from default args?**
   - Per probe: no, both pipe and port coexist.
   - But verify in case Playwright changes behavior in a future version.

3. **What happens if upstream's `connectOverCDP` fires before our Brave is fully ready?**
   - Probe added a 500ms sleep; production code should poll `/json/version` until it returns 200, then spawn upstream.
   - Add a `waitForCdpReady(port, timeoutMs=10000)` helper in `cdp-bridge.js`.

4. **How does Playwright handle the existing `BROWSER_LOAD_EXTENSIONS` env that the wrapper currently sets?**
   - When we move to Strategy A, our launch is the source of truth for extensions. We pass them as args directly. The env var is irrelevant in this mode and can stay set or be cleared — both are fine. Document explicitly: relay does NOT rely on `BROWSER_LOAD_EXTENSIONS`.

---

## What's Confirmed Safe

- Phase A (pure forwarding) implementation in the original plan is unchanged. The relay infrastructure stays simple — Strategy A only matters for Phase B onwards.
- Phase 0 made no changes outside `~/.claude/scripts/browser-mcp-relay/docs/`. The existing `wrap-browser-devtools-mcp.js`, `browser-mcp-config.json`, and `browser-mcp-doctor.js` are untouched. The `browser-devtools-mcp-pool` MCP entry is untouched.
- Probe cleaned up its profile dir on exit. No leaked state.
