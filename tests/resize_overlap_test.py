import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# Resize / orientation robustness: across a spread of common device shapes
# (phones portrait+landscape, tablets, desktop) and in EVERY scene (lobby, level,
# and the settings/shop/fortune-wheel/daily-bonus/tasks overlays), every interface
# control — buttons, text labels, tags, badges, the play board, the tray — must:
#   * stay fully INSIDE the visible design area (nothing clipped off-screen), and
#   * NOT OVERLAP any other independent control in the same scene (nothing covers
#     anything else), and
#   * stay anchored to its intended edge (HUD near the top, tray/helpers near the
#     bottom).
# Controls are read in design-space units via the window.__game.controls() hook,
# which reports { scene, name, x, y, w, h } for each visible top-level control.
#
# The design area is always >= 750x1334 in both axes (main.js resize() uses the
# MIN scale, so content is never compressed — the extra space becomes margin),
# which is why "inside the view" is checked against designW/designH, not the raw
# viewport.

# Common device shapes: portrait phones, landscape phone, tablets both ways, a
# desktop landscape, plus the exact nominal design canvas.
SIZES = [
    (412, 915),    # phone portrait (Pixel)
    (390, 844),    # phone portrait (iPhone)
    (360, 900),    # tall narrow android
    (768, 1024),   # tablet portrait
    (1024, 768),   # tablet landscape
    (1280, 720),   # desktop landscape (16:9)
    (844, 390),    # phone landscape
    (750, 1334),   # exact nominal design canvas
]

# On-screen tolerance (stroke/filter padding on text bounds adds a few px) and the
# minimum intersection (in BOTH axes) that counts as a real overlap rather than
# borderline touching.
EDGE_TOL = 3.0
OVERLAP_TOL = 8.0

# Scenes where we assert full pairwise non-overlap. The overlays intentionally
# layer a big centred panel under top-HUD fly-target counters, so for them we only
# assert on-screen (below), not pairwise separation.
NOOVERLAP_SCENES = {"lobby", "level"}


def rects_overlap(a, b):
    ix = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
    iy = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
    return ix > OVERLAP_TOL and iy > OVERLAP_TOL


def check(page, tag, scenes):
    """Assert on-screen + (for gameplay scenes) non-overlap for the given scenes."""
    v = page.evaluate("window.__game.view()")
    DW, DH = v["designW"], v["designH"]
    ctrls = [c for c in page.evaluate("window.__game.controls()") if c["scene"] in scenes]
    assert ctrls, (tag, "no controls reported for", scenes)

    # 1) every control fully inside the visible design area
    for c in ctrls:
        assert c["x"] >= -EDGE_TOL, ("off left", tag, c)
        assert c["y"] >= -EDGE_TOL, ("off top", tag, c)
        assert c["x"] + c["w"] <= DW + EDGE_TOL, ("off right", tag, c, DW)
        assert c["y"] + c["h"] <= DH + EDGE_TOL, ("off bottom", tag, c, DH)

    # 2) no two independent controls in the same gameplay scene overlap
    for sc in scenes:
        if sc not in NOOVERLAP_SCENES:
            continue
        items = [c for c in ctrls if c["scene"] == sc]
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                assert not rects_overlap(items[i], items[j]), (
                    "controls overlap", tag, items[i]["name"], items[j]["name"],
                    items[i], items[j])
    return v, ctrls


def by_name(ctrls, scene, name):
    for c in ctrls:
        if c["scene"] == scene and c["name"] == name:
            return c
    return None


try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": SIZES[0][0], "height": SIZES[0][1]})
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        # Boot into the LOBBY with the ordinary, fully-unlocked interface: a profile
        # that never cleared level 1 is routed straight into a stripped-down guided
        # level by the first-run flow (see newuser_test.py / firstlevel_test.py), and
        # the helpers stay locked until level 5. Record a level-5 clear (persisted,
        # hence honoured by every reload below) so every control is on screen here.
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        page.evaluate("window.__game.completeLevel(5); window.__game.flushSave();")
        # Unlocked-but-untaught helpers open a coached first use on the next level
        # entry, which lifts a helper button out of the HUD (boostercoach_test.py
        # owns that). The overlap sweep wants the ordinary helper row.
        page.evaluate("window.__game.markBoosterCoached('all')")

        for (vw, vh) in SIZES:
            tag = f"{vw}x{vh}"
            page.set_viewport_size({"width": vw, "height": vh})
            # Fresh clean state (all overlays closed, lobby shown) for each size.
            page.reload()
            page.wait_for_function(
                "window.__game && window.__game.scene && !!window.__game.controls",
                timeout=20000)
            time.sleep(0.4)

            # ---- Lobby -----------------------------------------------------
            assert page.evaluate("window.__game.inLobby()") is True, (tag, "not in lobby")
            v, ctrls = check(page, f"{tag} lobby", {"lobby"})
            DW, DH = v["designW"], v["designH"]
            # Corner chrome stays anchored to the top edge (centred in the 750 band,
            # per the SHOW_ALL spec) — the cog must sit near the top.
            cog = by_name(ctrls, "lobby", "cog")
            assert cog and cog["y"] < 160, ("lobby cog not near top", tag, cog)
            # The play button is the bottom-anchored call to action: it must hug the
            # bottom edge on every shape, not float with the vertically-centred block.
            play = by_name(ctrls, "lobby", "playBtn")
            assert play and play["y"] + play["h"] > DH - 200, (
                "lobby play button not near bottom", tag, play, DH)
            # The daily-gift button is shown on a fresh profile (unclaimed) — the
            # regression this test guards: its column must not clip the title.
            assert by_name(ctrls, "lobby", "dailyBtn"), (tag, "daily button expected visible")
            page.screenshot(path=f"{SC}/overlap_lobby_{tag}.png")

            # Lobby with the wheel unlocked too (progression), so the wheel button's
            # column is also checked against the title.
            page.evaluate("window.__game.setLevel(99)")
            time.sleep(0.2)
            check(page, f"{tag} lobby-hi", {"lobby"})
            page.evaluate("window.__game.setLevel(1)")
            time.sleep(0.15)

            # Lobby with Tasks unlocked as well. That button rides the RIGHT-edge
            # rail, under the coin pill, so this is what guards the second rail's
            # column — against the coin pill above it and the centred title beside
            # it. (Persisted, so every later size starts with it already on.)
            page.evaluate("window.__game.completeLevel(9); window.__game.flushSave();")
            time.sleep(0.25)
            _, ctrls_t = check(page, f"{tag} lobby-tasks", {"lobby"})
            assert by_name(ctrls_t, "lobby", "tasksBtn"), (tag, "tasks button expected visible")
            page.screenshot(path=f"{SC}/overlap_lobby_tasks_{tag}.png")

            # ---- Level -----------------------------------------------------
            page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
            time.sleep(0.6)
            v, ctrls = check(page, f"{tag} level", {"level"})
            DW, DH = v["designW"], v["designH"]
            cog = by_name(ctrls, "level", "cog")
            assert cog and cog["y"] < 160, ("level cog not near top", tag, cog)
            tray = by_name(ctrls, "level", "trayPanel")
            assert tray and (tray["y"] + tray["h"]) > DH - 260, ("tray not near bottom", tag, tray, DH)
            board = by_name(ctrls, "level", "board")
            assert board, (tag, "board missing")
            page.screenshot(path=f"{SC}/overlap_level_{tag}.png")
            page.evaluate("window.__game.exitLevel()")
            time.sleep(0.3)

            # ---- Overlays (on-screen only; layered panels intentionally stack) --
            page.evaluate("window.__game.openSettings()")
            time.sleep(0.4)
            check(page, f"{tag} settings", {"settings"})

            page.evaluate("window.__game.openShop()")
            time.sleep(0.4)
            check(page, f"{tag} shop", {"shop"})

            page.evaluate("window.__game.openWheel()")
            time.sleep(0.4)
            check(page, f"{tag} wheel", {"wheel"})

            page.evaluate("window.__game.openDailyBonus()")
            time.sleep(0.4)
            check(page, f"{tag} daily", {"daily"})

            page.evaluate("window.__game.openTasks()")
            time.sleep(0.5)
            check(page, f"{tag} tasks", {"tasks"})

            print(f"[{tag}] OK — design {round(DW)}x{round(DH)}")

        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("RESIZE / OVERLAP TEST PASSED")
        b.close()
finally:
    srv.terminate()
