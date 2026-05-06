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
