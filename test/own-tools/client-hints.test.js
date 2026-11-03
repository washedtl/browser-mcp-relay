const test = require("node:test");
const assert = require("node:assert");
const vm = require("node:vm");
const { clientHintsFromUA, CLIENT_HINTS_SOURCE } = require("../../src/own-tools/_client-hints.js");

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
  cros: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  crosArm32: "Mozilla/5.0 (X11; CrOS armv7l 15964.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
};

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

test("clientHintsFromUA: brands carry the major version, fullVersionList the full one", () => {
  const reduced = clientHintsFromUA(UAS.win);
  assert.deepStrictEqual(reduced.brands, [{ brand: "Chromium", version: "127" }, { brand: "Not?A_Brand", version: "24" }]);
  assert.deepStrictEqual(reduced.fullVersionList, [{ brand: "Chromium", version: "127.0.0.0" }, { brand: "Not?A_Brand", version: "24.0.0.0" }]);
  const full = clientHintsFromUA(UAS.winFull);
  assert.strictEqual(full.brands[0].version, "127");
  assert.strictEqual(full.fullVersionList[0].version, "127.0.6533.120");
});

test("clientHintsFromUA: has exactly the CDP Emulation.UserAgentMetadata fields", () => {
  assert.deepStrictEqual(Object.keys(clientHintsFromUA(UAS.win)).sort(),
    ["architecture", "bitness", "brands", "fullVersionList", "mobile", "model", "platform", "platformVersion", "wow64"]);
});

test("clientHintsFromUA: tolerates non-string input instead of throwing", () => {
  assert.strictEqual(clientHintsFromUA(undefined).platform, "Windows");
  assert.strictEqual(clientHintsFromUA(123).brands[0].brand, "Chromium");
});

test("CLIENT_HINTS_SOURCE is self-contained: evaluated in a bare realm it returns identical hints", () => {
  // stealth_apply embeds this source in the page, so it must not close over
  // anything from this module.
  const ctx = vm.createContext({});
  const inPage = vm.runInContext(`(${CLIENT_HINTS_SOURCE})`, ctx);
  for (const ua of Object.values(UAS)) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(inPage(ua))), clientHintsFromUA(ua), ua);
  }
});
