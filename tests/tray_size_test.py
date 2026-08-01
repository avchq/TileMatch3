import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# The bottom tray is sized to the CURRENT LEVEL's on-screen tile size, not a fixed
# 84px slot. A board tile is drawn at TILE_DRAW(96) * boardScale, so the tray slot
# matches that (a collected tile keeps its size flying into the tray), clamped to
# [SLOT_MIN, SLOT_MAX] so the 7-slot tray always fits the 750-wide safe band. Since
# the board scales to FILL the screen its tiles are large, so on normal screens the
# slot clamps at SLOT_MAX; a denser board (smaller tiles) would shrink the tray.
# (Regression: the old tray was a hard-coded SLOT=84 independent of the level.)

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 390, "height": 844})
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        time.sleep(0.4)

        def tray():
            return page.evaluate("window.__game.traySize()")

        # 1) The slot size is DERIVED from the level's tile size, clamped to fit.
        #    Check the identity slot == clamp(tileOnScreen, SLOT_MIN, SLOT_MAX) for a
        #    spread of levels (each has its own boardScale, so its own tile size).
        for lvl in (1, 3, 7, 10):
            page.evaluate(f"window.__game.startLevel({lvl})")
            time.sleep(0.5)
            t = tray()
            print(f"level {lvl}:", {k: round(v, 2) if isinstance(v, float) else v
                                    for k, v in t.items() if k != "slotXs"})
            expect = clamp(t["tileOnScreen"], t["slotMin"], t["slotMax"])
            assert abs(t["slot"] - expect) < 0.01, \
                (f"level {lvl}: slot must track the tile size (clamped)", t)
            # not the old hard-coded 84
            assert abs(t["slot"] - 84) > 0.5, (f"level {lvl}: tray still fixed at 84?", t)

        # 2) The 7 slots are evenly spaced by (slot + gap) and the tray panel stays
        #    inside the 750-wide safe band (no overflow) and centred on it.
        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.5)
        t = tray()
        xs = t["slotXs"]
        assert len(xs) == 7, ("expected 7 slots", xs)
        gaps = [round(xs[i + 1] - xs[i], 2) for i in range(6)]
        assert all(abs(g - (t["slot"] + 6)) < 0.5 for g in gaps), \
            ("slots must be spaced by slot+gap(6)", gaps, t["slot"])
        assert t["panelW"] <= 750 + 0.5, ("tray panel overflows the 750 safe band", t)
        assert abs((xs[0] + xs[-1]) / 2 - 375) < 0.5, ("tray not centred on the band", xs)

        # 3) On a normal screen the board tile is bigger than the tray can hold 7 of,
        #    so the slot clamps at SLOT_MAX (the widest that fits) — still != 84.
        assert t["tileOnScreen"] > t["slotMax"], ("expected a large board tile here", t)
        assert abs(t["slot"] - t["slotMax"]) < 0.01, ("slot must clamp to SLOT_MAX", t)

        # 4) A collected tile renders at the slot size in the tray (TILE_DRAW=96 * its
        #    container scale ≈ slot), i.e. the tray tile visually matches its slot,
        #    which in turn tracks the level's tile size.
        page.evaluate("window.__game.solveTap()")
        time.sleep(0.5)
        rendered = page.evaluate(
            "() => { const s = window.__game.scene; return s.tray.length "
            "? s.tray[0].container.scale.x * 96 : null; }")
        print("collected tile rendered size:", rendered, "slot:", t["slot"])
        assert rendered is not None, "expected a tile in the tray after solveTap"
        assert abs(rendered - t["slot"]) < 1.0, \
            ("a collected tray tile must render at the slot size", rendered, t["slot"])

        page.screenshot(path=f"{SC}/tray_size.png")
        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("TRAY SIZE TEST PASSED")
        b.close()
finally:
    srv.terminate()
