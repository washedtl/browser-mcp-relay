# Changelog

## Unreleased

### Faster navigation, results that fit

Found by measuring what an agent gets back from real sites. Broker mode.

- **Navigation no longer waits 5 s for nothing.** Upstream waits until no request is in flight, but a request cut off when its page is replaced never reports an end, and an EventSource has none, so its count only grew: `navigation_go-to` took 5-6 s on pages that load in 0.2 s, `sync_wait-for-network-idle` timed out, and `interaction_click` with `waitForNavigation: true` took 30 s. The broker now forgets a frame's requests when the frame loads a new document, and leaves EventSource streams out (measured: go-to 5.1 s → 0.8 s, that click 30 s → 0.7 s). A page that keeps a streaming `fetch` or a long poll open is still busy: see Troubleshooting in the reference.
- **A big result is cut at 30,000 characters and saved in full.** A page snapshot can be far over what Claude Code shows (measured: 947,174 characters for a 500-row table), and Claude Code then saves it as one unreadable line. When the length is in a few long fields (a snapshot, a page's HTML or text), a forwarded tool's result is now cut inside them, so it stays valid JSON, and their full text is saved under `results/` in the broker home for at least 24 hours. A result that is long for another reason (a list of many short records, dozens of long fields, text that is not JSON) is cut as plain text at the last line break before the limit, and saved whole. A note names the file, where the cut text continues in it and the arguments that return less.
- **Snapshots come without the `refs` map.** It listed every `[ref=eN]` of the snapshot text again, with the role, name and selector upstream finds it by, and was 45-64% of the result on four measured pages. Refs work as before, and the two tool descriptions that promised the map no longer do.
- **Screenshots work inside `execute`.** `callTool("content_take-screenshot", …)` failed with `Unrecognized key(s) in object: '_artifacts'`, and nested screenshots taken in the same second were written to one file. Nested calls now return what the tool declares and get the per-call file names direct calls have, so one `execute` can resize and screenshot a page at several widths.
- **A screenshot with a `selector` is the element.** `content_take-screenshot` found the element and then returned the whole viewport, because upstream passes the element to Playwright's page screenshot as an option it does not have (measured: a heading 37 px high came back 491 px high). The broker now takes the image from the element, for a CSS selector or a snapshot ref, whatever `fullPage` says. The page is scrolled to bring the element into view, and an element that is hidden or has no size fails after 5 s instead of Playwright's 30.
- **Going back works.** Chromium restored the earlier page from its back/forward cache without the load event Playwright waits for, so `navigation_go-back-or-forward` ran into its timeout. Brave now starts with `--disable-back-forward-cache` (measured: an 8 s error → 0.7 s).
- **Error text is plain.** Playwright's colour codes are removed, also from the lines an `execute` script logs.
- **The server instructions describe the working loop**: navigate, act on refs, snapshot again, ask for less on big pages, batch with `execute`, one tab per subagent.

### Brave 157

- An elevated broker (the fallback when de-elevating fails) can launch Brave again. Brave removed the `AutoDeElevate` feature the relay used to stop it relaunching itself de-elevated, and the launched process exited at once. Brave now also gets `--do-not-de-elevate`. The normal de-elevated broker was never affected.

### Several sessions at once

Found by running 5 sessions with 4 parallel agents each against one broker.

- **Screenshots, PDFs and recordings no longer overwrite each other.** Upstream named files to the second, so agents saving in the same second got one path and read each other's page. Broker-mode names now carry the session, tab and a counter.
- **Navigation has a 60 s default timeout.** Upstream's default is none, so a page whose load event never fires held the call open for good. An explicit `timeout` (even `0`) is kept.
- **`lighthouse_audit` runs one audit at a time**, each bounded at 5 minutes. A second concurrent audit failed the first (`performance mark has not been set`).
- **A runaway `execute` no longer takes every session down.** The watchdog stops the blocking code at a third of its limit (20 s) and only kills the broker if that doesn't help; a call left unanswered gets an error. `BROWSER_RELAY_BROKER_WATCHDOG_MS` now has a 30 s minimum.
- **A hung Brave is detected.** Its PID and pipe stay alive, so nothing noticed, and every session's next tab waited on it for good. After three unanswered pings (about 45 s) it's killed and the next call relaunches it.
- **Response bodies are bounded.** Upstream read every non-static body into the shared heap, and Playwright caches what it read for the page's lifetime: 8 tabs fetching 360 MB per round grew the broker ~780 MB a round, without end. A body declared over 64 KB is no longer read (`o11y_get-http-requests` shows a note; `capture_xhr` can save it), one of unknown size is kept up to 64 KB, and a tab stops reading bodies after 32 MB.
- **tabIds don't repeat after a broker restart.** A counter from 0 could give a subagent's old tabId to a sibling's new tab.
- `tabs_list` no longer waits on a page stuck in a loop. `tabs_new` and the server instructions tell agents to `tabs_close` when done; `storage_clear-local` says localStorage is shared.

### Launching

- **A Brave that exits during launch is relaunched** (up to 3 attempts, broker mode). An early exit used to fail the tool call (traced to CCleaner's Performance Optimizer waking a "sleeping" Brave on the first launch after idle: exclude Brave there to avoid the retry); a stray Brave that took the profile meanwhile is reaped before the relaunch. A missing executable or a Brave that hangs is not retried.
- **Launch failures are in `broker.log`**, every attempt. They used to reach only the calling session.
- **The early-exit error says what it found**: whether something holds the profile right now, instead of always guessing that another Brave does.
- The "credential-vault autofill isn't available" warning appears only when `BROWSER_RELAY_VAULT_FILES` names a file that exists. A list of missing files had nothing to lose, but put the warning in every session's first tool result.

## v0.4.1 — CDP lockdown, stealth fixes, cookie bridge

### Security: no CDP port in broker mode

- **Broker mode: no unauthenticated CDP port.** Brave used to listen on a TCP DevTools port (random, 127.0.0.1), and any local process could drive the shared, logged-in Brave and read its cookies through it. Brave now runs with `--remote-debugging-pipe` and opens no port (measured: 0 listening sockets on any of its processes). The broker serves CDP to upstream and its own tools at `ws://127.0.0.1:<port>/<secret>/devtools/browser` (a 256-bit secret, one browser session per client). Without the secret every request is refused: `/json/*` discovery (404), a wrong path, an `Origin` header or a foreign `Host` (403); 503 while Brave is down. Clients can't send `Browser.close`, `Browser.crash` or `Browser.crashGpuProcess` to the shared Brave, also not wrapped in the non-flat `Target.sendMessageToTarget`, which works only on the client's own sessions (so `emulate_device` can still resume a tab's iframes and workers).
- **The secret stays in the broker.** It is redacted from the broker log, `broker:status`, the relay Inspector and tool results (Playwright's and upstream's connect errors print the whole URL), and removed from the broker's environment once upstream is loaded.
- `lighthouse_audit` connects over that URL in broker mode (puppeteer, a tab it closes after). Legacy mode is unchanged and keeps its unauthenticated `9333 + slot - 1` port.
- The broker no longer picks or restarts for a CDP port: the "CDP port is taken by another process" restart is gone.

### Cookie bridge (optional, new)

- **Your Chrome logins in the broker's Brave, live.** A Chrome extension (`extensions/cookie-bridge/`, ID `dfcccancdkogdddemhecnffcjllbjmba`) reads cookies through `chrome.cookies`, a native-messaging host passes them to the broker over its pipe, and the broker sets them in Brave. It starts with a full sync, then mirrors every change (logins, rotated sessions, logouts), one way. Windows, Chrome and broker mode only; nothing syncs until you click **Approve & start sync** on the extension's review page. See the README's *Cookie bridge (optional)* and [REFERENCE](docs/REFERENCE.md#cookie-bridge).
- **Denylist with a keyword hold.** Banking, payments, crypto, brokerages, insurance, payroll, email and identity, password managers, government, tax and health, and cloud and registrar consoles never sync unless you re-allow them on the review page. Unknown sensitive-looking domains (keywords, IP addresses, local names) wait for your approval. Only generic categories ship in `policy.js`. Your always-allow list is the review page's per-domain toggles. `BROWSER_RELAY_BRIDGE_ALLOW` is a broker-side list only: the broker accepts those domains past the keyword hold (never past a deny), but the extension still waits for your toggle, so it makes nothing sync on its own.
- **Checked on both ends.** The broker classifies every cookie again (a partitioned one by its top-level site too; a partition key without a valid site is refused). It applies them over its own CDP connection, the secret proxy URL (no port, no `/json` discovery), and again on every Brave launch, before any tool runs. A deletion Brave may have lost in a crash (Chromium writes cookies every ~30 s) is applied again at the relaunch. The native host opens no port and authenticates with `broker.key` through a challenge (no replay; a squatter gets no MAC). A bridge never keeps an idle broker alive.
- **Values stay out of results and logs.** `cookies_export` returns bridge-managed cookies with value `"[bridge-managed]"` (name, domain, path and flags kept); `cookies_import` skips the placeholder. Page scripts (`execute`, `document.cookie`) can still read non-HttpOnly values: `execute` isn't a sandbox. Logs, `broker:status` (`cookieBridge` counts), the state file and acks never hold a value.
- `npm run bridge:install` / `bridge:uninstall` register or remove the host (HKCU, Chrome) and print the load-unpacked steps. `npm run bridge:uninstall -- --purge` also takes the synced logins back out of Brave: the running broker expires every bridge cookie (refused while the extension is still connected), and the state file and log are deleted. An elevated broker's pipe (EPERM) gets a clear message in the host log and on the review page. Files: `cookie-bridge.log` and `cookie-bridge-<hash>.json` (identities only) in the broker home.
- Limits: cookies only (no localStorage), Google sign-ins may not transfer, one Chrome profile at a time. Risks you accept are listed in the README: Brave keeps the synced cookies DPAPI-only (no App-Bound Encryption), any process running as you can drive the broker or rewrite the host's launcher, page scripts can read the values, parent-domain cookies sync where a subdomain is denied, and powerful allowed domains (code hosting, registries, AI accounts) sync unless you untick them.

### Stealth: Chromium-exact client hints

- **GREASE brand and brand order** generated the way Chromium does it (seeded by the major version), checked against headers measured on real Chrome builds. A Chrome UA gets the "Google Chrome" brand; Edge, Opera and Chromium UAs get an unbranded list instead of a wrong brand.
- **`fullVersionList` / `fullVersion`** carry a real stable build per major instead of `x.0.0.0`. `fullVersion` and `formFactors` are always sent: without them Chromium fell back to the host's own values (an emulated Chrome 131 reported Brave's 147; Android emulation reported Desktop).
- **`navigator.platform`** matches the UA's OS (`emulate_device` passes CDP `platform`; `stealth_apply` patches it only when it contradicts the UA).
- **Cross-origin iframes and dedicated workers** get the same UA override from `emulate_device` (auto-attached and paused until it's applied; `reset` turns it off). A child target that can't be resumed is detached (so it still loads) and reported instead of being left paused. Service and shared workers, a worker's `navigator.platform`, popups and `navigator.brave` are still not covered (documented).

## v0.4.0 — shared broker

### Broker mode (the new default on Windows)

- **One broker per user and profile serves every MCP session.** Each session's `node src/index.js` is now a ~23 MB shim that forwards its stdio to a background broker over a per-user named pipe. The broker runs one Brave on one persistent profile: logins are shared live between sessions and survive restarts. Your MCP client config does not change.
- **A window per session tab.** Every session gets its own visible, cascaded Brave window (`BROWSER_RELAY_BROKER_WINDOWS=offscreen` keeps them off-screen). Parallel subagents call `tabs_new` and pass the returned `tabId`, so they never drive each other's tab. `browser_show` brings a window forward for a manual login or 2FA.
- **Upstream in-process.** `browser-devtools-mcp` runs inside the broker (loaded on the first tool call); stubs and debug probes are scoped to the calling session's page.
- **Self-healing.** A crashed or killed Brave relaunches on the next call (≈ 1.5 s), with a one-line reset notice in that tab's next result. A dead broker is restarted by the next session that calls (≈ 4.5 s). A watchdog kills a broker whose event loop is blocked for 60 s, and an idle broker over 1 GB RSS recycles itself. Brave closes after 20 idle minutes; the broker exits 10 minutes after its last session.
- **De-elevation.** Started from an elevated session, the broker and its Brave run with the desktop shell's non-elevated token and an exact allowlisted environment (no API tokens meant for the client). If that fails, it runs elevated and says so in its log and in every session.
- **Authenticated pipe.** Shims and `broker:status` / `broker:stop` check the pipe owner with an HMAC over a nonce (`broker.key`), so a squatter on the predictable pipe name gets nothing; control MACs can't be replayed.
- **One-time profile seed.** On first start the broker profile is copied once from your freshest legacy profile (a pool slot, or v0.3's standalone `<repo>/.browser-data`), minus caches, so logins carry over. `npm run migrate-profile` does it by hand or shows a dry run.
- **Operations:** `npm run broker:status`, `npm run broker:stop`, a broker log in `%LOCALAPPDATA%\browser-mcp-relay\broker\broker.log`, and one relay Inspector hosted by the broker with every session's traffic (`BROWSER_RELAY_INSPECTOR_PORT`).
- **Legacy mode stays**, and is the default on macOS and Linux (the broker's unix-socket code is untested there): `BROWSER_RELAY_MODE=legacy`.

### Lighter and leaner (both modes)

- **Cached tool catalog.** `tools/list` comes from a disk cache keyed on the upstream build, the bundle patch and tool-affecting env: no upstream spawn and no Brave per session. Upstream `outputSchema`s (~62K chars) are no longer sent.
- **Hidden toolsets, enabled only with your OK.** `debug`, `react`, `scenario` and `trace` (22 tools) are hidden by default to save context. The new `toolsets` tool enables a group after asking you, with a real approve/decline prompt on clients that support MCP elicitation; `tools/list_changed` updates the client. `BROWSER_RELAY_TOOLSETS` pre-enables groups.
- **Lazy legacy relay.** An idle legacy session claims no slot, copies no profile and spawns neither upstream nor Brave until its first tool call. A dead Brave tears down the upstream child too, so forwarded tools recover; stdin EOF shuts the relay down.

### Security

- **TLS secure by default.** Certificate errors are ignored only with `BROWSER_RELAY_IGNORE_HTTPS_ERRORS=true` or while Brave runs through a loopback debug proxy (`BROWSER_RELAY_PROXY_URL`); a remote proxy never gets to MITM the profile. The proxy is a real `--proxy-server`, credentials stay off the command line and out of logs.
- **Inspector:** a Host allowlist on every request and WebSocket upgrade (DNS rebinding), exact own-origin checks, a CSP without `'unsafe-inline'`, `no-store` on API responses, and redaction of cookie, storage and form values plus auth headers in the traffic feed.
- **Autofill** fills only on `https://` pages whose scheme, host and port exactly match the saved credential (no subdomain or last-two-labels guess).
- **Pool:** one slot's reap no longer kills another slot's Brave (`pool-1` matched `pool-10`..`16`); recycled-PID locks are reclaimed.
- **Own tools:** data-out tools are bounded and can write to a file instead of the transcript (`capture_xhr` can no longer hang), `form_fill` never echoes values in errors, `download_capture` refuses relative or UNC paths and silent overwrites, concurrent heap snapshots no longer corrupt each other.
- **Telemetry:** upstream's PostHog usage telemetry is forced off for every upstream the relay runs, in both modes.

### Release polish

- The broker reaps a Brave left on its own profile before launching (found by the profile's `lockfile`, matched by exact `--user-data-dir`, nothing else killed) instead of failing with "profile in use" (code 21).
- A graceful close no longer kills a Brave that accepted `Browser.close` but needs longer than 10 s to finish writing on a busy machine (up to 30 s in all).
- `npm run smoke` fails clearly when Brave isn't installed (`--without-brave` checks the catalog alone); the setup wizard offers broker and legacy modes.
- `npm test` runs the unit files in parallel, then the real-Brave and end-to-end files one at a time; the README test badge is checked against the runner's count.
- Install with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` to skip ~1.2 GB of Playwright browsers the relay never uses.

## v0.3.6 and earlier

See the [git history](https://github.com/washedtl/browser-mcp-relay/commits/main) and the version notes in [`docs/REFERENCE.md`](docs/REFERENCE.md).
