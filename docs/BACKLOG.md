# browser-mcp-relay — Backlog

Open work, ranked by real-world leverage. Items are deferred not because they're unimportant but because they're either (a) not the highest-leverage thing to ship right now, (b) require an architectural pivot, or (c) need real-world signal we don't have yet.

This file is the canonical source for "what's known but not yet shipped." Items that get shipped move from here to a release note + a `feedback_*.md` memory entry.

## Contents

- [Stealth — Tier 2 (opinionated)](#stealth--tier-2-opinionated)
- [Stealth — Tier 3 (architectural)](#stealth--tier-3-architectural)
- [Stealth — Tier 4 (anti-patterns)](#stealth--tier-4-anti-patterns)
- [Tooling / DX](#tooling--dx)
- [Documentation](#documentation)
- [Distribution](#distribution)
- [Real-world signal first](#real-world-signal-first)

---

## Stealth — Tier 2 (opinionated)

Useful additions, ~200-400 LOC each. Defer until a specific use case demands them.

### `humanlike_click` + `humanlike_type` tools

**What:** New first-party tools with humanlike interaction timing — Bezier-curve mouse paths with realistic dwell, gaussian-distributed keystroke delays, occasional typo + correction patterns.

**Why deferred:** "How human is human enough" is itself an arms race. Worth a focused session against a specific site that's flagging current `interaction_click` / `interaction_fill`. Without that signal, we'd be optimizing against an imagined adversary.

**Ship gate:** A specific target site is flagging us via behavioral analysis. Capture the detection signal first (timing-side fingerprint), then design the humanizer to match the target's tolerance window.

### CDP `Network.setUserAgentOverride` userAgentMetadata

**What:** Extend `emulate_device` to pass `userAgentMetadata` (the `userAgentMetadata` arg of CDP's `Network.setUserAgentOverride`) so the HTTP-side `Sec-CH-UA-*` headers align with the JS-side `navigator.userAgentData` that Tier 1 already synthesizes.

**Why deferred:** Most current targets don't read Sec-CH-UA-* headers strictly. Tier 1's JS-side patch alone is sufficient for the 80% case.

**Ship gate:** A target is flagging on the HTTP-vs-JS UA mismatch. Easy to verify: compare `Sec-CH-UA-Platform` header to `navigator.userAgentData.platform` in a captured request — if they disagree, this is the missing piece.

**Effort:** ~50 LOC + an `emulate_device` test asserting the metadata gets through.

### WebGL renderer / vendor override

**What:** Override `WebGLRenderingContext.prototype.getParameter` to return realistic `(Intel Iris)` / `(NVIDIA RTX 3060)` strings instead of Playwright's signature output.

**Why deferred:** Easy to over-reach. A mismatched GPU+UA combination (e.g. `iOS UA + Linux GPU strings`) is an INSTANT flag — worse than no patch. Doing this right requires per-platform realistic GPU strings keyed off the UA.

**Ship gate:** Deploy a Tier-2 effort with realistic GPU vendor/renderer pairs sourced from real-browser fingerprint data, not made-up values.

**Effort:** ~100 LOC + a fingerprint database (~30 KB JSON of real GPU strings by platform).

### Chrome runtime expansion

**What:** Beyond Tier 1's `window.chrome = { runtime: {} }`, populate `chrome.loadTimes()`, `chrome.csi()`, `chrome.app` namespace with realistic shapes from real Chrome.

**Why deferred:** Most current sites don't probe deeper than `chrome.runtime`. Adding more surface = more chances to reveal an inconsistency.

**Ship gate:** A target probes `chrome.loadTimes()` (verifiable via `capture_xhr` plus inspecting the page's bot-detection JS for `chrome.loadTimes` references).

### Permissions full overrides

**What:** Beyond Tier 1's notifications fix, also override `clipboard-read`, `geolocation`, `camera`, `microphone` permission queries to return realistic states.

**Why deferred:** Each adds a small detection surface, marginal aggregate benefit. Easy to ship in batch when Tier 2 work happens.

**Effort:** ~30 LOC (one block extending the existing notifications fix).

---

## Stealth — Tier 3 (architectural)

Big lifts. Different scope from JS patches.

### Real-Brave-attach mode (CloakBrowser pattern)

**What:** A new mode where the relay does NOT launch its own Brave via `launchPersistentContext`. Instead it connects via `chromium.connectOverCDP` to a Brave the user is already running interactively. Eliminates the entire "Playwright launched it" fingerprint surface.

**Why this is the real win:** No JS-side patches can defeat detection of CDP-injected runtime artifacts. Detached-CDP-attach (where Brave was started by the user with `--remote-debugging-port=N` themselves) avoids those artifacts entirely.

**Why deferred:** Big architectural pivot. Requires:
- New mode in `index.js` that skips `launchBrave` and just connects via CDP
- User must launch Brave themselves with the right flags + a fresh user-data-dir (or accept profile-lock contention with their main browsing session)
- New documentation explaining the trade-off (no auto-launch convenience, no auto-cleanup on shutdown)
- The Walmart sidecar already does this — code patterns exist to copy

**Already exists where:** `~/Documents/GitHub/Washed-Command-Center/washed-web-app-v2-test/walmart_search.py` — uses CloakBrowser to attach to a manually-launched Brave with Walmart+ session auth. Pattern is proven.

**Ship gate:** A specific use case where Tier 1+2 stealth is provably insufficient AND attached-mode provides relief. Walmart B2C-authed scraping is the canonical example.

**Effort:** ~200 LOC + new docs. Probably 1 focused session.

### `rebrowser-patches` integration

**What:** Patch the chromium binary at startup to remove the most-detectable runtime artifacts that JS-side patches CAN'T reach (CDP runtime symbols on `window`, the iframe `contentWindow` Proxy trap that exposes attached debuggers).

**Why deferred:** Wrong audience. browser-mcp-relay is for friends running on their own Brave install — we can't ship a patched chromium. Doing so would also fork the upstream, breaking the "no fork" architectural property the README highlights.

**Ship gate:** Probably never for this project. If a friend genuinely needs binary-patched chromium, they're outside the scope where browser-mcp-relay is the right tool. Point them at `rebrowser-patches` directly.

---

## Stealth — Tier 4 (anti-patterns)

These are tempting but counterproductive. Documented here so we don't accidentally implement them later.

### `puppeteer-extra-stealth` integration

**Don't.** The library packs 25+ evasions, but:

- Most overlap with Brave Shields' built-in anti-fingerprinting → creates **new** inconsistencies (patches fighting patches)
- The "puppeteer-stealth fingerprint" itself is signature-detected by sophisticated vendors now (the stealth library has its own tells in how it mutates objects)
- Adds a heavy dep with regular churn

If we want broader coverage, copy specific evasions selectively into our stealth-apply.js, vetted against Brave's behavior.

### Canvas randomization

**Don't.** Brave Shields already randomizes canvas output per-session. Adding our own randomization on top creates fingerprint inconsistencies that score WORSE than either alone.

### Battery API spoofing

**Don't.** The Battery API is deprecated in Chromium and isn't actually used by major anti-bot vendors anymore (they moved to it being a low-weight signal years ago). Ship effort would catch a ~5% case at best.

### Font enumeration spoofing

**Don't.** High effort, marginal gain. Real fingerprint diversity comes from the OS-installed fonts; spoofing them creates a "perfectly-uniform fingerprint" tell.

### `event.isTrusted` faking

**Impossible.** Synthetic events from CDP fundamentally have `isTrusted=false`. Any patch that tries to fake this gets caught the moment it's proxy-detected. **Press-and-hold CAPTCHAs and similar will detect us regardless** — this is by browser design. The only solution is real hardware events (out of scope) or routing the user through them manually.

Per the LightningATC dossier (`recon_lightningatc_session_2026_05_10_pickup.md`): *"never auto-solve captchas/press-and-hold (`event.isTrusted=false` = instant flag)."* This is a known wall.

---

## Tooling / DX

Lower-priority items not specifically about stealth.

### macOS + Linux CI matrix

**What:** Extend `.github/workflows/clean-clone.yml` to a 3-OS matrix (`windows-latest`, `macos-latest`, `ubuntu-latest`).

**Why deferred:** README says Mac/Linux are "best-effort, not maintainer-verified." Code is portable but no end-to-end Mac/Linux testing has happened. Adding CI without first verifying locally produces noise — every Mac/Linux test that fails is "unknown — could be code, could be runner."

**Ship gate:** First a real Mac/Linux pass on the maintainer's hands. Then enable CI to keep it green going forward.

### Inspector "Activity" page virtual scrolling

**What:** The activity feed is currently capped at 200 events (ring buffer). For long-running sessions, you can't review history past that cap. Virtual scrolling + persisting events to disk would lift the cap.

**Why deferred:** 200-event window covers ~2-3 minutes of normal MCP traffic. Most use cases don't need more.

**Ship gate:** Someone asks for it. Until then, the export-to-JSON endpoint (added in PR #8) covers offline analysis.

### Auto-update version-check stderr line

**What:** On relay start, fetch the latest tag from npm registry / GitHub releases and stderr-log if the local version is behind.

**Why deferred:** Adds a network dependency for a localhost tool. Privacy-first. The friend onboarding doc tells people how to upgrade; that's enough.

**Ship gate:** Probably never. Document upgrade in REFERENCE.md instead.

### `lighthouse@13` upgrade

**What:** Currently pinned at `lighthouse@^11.0.0` due to dep churn. v13 fixes the 3 low-severity transitive `cookie<0.7.0` advisories.

**Why deferred:** Breaking dep upgrade. Localhost-bound dev tool, so the advisories aren't exploitable in practice. Tracked but not blocking.

**Ship gate:** When lighthouse@13's API differences are minor enough to be a 1-day adapter, OR when the cookie<0.7.0 advisories become actually exploitable.

---

## Documentation

### Reference architecture diagram

**What:** A hand-drawn (or PIL-generated) architecture diagram showing the multi-layer flow: MCP client → relay node → upstream BDMCP child → Brave subtree → CDP back to relay's own-tools.

**Why deferred:** The ASCII diagram in REFERENCE.md does the job. A polished SVG is nice-to-have but isn't blocking comprehension.

### Per-tool worked examples

**What:** REFERENCE.md has 3 worked examples (`lighthouse_audit`, `cookies_export`, `extract_structured`). Could expand to ~10-15 covering the full first-party catalog.

**Why deferred:** The current 3 cover the most common patterns. Adding more is busywork unless they unlock specific use cases.

### Friend-onboarding video

**What:** 2-minute screen recording of `git clone → npm install → npm run setup → relay attached to Cursor → first tool call works`.

**Why deferred:** Costs ~30 minutes to record well. README simplification + clean-clone CI mostly covers the same ground.

**Ship gate:** Friend onboarding starts hitting issues that are easier to show than describe.

---

## Distribution

### npm package publish

**What:** Publish `browser-mcp-relay` to npm so friends can `npx browser-mcp-relay setup` instead of `git clone`.

**Why deferred:** Git-clone is the dominant install pattern for this audience. npm-publishing means owning a public package name + semver discipline at a higher cost than tag-based releases.

**Ship gate:** A friend wants to install but doesn't have git. Until then, the README's clone instructions are fine.

### Single-binary distribution

**What:** Bundle the relay as a single executable via `pkg` or `bun build --compile`.

**Why deferred:** Adds a build step, breaks the "just a Node script" simplicity. Worth it only if friends without Node want to use this — and that audience is probably better served by a hosted tool, not a binary.

---

## Real-world signal first

The honest meta-thing: **most items in this backlog should not be shipped without real-world signal first.** A week of friends actually using v0.3.3+ generates more useful priority data than any planning session.

Specific signal to watch for:

- **Inspector traffic logs** — which of the 70 tools are actually called? If 50 of them have zero invocations after 2 weeks, the right move is deprecation, not more polish.
- **Issue reports** — what breaks for friends? The `windows-only CI + clean-clone smoke` setup catches install-time regressions; only friends running real workflows surface in-flight bugs.
- **Performance** — does relay startup feel slow? Does Brave-launch latency matter? `npm run smoke` reports timing; a week of real use generates the distribution.
- **Stealth wins/losses** — are friends scraping sites that flag them? Concrete failure cases are 100x more useful for prioritizing Tier 2/3 stealth work than speculative planning.

The treadmill of "ship more features" feels productive but masks the higher-leverage move: **let it soak, gather signal, prioritize from data.**
