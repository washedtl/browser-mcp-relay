// policy.js — which domains' cookies the cookie bridge may copy from the
// owner's Chrome into the broker's Brave. Shared, unchanged, by both ends:
//
//   - the extension: `import "./policy.js"` (module service worker) or
//     <script src="policy.js"> (options page), then globalThis.CookieBridgePolicy;
//   - the broker (Node): require(".../extensions/cookie-bridge/policy.js").
//
// A plain script on purpose (no import/export: the repo is CommonJS, and a
// module service worker can still side-effect-import it).
//
// Denylist mode ("everything besides banking and confidential stuff"):
//   deny  — built-in categories below, matched on the domain and every
//           subdomain; never synced unless the owner re-allows the domain on
//           the review page (the cookie then carries userOverride:true);
//   hold  — the keyword guard: an unknown domain that looks sensitive waits
//           for the owner's approval on the review page;
//   allow — everything else. The owner's business tools are listed so a
//           sensitive-looking subdomain of theirs is not held.
// Deny is checked first, so a denied subdomain of a business tool
// (aws.amazon.com) stays denied.
//
// classify(domain) -> { decision: "allow"|"deny"|"hold", category, reason }

(function (root) {
  "use strict";

  const CATEGORY_LABELS = Object.freeze({
    finance: "Banking, credit unions, payments, crypto, brokerages, insurance, payroll",
    "email-identity": "Email and identity (account sign-in, mail)",
    "password-manager": "Password managers",
    "gov-tax-health": "Government, tax and health",
    "cloud-infra": "Cloud, infrastructure and domain-registrar consoles",
    invalid: "Not a valid cookie domain",
    keyword: "Sensitive keyword in the domain",
    business: "Business tool",
    default: "Not on the denylist",
  });

  const list = (s) => Object.freeze(s.trim().split(/\s+/));

  const DENYLIST = Object.freeze({
    finance: list(`
      chase.com jpmorgan.com jpmorganchase.com bankofamerica.com merrilledge.com ml.com wellsfargo.com wf.com
      citi.com citibank.com citicards.com usbank.com pnc.com truist.com capitalone.com tdbank.com td.com ally.com
      discover.com americanexpress.com aexp.com synchrony.com mysynchrony.com syf.com barclays.com barclaycardus.com
      barclaysus.com hsbc.com citizensbank.com fifththird.com 53.com keybank.com key.com huntington.com regions.com
      mtb.com santanderbank.com bmo.com firstcitizens.com frostbank.com comerica.com zionsbank.com axosbank.com
      usaa.com navyfederal.org penfed.org becu.org alliantcreditunion.org schoolsfirstfcu.org golden1.com dcu.org
      lmcu.org suncoastcreditunion.com mountainamerica.com sofi.com chime.com varomoney.com marcus.com
      goldmansachs.com mercury.com relayfi.com brex.com ramp.com novo.co bluevine.com
      paypal.com paypal.me venmo.com cash.app cash.me squareup.com stripe.com wise.com transferwise.com zelle.com
      zellepay.com payoneer.com revolut.com remitly.com westernunion.com moneygram.com xoom.com worldremit.com
      klarna.com affirm.com afterpay.com sezzle.com braintreegateway.com braintreepayments.com adyen.com
      authorize.net checkout.com skrill.com neteller.com paddle.com bill.com melio.com pay.amazon.com
      coinbase.com binance.com binance.us kraken.com gemini.com crypto.com blockchain.com kucoin.com bybit.com
      okx.com bitstamp.net bitfinex.com bitget.com metamask.io ledger.com trezor.io exodus.com uphold.com strike.me
      river.com swanbitcoin.com phantom.app
      schwab.com fidelity.com vanguard.com etrade.com morganstanley.com robinhood.com webull.com tdameritrade.com
      interactivebrokers.com ibkr.com public.com m1.com m1finance.com wealthfront.com betterment.com acorns.com
      stash.com firstrade.com tastytrade.com tastyworks.com empower.com personalcapital.com principal.com tiaa.org
      troweprice.com edwardjones.com ameriprise.com lpl.com computershare.com carta.com
      experian.com equifax.com transunion.com annualcreditreport.com myfico.com creditkarma.com
      geico.com progressive.com statefarm.com allstate.com libertymutual.com nationwide.com farmers.com
      lemonade.com metlife.com prudential.com newyorklife.com northwesternmutual.com
      adp.com myworkday.com workday.com gusto.com paychex.com paylocity.com paycom.com trinet.com justworks.com
      rippling.com ukg.com deel.com
    `),
    "email-identity": list(`
      google.com gmail.com googlemail.com accounts.youtube.com
      live.com outlook.com hotmail.com microsoftonline.com login.microsoft.com account.microsoft.com
      login.windows.net office.com office365.com microsoft365.com sharepoint.com
      apple.com icloud.com me.com
      proton.me protonmail.com protonmail.ch pm.me
      yahoo.com ymail.com aol.com
      mail.zoho.com accounts.zoho.com fastmail.com tuta.com tutanota.com gmx.com gmx.net mail.com hey.com
      okta.com oktapreview.com auth0.com onelogin.com duosecurity.com duo.com pingidentity.com authy.com
    `),
    "password-manager": list(`
      1password.com 1password.ca 1password.eu lastpass.com bitwarden.com bitwarden.eu dashlane.com
      keepersecurity.com keepersecurity.eu keeper.io nordpass.com roboform.com enpass.io passbolt.com
      logmeonce.com stickypassword.com vault.zoho.com
    `),
    "gov-tax-health": list(`
      id.me gc.ca nhs.uk
      intuit.com turbotax.com quickbooks.com hrblock.com taxact.com taxslayer.com freetaxusa.com
      jacksonhewitt.com libertytax.com 1040.com efile.com
      mychart.com followmyhealth.com healow.com athenahealth.com kp.org kaiserpermanente.org uhc.com myuhc.com
      unitedhealthcare.com optum.com optumrx.com aetna.com cigna.com humana.com anthem.com bcbs.com
      elevancehealth.com caremark.com express-scripts.com zocdoc.com teladoc.com onemedical.com labcorp.com
      questdiagnostics.com 23andme.com goodrx.com pharmacy.amazon.com
    `),
    "cloud-infra": list(`
      aws.amazon.com amazonaws.com awsapps.com
      cloudflare.com render.com vercel.com digitalocean.com azure.com heroku.com netlify.com fly.io railway.app
      railway.com linode.com control.akamai.com vultr.com hetzner.com hetzner.cloud ovh.com ovhcloud.com
      scaleway.com upcloud.com supabase.com neon.tech planetscale.com cloud.mongodb.com backblaze.com wasabi.com
      cloud.oracle.com oraclecloud.com cloud.ibm.com alibabacloud.com aliyun.com contabo.com kamatera.com
      hostwinds.com interserver.net ionos.com bluehost.com hostinger.com siteground.com hostgator.com
      dreamhost.com a2hosting.com inmotionhosting.com liquidweb.com login.tailscale.com
      console.anthropic.com platform.openai.com
      namecheap.com godaddy.com porkbun.com dynadot.com name.com hover.com gandi.net namesilo.com
      networksolutions.com register.com enom.com epik.com spaceship.com dnsimple.com domains.squarespace.com
    `),
  });

  // The owner's business tools: allowed even where a keyword would hold a subdomain.
  const BUSINESS_ALLOW = list(`
    amazon.com keepa.com washed.boxedup.cc boxeduplabs.com discord.com discordapp.com ebay.com walmart.com
    whop.com github.com
  `);

  // Substrings of the domain that hold an unknown domain back for review.
  const KEYWORDS = list(`
    bank credit financ invest wallet pay tax health medic clinic patient hospital pharm insur loan mortgage
    crypto coin broker vault password mychart mail
  `);

  // Last label (TLD) that is deny-only, and second-level labels that mark a
  // national government suffix (gov.uk, gouv.fr, gob.mx, govt.nz, ...).
  const DENY_TLDS = Object.freeze({ gov: "gov-tax-health", mil: "gov-tax-health", bank: "finance" });
  const GOV_SECOND_LEVEL = new Set(["gov", "gouv", "gob", "govt", "mil"]);

  const DENY_INDEX = new Map();
  for (const category of Object.keys(DENYLIST)) for (const d of DENYLIST[category]) DENY_INDEX.set(d, category);
  const BUSINESS_INDEX = new Set(BUSINESS_ALLOW);

  const HOSTNAME_RE = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
  const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
  const IPV6_RE = /^\[?[0-9a-f:.]*:[0-9a-f:.]*\]?$/;

  /** Lowercase, trimmed, without leading / trailing dots; "" when not a string. */
  function normalizeDomain(domain) {
    if (typeof domain !== "string") return "";
    return domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
  }

  /** The domain and each parent: a.b.c → [a.b.c, b.c, c]. */
  function suffixes(host) {
    const labels = host.split(".");
    return labels.map((_, i) => labels.slice(i).join("."));
  }

  const result = (decision, category, reason) => ({ decision, category, reason });

  /**
   * @param {string} domain — a cookie domain (".example.com" or "example.com")
   * @returns {{decision: "allow"|"deny"|"hold", category: string, reason: string}}
   */
  function classify(domain) {
    const host = normalizeDomain(domain);
    if (IPV4_RE.test(host) || (host.includes(":") && IPV6_RE.test(host))) {
      return result("hold", "keyword", "An IP address (router / NAS consoles live there): held for review");
    }
    if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) {
      return result("deny", "invalid", "Not a valid cookie domain");
    }
    const labels = host.split(".");
    for (const s of suffixes(host)) {
      const category = DENY_INDEX.get(s);
      if (category) return result("deny", category, `Built-in denylist: ${CATEGORY_LABELS[category]} (${s})`);
    }
    const tld = labels[labels.length - 1];
    if (DENY_TLDS[tld]) {
      return result("deny", DENY_TLDS[tld], `Built-in denylist: ${CATEGORY_LABELS[DENY_TLDS[tld]]} (.${tld})`);
    }
    if (labels.length >= 2 && tld.length === 2 && GOV_SECOND_LEVEL.has(labels[labels.length - 2])) {
      const suffix = labels.slice(-2).join(".");
      return result("deny", "gov-tax-health", `Built-in denylist: ${CATEGORY_LABELS["gov-tax-health"]} (.${suffix})`);
    }
    for (const s of suffixes(host)) {
      if (BUSINESS_INDEX.has(s)) return result("allow", "business", `Business tool (${s})`);
    }
    const keyword = KEYWORDS.find((k) => host.includes(k));
    if (keyword) return result("hold", "keyword", `Keyword "${keyword}" in the domain: held for review`);
    // credit-union style names: becu, alliantcu, myfcu (a label ending in "cu", not the TLD)
    if (labels.slice(0, -1).some((l) => l.endsWith("cu"))) {
      return result("hold", "keyword", `Keyword "cu" (credit union) in the domain: held for review`);
    }
    return result("allow", "default", "Not on the denylist and no sensitive keyword");
  }

  const api = Object.freeze({ classify, normalizeDomain, DENYLIST, KEYWORDS, BUSINESS_ALLOW, CATEGORY_LABELS });
  root.CookieBridgePolicy = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
