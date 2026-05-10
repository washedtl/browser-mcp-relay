// detect-browser.js — cross-platform Brave executable detection.
//
// Order of resolution:
//   1. BROWSER_RELAY_BRAVE_PATH env var (explicit override; verified to exist).
//   2. Per-platform standard install locations (Stable, Beta, Nightly, Dev
//      across system + per-user Program Files / LOCALAPPDATA on win32; matching
//      `.app` bundles on darwin; channel-named binaries on linux).
//   3. (Windows only) Registry probe across HKLM + HKCU for all four channels
//      via PowerShell as a last resort.
//   4. Throw a clear, actionable error.
//
// Pure module — no top-level filesystem or process work, so requiring it
// from tests is cheap.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

// Brave profile/user-data directory (parent of the per-profile subfolders
// like `Default/`). The cookie file lives at `<profileDir>/Default/Network/Cookies`
// (modern Chromium 92+) with a fallback to `<profileDir>/Default/Cookies`.

/**
 * Resolve the Brave executable path for the current platform.
 *
 * Lookup order:
 *   - BROWSER_RELAY_BRAVE_PATH env var (must exist on disk if set)
 *   - Platform-specific standard locations (file existence)
 *   - Windows: PowerShell `which` (Get-Command) as final probe
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {string} [opts.platform=process.platform] — "win32"|"darwin"|"linux"
 * @param {(p: string) => boolean} [opts.exists] — file-existence probe (test seam)
 * @param {(cmd: string, args: string[]) => { status: number, stdout: string }} [opts.spawnSync] — test seam
 * @returns {string} absolute path to brave
 * @throws {Error} with a helpful message listing the locations checked
 */
function detectBravePath(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const exists = opts.exists || ((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
  const spawn = opts.spawnSync || spawnSync;

  // 1. Explicit override.
  const override = env.BROWSER_RELAY_BRAVE_PATH;
  if (override && override.length > 0) {
    if (exists(override)) return override;
    throw new Error(
      `[browser-mcp-relay] BROWSER_RELAY_BRAVE_PATH is set to "${override}" but no file exists there. ` +
      `Either fix the path or unset the env var to fall back to auto-detect.`,
    );
  }

  const candidates = standardLocations(platform, env);
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }

  // 2. Final probes (platform-specific).
  if (platform === "linux" || platform === "darwin") {
    const which = spawn("which", ["brave-browser"], { encoding: "utf8" });
    if (which && which.status === 0 && which.stdout) {
      const resolved = which.stdout.trim().split(/\r?\n/)[0];
      if (resolved && exists(resolved)) return resolved;
    }
    const whichBrave = spawn("which", ["brave"], { encoding: "utf8" });
    if (whichBrave && whichBrave.status === 0 && whichBrave.stdout) {
      const resolved = whichBrave.stdout.trim().split(/\r?\n/)[0];
      if (resolved && exists(resolved)) return resolved;
    }
  } else if (platform === "win32") {
    // Registry probe — only fires if file probes all missed. Cheap-ish
    // but we put it last so happy paths never shell out to PowerShell.
    //
    // F1-8 (2026-05-10): probe BOTH HKLM (system-wide install) AND HKCU
    // (per-user install, which is the default for unprivileged installers
    // and the LOCALAPPDATA install path). Stable channel only — Brave's
    // pre-release channels use distinct keys (Brave-Browser-Beta etc.)
    // which would expand this list further; if a user has only pre-release
    // Brave installed AND it's in a non-standard location AND the file
    // probes missed it, we fall through to the generic not-found error.
    // That's an acceptable corner case.
    const probes = [
      "HKLM:\\Software\\BraveSoftware\\Brave-Browser\\BLBeacon",
      "HKCU:\\Software\\BraveSoftware\\Brave-Browser\\BLBeacon",
      "HKLM:\\Software\\BraveSoftware\\Brave-Browser-Beta\\BLBeacon",
      "HKCU:\\Software\\BraveSoftware\\Brave-Browser-Beta\\BLBeacon",
      "HKLM:\\Software\\BraveSoftware\\Brave-Browser-Nightly\\BLBeacon",
      "HKCU:\\Software\\BraveSoftware\\Brave-Browser-Nightly\\BLBeacon",
      "HKLM:\\Software\\BraveSoftware\\Brave-Browser-Dev\\BLBeacon",
      "HKCU:\\Software\\BraveSoftware\\Brave-Browser-Dev\\BLBeacon",
    ];
    const psSnippet = probes
      .map((p) => `(Get-ItemProperty -Path '${p}' -ErrorAction SilentlyContinue).version`)
      .join("; ");
    const reg = spawn(
      "powershell",
      ["-NoProfile", "-Command", psSnippet],
      { encoding: "utf8", windowsHide: true },
    );
    // Registry just confirms install; file path is still under PROGRAMFILES.
    // If the registry says it's installed but our file probes missed it,
    // log a hint and continue to throw.
    if (reg && reg.status === 0 && reg.stdout && reg.stdout.trim().length > 0) {
      // First non-empty version line wins (stable preferred — listed first).
      const version = reg.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      throw braveNotFoundError(candidates, platform, {
        registryVersion: version || reg.stdout.trim(),
      });
    }
  }

  throw braveNotFoundError(candidates, platform);
}

/**
 * F1-15: homedir for the *requested* platform. When `standardLocations` is
 * called with the current platform (the production case via detectBravePath),
 * `os.homedir()` is correct. When called with a different platform from
 * tests / cross-host introspection, `os.homedir()` would produce a path
 * shape (separator + casing) that doesn't match the requested platform.
 * Fall back to a generic posix-style root so the returned paths are
 * coherent for the requested platform.
 */
function posixHomedirOrFallback(fallback) {
  const home = os.homedir();
  // If host's homedir contains a backslash or drive-letter, it's a Windows
  // homedir — not a meaningful base for posix-style paths.
  if (typeof home === "string" && home.length > 0 && home.charAt(0) === "/") return home;
  return fallback;
}

/**
 * Per-platform list of standard Brave install paths to probe (in order).
 * Pure helper — exposed so tests can assert per-OS expectations directly
 * without needing to fake `fs.statSync`.
 */
function standardLocations(platform, env) {
  if (platform === "win32") {
    const programFiles = env.PROGRAMFILES || "C:\\Program Files";
    const programFilesX86 = env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    // F1-8 (2026-05-10): probe Brave Beta / Nightly / Dev install dirs in
    // addition to stable. Stable wins when multiple are installed (it's
    // listed first); other channels are fallbacks for users who only have
    // pre-release Brave installed.
    const channels = ["Brave-Browser", "Brave-Browser-Beta", "Brave-Browser-Nightly", "Brave-Browser-Dev"];
    const roots = [programFiles, programFilesX86, localAppData];
    const out = [];
    for (const ch of channels) {
      for (const root of roots) {
        out.push(path.join(root, "BraveSoftware", ch, "Application", "brave.exe"));
      }
    }
    return out;
  }
  if (platform === "darwin") {
    // F1-8: Beta/Nightly/Dev .app bundles use distinct names on macOS.
    //
    // F1-15 (2026-05-10): use path.posix.join + a posix-style homedir so
    // calling this with platform="darwin" from a Windows / Linux host
    // (tests, cross-host introspection) produces correct macOS paths
    // instead of mixing the host's separator convention. Production is
    // unaffected because detectBravePath only passes process.platform,
    // but the helper now matches its "per-platform" docstring claim.
    const apps = [
      "Brave Browser.app",
      "Brave Browser Beta.app",
      "Brave Browser Nightly.app",
      "Brave Browser Dev.app",
    ];
    const home = posixHomedirOrFallback("/Users/local");
    const out = [];
    for (const app of apps) {
      const inner = app.replace(/\.app$/, "");
      out.push(`/Applications/${app}/Contents/MacOS/${inner}`);
      out.push(path.posix.join(home, "Applications", app, "Contents", "MacOS", inner));
    }
    return out;
  }
  if (platform === "linux") {
    return [
      "/usr/bin/brave-browser",
      "/usr/bin/brave",
      "/usr/bin/brave-browser-beta",
      "/usr/bin/brave-browser-nightly",
      "/usr/bin/brave-browser-dev",
      "/snap/bin/brave",
      "/opt/brave.com/brave/brave-browser",
      "/opt/brave.com/brave/brave",
      "/opt/brave.com/brave-beta/brave-browser-beta",
      "/opt/brave.com/brave-nightly/brave-browser-nightly",
      "/opt/brave.com/brave-dev/brave-browser-dev",
    ];
  }
  return [];
}

function braveNotFoundError(candidates, platform, extra = {}) {
  const locList = candidates.length > 0
    ? candidates.map((c) => `  - ${c}`).join("\n")
    : "  (no standard locations known for this platform)";
  const hint = extra.registryVersion
    ? `\nWindows registry indicates Brave ${extra.registryVersion} is installed, but the executable wasn't at any standard path. ` +
      `Set BROWSER_RELAY_BRAVE_PATH to the actual brave.exe location.`
    : "";
  return new Error(
    `[browser-mcp-relay] Brave not found on platform "${platform}". ` +
    `Install Brave (https://brave.com/download/) or set BROWSER_RELAY_BRAVE_PATH=/path/to/brave.\n` +
    `Checked these locations:\n${locList}${hint}`,
  );
}

/**
 * Resolve the Brave user-data-dir (parent of profile subfolders like `Default/`).
 *
 * Returned path is the directory; the cookie SQLite store lives at
 * `<profileDir>/Default/Network/Cookies` (modern) or `<profileDir>/Default/Cookies`
 * (legacy, pre-Chromium-92). Use {@link findCookiesFile} from `pool-shared.js`
 * to resolve to the actual file with fallback.
 *
 * Lookup order:
 *   1. BROWSER_RELAY_BRAVE_PROFILE_DIR env var (used as-is, even if missing —
 *      caller decides whether to verify existence).
 *   2. Per-platform default location.
 *
 * Returns null on unknown platforms.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {NodeJS.Platform} [opts.platform=process.platform]
 * @param {string} [opts.homedir=os.homedir()] — test seam
 * @returns {string | null}
 */
function detectBraveProfileDir(opts = {}) {
  const env = opts.env || process.env;
  const platform = opts.platform || process.platform;
  const homedir = opts.homedir || os.homedir();

  const override = env.BROWSER_RELAY_BRAVE_PROFILE_DIR;
  if (override && override.length > 0) return override;

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(homedir, "AppData", "Local");
    return path.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data");
  }
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "BraveSoftware", "Brave-Browser");
  }
  if (platform === "linux") {
    // Brave on Linux honors XDG_CONFIG_HOME, fall back to ~/.config per spec.
    const xdgConfigHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : path.join(homedir, ".config");
    return path.join(xdgConfigHome, "BraveSoftware", "Brave-Browser");
  }
  return null;
}

module.exports = {
  detectBravePath,
  detectBraveProfileDir,
  standardLocations,
};
