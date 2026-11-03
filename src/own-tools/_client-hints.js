// _client-hints.js — ONE User-Agent Client Hints generator shared by
// emulate_device (CDP Network.setUserAgentOverride userAgentMetadata → the
// HTTP Sec-CH-UA-* headers) and stealth_apply (in-page
// navigator.userAgentData). Before W1D each tool had its own copy and they
// disagreed on architecture / bitness / platformVersion for Mac and Android
// UAs — a header-vs-JS mismatch is exactly what anti-bot vendors look for.
//
// stealth_apply runs this function INSIDE the page (it embeds
// CLIENT_HINTS_SOURCE), so it must stay self-contained: no closures over
// module scope, no Node APIs, no helpers defined outside the function body.
//
// Values follow Chromium (content/common/user_agent.cc +
// components/embedder_support/user_agent_utils.cc):
//   • Android sends no architecture / bitness ("").
//   • macOS is always 64-bit; we report arm because the Mac UA token is
//     frozen at "Intel Mac OS X 10_15_7" even on Apple Silicon, and
//     stealth_apply's WebGL patch reports an Apple M1 GPU for Mac UAs.
//   • Linux reports an empty platformVersion.
//   • STEALTH2-1/2: brands = Chromium's GREASE brand + "Chromium" + the
//     browser brand ("Google Chrome" for a Chrome UA), in Chromium's
//     major-seeded order (user_agent_utils.cc GenerateBrandVersionList /
//     GetGreasedUserAgentBrandVersion / GetRandomOrder, chromium main at
//     482f8fbb, 2026-10-19). Exact for Chrome 110+ (lists measured on real
//     builds match); older majors used an earlier GREASE scheme.
//   • STEALTH2-3: fullVersionList / fullVersion carry a real Chrome build
//     (Chrome never reports x.0.0.0 there; Brave does, for its own brand).
// The return value has exactly the fields of CDP Emulation.UserAgentMetadata:
// any field left out falls back to the HOST browser's value in Chromium
// (content/browser/devtools/protocol/emulation_handler.cc), e.g. Brave's own
// full version under an emulated Chrome 131.

function clientHintsFromUA(ua) {
  ua = typeof ua === "string" ? ua : "";
  var cm = ua.match(/Chrome\/(\d+)((?:\.\d+){3})?/);
  var major = cm ? cm[1] : "127";
  var seed = Number(major);
  // STEALTH2-3: an unreduced UA's own version, else (reduced "x.0.0.0") the
  // highest build Chrome shipped to Windows, Mac and Linux in that milestone
  // (chromiumdash.appspot.com, 2026-11-03), majors 100..157. Majors outside
  // the table step the build from the nearest entry (~25/milestone lately,
  // ~55 before 100) so it stays plausible; refresh the table from
  // chromiumdash as new milestones ship.
  var fullVersion;
  if (cm && cm[2] && cm[2] !== ".0.0.0") {
    fullVersion = major + cm[2];
  } else {
    var FIRST = 100;
    var BUILDS = ("4896.127 4951.64 5005.115 5060.134 5112.101 5195.125 5249.119 5304.121 5359.124 5414.119 " +
      "5481.177 5563.146 5615.121 5672.126 5735.198 5790.170 5845.187 5938.149 5993.117 6045.199 " +
      "6099.216 6167.184 6261.128 6312.122 6367.207 6422.141 6478.182 6533.119 6613.137 6668.100 " +
      "6723.116 6778.264 6834.159 6943.141 6998.165 7049.114 7103.113 7151.119 7204.183 7258.154 " +
      "7339.207 7390.122 7444.162 7499.192 7559.132 7632.159 7680.177 7727.137 7778.178 7827.200 " +
      "7871.186 7922.173 7977.82 8010.52 8037.97 8059.84 8078.79 8103.26").split(" ");
    var nearest = Math.max(0, Math.min(BUILDS.length - 1, seed - FIRST));
    var bp = BUILDS[nearest].split(".");
    var build = Math.max(1, Number(bp[0]) + (seed - FIRST - nearest) * (seed < FIRST ? 55 : 25));
    fullVersion = major + ".0." + build + "." + bp[1];
  }
  // Order matters: Android UAs contain "Linux; Android", iOS UAs contain
  // "Mac OS X", Chrome OS UAs contain "X11".
  var platform = /Windows/.test(ua) ? "Windows"
    : /iPhone|iPad/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /CrOS/.test(ua) ? "Chrome OS"
    : /Macintosh/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux"
    : "Windows";
  var mobile = /Mobi|Android|iPhone/.test(ua);
  // The first parenthesised UA token holds the OS / CPU details.
  var osToken = (ua.match(/\(([^)]*)\)/) || [])[1] || "";
  var platformVersion = "";
  // Linux / Chrome OS defaults, read from the CPU word only (a build number
  // like "15964.0.0" must not read as 64-bit).
  var architecture = /arm|aarch/i.test(osToken) ? "arm" : "x86";
  var bitness = /x86_64|amd64|aarch64|arm64/i.test(osToken) ? "64" : "32";
  var model = "";
  var wow64 = false;
  var m;
  if (platform === "Windows") {
    platformVersion = "15.0.0";
    architecture = "x86";
    bitness = /Win64|WOW64|x64/.test(osToken) ? "64" : "32";
    wow64 = /WOW64/.test(osToken);
  } else if (platform === "macOS") {
    m = osToken.match(/Mac OS X (\d+)[._](\d+)(?:[._](\d+))?/);
    platformVersion = m && Number(m[1]) >= 11 ? m[1] + "." + m[2] + "." + (m[3] || "0") : "14.0.0";
    architecture = "arm";
    bitness = "64";
  } else if (platform === "iOS") {
    m = osToken.match(/OS (\d+)_(\d+)(?:_(\d+))?/);
    platformVersion = m ? m[1] + "." + m[2] + "." + (m[3] || "0") : "";
    architecture = "arm";
    bitness = "64";
  } else if (platform === "Android") {
    m = osToken.match(/Android (\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    platformVersion = m ? m[1] + "." + (m[2] || "0") + "." + (m[3] || "0") : "";
    architecture = "";
    bitness = "";
    m = osToken.match(/Android [^;]*;\s*([^;]+)/);
    model = m ? m[1].replace(/\s*Build\/.*$/, "").trim() : "";
    if (model === "K") model = ""; // reduced UA hides the model
  } else if (platform === "Chrome OS") {
    m = osToken.match(/CrOS \S+ (\d+\.\d+\.\d+)/);
    platformVersion = m ? m[1] : "";
  }
  // STEALTH2-2: a Chrome UA carries the "Google Chrome" brand. Other
  // Chromium browsers name themselves in the UA (Edge "Edg/", Opera "OPR/",
  // ...) and report their OWN full version, which we can't know, so they get
  // Chromium's unbranded list rather than a wrong brand. Headless Chrome
  // ("HeadlessChrome/") still sends Google Chrome's hints. (Brave's UA is
  // byte-identical to Chrome's; Brave's native hints are never generated
  // here: stealth_apply keeps them, emulate_device only replaces them when
  // asked to emulate a UA.)
  var brand = cm && !/\b(?:Edg|EdgA|EdgiOS|OPR|OPX|SamsungBrowser|YaBrowser|Chromium)\//.test(ua)
    ? "Google Chrome" : null;
  // STEALTH2-1: port of GetGreasedUserAgentBrandVersion + GenerateBrandVersionList
  // + ShuffleBrandList: [GREASE, Chromium, brand?] placed at order[i].
  var GREASE_CHARS = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  var GREASE_VERSIONS = ["8", "99", "24"];
  var greaseBrand = "Not" + GREASE_CHARS[seed % 11] + "A" + GREASE_CHARS[(seed + 1) % 11] + "Brand";
  var greaseVersion = GREASE_VERSIONS[seed % 3];
  var ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  function brandList(version, greaseFull) {
    var list = [{ brand: greaseBrand, version: greaseFull }, { brand: "Chromium", version: version }];
    if (brand) list.push({ brand: brand, version: version });
    var order = list.length === 2 ? [seed % 2, (seed + 1) % 2] : ORDERS[seed % 6];
    var out = [];
    for (var i = 0; i < list.length; i++) out[order[i]] = list[i];
    return out;
  }
  return {
    brands: brandList(major, greaseVersion),
    fullVersionList: brandList(fullVersion, greaseVersion + ".0.0.0"),
    fullVersion: fullVersion,
    platform: platform,
    platformVersion: platformVersion,
    architecture: architecture,
    model: model,
    mobile: mobile,
    bitness: bitness,
    wow64: wow64,
    formFactors: [mobile ? "Mobile" : "Desktop"],
  };
}

// STEALTH2-4: the navigator.platform Chromium reports for the hints' OS
// (third_party/blink/renderer/core/execution_context/navigator_base.cc,
// GetReducedNavigatorPlatform: Linux + ChromeOS report "Linux x86_64" on any
// CPU, Android "Linux armv81"). emulate_device passes it to CDP as
// `platform`; stealth_apply uses it in-page, so it is self-contained too.
function navigatorPlatformFromHints(hints, ua) {
  var p = hints && hints.platform;
  if (p === "macOS") return "MacIntel";
  if (p === "Android") return "Linux armv81";
  if (p === "Linux" || p === "Chrome OS") return "Linux x86_64";
  if (p === "iOS") return /iPad/.test(typeof ua === "string" ? ua : "") ? "iPad" : "iPhone";
  return "Win32";
}

module.exports = {
  clientHintsFromUA,
  CLIENT_HINTS_SOURCE: clientHintsFromUA.toString(),
  navigatorPlatformFromHints,
  NAVIGATOR_PLATFORM_SOURCE: navigatorPlatformFromHints.toString(),
};
