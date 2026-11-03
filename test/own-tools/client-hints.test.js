const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const {
  clientHintsFromUA, CLIENT_HINTS_SOURCE,
  navigatorPlatformFromHints, NAVIGATOR_PLATFORM_SOURCE,
} = require("../../src/own-tools/_client-hints.js");

// One generator feeds BOTH emulate_device (CDP userAgentMetadata → HTTP
// Sec-CH-UA-*) and stealth_apply (in-page navigator.userAgentData). Values
// follow Chromium's own rules (content/common/user_agent.cc +
// embedder_support/user_agent_utils.cc): no arch/bitness on Android, Mac is
// always 64-bit, Linux reports an empty platformVersion.

const UAS = {
  win: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  winFull: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.6533.120 Safari/537.36",
  winWow64: "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  win32: "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  macFrozen: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  mac14: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  linux: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  linuxArm: "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
  androidBuild: "Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A.220624.014) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
  androidReduced: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile/15E148 Safari/604.1",
  cros: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  crosArm32: "Mozilla/5.0 (X11; CrOS armv7l 15964.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0",
  opera: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 OPR/134.0.0.0",
};
const chromeUA = (major, os = "Windows NT 10.0; Win64; x64") =>
  `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

// Serialize a brand list the way Chromium writes the Sec-CH-UA header.
const header = (list) => list.map((b) => `"${b.brand}";v="${b.version}"`).join(", ");

const pick = (o) => ({
  platform: o.platform, platformVersion: o.platformVersion, architecture: o.architecture,
  bitness: o.bitness, model: o.model, mobile: o.mobile, wow64: o.wow64,
});

test("clientHintsFromUA: per-platform values", () => {
  const cases = {
    win: { platform: "Windows", platformVersion: "15.0.0", architecture: "x86", bitness: "64", model: "", mobile: false, wow64: false },
    winWow64: { platform: "Windows", platformVersion: "15.0.0", architecture: "x86", bitness: "64", model: "", mobile: false, wow64: true },
    win32: { platform: "Windows", platformVersion: "15.0.0", architecture: "x86", bitness: "32", model: "", mobile: false, wow64: false },
    // The Mac UA token is frozen at 10_15_7 even on Apple Silicon; Chrome
    // (and our WebGL "Apple M1" string) imply a modern arm64 macOS.
    macFrozen: { platform: "macOS", platformVersion: "14.0.0", architecture: "arm", bitness: "64", model: "", mobile: false, wow64: false },
    mac14: { platform: "macOS", platformVersion: "14.5.0", architecture: "arm", bitness: "64", model: "", mobile: false, wow64: false },
    linux: { platform: "Linux", platformVersion: "", architecture: "x86", bitness: "64", model: "", mobile: false, wow64: false },
    linuxArm: { platform: "Linux", platformVersion: "", architecture: "arm", bitness: "64", model: "", mobile: false, wow64: false },
    android: { platform: "Android", platformVersion: "14.0.0", architecture: "", bitness: "", model: "Pixel 8", mobile: true, wow64: false },
    androidBuild: { platform: "Android", platformVersion: "13.0.0", architecture: "", bitness: "", model: "SM-S918B", mobile: true, wow64: false },
    androidReduced: { platform: "Android", platformVersion: "10.0.0", architecture: "", bitness: "", model: "", mobile: true, wow64: false },
    iphone: { platform: "iOS", platformVersion: "17.0.0", architecture: "arm", bitness: "64", model: "", mobile: true, wow64: false },
    cros: { platform: "Chrome OS", platformVersion: "14541.0.0", architecture: "x86", bitness: "64", model: "", mobile: false, wow64: false },
    // "64" inside the build number must not read as 64-bit.
    crosArm32: { platform: "Chrome OS", platformVersion: "15964.0.0", architecture: "arm", bitness: "32", model: "", mobile: false, wow64: false },
  };
  for (const [k, expected] of Object.entries(cases)) {
    assert.deepStrictEqual(pick(clientHintsFromUA(UAS[k])), expected, k);
  }
});

// ─── STEALTH2-1/2: GREASE brand + brand order, ported from Chromium ───
// components/embedder_support/user_agent_utils.cc (GenerateBrandVersionList,
// GetGreasedUserAgentBrandVersion, GetRandomOrder + ShuffleBrandList), seeded
// by the major version. Expected values are what real Chrome sent, as
// published independently of this port (crbug 358138960 for 127, the npm
// ua-hints README / StackOverflow 77656730 for 120, DeviceDetector.NET #88
// for 131, reqxide #1 for 132, clearcotelabs.com for 156).
test("STEALTH2-1/2: Chrome UAs get Chrome's exact Sec-CH-UA (GREASE brand, version, order, Google Chrome brand)", () => {
  const real = {
    120: '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    127: '"Not)A;Brand";v="99", "Google Chrome";v="127", "Chromium";v="127"',
    131: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    132: '"Not A(Brand";v="8", "Chromium";v="132", "Google Chrome";v="132"',
    156: '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
  };
  for (const [major, expected] of Object.entries(real)) {
    assert.strictEqual(header(clientHintsFromUA(chromeUA(major)).brands), expected, `Chrome ${major}`);
  }
});

test("STEALTH2-1: all six brand orders match lists measured on real Chrome builds", () => {
  // major % 6 picks the order. Measured on Google Chrome 152-155 per
  // clearcotelabs.com/chrome-user-agent (2026-11-03); with 120 (order 0)
  // and 127 (order 1) above, every order is pinned by a real header.
  const measured = {
    152: '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"', // order 2
    153: '"Google Chrome";v="153", "Not_A Brand";v="8", "Chromium";v="153"', // order 3
    154: '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"', // order 4
    155: '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"', // order 5
  };
  for (const [major, expected] of Object.entries(measured)) {
    assert.strictEqual(header(clientHintsFromUA(chromeUA(major)).brands), expected, `Chrome ${major}`);
  }
});

test("STEALTH2-1: unbranded 2-entry order follows the major's parity (GREASE at major % 2)", () => {
  // GetRandomOrder size 2: {seed % 2, (seed + 1) % 2}; 148 (even) is above.
  const edge149 = UAS.edge.replace(/148/g, "149");
  assert.strictEqual(header(clientHintsFromUA(edge149).brands), '"Chromium";v="149", "Not)A;Brand";v="24"');
});

test("STEALTH2-2: a HeadlessChrome UA keeps Chrome's brand list (headless Chrome sends Google Chrome hints)", () => {
  const headless = chromeUA(147, "X11; Linux x86_64").replace("Chrome/", "HeadlessChrome/");
  assert.strictEqual(header(clientHintsFromUA(headless).brands), header(clientHintsFromUA(chromeUA(147)).brands));
});

test("STEALTH2-1: brand slots match the live Brave 147 capture (same algorithm, brand \"Brave\")", () => {
  // Captured 2026-11-03 from Brave 1.89.143 / Chromium 147 (throwaway
  // profile): Brave, Not.A/Brand v8, Chromium. Chrome takes the Brave slot.
  assert.strictEqual(header(clientHintsFromUA(chromeUA(147)).brands),
    '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"');
});

test("STEALTH2-2: non-Chrome Chromium browsers are not labelled Google Chrome (Chromium's unbranded 2-entry list)", () => {
  // A Chromium build (no brand) at 148 sends "Not/A)Brand";v="99", "Chromium";v="148".
  for (const ua of [UAS.edge, UAS.opera]) {
    const h = clientHintsFromUA(ua);
    assert.strictEqual(header(h.brands), '"Not/A)Brand";v="99", "Chromium";v="148"', ua);
    assert.ok(!h.fullVersionList.some((b) => b.brand === "Google Chrome"), ua);
  }
});

test("STEALTH2-1: fullVersionList uses the same order; GREASE full version is <v>.0.0.0", () => {
  const h = clientHintsFromUA(chromeUA(131));
  assert.deepStrictEqual(h.fullVersionList.map((b) => b.brand), h.brands.map((b) => b.brand));
  assert.deepStrictEqual(h.fullVersionList.find((b) => b.brand === "Not_A Brand"), { brand: "Not_A Brand", version: "24.0.0.0" });
});

// ─── STEALTH2-3: a real Chrome full version, never x.0.0.0 ───────────
test("STEALTH2-3: a reduced UA (x.0.0.0) gets a real stable Chrome build in fullVersionList + fullVersion", () => {
  // The highest version Chrome shipped to Windows, Mac AND Linux in that
  // milestone (chromiumdash.appspot.com fetch_releases, 2026-11-03).
  const real = { 120: "120.0.6099.216", 127: "127.0.6533.119", 131: "131.0.6778.264", 147: "147.0.7727.137" };
  for (const [major, full] of Object.entries(real)) {
    const h = clientHintsFromUA(chromeUA(major));
    assert.strictEqual(h.fullVersion, full, `Chrome ${major}`);
    for (const brand of ["Google Chrome", "Chromium"]) {
      assert.strictEqual(h.fullVersionList.find((b) => b.brand === brand).version, full, `${brand} ${major}`);
    }
  }
});

test("STEALTH2-3: an unreduced UA keeps its own full version (UA string and hints agree)", () => {
  const h = clientHintsFromUA(UAS.winFull);
  assert.strictEqual(h.brands.find((b) => b.brand === "Chromium").version, "127");
  assert.strictEqual(h.fullVersion, "127.0.6533.120");
  assert.strictEqual(h.fullVersionList.find((b) => b.brand === "Google Chrome").version, "127.0.6533.120");
});

test("STEALTH2-3: every major from 100 up gets a plausible, strictly increasing build (incl. majors past the table)", () => {
  let lastBuild = 0;
  for (let major = 100; major <= 175; major++) {
    const v = clientHintsFromUA(chromeUA(major)).fullVersion;
    const m = v.match(/^(\d+)\.0\.(\d{4,})\.(\d+)$/);
    assert.ok(m, `Chrome ${major}: ${v}`);
    assert.strictEqual(Number(m[1]), major);
    assert.ok(Number(m[3]) > 0, `Chrome ${major}: patch must not be 0 (${v})`);
    assert.ok(Number(m[2]) > lastBuild, `Chrome ${major}: build ${m[2]} must exceed ${lastBuild}`);
    lastBuild = Number(m[2]);
  }
  // Spot-check builds against chromiumdash's milestone branch numbers.
  const branch = { 100: 4896, 120: 6099, 140: 7339, 156: 8078, 157: 8103 };
  for (const [major, build] of Object.entries(branch)) {
    assert.strictEqual(clientHintsFromUA(chromeUA(major)).fullVersion.split(".")[2], String(build), `Chrome ${major}`);
  }
});

test("STEALTH2-3: formFactors follow the mobile bit (else Chromium keeps the host's own)", () => {
  assert.deepStrictEqual(clientHintsFromUA(UAS.win).formFactors, ["Desktop"]);
  assert.deepStrictEqual(clientHintsFromUA(UAS.android).formFactors, ["Mobile"]);
});

test("clientHintsFromUA: has exactly the CDP Emulation.UserAgentMetadata fields", () => {
  // fullVersion (deprecated) and formFactors left unset fall back to the
  // HOST browser's values in Chromium (emulation_handler.cc), e.g. an
  // emulated Chrome 131 reported uaFullVersion "147.0.0.0" in Brave 147.
  assert.deepStrictEqual(Object.keys(clientHintsFromUA(UAS.win)).sort(),
    ["architecture", "bitness", "brands", "formFactors", "fullVersion", "fullVersionList", "mobile", "model", "platform", "platformVersion", "wow64"]);
});

test("clientHintsFromUA: tolerates non-string input instead of throwing", () => {
  assert.strictEqual(clientHintsFromUA(undefined).platform, "Windows");
  assert.ok(clientHintsFromUA(123).brands.some((b) => b.brand === "Chromium"));
});

// ─── STEALTH2-4: navigator.platform ──────────────────────────────────
test("STEALTH2-4: navigatorPlatformFromHints returns Chromium's reduced navigator.platform for the UA's OS", () => {
  // third_party/blink/renderer/core/execution_context/navigator_base.cc
  // GetReducedNavigatorPlatform: Win32 / MacIntel / "Linux x86_64" on Linux
  // + ChromeOS whatever the CPU / "Linux armv81" on Android / iPhone.
  const cases = {
    win: "Win32", win32: "Win32", macFrozen: "MacIntel", linux: "Linux x86_64", linuxArm: "Linux x86_64",
    cros: "Linux x86_64", crosArm32: "Linux x86_64", android: "Linux armv81", iphone: "iPhone", ipad: "iPad",
  };
  for (const [k, expected] of Object.entries(cases)) {
    assert.strictEqual(navigatorPlatformFromHints(clientHintsFromUA(UAS[k]), UAS[k]), expected, k);
  }
});

test("CLIENT_HINTS_SOURCE + NAVIGATOR_PLATFORM_SOURCE are self-contained: evaluated in a bare realm they return identical values", () => {
  // stealth_apply embeds these sources in the page, so they must not close
  // over anything from this module.
  const ctx = vm.createContext({});
  const inPage = vm.runInContext(`(${CLIENT_HINTS_SOURCE})`, ctx);
  const inPagePlatform = vm.runInContext(`(${NAVIGATOR_PLATFORM_SOURCE})`, ctx);
  const uas = [...Object.values(UAS), chromeUA(120), chromeUA(147), chromeUA(175), chromeUA(99)];
  for (const ua of uas) {
    const hints = clientHintsFromUA(ua);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(inPage(ua))), hints, ua);
    assert.strictEqual(inPagePlatform(hints, ua), navigatorPlatformFromHints(hints, ua), ua);
  }
});
