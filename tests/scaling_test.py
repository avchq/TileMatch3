import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# The board scales to fill the fixed 750-wide GAME COLUMN — it is NOT pinned at a
# fixed design size (the old bug: boardScale capped at 1.0 with big empty margins),
# and it is NOT blown up edge-to-edge on a wide screen either (the game stays a
# vertical column; a wide screen just shows the blurred background on the sides).
# So on any screen the board is sized to the column — min(viewW, 750) - 60 wide,
# fitting the vertical band between the HUD and tray — never to the raw viewport.
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
        viewW: s.viewW,
        colAreaW: Math.min(s.viewW, 750) - 60, // the 750-wide column, matches _layoutBoard
        viewportAreaW: s.viewW - 60,           // what the board WOULD fill if blown up
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
        #    the column — boardScale must exceed 1 (old capped value was pinned at 1.0).
        page.set_viewport_size({"width": 1000, "height": 2000})
        time.sleep(0.2)
        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.6)
        m = metrics()
        print("[1000x2000] level 1:", m)
        assert m["boardScale"] > 1.05, ("board did not grow past scale 1 — still capped", m)

        # 2) Board fills the width of the 750-wide column (uses most of the 690-wide
        #    band), and never overflows it or the vertical band.
        assert m["boardW"] >= 600, ("board does not fill the column width", m)
        assert m["boardW"] <= m["colAreaW"] + 1, ("board overflows the column width", m)
        assert m["boardH"] <= m["areaH"] + 1, ("board overflows the vertical band", m)

        # 3) Wide (landscape) screen: the game stays a vertical column, so the board
        #    is sized to the 750 column — NOT blown up to the full viewport width.
        page.set_viewport_size({"width": 1024, "height": 600})
        time.sleep(0.2)
        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.6)
        m2 = metrics()
        print("[1024x600] level 1:", m2)
        # The board footprint is bounded by the column, well under the raw viewport
        # width — this is the regression guard against the "blow up edge-to-edge" bug.
        assert m2["boardW"] <= m2["colAreaW"] + 1, ("board wider than the 750 column", m2)
        assert m2["boardW"] < 0.6 * m2["viewportAreaW"], ("board blown up to the viewport, not column-sized", m2)
        # It is column-sized, i.e. the SAME footprint as on the portrait screen
        # above (its size tracks the column, not the wide viewport).
        assert abs(m2["boardW"] - m["boardW"]) <= 2, ("board size changed with viewport width", m, m2)
        assert m2["boardH"] <= m2["areaH"] + 1, ("board overflows the vertical band", m2)
        page.screenshot(path=f"{SC}/scaling_landscape.png")

        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("SCALING TEST PASSED")
        b.close()
finally:
    srv.terminate()
