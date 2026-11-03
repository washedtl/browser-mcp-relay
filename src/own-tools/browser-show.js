// browser_show — bring this session's window on-screen and to the front, so
// the user can watch or take over (manual login, CAPTCHA, 2FA).
//
// W2D (2026-11-03): each session tab is its own window. A minimized window
// also stalls rendering (rAF ~2/s, screenshots 3-5 s), so it is restored; a
// window placed off-screen (broker placement "offscreen") is moved onto the
// display Chromium reports for it. Acts on ctx.page: the tab the call's
// tabId names, else main.

const { getOrCreatePageCdp } = require("./_page-cdp-session.js");

const ONSCREEN_MARGIN = 40;

/** Do two screen rectangles overlap? */
function overlaps(a, b) {
  return a.left < b.left + b.width && b.left < a.left + a.width &&
    a.top < b.top + b.height && b.top < a.top + a.height;
}

module.exports = {
  name: "browser_show",
  description:
    "Bring your browser window on-screen and to the front so the user can see it or take over: " +
    "restores it if minimized and moves it into view if it is off-screen. Use before asking the user " +
    "to log in, solve a CAPTCHA or pass 2FA by hand.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args, { page, context }) => {
    // Browser.* window calls work from a page session (they use its target).
    const cdp = await getOrCreatePageCdp(page, context);
    let { windowId, bounds } = await cdp.send("Browser.getWindowForTarget");
    // A minimized window can only leave that state on its own (no bounds
    // in the same call), and reports its real bounds afterwards.
    const restored = bounds.windowState === "minimized";
    if (restored) {
      await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      ({ bounds } = await cdp.send("Browser.getWindowForTarget"));
    }
    let movedOnScreen = false;
    if (bounds.windowState === "normal") {
      // The display the window is on; for a window off every display,
      // Chromium reports the nearest one. Unreadable (no JS) → leave it.
      const display = await page.evaluate(() => ({
        left: screen.availLeft, top: screen.availTop, width: screen.availWidth, height: screen.availHeight,
      })).catch(() => null);
      if (display && !overlaps(bounds, display)) {
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left: display.left + ONSCREEN_MARGIN, top: display.top + ONSCREEN_MARGIN },
        });
        movedOnScreen = true;
      }
    }
    await page.bringToFront();
    return { content: [{ type: "text", text: JSON.stringify({ shown: true, url: page.url(), restored, movedOnScreen }) }] };
  },
};
