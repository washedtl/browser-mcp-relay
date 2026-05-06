# DAP — Publishable browser-mcp-relay

**Status:** PLANNED. Not for execution until user explicitly says "ship it".
**Goal:** Take `browser-mcp-relay` from "works on Washed's Windows machine" to "friend clones the repo, runs setup, has a working MCP in <10 minutes on Win/Mac/Linux".
**Non-goals:** Publishing to npm. Building a website. Adding new tools beyond the 16 already shipped. Marketing.

---

## Hard rules (apply to every wave)

- **Don't break Washed's local install.** All work happens in the relay repo dir; user's `~/.claude.json` is left alone. Setup script writes a NEW `~/.claude.json` entry only if user explicitly opts in via flag.
- **Pool wrapper coupling is removed, not deleted.** The wrapper file at `~/.claude/scripts/wrap-browser-devtools-mcp.js` stays in Washed's private setup. Relay learns to run standalone (single Brave). Pool integration becomes opt-in via env var.
- **Secrets sweep before EVERY commit.** No `~/.claude.json` paths, no Discord webhooks, no API keys, no Washed-specific identifiers. Use `git secret-scan` or `trufflehog` pre-commit.
- **Upstream license respected.** `browser-devtools-mcp` stays a runtime npm dep, never vendored. Its license attribution lives in `THIRD_PARTY_NOTICES.md`.
- **No new own-tools in this DAP.** Scope is exclusively portability + repo hygiene. New tools wait until after publish.
- **DAP exit criterion:** A clean Windows VM AND a clean Mac (Washed can borrow one) can both clone, run `npm run setup`, register the MCP in their Claude Code config, and successfully call `lighthouse_audit` against `example.com`.

---

## Wave 1 — Decouple from user-specific paths

**Builder skills:** `simplify`, `modern-python` not relevant — node only. `superpowers:verification-before-completion`.
**Reviewer skills:** spec compliance + code quality.

### Tasks
1. **Externalize `bravePath`**
   - Currently hardcoded in `browser-mcp-config.json`. Move to `local-config.json` (gitignored) with auto-detection fallback.
   - Add `src/detect-browser.js` returning first match across:
     - Win: `HKLM:\Software\BraveSoftware\Brave-Browser\BLBeacon\version` registry probe + `%PROGRAMFILES%\BraveSoftware\Brave-Browser\Application\brave.exe` + same in `(x86)` + `%LOCALAPPDATA%`
     - Mac: `/Applications/Brave Browser.app/Contents/MacOS/Brave Browser`
     - Linux: `which brave-browser` || `which brave` || `/usr/bin/brave-browser`
   - Falls back to `BROWSER_RELAY_BRAVE_PATH` env var if auto-detect fails.
2. **Externalize user-data-dir**
   - Currently relay assumes pool slots at `~/.claude/scripts/.browser-data-mcp-pool-N`.
   - Default standalone mode: `<repo>/.browser-data` (gitignored).
   - Pool mode (opt-in): set `BROWSER_RELAY_POOL_DIR=<path>` and `BROWSER_RELAY_POOL_SLOT=N`.
3. **Cookies snapshot source becomes optional**
   - The pool wrapper snapshots cookies from `-mcp-2`. Standalone relay has no equivalent — that's fine. Document the limitation in README.
4. **Verify Washed's local install still works** after refactor. Re-run the `lighthouse_audit example.com` smoke test.

### Verify
- `node src/index.js` works with zero env vars on Washed's machine (auto-detect finds Brave)
- `BROWSER_RELAY_BRAVE_PATH=/fake/path node src/index.js` errors clearly: "Brave not found at /fake/path"
- All 61 existing tests still pass
- Washed's `~/.claude.json` browser-devtools-mcp-relay entry still functional after restart of Cursor

### Reviewer prompt
"Verify no hardcoded user paths remain in `src/`, `test/`, or `package.json`. Verify auto-detect logic is OS-portable (no shell-out to PowerShell on Mac). Verify `local-config.json` is gitignored and `local-config.example.json` is checked in."

---

## Wave 2 — Cross-platform process management

**Builder skills:** `superpowers:systematic-debugging` (the reaper logic has been historically buggy on Windows), `webapp-testing`.
**Reviewer skills:** spec compliance + code quality.

### Tasks
1. **Process inspection shim** at `src/process-shim.js`
   - `listProcessesByCommand(needle)` returns `[{pid, command}]`
   - Win: `Get-CimInstance Win32_Process | Where-Object CommandLine -like "*needle*"` (already working)
   - Mac/Linux: `ps -eo pid,command | grep needle | grep -v grep`
   - `isPidAlive(pid)`:
     - Win: `tasklist /fi "PID eq N" /nh` — already working
     - Mac/Linux: `kill -0 N` (POSIX standard)
2. **Cookie file path detection** in `src/detect-browser.js`
   - Win: `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data\Default\Network\Cookies`
   - Mac: `~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Network/Cookies`
   - Linux: `~/.config/BraveSoftware/Brave-Browser/Default/Network/Cookies`
   - Used by `cookies_export` tool; degrade gracefully with clear error if not found.
3. **Brave-launch flags** — verify Playwright `chromium.launchPersistentContext({channel:"chrome", executablePath: bravePath})` works on Mac. (Playwright handles flag differences.) Smoke test on a Mac if available; otherwise mark Mac as "untested but expected to work" in README.

### Verify
- Unit test: mock `child_process.execSync`; verify Win path uses PowerShell, Mac/Linux paths use `ps`/`kill`
- `node test/process-shim.test.js` passes on Windows (real environment)
- Reaper still successfully kills orphan Brave on Windows after this refactor

### Reviewer prompt
"Verify `src/process-shim.js` has no PowerShell on non-Win paths. Verify graceful degradation when cookie file doesn't exist (cookies_export returns clear error, doesn't crash). Verify the existing tasklist-based reaper bug fix from v2 wrapper isn't regressed."

---

## Wave 3 — Setup script + install ergonomics

**Builder skills:** `simplify`, `superpowers:verification-before-completion`.
**Reviewer skills:** spec compliance.

### Tasks
1. **`scripts/setup.js`** — interactive wizard
   - Detects OS and Brave install
   - Writes `local-config.json` with detected paths
   - Asks: "Register relay in Claude Code config? [y/N]" — if yes, locates `~/.claude.json` and prints the exact JSON snippet to paste (does NOT modify the file automatically; printing is safer than a botched write)
   - Final step: runs a self-test: spawn relay, call `tools/list`, verify ≥40 tools returned, kill relay, print "✓ Relay healthy."
2. **`local-config.example.json`** committed with placeholders
3. **`.gitignore`** entries:
   - `local-config.json`
   - `node_modules/`
   - `.browser-data*/`
   - `*.log`
4. **`package.json` scripts:**
   - `"setup": "node scripts/setup.js"`
   - `"smoke": "node scripts/smoke.js"` (non-interactive equivalent for CI)
   - `"test": "node --test test/"`

### Verify
- Fresh clone in a sibling dir: `cd <tmp>/browser-mcp-relay-test && npm install && npm run setup` → green path with no errors
- `local-config.json` is gitignored (`git check-ignore` confirms)
- `npm run smoke` exits 0 in <60s

### Reviewer prompt
"Verify setup.js never writes to `~/.claude.json` automatically, only prints the snippet. Verify `local-config.json` is in `.gitignore`. Verify smoke script doesn't leave orphan Brave processes after exit."

---

## Wave 4 — Repo hygiene + docs

**Builder skills:** `frontend-design:frontend-design` not relevant. `superpowers:verification-before-completion`.
**Reviewer skills:** code quality + supply-chain-risk-auditor (for license verification).

### Tasks
1. **`LICENSE`** — MIT, copyright "Washed TL" or chosen handle
2. **`THIRD_PARTY_NOTICES.md`** — list `browser-devtools-mcp`, `playwright-core`, `lighthouse`, `@modelcontextprotocol/sdk` with their licenses pulled from npm
3. **`README.md`** — sections:
   - What it is (1 paragraph: relay forwards 41 upstream tools + adds 16 own-tools)
   - Why (2 bullets: own the surface, multi-session safe)
   - Install (4 steps: clone → npm install → npm run setup → register MCP)
   - Tool catalog (16 own-tools, one-line each, link to source)
   - 3 worked examples (`lighthouse_audit`, `cookies_export`, `extract_structured`)
   - Architecture diagram (ASCII or mermaid: Cursor → relay → upstream child + own-tools, both attach to one Brave via CDP)
   - Limitations (Win first-class, Mac/Linux best-effort; no cookie snapshot in standalone mode; requires Brave installed)
4. **`CONTRIBUTING.md`** — "Add an own-tool in 5 minutes" guide (file in `own-tools/`, 2 tests, restart MCP, done)
5. **Pre-commit secrets scan** — run `trufflehog filesystem .` once, paste clean output into a gist linked from PR

### Verify
- README renders correctly on GitHub (push to a private test repo first)
- `trufflehog filesystem .` returns 0 findings
- All license files present in `THIRD_PARTY_NOTICES.md` match `node_modules/<pkg>/package.json` license fields

### Reviewer prompt (supply-chain-risk-auditor)
"Audit dependencies in package.json. Verify each direct dep has a permissive license compatible with MIT distribution. Flag any GPL/AGPL deps. Flag any deps without a recent maintainer."

---

## Wave 5 — Final pre-publish checklist (no code, just verification)

**Builder skills:** none, this is a checklist wave.
**Reviewer skills:** spec compliance ONE MORE TIME on the whole repo.

### Checklist
- [ ] `git log --all -p | grep -iE "(claude\.json|simplecop|washedtl|api[_-]?key|webhook)"` returns nothing sensitive
- [ ] `git ls-files | xargs grep -l "C:\\\\Users"` returns nothing (no Windows-user-specific paths in tracked files)
- [ ] Fresh Windows VM clone + setup + lighthouse_audit example.com → green
- [ ] Fresh Mac (Washed borrows one) clone + setup + lighthouse_audit example.com → green OR mark Mac as "untested" in README
- [ ] All 61 tests + smoke script pass
- [ ] `npm pack` (just for inspection) shows no surprise files in tarball
- [ ] README screenshot of working setup pasted into a gist for sanity

### Final reviewer prompt
"This is the LAST review before publish. Walk the README install path as a stranger. Identify any step where a friend would get stuck. Identify any leftover Washed-specific identifier."

---

## Wave dispatch order

W1 → W2 → W3 → W4 → W5. Strictly sequential — each wave's portability changes feed the next.

Estimated work: 3-4 hours per wave × 5 waves = 15-20 hours total. Could compress to 8-10 with parallel review/build.

## Drift signals (STOP)

- Adding new own-tools "while we're in here" — NO, that's a separate DAP
- Adding npm publish to the plan — NO, scope is GitHub-shareable only
- Bundling the pool wrapper "for completeness" — NO, decouple is the point
- Skipping Wave 5 because "everything looks fine" — NO, this is the highest-leverage wave

## When to actually run this

Trigger conditions (any one of these):
- A friend asks "can I use what you built?"
- Washed wants to put it on a personal site/portfolio
- An open-source maintainer of `browser-devtools-mcp` asks if we'd contribute the own-tools back (they might not, but the repo being public makes that conversation easier)

Until one of those, this plan sits here. Read on next pass.
