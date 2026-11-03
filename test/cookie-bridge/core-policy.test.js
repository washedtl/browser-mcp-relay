// core-policy.test.js — W2F: the cookie bridge's domain policy
// (extensions/cookie-bridge/policy.js), shared by the extension and the
// broker. Denylist mode: deny = built-in categories, hold = keyword guard,
// allow = everything else (business tools explicitly).

"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const POLICY_FILE = path.join(__dirname, "..", "..", "extensions", "cookie-bridge", "policy.js");
const policy = require(POLICY_FILE);
const { classify, normalizeDomain, DENYLIST, KEYWORDS, BUSINESS_ALLOW, CATEGORY_LABELS } = policy;

const decision = (d) => classify(d).decision;

test("policy: business tools are allowed, category business (owner list)", () => {
  for (const d of [
    "amazon.com", ".amazon.com", "www.amazon.com", "sellercentral.amazon.com", "keepa.com", "washed.boxedup.cc",
    "boxeduplabs.com", "discord.com", "ebay.com", "www.ebay.com", "walmart.com", "seller.walmart.com", "whop.com", "github.com",
  ]) {
    assert.deepStrictEqual([d, classify(d).decision, classify(d).category], [d, "allow", "business"]);
  }
});

test("policy: a business domain's sensitive-looking subdomain is still allowed (no keyword hold)", () => {
  assert.strictEqual(decision("payments.ebay.com"), "allow");
  assert.strictEqual(decision("wallet.walmart.com"), "allow");
});

test("policy: an unknown, harmless domain is allowed by default", () => {
  const r = classify("www.target.com");
  assert.strictEqual(r.decision, "allow");
  assert.strictEqual(r.category, "default");
  assert.strictEqual(decision("example.com"), "allow");
});

test("policy: banking / credit unions / payments / crypto / brokerages are denied (finance)", () => {
  for (const d of [
    "chase.com", "secure.chase.com", ".bankofamerica.com", "wellsfargo.com", "capitalone.com", "navyfederal.org", "becu.org",
    "paypal.com", ".paypal.com", "venmo.com", "cash.app", "dashboard.stripe.com", "squareup.com", "wise.com",
    "coinbase.com", "kraken.com", "binance.us", "schwab.com", "fidelity.com", "vanguard.com", "robinhood.com", "etrade.com",
    "pay.amazon.com",
  ]) {
    assert.deepStrictEqual([d, classify(d).decision, classify(d).category], [d, "deny", "finance"]);
  }
});

test("policy: email + identity providers are denied (Google, Microsoft, Apple account + mail, Proton, Yahoo mail)", () => {
  for (const d of [
    "google.com", "accounts.google.com", "mail.google.com", ".google.com", "gmail.com",
    "login.microsoftonline.com", "outlook.live.com", "login.live.com", "outlook.com", "account.microsoft.com",
    "appleid.apple.com", "apple.com", "icloud.com", "proton.me", "mail.proton.me", "protonmail.com",
    "mail.yahoo.com", "login.yahoo.com", "okta.com", "acme.okta.com",
  ]) {
    assert.deepStrictEqual([d, classify(d).decision, classify(d).category], [d, "deny", "email-identity"]);
  }
});

test("policy: password managers are denied", () => {
  for (const d of ["my.1password.com", "1password.com", "vault.bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com"]) {
    assert.deepStrictEqual([d, classify(d).decision, classify(d).category], [d, "deny", "password-manager"]);
  }
});

test("policy: government / tax / health are denied, *.gov and national gov suffixes included", () => {
  for (const d of [
    "irs.gov", "sa.www4.irs.gov", "www.ssa.gov", "login.gov", "army.mil", "www.gov.uk", "tax.service.gov.uk", "canada.gc.ca",
    "id.me", "intuit.com", "turbotax.intuit.com", "myturbotax.intuit.com", "hrblock.com", "taxact.com",
    "kp.org", "myuhc.com", "mychart.com", "followmyhealth.com", "pharmacy.amazon.com",
  ]) {
    assert.deepStrictEqual([d, classify(d).decision, classify(d).category], [d, "deny", "gov-tax-health"]);
  }
});

test("policy: cloud / infra / registrar consoles are denied", () => {
  for (const d of [
    "aws.amazon.com", "console.aws.amazon.com", "signin.aws.amazon.com", "us-east-1.console.aws.amazon.com", "awsapps.com",
    "dash.cloudflare.com", "cloudflare.com", "dashboard.render.com", "vercel.com", "cloud.digitalocean.com",
    "portal.azure.com", "namecheap.com", "godaddy.com", "porkbun.com",
  ]) {
    assert.deepStrictEqual([d, classify(d).decision, classify(d).category], [d, "deny", "cloud-infra"]);
  }
});

test("policy: deny wins over business allow (aws.amazon.com is denied, amazon.com allowed)", () => {
  assert.strictEqual(decision("console.aws.amazon.com"), "deny");
  assert.strictEqual(decision("amazon.com"), "allow");
  assert.strictEqual(decision("smile.amazon.com"), "allow");
});

test("policy: matches whole labels only (no partial-label or look-alike matches)", () => {
  assert.strictEqual(decision("notchase.com"), "allow");
  assert.strictEqual(decision("chase.com.example.net"), "allow");
  assert.strictEqual(decision("gov.example.com"), "allow", "a 'gov' label that isn't a public suffix");
  assert.strictEqual(decision("mygoogle.com"), "allow");
});

test("policy: the keyword guard holds unknown sensitive-looking domains back (category keyword)", () => {
  for (const d of [
    "mybank.example", "lakesidecu.org", "firstcreditunion.com", "acme-financial.com", "investnow.io", "coolwallet.io",
    "paystation.example", "taxprep.example", "cityhealth.org", "mypatientportal.com", "mychart.bigclinic.org",
    "pay.example.com", "insurancequotes.example", "bitcoinshop.example", "webmail.example.net",
  ]) {
    const r = classify(d);
    assert.deepStrictEqual([d, r.decision, r.category], [d, "hold", "keyword"]);
    assert.match(r.reason, /keyword/i);
  }
});

test("policy: 'cu' only holds at the end of a label (credit-union style), not inside words", () => {
  assert.strictEqual(decision("cursor.com"), "allow");
  assert.strictEqual(decision("discuss.example"), "allow");
  assert.strictEqual(decision("alliantcu.org"), "hold");
  assert.strictEqual(decision("myfcu.org"), "hold");
});

test("policy: deny-only suffixes: .bank and .mil TLDs", () => {
  assert.strictEqual(classify("example.bank").decision, "deny");
  assert.strictEqual(classify("example.bank").category, "finance");
  assert.strictEqual(classify("navy.mil").category, "gov-tax-health");
});

test("policy: IP addresses are held (router / NAS consoles), localhost is allowed", () => {
  assert.strictEqual(decision("192.168.1.1"), "hold");
  assert.strictEqual(decision("10.0.0.5"), "hold");
  assert.strictEqual(decision("[::1]"), "hold");
  assert.strictEqual(decision("localhost"), "allow");
});

test("policy: case, a leading dot and a trailing dot don't matter", () => {
  assert.strictEqual(decision("WWW.CHASE.COM"), "deny");
  assert.strictEqual(decision("..chase.com"), "deny");
  assert.strictEqual(decision("chase.com."), "deny");
  assert.strictEqual(normalizeDomain(" .Sub.Example.COM. "), "sub.example.com");
});

test("policy: malformed input is denied as invalid (never allowed by accident)", () => {
  for (const d of ["", ".", "..", null, undefined, 42, {}, "exa mple.com", "a..b.com", "evil.com/path", "x".repeat(300) + ".com", "user@host.com"]) {
    const r = classify(d);
    assert.deepStrictEqual([String(d).slice(0, 20), r.decision, r.category], [String(d).slice(0, 20), "deny", "invalid"]);
  }
});

test("policy: every result has decision, category and a human reason", () => {
  for (const d of ["amazon.com", "chase.com", "mybank.example", "example.com", ""]) {
    const r = classify(d);
    assert.ok(["allow", "deny", "hold"].includes(r.decision));
    assert.strictEqual(typeof r.category, "string");
    assert.ok(typeof r.reason === "string" && r.reason.length > 5, d);
  }
});

test("policy: exported lists are frozen, labelled, and free of duplicates / malformed entries", () => {
  assert.ok(Object.isFrozen(DENYLIST) && Object.isFrozen(KEYWORDS) && Object.isFrozen(BUSINESS_ALLOW));
  const seen = new Map();
  for (const [category, domains] of Object.entries(DENYLIST)) {
    assert.ok(CATEGORY_LABELS[category], `no label for ${category}`);
    assert.ok(Object.isFrozen(domains));
    for (const d of domains) {
      assert.strictEqual(normalizeDomain(d), d, `${d} is not normalized`);
      assert.ok(!seen.has(d), `${d} is listed in both ${seen.get(d)} and ${category}`);
      seen.set(d, category);
      assert.strictEqual(classify(d).decision, "deny", d);
      assert.strictEqual(classify(d).category, category, d);
    }
  }
  for (const d of BUSINESS_ALLOW) assert.strictEqual(classify(d).decision, "allow", d);
  assert.ok(KEYWORDS.length >= 8);
});

test("policy: the file runs as a plain (non-CommonJS) script and publishes globalThis.CookieBridgePolicy", () => {
  // what the extension gets: `import "./policy.js"` in a module service
  // worker, or <script src="policy.js"> on the options page; no `module`
  const src = fs.readFileSync(POLICY_FILE, "utf8");
  assert.ok(!/^\s*(?:export|import)\s/m.test(src), "no ES module syntax: Node loads it as CommonJS");
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`"use strict";\n${src}`, sandbox, { filename: "policy.js" });
  const api = sandbox.CookieBridgePolicy;
  assert.ok(api && typeof api.classify === "function");
  assert.strictEqual(api.classify("chase.com").decision, "deny");
  assert.strictEqual(api.classify("amazon.com").decision, "allow");
});

test("policy: Google's country domains are identity too (google.<cc>, google.co.<cc>, google.com.<cc>)", () => {
  for (const d of ["google.de", "accounts.google.de", "google.co.uk", ".google.co.uk", "mail.google.co.jp", "google.com.au", "myaccount.google.com", "accounts.youtube.com"]) {
    assert.deepStrictEqual([d, classify(d).decision, classify(d).category], [d, "deny", "email-identity"]);
  }
  assert.strictEqual(decision("googleads.example"), "allow");
  assert.strictEqual(decision("google.example.com"), "allow", "a google label under someone else's domain");
});

test("policy: .youtube.com and .amazon.com session cookies stay allowed (business use)", () => {
  assert.strictEqual(decision(".youtube.com"), "allow");
  assert.strictEqual(decision("www.youtube.com"), "allow");
  assert.strictEqual(decision(".amazon.com"), "allow");
});

test("policy: single-label hosts and .local / .lan / .internal / .home.arpa are held; localhost stays allowed", () => {
  for (const d of ["router", "nas", "intranet", "printer.local", "nas.lan", "jira.corp.internal", "gw.home.arpa"]) {
    assert.deepStrictEqual([d, classify(d).decision], [d, "hold"]);
  }
  assert.strictEqual(decision("localhost"), "allow");
});
