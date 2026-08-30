import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

# The settings cog must sit in the TOP-LEFT CORNER of the screen in both the
# lobby and the level scene, and stay pinned there on viewports TALLER than the
# 750x1334 design canvas. Regression guard: the lobby cog used to live on the
# vertically-centred uiLayer, so on a tall viewport it drifted down by
# (viewH - 1334)/2 instead of hugging the top edge.

SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

# Read the cog's centre in logical stage/screen coords together with the logical
# screen size, so the check is independent of devicePixelRatio.
COG_METRIC = """(which) => {
  const g = window.__game;
  const cog = which === 'lobby' ? g.lobby.cog : g.scene.cog;
  const p = cog.getGlobalPosition();
  return { x: p.x, y: p.y, w: g.app.screen.width, h: g.app.screen.height };
}"""

def check(page, which):
    m = page.evaluate(COG_METRIC, which)
    # Cog is ~76px wide at (60,84) design; on the top edge it must land well
    # within the top 8% and left 25% of the screen for any sane viewport.
    fx, fy = m["x"] / m["w"], m["y"] / m["h"]
    print(f"  {which}: cog centre=({m['x']:.0f},{m['y']:.0f}) screen={m['w']}x{m['h']} "
          f"-> frac=({fx:.3f},{fy:.3f})")
    assert fy < 0.08, f"{which} cog not pinned to top edge (y frac {fy:.3f})"
    assert fx < 0.25, f"{which} cog not near left edge (x frac {fx:.3f})"

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    # nominal ratio (no vertical offset) and a TALL viewport (large offset).
    for vw, vh in [(780, 1334), (750, 1700), (800, 1900)]:
        page = b.new_page(viewport={"width": vw, "height": vh})
        harness.patient(page)
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        page.goto(f"{BASE}/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=60000)
        # Boot into the LOBBY: a profile that never cleared level 1 is routed
        # straight into the level by the first-run flow (see newuser_test.py),
        # and the lobby cog is half of what this test checks.
        page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=60000)
        time.sleep(0.5)
        print(f"[{vw}x{vh}]")
        # Lobby cog
        assert page.evaluate("window.__game.inLobby()") is True
        check(page, "lobby")
        page.screenshot(path=f"{SC}/cog_corner_lobby_{vw}x{vh}.png")
        # Level cog
        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.6)
        assert page.evaluate("window.__game.state()")["inLobby"] is False
        check(page, "level")
        page.screenshot(path=f"{SC}/cog_corner_level_{vw}x{vh}.png")
        assert not errs, f"page errors: {errs[:5]}"
        page.close()
    print("COG CORNER TEST PASSED")
    b.close()