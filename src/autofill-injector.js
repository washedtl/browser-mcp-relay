// autofill-injector.js — attaches Brave-autofill-equivalent behavior to a
// Playwright BrowserContext. On every navigation in any page (including pages
// created later by upstream BDMCP via CDP attach), looks up the URL's host
// in the vault and fills the username/password fields if a saved credential
// exists.
//
// Notes on safety:
//   - Never logs password values. Only logs hostname + (count of creds found,
//     username string truncated to first 3 chars). Stderr-safe.
//   - Only fills fields that are CURRENTLY EMPTY — won't overwrite user input.
//   - Does NOT auto-submit. User clicks the submit button themselves.
//   - The injected script runs in the page's isolated world (frame.evaluate)
//     so the page's own JS can't read our injected variables.

const PASSWORD_FIELD_SELECTORS = [
  'input[type="password"]:not([disabled])',
  'input[autocomplete="current-password"]:not([disabled])',
  'input[autocomplete="new-password"]:not([disabled])',
];

// W0-6 (2026-05-09): expanded to cover Microsoft AAD (`name="loginfmt"`),
// Google (`name="identifier"`), Apple ID (`id="account_name_text_field"`),
// and common SaaS patterns (`name="account"`, `id="email-input"`,
// `id="username-input"`, `id="user-email"`).
const USERNAME_FIELD_SELECTORS = [
  // Standard autocomplete hints — most reliable, try first.
  'input[autocomplete="username"]:not([disabled])',
  'input[autocomplete="email"]:not([disabled])',
  // type=email — semantic.
  'input[type="email"]:not([disabled])',
  // Identity-provider-specific name attributes (most-popular SaaS / IdPs).
  'input[name="loginfmt"]:not([disabled])',     // Microsoft AAD
  'input[name="identifier"]:not([disabled])',   // Google
  'input[name="account"]:not([disabled])',      // misc SaaS
  'input[name="login"]:not([disabled])',
  'input[name="username"]:not([disabled])',
  'input[name="user"]:not([disabled])',
  'input[name="email"]:not([disabled])',
  'input[name="userid"]:not([disabled])',
  'input[name="user_email"]:not([disabled])',
  // Common id attribute patterns.
  'input[id="login"]:not([disabled])',
  'input[id="username"]:not([disabled])',
  'input[id="email"]:not([disabled])',
  'input[id="user"]:not([disabled])',
  'input[id="userid"]:not([disabled])',
  'input[id="signinName"]:not([disabled])',
  'input[id="email-input"]:not([disabled])',
  'input[id="username-input"]:not([disabled])',
  'input[id="user-email"]:not([disabled])',
  'input[id="account_name_text_field"]:not([disabled])', // Apple ID
];

/** Body of the injected fill function. Stringified and passed to
 *  frame.evaluate as a function — runs in the page's isolated world. */
function fillScript({ username, password, usernameSelectors, passwordSelectors }) {
  function dispatch(el) {
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function fillFirstEmpty(selectors, value) {
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        // Skip hidden inputs. Use OR — display:none has offsetParent=null but
        // visibility="visible", so AND would let display:none-hidden honeypot
        // fields through and fillFirstEmpty would return on the first hit
        // before reaching the visible field.
        if (el.offsetParent === null || getComputedStyle(el).visibility === "hidden") continue;
        if (!el.value) {
          // Use native setter so React/Vue/etc see the change
          const proto = Object.getPrototypeOf(el);
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, value); else el.value = value;
          dispatch(el);
          return el;
        }
      }
    }
    return null;
  }

  // Retry up to ~3s in case fields are added asynchronously.
  return new Promise((resolve) => {
    const start = Date.now();
    function attempt() {
      const userEl = fillFirstEmpty(usernameSelectors, username);
      const passEl = fillFirstEmpty(passwordSelectors, password);
      const filledUser = !!userEl;
      const filledPass = !!passEl;
      if (filledUser && filledPass) return resolve({ user: true, pass: true });
      if (Date.now() - start > 3000) return resolve({ user: filledUser, pass: filledPass });
      setTimeout(attempt, 200);
    }
    attempt();
  });
}

/** Attach autofill listeners to a Playwright BrowserContext.
 *
 *  - Listens for `page` events (new pages in the context, including ones
 *    created by upstream BDMCP via CDP attach since they share this context).
 *  - On each page's framenavigated, looks up the URL's host in the vault.
 *  - If creds found, runs fillScript in the page's isolated world.
 */
function attachAutofill(context, vault, log = () => {}) {
  if (!vault || vault.totalEntries === 0) {
    log(`[autofill] vault empty — skipping autofill setup`);
    return;
  }

  // V1-2: per-frame fill-in-progress tracking. `framenavigated` fires for
  // every redirect step in OAuth chains; without this guard, multiple
  // 3-second fill loops spin up concurrently and clobber any user input
  // already typed. WeakMap keyed by frame so it's GC'd when the frame is.
  const ACTIVE_FILLS = new WeakMap();

  function attachToPage(page) {
    page.on("framenavigated", async (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (!url || url === "about:blank" || url.startsWith("chrome://") || url.startsWith("chrome-error://")) return;
      const creds = vault.lookup(url);
      if (creds.length === 0) return;
      // Skip if a fill is already in progress for this frame.
      if (ACTIVE_FILLS.has(frame)) return;

      // W0-5: cross-subdomain credential leak protection. When `lookup`
      // returns multiple registrable-fallback matches (i.e. no exact-host
      // entry in the vault), don't silently pick `creds[0]` — the candidate
      // is ambiguous (e.g. on signin.amazon.com with vault entries for AWS,
      // Audible, Twitch, all under amazon.com, picking creds[0] would fill
      // the WRONG account). Skip and log; user can log in manually.
      const c = creds[0];
      const isAmbiguousFallback = c._match === "registrable" && creds.length > 1;
      if (isAmbiguousFallback) {
        let host = "";
        try { host = new URL(url).hostname; } catch {}
        log(`[autofill] ${host}: ${creds.length} ambiguous cross-subdomain creds (no exact-host match) — skipping autofill to avoid wrong-account fill`);
        return;
      }
      const userPeek = c.username.length > 3 ? c.username.slice(0, 3) + "***" : "***";
      log(`[autofill] ${new URL(url).hostname}: found ${creds.length} cred(s) [${c._match}], trying user=${userPeek}`);
      const fillPromise = (async () => {
        try {
          const result = await frame.evaluate(fillScript, {
            username: c.username,
            password: c.password,
            usernameSelectors: USERNAME_FIELD_SELECTORS,
            passwordSelectors: PASSWORD_FIELD_SELECTORS,
          });
          log(`[autofill] ${new URL(url).hostname}: filled user=${result.user} pass=${result.pass}`);
        } catch (e) {
          // Page navigated away or closed mid-fill — best-effort.
          log(`[autofill] ${new URL(url).hostname}: fill error (ignored): ${e.message.split("\n")[0]}`);
        }
      })();
      ACTIVE_FILLS.set(frame, fillPromise);
      fillPromise.finally(() => ACTIVE_FILLS.delete(frame));
    });
  }

  // Hook existing pages
  for (const page of context.pages()) attachToPage(page);
  // Hook future pages (including BDMCP-created)
  context.on("page", attachToPage);
}

module.exports = { attachAutofill, USERNAME_FIELD_SELECTORS, PASSWORD_FIELD_SELECTORS };
