# browser-mcp-relay

Custom MCP server that wraps `browser-devtools-mcp` (upstream) with a relay
shim, allowing us to add tools beyond what upstream exposes.

## What it does
1. Reuses the pool/lock/cookie/role layer from `wrap-browser-devtools-mcp.js`
   to claim a profile dir and snapshot cookies.
2. Spawns upstream `browser-devtools-mcp` as a child process with piped stdio.
3. Acts as an MCP server, forwarding most tool calls to the upstream child
   and (in future phases) handling additional tools (Lighthouse, memory snapshot,
   device emulation, multi-tab, dialog, file upload, multi-field form fill)
   ourselves via direct CDP.

## Configured as
MCP entry `browser-devtools-mcp-relay` in `~/.claude.json`, separate from
the existing `browser-devtools-mcp-pool` entry. Coexists; either can be
disabled without affecting the other.

## Verify
- `node src/index.js` (manually launch; expect cookie snapshot + relay banner)
- `npm test` (unit tests)
- `node ../browser-mcp-doctor.js --pretty` (existing doctor; doesn't need changes)

## Phases
- Phase 0 — research (complete; see `docs/phase-0-research.md`)
- Phase A — pure forwarding relay infrastructure (this is what gets shipped first)
- Phase B — Strategy A CDP wiring (relay launches Brave, upstream attaches via CDP)
- Phase C — own-tool implementations (one per tool plan doc, written as we go)
- Phase D — migration playbook (optional repoint of the original entry)

## Environment variables

All paths the relay needs are auto-detected by default. Override them with these
env vars (or copy `local-config.example.json` → `local-config.json` for reference;
the relay reads env vars at runtime, the example file is documentation).

| Env var | Default | Purpose |
| --- | --- | --- |
| `BROWSER_RELAY_BRAVE_PATH` | auto-detect | Absolute path to brave/brave.exe. Auto-detect probes standard install locations on Win/Mac/Linux + Windows registry. |
| `BROWSER_RELAY_UPSTREAM_PATH` | `require.resolve("browser-devtools-mcp/dist/index.js")` | Path to upstream `browser-devtools-mcp` entry. The npm dep is the default; override to point at a custom build. |
| `BROWSER_RELAY_POOL_DIR` | unset (standalone mode) | Opt-in: absolute path to a single Brave user-data-dir to claim. Default standalone mode uses `<repo>/.browser-data`. |
| `BROWSER_RELAY_POOL_SLOT` | unset | Cosmetic slot index for the launch banner when pool mode is active. |
| `BROWSER_HEADLESS_ENABLE` | `false` | Set `true` to launch Brave headless. |
| `BROWSER_LOAD_EXTENSIONS` | unset | Path to an unpacked Chrome extension. |
| `BROWSER_MCP_ROLE` | unset | Role-based slot filter (only meaningful when the optional pool wrapper is present and `slotRoles` is configured). |

### Modes

- **Standalone (default)** — One Brave per relay process, profile stored at `<repo>/.browser-data`. No cookie snapshot. Suitable for a fresh clone.
- **Pool (opt-in)** — Set `BROWSER_RELAY_POOL_DIR` to a profile dir managed elsewhere. If a `wrap-browser-devtools-mcp.js` file is present two directories above this repo, its richer config (multi-slot pool, cookie snapshot from a dedicated source profile, slot roles) is reused. Otherwise pool mode behaves like standalone with a custom dir.
