// browser_show — bring this session's window on-screen and to the front, so
// the user can watch or take over (manual login, CAPTCHA, 2FA).
//
// W2D (2026-11-03): each session tab is its own window. W2E: the window work
// is window-pages' showWindow: a minimized window is restored (it also stalls
// rendering: rAF ~2/s, screenshots 3-5 s), and one placed off-screen
// (BROWSER_RELAY_BROKER_WINDOWS=offscreen) moves to a visible cascade slot.
// Acts on ctx.page: the tab the call's tabId names, else main.

const { showWindow } = require("../broker/window-pages.js");

module.exports = {
  name: "browser_show",
  description:
    "Bring your browser window on-screen and to the front so the user can see it or take over: " +
    "restores it if minimized and moves it into view if it is off-screen. Use before asking the user " +
    "to log in, solve a CAPTCHA or pass 2FA by hand.",
  inputSchema: { type: "object", properties: {} },
  handler: async (_args, { page }) => {
    const { restored, movedOnScreen } = await showWindow(page);
    await page.bringToFront();
    return { content: [{ type: "text", text: JSON.stringify({ shown: true, url: page.url(), restored, movedOnScreen }) }] };
  },
};
