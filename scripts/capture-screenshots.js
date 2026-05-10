#!/usr/bin/env node
/**
 * scripts/capture-screenshots.js — Regenerate docs/screenshots/*.png from the
 * live Inspector. Closes the screenshot-drift gap (e.g. README hero showing
 * "TOOLS 67" months after the relay grew to 70).
 *
 * Flow:
 *   1. Spawn the relay's standalone inspector at a unique port
 *   2. Drive Playwright through each canonical page
 *   3. Save 1440×900 PNGs to docs/screenshots/
 *   4. Tear down the inspector
 *
 * Run:  npm run capture-screenshots
 *
 * Notes:
 *   • Standalone inspector (no relay traffic). Activity feed will be empty;
 *     that's intentional — we want clean canonical screenshots, not traffic-
 *     dependent state.
 *   • Listens on port 9094 by default to avoid clashing with a real relay's
 *     in-process inspector at 9091. Override via CAPTURE_INSPECTOR_PORT.
 *   • Uses the relay's own Playwright dependency — no extra install.
 */

const path = require("node:path");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const { chromium } = require("playwright-core");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCREENSHOTS_DIR = path.join(REPO_ROOT, "docs", "screenshots");
const INSPECTOR_PORT = parseInt(process.env.CAPTURE_INSPECTOR_PORT, 10) || 9094;
const VIEWPORT = { width: 1440, height: 900 };

// Pages to capture. The names match docs/screenshots/*.png that the README +
// REFERENCE.md reference. Keep this list aligned with REFERENCE.md's
// "Inspector → Pages" table.
const PAGES = [
  { route: "/", file: "01-pool-overview.png", label: "Pool overview" },
  { route: "/tools", file: "03-tools-catalog.png", label: "Tools catalog" },
  { route: "/activity", file: "04-activity-history.png", label: "Activity history" },
  { route: "/settings", file: "06-settings.png", label: "Settings" },
  // Slot detail (02) is captured separately because it needs a slot index.
  // We default to slot 1 — the inspector renders an empty per-slot page when
  // there's no real relay attached, which is fine for a canonical shot.
  { route: "/slot/1", file: "02-slot-detail.png", label: "Slot detail" },
];

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/status`);
      if (r.ok) return;
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Inspector at :${port} did not become ready within ${timeoutMs}ms`);
}

async function captureOne(browser, route, outFile, label) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const url = `http://127.0.0.1:${INSPECTOR_PORT}${route}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
  // Small settle delay — the inspector's first paint sometimes finishes a
  // microtask after networkidle when async data fetches resolve.
  await page.waitForTimeout(400);
  await page.screenshot({ path: outFile, fullPage: false });
  await page.close();
  console.log(`  ✓ ${label.padEnd(20)} → ${path.relative(REPO_ROOT, outFile)}`);
}

async function main() {
  console.log("[capture-screenshots] starting standalone inspector on port " + INSPECTOR_PORT);
  await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });

  const inspector = spawn(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "inspector.js")],
    {
      env: {
        ...process.env,
        BROWSER_RELAY_INSPECTOR_PORT: String(INSPECTOR_PORT),
        BROWSER_RELAY_INSPECTOR_BIND: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let inspectorErr = "";
  inspector.stderr.on("data", (chunk) => { inspectorErr += chunk.toString(); });

  // Tear down on any exit path.
  const teardown = () => {
    if (process.platform === "win32") {
      try {
        require("node:child_process").execSync(
          `taskkill /F /T /PID ${inspector.pid}`,
          { stdio: "ignore", windowsHide: true },
        );
      } catch { /* already gone */ }
    } else {
      try { inspector.kill("SIGTERM"); } catch { /* already gone */ }
    }
  };
  process.on("exit", teardown);
  process.on("SIGINT", () => { teardown(); process.exit(130); });
  process.on("SIGTERM", () => { teardown(); process.exit(143); });

  try {
    await waitForPort(INSPECTOR_PORT);
    console.log("[capture-screenshots] inspector ready, launching headless Brave");

    // Use Playwright's bundled chromium — we don't need Brave for capturing
    // screenshots of an HTML page that the inspector serves. The relay's
    // launchPersistentContext path is for when we need a real authed Brave;
    // capture-screenshots just needs ANY chromium.
    const browser = await chromium.launch({ headless: true });
    try {
      for (const { route, file, label } of PAGES) {
        const out = path.join(SCREENSHOTS_DIR, file);
        await captureOne(browser, route, out, label);
      }
    } finally {
      await browser.close();
    }

    // Regenerate hero.png from the fresh tools-catalog screenshot.
    // Best-effort — if Python or Pillow isn't available, fall through with a
    // visible warning rather than failing the whole capture run.
    try {
      const { spawnSync } = require("node:child_process");
      console.log("[capture-screenshots] regenerating docs/hero.png...");
      const r = spawnSync("python", [path.join(REPO_ROOT, "scripts", "build-hero.py")], {
        stdio: ["ignore", "inherit", "inherit"],
        timeout: 30000,
      });
      if (r.status !== 0) {
        console.warn("[capture-screenshots] build-hero.py exited", r.status, "— hero may be stale");
      }
    } catch (e) {
      console.warn("[capture-screenshots] couldn't run build-hero.py (skipping):", e.message);
    }

    console.log("[capture-screenshots] done");
  } catch (e) {
    console.error("[capture-screenshots] FAILED:", e.message);
    if (inspectorErr) {
      console.error("[capture-screenshots] inspector stderr tail:");
      console.error(inspectorErr.slice(-1000));
    }
    teardown();
    process.exit(1);
  } finally {
    teardown();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[capture-screenshots] fatal:", e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { main, PAGES, INSPECTOR_PORT };
