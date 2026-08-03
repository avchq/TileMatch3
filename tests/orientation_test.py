import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# The game fills any viewport with no letterbox bars and never crops its content.
# The renderer is sized to the whole window and the stage is uniformly scaled so
# the CONSTRAINING viewport dimension maps exactly onto the 750x1334 design; the
# other dimension gains extra design units the scenes reflow into. So for every
# resolution — portrait, near-square, or landscape — we expect:
#   * the canvas exactly covers the viewport (no bars, no distortion),
#   * the design area is never smaller than the 750x1334 nominal (never cropped),
#   * exactly one dimension equals the nominal (the constraining one fills), and
#   * the board + tray + helper row all sit inside the design area, laid out
#     around the horizontal centre and above the bottom edge.
DESIGN_W, DESIGN_H = 750, 1334

# A spread of shapes: tall-narrow, near-square, wide landscape, tall phone, plus
# a couple of extras to prove it generalises beyond the required set.
SIZES = [
    (344, 882),   # tall & narrow
    (374, 667),   # near the design aspect
    (1024, 366),  # wide landscape
    (412, 914),   # typical phone
    (768, 1024),  # tablet portrait
    (900, 500),   # generic landscape
]

def approx(a, b, tol=1.5):
    return abs(a - b) <= tol

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
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        time.sleep(0.5)

        def view(): return page.evaluate("window.__game.view()")

        for (vw, vh) in SIZES:
            page.set_viewport_size({"width": vw, "height": vh})
            time.sleep(0.25)
            # Lobby fit
            v = view()
            tag = f"{vw}x{vh}"
            print(f"[{tag}] lobby view:", v)

            # 1) canvas covers the viewport at the viewport's aspect ratio (fills,
            #    no letterbox) — canvasW/H are buffer px (viewport * resolution).
            assert approx(v["canvasW"] / v["canvasH"], vw / vh, 0.02), ("aspect mismatch", tag, v)

            # 2) design area never smaller than nominal (nothing is cropped)
            assert v["designW"] >= DESIGN_W - 1, ("designW < nominal", tag, v)
            assert v["designH"] >= DESIGN_H - 1, ("designH < nominal", tag, v)

            # 3) exactly one dimension equals the nominal — the constraining one
            #    fills the viewport edge-to-edge.
            fills_w = approx(v["designW"], DESIGN_W, 2)
            fills_h = approx(v["designH"], DESIGN_H, 2)
            assert fills_w or fills_h, ("neither dimension fills nominal", tag, v)

            # 4) the design aspect matches the viewport aspect (uniform scale,
            #    no stretch): designW/designH == vw/vh.
            assert approx(v["designW"] / v["designH"], vw / vh, 0.02), ("design aspect", tag, v)

            page.screenshot(path=f"{SC}/fit_lobby_{tag}.png")

            # Now inside a level: the board + tray + helper row must all fit.
            page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
            time.sleep(0.6)
            v = view()
            st = page.evaluate("window.__game.state()")
            # board centred horizontally, and its centre sits inside the view
            assert approx(v["boardCX"], v["designW"] / 2, 2), ("board not centred", tag, v)
            assert 0 < v["boardCY"] < v["designH"], ("board centre off-screen", tag, v)
            # helper row baseline (by=1266) is anchored oy from the bottom; with a
            # ~46px half-height it must clear the bottom edge.
            helper_bottom = v["oy"] + 1266 + 46
            assert helper_bottom <= v["designH"] + 0.5, ("helper row past bottom", tag, v, helper_bottom)
            # tray panel top (~1080 + oy) sits below the board bottom (no overlap)
            board_bottom = 1140 + v["oy"] - 110
            tray_top = v["oy"] + 1140 - 60
            assert board_bottom <= tray_top, ("board/tray overlap", tag, v)
            # every board tile lands inside the visible view
            oob = page.evaluate("""() => {
                const s = window.__game.scene;
                let bad = 0;
                for (const t of s.tiles) {
                    if (t.inTray || t.matched) continue;
                    const c = t.container;
                    if (c.x < 0 || c.x > s.viewW || c.y < 0 || c.y > s.viewH) bad++;
                }
                return bad;
            }""")
            assert oob == 0, ("board tiles off-screen", tag, oob)
            print(f"[{tag}] level ok — boardCount {st['boardCount']}, oy {round(v['oy'])}")
            page.screenshot(path=f"{SC}/fit_level_{tag}.png")

            # back to the lobby for the next size
            page.evaluate("window.__game.exitLevel()")
            time.sleep(0.3)

        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("ORIENTATION / FIT TEST PASSED")
        b.close()
finally:
    srv.terminate()
