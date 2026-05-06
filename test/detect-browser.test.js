const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

const { detectBravePath, detectBraveProfileDir, standardLocations } = require("../src/detect-browser.js");

// Test seam helpers ─ keep the actual fs/spawn isolated from these unit tests
// so they don't depend on whether the host has Brave installed.

function fakeExists(allow) {
  // allow is a Set of paths considered "real"
  return (p) => allow.has(p);
}

function fakeSpawn(_cmd, _args) {
  // Default fake: command not found → status non-zero
  return { status: 1, stdout: "" };
}

// ───── BROWSER_RELAY_BRAVE_PATH override ─────

test("detectBravePath returns the env override when the file exists", () => {
  const result = detectBravePath({
    env: { BROWSER_RELAY_BRAVE_PATH: "/custom/brave" },
    platform: "linux",
    exists: fakeExists(new Set(["/custom/brave"])),
    spawnSync: fakeSpawn,
  });
  assert.strictEqual(result, "/custom/brave");
});

test("detectBravePath throws a clear error when env override points at a missing file", () => {
  assert.throws(
    () =>
      detectBravePath({
        env: { BROWSER_RELAY_BRAVE_PATH: "/missing/brave" },
        platform: "linux",
        exists: fakeExists(new Set()),
        spawnSync: fakeSpawn,
      }),
    /BROWSER_RELAY_BRAVE_PATH.*\/missing\/brave.*no file/i,
  );
});

// ───── Linux ─────

test("detectBravePath finds /usr/bin/brave-browser on Linux", () => {
  const result = detectBravePath({
    env: {},
    platform: "linux",
    exists: fakeExists(new Set(["/usr/bin/brave-browser"])),
    spawnSync: fakeSpawn,
  });
  assert.strictEqual(result, "/usr/bin/brave-browser");
});

test("detectBravePath falls through to `which brave-browser` on Linux when no standard path matches", () => {
  let calls = 0;
  const result = detectBravePath({
    env: {},
    platform: "linux",
    exists: fakeExists(new Set(["/opt/custom/brave-browser"])),
    spawnSync: (_cmd, args) => {
      calls++;
      if (args[0] === "brave-browser") {
        return { status: 0, stdout: "/opt/custom/brave-browser\n" };
      }
      return { status: 1, stdout: "" };
    },
  });
  assert.strictEqual(result, "/opt/custom/brave-browser");
  assert.ok(calls >= 1, "should have shelled out to which");
});

test("detectBravePath throws on Linux when nothing is found", () => {
  assert.throws(
    () =>
      detectBravePath({
        env: {},
        platform: "linux",
        exists: fakeExists(new Set()),
        spawnSync: fakeSpawn,
      }),
    /Brave not found.*linux/i,
  );
});

// ───── macOS ─────

test("detectBravePath finds the standard /Applications path on macOS", () => {
  const macStd = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
  const result = detectBravePath({
    env: {},
    platform: "darwin",
    exists: fakeExists(new Set([macStd])),
    spawnSync: fakeSpawn,
  });
  assert.strictEqual(result, macStd);
});

test("detectBravePath throws on macOS when nothing is found", () => {
  assert.throws(
    () =>
      detectBravePath({
        env: {},
        platform: "darwin",
        exists: fakeExists(new Set()),
        spawnSync: fakeSpawn,
      }),
    /Brave not found.*darwin/i,
  );
});

// ───── Windows ─────

test("detectBravePath finds the PROGRAMFILES path on Windows", () => {
  const env = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  };
  const winStd = path.join(env.PROGRAMFILES, "BraveSoftware", "Brave-Browser", "Application", "brave.exe");
  const result = detectBravePath({
    env,
    platform: "win32",
    exists: fakeExists(new Set([winStd])),
    spawnSync: fakeSpawn,
  });
  assert.strictEqual(result, winStd);
});

test("detectBravePath falls through to LOCALAPPDATA on Windows", () => {
  const env = {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  };
  const localApp = path.join(env.LOCALAPPDATA, "BraveSoftware", "Brave-Browser", "Application", "brave.exe");
  const result = detectBravePath({
    env,
    platform: "win32",
    exists: fakeExists(new Set([localApp])),
    spawnSync: fakeSpawn,
  });
  assert.strictEqual(result, localApp);
});

test("detectBravePath probes the Windows registry as a last resort and reports it in the error", () => {
  assert.throws(
    () =>
      detectBravePath({
        env: { PROGRAMFILES: "C:\\Program Files" },
        platform: "win32",
        exists: fakeExists(new Set()),
        spawnSync: (_cmd, args) => {
          if (args.some((a) => typeof a === "string" && a.includes("BLBeacon"))) {
            return { status: 0, stdout: "1.83.117\r\n" };
          }
          return { status: 1, stdout: "" };
        },
      }),
    /registry.*1\.83\.117|registry indicates Brave 1\.83\.117/i,
  );
});

// ───── standardLocations pure helper ─────

test("standardLocations returns 3 paths on Windows in the expected order", () => {
  const env = {
    PROGRAMFILES: "C:\\PF",
    "PROGRAMFILES(X86)": "C:\\PF86",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  };
  const locs = standardLocations("win32", env);
  assert.strictEqual(locs.length, 3);
  assert.match(locs[0], /^C:\\PF\\BraveSoftware/);
  assert.match(locs[1], /^C:\\PF86\\BraveSoftware/);
  assert.match(locs[2], /^C:\\Users\\u\\AppData\\Local\\BraveSoftware/);
});

test("standardLocations returns at least one entry on darwin and linux", () => {
  assert.ok(standardLocations("darwin", {}).length >= 1);
  assert.ok(standardLocations("linux", {}).length >= 1);
});

test("standardLocations returns [] for unknown platforms", () => {
  assert.deepStrictEqual(standardLocations("freebsd", {}), []);
});

// ───── detectBraveProfileDir ─────

test("detectBraveProfileDir returns the env override when set", () => {
  const result = detectBraveProfileDir({
    env: { BROWSER_RELAY_BRAVE_PROFILE_DIR: "/custom/profile" },
    platform: "linux",
    homedir: "/home/u",
  });
  assert.strictEqual(result, "/custom/profile");
});

test("detectBraveProfileDir on Win uses LOCALAPPDATA\\BraveSoftware\\Brave-Browser\\User Data", () => {
  const result = detectBraveProfileDir({
    env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
    platform: "win32",
    homedir: "C:\\Users\\u",
  });
  assert.strictEqual(
    result,
    path.join("C:\\Users\\u\\AppData\\Local", "BraveSoftware", "Brave-Browser", "User Data"),
  );
});

test("detectBraveProfileDir on Win falls back to homedir\\AppData\\Local when LOCALAPPDATA is unset", () => {
  const result = detectBraveProfileDir({
    env: {},
    platform: "win32",
    homedir: "C:\\Users\\fallback",
  });
  assert.match(result, /AppData[\\/]Local[\\/]BraveSoftware[\\/]Brave-Browser[\\/]User Data$/);
});

test("detectBraveProfileDir on darwin uses ~/Library/Application Support/BraveSoftware/Brave-Browser", () => {
  const result = detectBraveProfileDir({
    env: {},
    platform: "darwin",
    homedir: "/Users/u",
  });
  assert.strictEqual(
    result,
    path.join("/Users/u", "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
  );
});

test("detectBraveProfileDir on linux uses ~/.config/BraveSoftware/Brave-Browser", () => {
  const result = detectBraveProfileDir({
    env: {},
    platform: "linux",
    homedir: "/home/u",
  });
  assert.strictEqual(
    result,
    path.join("/home/u", ".config", "BraveSoftware", "Brave-Browser"),
  );
});

test("detectBraveProfileDir on linux honors XDG_CONFIG_HOME when set", () => {
  const result = detectBraveProfileDir({
    env: { XDG_CONFIG_HOME: "/custom/config" },
    platform: "linux",
    homedir: "/home/u",
  });
  assert.strictEqual(
    result,
    path.join("/custom/config", "BraveSoftware", "Brave-Browser"),
  );
});

test("detectBraveProfileDir on linux ignores empty XDG_CONFIG_HOME", () => {
  const result = detectBraveProfileDir({
    env: { XDG_CONFIG_HOME: "" },
    platform: "linux",
    homedir: "/home/u",
  });
  assert.strictEqual(
    result,
    path.join("/home/u", ".config", "BraveSoftware", "Brave-Browser"),
  );
});

test("detectBraveProfileDir returns null on unknown platforms", () => {
  assert.strictEqual(
    detectBraveProfileDir({ env: {}, platform: "freebsd", homedir: "/home/u" }),
    null,
  );
});
