import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# The board must SCALE TO FILL the screen — not sit at a fixed design size. It
# fits the actual available width (viewW) and the vertical band between the HUD
# and the tray, with NO upper cap, so tiles grow on big screens and the play area
# responds to both axes. (Previously boardScale = min(1, areaW/spanX, areaH/spanY)
# with a fixed areaW=690 pinned the board at scale 1.0 with big empty margins and
# made tile size independent of the screen — the bug this test guards against.)
#
# board metrics, mirroring src/game.js _layoutBoard's bounds math (CELL=88, LIFT=7)
BOARD_METRICS = """() => {
    const s = window.__game.scene;
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,maxLayer=0;
    for (const t of s.tiles) {
        minX=Math.min(minX,t.gx); maxX=Math.max(maxX,t.gx);
        minY=Math.min(minY,t.gy); maxY=Math.max(maxY,t.gy);
        maxLayer=Math.max(maxLayer,t.layer);
    }
    const spanX=(maxX-minX+1)*88;
    const spanY=(maxY-minY+1)*88 + maxLayer*7;
    return {
        boardScale: s.boardScale,
        spanX, spanY,
        areaW: s.viewW - 60,          // matches _layoutBoard's available width
        areaH: s.boardBottom - s.boardTop,
        boardW: s.boardScale*spanX,   // board footprint in design units
        boardH: s.boardScale*spanY,
    };
}"""

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 1000, "height": 2000})
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        time.sleep(0.4)

        def metrics():
            return page.evaluate(BOARD_METRICS)

        # 1) Roomy portrait screen: the board grows PAST its raw design size to fill
        #    space — boardScale must exceed 1 (old capped value was pinned at 1.0).
        page.set_viewport_size({"width": 1000, "height": 2000})
        time.sleep(0.2)
        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.6)
        m = metrics()
        print("[1000x2000] level 1:", m)
        assert m["boardScale"] > 1.05, ("board did not grow past scale 1 — still capped", m)

        # 2) Board fills the width in portrait: its footprint uses most of the
        #    690-wide safe band, not the ~440 units of the raw layout.
        assert m["boardW"] >= 600, ("board does not fill the available width", m)

        # 3) Landscape: the board fills the vertical band between HUD and tray
        #    instead of leaving big margins (old: ~0.40 of areaH; new: ~1.0).
        page.set_viewport_size({"width": 1024, "height": 600})
        time.sleep(0.2)
        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.6)
        m2 = metrics()
        print("[1024x600] level 1:", m2)
        assert m2["boardH"] >= 0.85 * m2["areaH"], ("board underfills the vertical band", m2)
        page.screenshot(path=f"{SC}/scaling_landscape.png")

        # 4) Sanity: the board still fits inside its area (never oversized / cropped).
        assert m2["boardH"] <= m2["areaH"] + 1, ("board overflows the vertical band", m2)
        assert m["boardW"] <= m["areaW"] + 1, ("board overflows the available width", m)

        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("SCALING TEST PASSED")
        b.close()
finally:
    srv.terminate()
