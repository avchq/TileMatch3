# Regression guard for the iOS "white tiles, no fruit" bug.
#
# On iOS/WebKit the fruit tiles rendered as blank white/grey rounded tiles with
# no emoji, because makeTileTextures() rasterized the emoji to a canvas as the
# very first boot step — before WebKit's font subsystem was warm — so fillText
# painted nothing (the tile body drew, the fruit did not). The fix waits for
# document.fonts.ready and verifies a probe emoji actually paints before
# generating the tile textures (src/icons.js), and boot awaits it (src/main.js).
#
# NB: the raw iOS timing failure CANNOT be reproduced in headless Chromium
# (Chromium paints the emoji even at boot). This test instead asserts the fix's
# invariants through the window.__game.tileFaces() hook:
#   * fontsReady  -> the font warm-up ran before the faces were generated
#                    (drops to false if the async await is reverted -> fails)
#   * painted[i]  -> every tile face carries a non-blank fruit emoji
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()
with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
        "--autoplay-policy=no-user-gesture-required"])
    page = browser.new_page(viewport={"width": 780, "height": 1334})
    harness.patient(page)

    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

    page.goto(f"{BASE}/index.html")
    page.wait_for_function("window.__game && window.__game.tileFaces", timeout=60000)

    faces = page.evaluate("window.__game.tileFaces()")
    print("tileFaces:", faces["fontsReady"], faces["types"], faces["painted"])

    assert faces["types"] == 20, f"expected 20 tile types, got {faces['types']}"
    # The fix's ordering invariant: faces were generated after the font
    # warm-up confirmed the emoji rasterizes. Reverting the async await drops
    # this to false.
    assert faces["fontsReady"] is True, "tile faces generated before font warm-up"
    # Content invariant: every tile carries its fruit emoji (non-blank).
    blank = [i for i, painted in enumerate(faces["painted"]) if not painted]
    assert not blank, f"tile faces missing their emoji at types {blank}"

    assert not errors, f"console/page errors: {errors}"
    print("PASS: all 20 tile faces carry their fruit; font warm-up ran first")