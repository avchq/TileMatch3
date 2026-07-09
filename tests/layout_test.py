import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# The type layout is seeded only from the level number (src/game.js loadLevel),
# so a level's tiles land on the same positions with the same types every load —
# a given fruit (e.g. strawberry) is always in the same spot across reloads.

def layout(page):
    # position -> type, keyed by grid cell + layer (positions are fixed by the
    # level file; we assert the TYPE on each position is stable).
    return page.evaluate("""() => {
        const m = {};
        for (const t of window.__game.scene.tiles) m[`${t.gx}|${t.gy}|${t.layer}`] = t.type;
        return m;
    }""")

try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 780, "height": 1334})
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=20000)
        time.sleep(0.5)

        # 1) same level, loaded twice in the same session -> identical layout
        page.evaluate("window.__game.startLevel(1)"); time.sleep(0.7)
        first = layout(page)
        page.evaluate("window.__game.startLevel(1)"); time.sleep(0.7)
        second = layout(page)
        assert first == second, "reloading a level must reproduce the same type layout"
        assert len(first) > 0

        # 2) survives a full page reload (new JS context, fresh Math.random state)
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=20000)
        time.sleep(0.4)
        page.evaluate("window.__game.startLevel(1)"); time.sleep(0.7)
        after_reload = layout(page)
        assert after_reload == first, "layout must be identical after a page reload"
        print(f"level 1 layout stable across reloads: {len(first)} tiles")

        # 3) different levels get different layouts (seed spreads by level number)
        page.evaluate("window.__game.startLevel(2)"); time.sleep(0.7)
        lvl2 = layout(page)
        assert lvl2 != first, "different levels should not share the same layout"

        # 4) still solvable — the deterministic board can be cleared to a win
        page.evaluate("window.__game.startLevel(1)"); time.sleep(0.7)
        guard = 0
        while True:
            st = page.evaluate("window.__game.state()")
            if st["overlay"] or st["boardCount"] == 0:
                break
            if page.evaluate("window.__game.solveTap()") == -1:
                break
            time.sleep(0.2)
            guard += 1
            assert guard < 400, "too many taps — board did not solve"
        time.sleep(0.4)
        st = page.evaluate("window.__game.state()")
        assert st["overlay"] and st["boardCount"] == 0, f"deterministic board must still be winnable: {st}"

        page.screenshot(path=f"{SC}/layout_state.png")
        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("LAYOUT DETERMINISM TEST PASSED")
        b.close()
finally:
    srv.terminate()
