#!/usr/bin/env python3
"""Build a polished desktop-mockup hero image for the browser-mcp-relay README.

Composition:
  - Dark gradient backdrop (top-left to bottom-right)
  - Floating browser window with rounded corners
  - macOS-style traffic-light dots
  - Address bar showing localhost:9091
  - Embedded screenshot inside the window
  - Soft drop shadow under the window
  - Output: 1920x1080 (2x retina-friendly when displayed at 960 wide)
"""

import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# Paths
REPO = r"C:\Users\tlip9\.claude\scripts\browser-mcp-relay"
SCREENSHOT = os.path.join(REPO, "docs", "screenshots", "03-tools-catalog.png")
OUT = os.path.join(REPO, "docs", "hero.png")

# Canvas dims
W, H = 1600, 900
# Window dims (the inset frame) — tight bezel; the screenshot does the talking
WIN_W = 1440
WIN_H = 810
WIN_X = (W - WIN_W) // 2
WIN_Y = (H - WIN_H) // 2 - 8  # nudge up so shadow has room below

# Window chrome heights
CHROME_H = 44  # title-bar height
CONTENT_RADIUS = 12  # rounded corner radius

# ---- 1. backdrop ----
# Use a vertical gradient + a subtle radial wash.
backdrop = Image.new("RGB", (W, H))
draw = ImageDraw.Draw(backdrop)

# Linear gradient: deep slate top → near-black bottom
TOP = (24, 27, 34)      # #181b22
BOTTOM = (10, 12, 16)   # #0a0c10

for y in range(H):
    t = y / H
    r = int(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
    g = int(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
    b = int(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
    draw.line([(0, y), (W, y)], fill=(r, g, b))

# Soft warm wash in upper-left corner (subtle Firecrawl-orange echo)
glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
glow_draw = ImageDraw.Draw(glow)
glow_draw.ellipse(
    [(-400, -400), (1100, 900)],
    fill=(255, 95, 35, 24)  # very low alpha
)
glow = glow.filter(ImageFilter.GaussianBlur(radius=200))
backdrop = Image.alpha_composite(backdrop.convert("RGBA"), glow)

# ---- 2. shadow ----
shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
sh_draw = ImageDraw.Draw(shadow)
SHADOW_OFFSET_Y = 40
SHADOW_PAD = 60
sh_draw.rounded_rectangle(
    [
        (WIN_X - SHADOW_PAD, WIN_Y + SHADOW_OFFSET_Y),
        (WIN_X + WIN_W + SHADOW_PAD, WIN_Y + WIN_H + SHADOW_OFFSET_Y + SHADOW_PAD),
    ],
    radius=CONTENT_RADIUS + SHADOW_PAD,
    fill=(0, 0, 0, 220),
)
shadow = shadow.filter(ImageFilter.GaussianBlur(radius=60))
backdrop = Image.alpha_composite(backdrop, shadow)

# ---- 3. window frame ----
window = Image.new("RGBA", (WIN_W, WIN_H), (0, 0, 0, 0))
win_draw = ImageDraw.Draw(window)

# Window background (very dark, a hair lighter than the backdrop bottom)
WINDOW_BG = (15, 17, 22, 255)  # #0f1116
win_draw.rounded_rectangle(
    [(0, 0), (WIN_W - 1, WIN_H - 1)],
    radius=CONTENT_RADIUS,
    fill=WINDOW_BG,
)

# Top chrome strip (slightly lighter so it reads as a header)
CHROME_BG = (24, 26, 32, 255)  # #181a20
win_draw.rounded_rectangle(
    [(0, 0), (WIN_W - 1, CHROME_H - 1)],
    radius=CONTENT_RADIUS,
    fill=CHROME_BG,
)
# Cover the bottom corners of the chrome (so only top corners are rounded)
win_draw.rectangle([(0, CHROME_H // 2), (WIN_W - 1, CHROME_H - 1)], fill=CHROME_BG)
# Hairline divider under the chrome
win_draw.line([(0, CHROME_H), (WIN_W, CHROME_H)], fill=(38, 41, 49, 255), width=1)

# Traffic-light dots (macOS-ish; muted to feel professional, not playful)
DOT_R = 7
DOT_Y = CHROME_H // 2
DOT_X_START = 22
DOT_GAP = 22
COLORS = [(237, 91, 86), (245, 191, 79), (98, 195, 92)]  # red / amber / green
for i, color in enumerate(COLORS):
    cx = DOT_X_START + i * DOT_GAP
    win_draw.ellipse(
        [(cx - DOT_R, DOT_Y - DOT_R), (cx + DOT_R, DOT_Y + DOT_R)],
        fill=color,
    )

# Address bar pill in the center of the chrome
PILL_W = 360
PILL_H = 26
PILL_X = (WIN_W - PILL_W) // 2
PILL_Y = (CHROME_H - PILL_H) // 2
win_draw.rounded_rectangle(
    [(PILL_X, PILL_Y), (PILL_X + PILL_W, PILL_Y + PILL_H)],
    radius=PILL_H // 2,
    fill=(15, 17, 22, 255),
    outline=(48, 52, 62, 255),
    width=1,
)

# Pill text — try to use a system font; fall back to default
def find_font(size):
    candidates = [
        r"C:\Windows\Fonts\segoeui.ttf",
        r"C:\Windows\Fonts\arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for c in candidates:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size=size)
            except Exception:
                continue
    return ImageFont.load_default()

font_pill = find_font(13)
font_title = find_font(13)

# Subtle lock-icon glyph (■ won't render right; use a minimal padlock via two rectangles)
LOCK_X = PILL_X + 14
LOCK_Y = PILL_Y + (PILL_H // 2) - 6
win_draw.rounded_rectangle(
    [(LOCK_X, LOCK_Y + 4), (LOCK_X + 8, LOCK_Y + 11)],
    radius=1,
    fill=(140, 145, 155, 255),
)
win_draw.arc(
    [(LOCK_X + 1, LOCK_Y - 1), (LOCK_X + 7, LOCK_Y + 6)],
    start=180, end=360, fill=(140, 145, 155, 255), width=1,
)

# URL text
url_text = "localhost:9091/tools"
url_x = PILL_X + 32
url_y = PILL_Y + (PILL_H // 2) - 8
win_draw.text((url_x, url_y), url_text, fill=(196, 200, 210, 255), font=font_pill)

# Window title (left of pill)
title_text = "browser-mcp-relay  ·  Inspector"
title_x = DOT_X_START + 3 * DOT_GAP + 24
title_y = DOT_Y - 8
win_draw.text((title_x, title_y), title_text, fill=(155, 160, 170, 255), font=font_title)

# ---- 4. embed screenshot inside the window content area ----
shot = Image.open(SCREENSHOT).convert("RGBA")
content_w = WIN_W
content_h = WIN_H - CHROME_H
# Resize shot to fit the content area while preserving aspect ratio
shot_aspect = shot.width / shot.height
content_aspect = content_w / content_h
if shot_aspect > content_aspect:
    new_w = content_w
    new_h = int(content_w / shot_aspect)
else:
    new_h = content_h
    new_w = int(content_h * shot_aspect)

shot_resized = shot.resize((new_w, new_h), Image.LANCZOS)
shot_x = (content_w - new_w) // 2
shot_y = CHROME_H + (content_h - new_h) // 2

# Mask the screenshot to the window's bottom rounded corners
content_mask = Image.new("L", (WIN_W, WIN_H), 0)
mask_draw = ImageDraw.Draw(content_mask)
mask_draw.rounded_rectangle(
    [(0, CHROME_H), (WIN_W - 1, WIN_H - 1)],
    radius=CONTENT_RADIUS,
    fill=255,
)
# Square off the top of the content mask (chrome already handles top corners)
mask_draw.rectangle([(0, CHROME_H), (WIN_W - 1, CHROME_H + CONTENT_RADIUS)], fill=255)

# Paste the resized shot into a transparent canvas, then mask
shot_canvas = Image.new("RGBA", (WIN_W, WIN_H), (0, 0, 0, 0))
shot_canvas.paste(shot_resized, (shot_x, shot_y))
# Apply mask via putalpha → split, replace alpha
sa_r, sa_g, sa_b, sa_a = shot_canvas.split()
masked_alpha = ImageDraw.Draw(Image.new("L", (WIN_W, WIN_H), 0))
final_alpha = Image.new("L", (WIN_W, WIN_H), 0)
final_alpha_draw = ImageDraw.Draw(final_alpha)
# Combine: only keep shot pixels where the mask is 255
import PIL.ImageChops as IC
final_alpha = IC.multiply(sa_a, content_mask)
shot_canvas.putalpha(final_alpha)

# Composite shot onto window
window = Image.alpha_composite(window, shot_canvas)

# ---- 5. paste window onto backdrop ----
backdrop.paste(window, (WIN_X, WIN_Y), window)

# Tagline removed — subtraction. Let the UI speak. README H1 communicates intent.

# ---- save ----
backdrop.convert("RGB").save(OUT, "PNG", optimize=True)
print(f"Wrote {OUT} ({os.path.getsize(OUT)//1024} KB, {W}x{H})")
