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
// The return value has exactly the fields of CDP Emulation.UserAgentMetadata.

function clientHintsFromUA(ua) {
  ua = typeof ua === "string" ? ua : "";
  var cm = ua.match(/Chrome\/(\d+)((?:\.\d+){3})?/);
  var major = cm ? cm[1] : "127";
  var fullVersion = cm && cm[2] ? major + cm[2] : major + ".0.0.0";
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
  // "Not?A_Brand" is the GREASE slot real Chromium ships.
  var brands = [
    { brand: "Chromium", version: major },
    { brand: "Not?A_Brand", version: "24" },
  ];
  var fullVersionList = [
    { brand: "Chromium", version: fullVersion },
    { brand: "Not?A_Brand", version: "24.0.0.0" },
  ];
  return {
    brands: brands,
    fullVersionList: fullVersionList,
    platform: platform,
    platformVersion: platformVersion,
    architecture: architecture,
    model: model,
    mobile: mobile,
    bitness: bitness,
    wow64: wow64,
  };
}

module.exports = {
  clientHintsFromUA,
  CLIENT_HINTS_SOURCE: clientHintsFromUA.toString(),
};
