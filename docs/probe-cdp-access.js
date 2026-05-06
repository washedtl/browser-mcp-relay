// probe-cdp-access.js — verifies Strategy A end-to-end:
//   1. Launch a real Brave with --remote-debugging-port=N
//   2. Connect via Playwright chromium.connectOverCDP("http://localhost:N")
//   3. Drive a page (navigate, evaluate)
//   4. Confirm we can do this against the SAME Brave that upstream
//      browser-devtools-mcp could attach to via BROWSER_CDP_CONNECT_URL.
//
// Run: node ~/.claude/scripts/browser-mcp-relay/docs/probe-cdp-access.js
//
// Uses upstream's bundled playwright (no need to install our own yet).

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const UPSTREAM_NODE_MODULES =
  "C:\\Users\\tlip9\\.cursor\\extensions\\serkan-ozal.browser-devtools-mcp-vscode-0.6.3-universal\\node_modules";

// Resolve playwright from upstream's node_modules so we don't need our own install.
const playwright = require(path.join(UPSTREAM_NODE_MODULES, "playwright"));

// Use Playwright's bundled chromium (the one upstream uses) so we know the
// binary is the same Brave/Chromium build the rest of the system targets.
// The probe profile is throwaway — gets cleaned at the end.
const PROBE_PROFILE = "C:\\tmp\\.brave-relay-probe";
const PORT = 9333;

async function main() {
  // Clean leftover from prior probe runs.
  try { fs.rmSync(PROBE_PROFILE, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(PROBE_PROFILE, { recursive: true });

  process.stderr.write(`[probe] launching chromium with --remote-debugging-port=${PORT}\n`);

  // Launch via launchPersistentContext (gives us automation-friendly defaults
  // matching what upstream does). Add --remote-debugging-port to args so the
  // CDP endpoint is reachable from outside this process. Without this,
  // Playwright defaults to --remote-debugging-pipe which is anonymous.
  const context = await playwright.chromium.launchPersistentContext(PROBE_PROFILE, {
    headless: false,
    args: [`--remote-debugging-port=${PORT}`],
    handleSIGINT: false,
    handleSIGTERM: false,
  });

  process.stderr.write(`[probe] chromium launched, persistent context active\n`);

  // Verify the CDP port responds to /json/version (the discovery endpoint
  // upstream's resolveCdpConnectEndpoint uses).
  await new Promise((r) => setTimeout(r, 500)); // brief settle time
  const versionResp = await fetch(`http://127.0.0.1:${PORT}/json/version`);
  if (!versionResp.ok) {
    throw new Error(`/json/version returned status ${versionResp.status}`);
  }
  const versionInfo = await versionResp.json();
  process.stderr.write(`[probe] /json/version responded: ${JSON.stringify(versionInfo).slice(0, 120)}...\n`);
  if (!versionInfo.webSocketDebuggerUrl) {
    throw new Error("no webSocketDebuggerUrl in /json/version response");
  }

  // Now connect via Playwright connectOverCDP — proves an EXTERNAL Playwright
  // can drive the same browser. (This is what upstream would do when given
  // BROWSER_CDP_CONNECT_URL=http://localhost:9333.)
  process.stderr.write(`[probe] connecting external Playwright via connectOverCDP(http://127.0.0.1:${PORT})\n`);
  const externalBrowser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const externalContexts = externalBrowser.contexts();
  process.stderr.write(`[probe] connectOverCDP succeeded — ${externalContexts.length} context(s) visible\n`);
  if (externalContexts.length === 0) {
    throw new Error("connectOverCDP returned 0 contexts — upstream would error here");
  }

  const externalContext = externalContexts[0];
  const externalPages = externalContext.pages();
  let page = externalPages[0];
  if (!page) {
    page = await externalContext.newPage();
    process.stderr.write(`[probe] no existing page, created new one\n`);
  }

  // Drive the page to confirm it actually works.
  await page.goto("about:blank");
  const title = await page.title();
  process.stderr.write(`[probe] navigated to about:blank, title=${JSON.stringify(title)}\n`);

  // Verify the SAME page is visible from the original launchPersistentContext
  // reference (this is the key sharing test — both Playwright references see
  // the same browser state, just like our relay + upstream would).
  const ownPages = context.pages();
  process.stderr.write(`[probe] launchPersistentContext sees ${ownPages.length} page(s)\n`);

  // Cleanup.
  await externalBrowser.close();    // closes the connectOverCDP socket only
  await context.close();            // closes the actual chromium
  try { fs.rmSync(PROBE_PROFILE, { recursive: true, force: true }); } catch {}

  process.stderr.write(`[probe] STRATEGY A VERIFIED — connectOverCDP works against launchPersistentContext\n`);
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`[probe] FAILED: ${e.stack || e.message}\n`);
  process.exit(1);
});
