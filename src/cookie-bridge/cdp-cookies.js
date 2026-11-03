// cdp-cookies.js — a chrome.cookies.Cookie (as the extension sends it) →
// the CookieParam CDP Storage.setCookies takes, plus its identity key and the
// "already expired" twin that deletes it.
//
// Measured on Brave 147 (Chrome/147.0.7727.117), see core-cdp-cookies.test.js:
//   - a host-only cookie needs `url` and NO `domain` (a domain, dotted or
//     not, can make it a domain cookie); a domain cookie gets both;
//   - an https url forces Secure, so the scheme follows cookie.secure;
//   - partitionKey must be {topLevelSite, hasCrossSiteAncestor} (a string
//     fails the whole batch);
//   - there is no Storage.deleteCookies on the browser target: setting the
//     cookie again with an expiry in the past deletes it;
//   - a cookie Chromium won't store (SameSite=None without Secure, a bad
//     __Host- prefix) is dropped silently, so those rules are checked here.
//
// Error strings never contain the cookie's value.

"use strict";

const SAME_SITE = { no_restriction: "None", lax: "Lax", strict: "Strict", unspecified: null };
const HOST_RE = /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?$/i;
const IPV6_RE = /^[0-9a-f:.]+$/i;

const isBool = (v) => v === undefined || typeof v === "boolean";

/** A partition's top-level site as Chromium serializes it: "https://example.com" (scheme + host, nothing else). */
function validTopLevelSite(site) {
  if (typeof site !== "string" || !/^https?:\/\/[^\s/?#@]+$/i.test(site)) return false;
  try {
    const u = new URL(site);
    return Boolean(u.hostname) && (u.hostname.includes(":") ? IPV6_RE.test(u.hostname.replace(/^\[|\]$/g, "")) : HOST_RE.test(u.hostname));
  } catch {
    return false;
  }
}

/**
 * @returns {{param: object, host: string} | {error: string}}
 */
function toCdpCookie(c) {
  if (!c || typeof c !== "object") return { error: "malformed cookie (not an object)" };
  if (typeof c.name !== "string" || typeof c.value !== "string") return { error: "malformed cookie (name/value)" };
  if (typeof c.domain !== "string") return { error: "malformed cookie (domain)" };
  const host = c.domain.trim().replace(/^\.+/, "").replace(/^\[(.*)\]$/, "$1");
  const ipv6 = host.includes(":");
  if (!host || (ipv6 ? !IPV6_RE.test(host) : !HOST_RE.test(host))) return { error: "malformed cookie (domain)" };
  const path = c.path === undefined ? "/" : c.path;
  if (typeof path !== "string" || !path.startsWith("/")) return { error: "malformed cookie (path)" };
  if (![c.hostOnly, c.secure, c.httpOnly, c.session].every(isBool)) return { error: "malformed cookie (flags)" };
  if (c.sameSite !== undefined && !(c.sameSite in SAME_SITE)) return { error: "malformed cookie (sameSite)" };
  if (!c.session && c.expirationDate !== undefined && !Number.isFinite(c.expirationDate)) return { error: "malformed cookie (expirationDate)" };
  // A partitioned cookie always carries its top-level site (measured: Brave
  // 147's chrome.cookies gives an unpartitioned one no partitionKey at all).
  // One without a valid site would be stored unpartitioned AND skip the
  // site's policy check (importer.js _verdict): refused.
  if (c.partitionKey !== undefined) {
    const k = c.partitionKey;
    if (k === null || typeof k !== "object" || !validTopLevelSite(k.topLevelSite)) return { error: "malformed cookie (partitionKey)" };
    if (k.hasCrossSiteAncestor !== undefined && typeof k.hasCrossSiteAncestor !== "boolean") return { error: "malformed cookie (partitionKey)" };
  }

  const secure = Boolean(c.secure);
  const hostOnly = Boolean(c.hostOnly);
  const sameSite = c.sameSite === undefined ? null : SAME_SITE[c.sameSite];
  const pk = c.partitionKey
    ? { topLevelSite: c.partitionKey.topLevelSite, hasCrossSiteAncestor: Boolean(c.partitionKey.hasCrossSiteAncestor) }
    : null;

  // Chromium's rules: such a cookie would be dropped without an error
  if (sameSite === "None" && !secure) return { error: "SameSite=None cookie without Secure" };
  if (c.name.startsWith("__Secure-") && !secure) return { error: "__Secure- cookie without Secure" };
  if (c.name.startsWith("__Host-") && !(secure && hostOnly && path === "/")) return { error: "__Host- cookie must be Secure, host-only, path /" };
  if (pk && !secure) return { error: "Partitioned cookie without Secure" };

  const param = {
    name: c.name,
    value: c.value,
    url: `${secure ? "https" : "http"}://${ipv6 ? `[${host}]` : host}/`,
  };
  if (!hostOnly) param.domain = `.${host}`;
  param.path = path;
  param.secure = secure;
  param.httpOnly = Boolean(c.httpOnly);
  if (sameSite) param.sameSite = sameSite;
  if (!c.session && c.expirationDate !== undefined) param.expires = c.expirationDate;
  if (pk) param.partitionKey = pk;
  return { param, host };
}

/** The identity Chromium keys a cookie by (never its value). */
function cookieKey(param) {
  const pk = param.partitionKey;
  // a host-only cookie: its host from the url, without the scheme (Secure is not part of the identity)
  const where = param.domain || `host:${param.url.replace(/^https?:\/\//, "")}`;
  return [param.name, where, param.path, pk ? pk.topLevelSite : "", pk ? String(pk.hasCrossSiteAncestor) : ""].join("\u0000");
}

/** The same cookie, already expired: setting it deletes the stored one. */
function expireParam(param) {
  const { value: _value, expires: _expires, ...identity } = param;
  return { ...identity, value: "", expires: 1 };
}

/** Has a (non-session) cookie's expiry passed? `nowSec`: seconds since the epoch. */
function isExpired(param, nowSec = Date.now() / 1000) {
  return typeof param.expires === "number" && param.expires <= nowSec;
}

module.exports = { toCdpCookie, cookieKey, expireParam, isExpired };
