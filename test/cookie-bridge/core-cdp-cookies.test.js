// core-cdp-cookies.test.js — W2F: chrome.cookies.Cookie → CDP
// Storage.setCookies CookieParam (src/cookie-bridge/cdp-cookies.js).
// Shapes measured on Brave 147 (Chrome/147.0.7727.117): a host-only cookie
// needs `url` without `domain`; an https url forces secure; partitionKey must
// be the {topLevelSite, hasCrossSiteAncestor} object; a cookie is deleted by
// setting it again already expired (there is no Storage.deleteCookies).

"use strict";

const test = require("node:test");
const assert = require("node:assert");

const { toCdpCookie, expireParam, isExpired, cookieKey } = require("../../src/cookie-bridge/cdp-cookies.js");

const base = (over = {}) => ({
  name: "sid", value: "v", domain: ".example.com", hostOnly: false, path: "/", secure: true, httpOnly: true,
  sameSite: "lax", session: false, expirationDate: 1893456000.25, storeId: "0", ...over,
});

test("cdp-cookies: a domain cookie → url (https when secure) + .domain + every flag", () => {
  const { param, host, error } = toCdpCookie(base());
  assert.strictEqual(error, undefined);
  assert.strictEqual(host, "example.com");
  assert.deepStrictEqual(param, {
    name: "sid", value: "v", url: "https://example.com/", domain: ".example.com", path: "/",
    secure: true, httpOnly: true, sameSite: "Lax", expires: 1893456000.25,
  });
});

test("cdp-cookies: a host-only cookie → url only, no domain (else Chromium makes it a domain cookie)", () => {
  const { param } = toCdpCookie(base({ domain: "www.example.com", hostOnly: true, path: "/app" }));
  assert.strictEqual(param.url, "https://www.example.com/");
  assert.strictEqual(param.domain, undefined);
  assert.strictEqual(param.path, "/app");
});

test("cdp-cookies: a non-secure cookie gets an http url (an https url would force Secure)", () => {
  const { param } = toCdpCookie(base({ secure: false, sameSite: "lax" }));
  assert.strictEqual(param.url, "http://example.com/");
  assert.strictEqual(param.secure, false);
});

test("cdp-cookies: sameSite no_restriction→None, lax→Lax, strict→Strict, unspecified/absent→omitted", () => {
  assert.strictEqual(toCdpCookie(base({ sameSite: "no_restriction" })).param.sameSite, "None");
  assert.strictEqual(toCdpCookie(base({ sameSite: "lax" })).param.sameSite, "Lax");
  assert.strictEqual(toCdpCookie(base({ sameSite: "strict" })).param.sameSite, "Strict");
  assert.ok(!("sameSite" in toCdpCookie(base({ sameSite: "unspecified" })).param));
  assert.ok(!("sameSite" in toCdpCookie(base({ sameSite: undefined })).param));
});

test("cdp-cookies: expirationDate → expires; a session cookie has no expires", () => {
  assert.strictEqual(toCdpCookie(base({ expirationDate: 2000000000 })).param.expires, 2000000000);
  const s = toCdpCookie(base({ session: true, expirationDate: undefined })).param;
  assert.ok(!("expires" in s));
});

test("cdp-cookies (V2-1): a partitionKey without a valid topLevelSite is refused, never stored unpartitioned (it would skip the site's policy check)", () => {
  for (const partitionKey of [{}, { topLevelSite: "" }, { topLevelSite: 5 }, { topLevelSite: "top.example" }, { topLevelSite: "https://" },
    { topLevelSite: "https://top.example/path" }, { topLevelSite: "https://bad host.example" }, { topLevelSite: "ftp://top.example" },
    { topLevelSite: "https://top.example", hasCrossSiteAncestor: "yes" }]) {
    const r = toCdpCookie(base({ sameSite: "no_restriction", partitionKey }));
    assert.strictEqual(r.error, "malformed cookie (partitionKey)", JSON.stringify(partitionKey));
  }
  assert.ok(!toCdpCookie(base({ sameSite: "no_restriction" })).param.partitionKey, "no partitionKey: unpartitioned (what Chrome sends for one)");
});

test("cdp-cookies: partitionKey → {topLevelSite, hasCrossSiteAncestor}", () => {
  const p = toCdpCookie(base({ sameSite: "no_restriction", partitionKey: { topLevelSite: "https://top.example" } })).param;
  assert.deepStrictEqual(p.partitionKey, { topLevelSite: "https://top.example", hasCrossSiteAncestor: false });
  const p2 = toCdpCookie(base({ partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: true } })).param;
  assert.deepStrictEqual(p2.partitionKey, { topLevelSite: "https://top.example", hasCrossSiteAncestor: true });
});

test("cdp-cookies: IPv6 / localhost hosts make a valid url", () => {
  assert.strictEqual(toCdpCookie(base({ domain: "::1", hostOnly: true, secure: false })).param.url, "http://[::1]/");
  assert.strictEqual(toCdpCookie(base({ domain: "localhost", hostOnly: true, secure: false })).param.url, "http://localhost/");
});

test("cdp-cookies: malformed cookies are refused with a reason (no value in it)", () => {
  const cases = [
    null, "x", base({ domain: "" }), base({ domain: 5 }), base({ name: 1 }), base({ value: null }),
    base({ path: "nope" }), base({ sameSite: "weird" }), base({ secure: "yes" }), base({ expirationDate: "soon" }),
    base({ partitionKey: "https://top.example" }), base({ domain: "bad host.com" }),
  ];
  for (const c of cases) {
    const r = toCdpCookie(c);
    assert.ok(r.error, `accepted ${JSON.stringify(c)}`);
    assert.ok(!r.param);
    assert.ok(!String(r.error).includes('"v"'));
  }
});

test("cdp-cookies: Chromium's own rules are checked up front (Brave drops such cookies silently)", () => {
  assert.match(toCdpCookie(base({ secure: false, sameSite: "no_restriction" })).error, /SameSite=None/);
  assert.match(toCdpCookie(base({ name: "__Secure-x", secure: false })).error, /__Secure-/);
  assert.match(toCdpCookie(base({ name: "__Host-x", hostOnly: false })).error, /__Host-/);
  assert.match(toCdpCookie(base({ name: "__Host-x", hostOnly: true, domain: "example.com", path: "/a" })).error, /__Host-/);
  assert.strictEqual(toCdpCookie(base({ name: "__Host-x", hostOnly: true, domain: "example.com" })).error, undefined);
  assert.match(toCdpCookie(base({ secure: false, sameSite: "lax", partitionKey: { topLevelSite: "https://t.example" } })).error, /[Pp]artitioned/);
});

test("cdp-cookies: the key is the cookie's identity (name, host-only-ness, domain, path, partition), not its value", () => {
  const k = (o) => cookieKey(toCdpCookie(base(o)).param);
  assert.strictEqual(k({ value: "a" }), k({ value: "b", expirationDate: 1 }));
  const keys = [
    k({}), k({ name: "other" }), k({ path: "/x" }), k({ domain: "example.com", hostOnly: true }),
    k({ domain: ".sub.example.com" }), k({ sameSite: "no_restriction", partitionKey: { topLevelSite: "https://a.example" } }),
    k({ sameSite: "no_restriction", partitionKey: { topLevelSite: "https://a.example", hasCrossSiteAncestor: true } }),
  ];
  assert.strictEqual(new Set(keys).size, keys.length, keys.join("\n"));
  assert.ok(!keys.some((x) => x.includes("\u0000v\u0000")));
});

test("cdp-cookies: the key ignores Secure (Chromium overwrites a cookie whose Secure flag changed)", () => {
  const k = (o) => cookieKey(toCdpCookie(base(o)).param);
  assert.strictEqual(k({ domain: "example.com", hostOnly: true, secure: true }), k({ domain: "example.com", hostOnly: true, secure: false, sameSite: "lax" }));
  assert.strictEqual(k({ secure: true }), k({ secure: false }));
});

test("cdp-cookies: expireParam deletes by identity: same url/domain/path/partition, empty value, expires in 1970", () => {
  const { param } = toCdpCookie(base({ sameSite: "no_restriction", partitionKey: { topLevelSite: "https://top.example" } }));
  const del = expireParam(param);
  assert.strictEqual(del.value, "");
  assert.strictEqual(del.expires, 1);
  for (const f of ["name", "url", "domain", "path", "secure", "sameSite", "partitionKey"]) assert.deepStrictEqual(del[f], param[f], f);
  assert.strictEqual(cookieKey(del), cookieKey(param));
});

test("cdp-cookies: isExpired — session cookies never, others once expires has passed", () => {
  const now = 1_800_000_000;
  assert.strictEqual(isExpired({ name: "a" }, now), false);
  assert.strictEqual(isExpired({ expires: now - 1 }, now), true);
  assert.strictEqual(isExpired({ expires: now + 60 }, now), false);
});
