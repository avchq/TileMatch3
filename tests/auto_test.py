import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# Auto Complete is a FREE endgame button (no booster/inventory). It appears —
# replacing the three helpers in the row — only when the board is trivially
# solvable: total remaining tiles (board + rack) <= 12 AND nothing left covered.
# Pressing it sweeps every tile into the first tray slot and wins the level.
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
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        time.sleep(0.5)

        def astate(): return page.evaluate("window.__game.autoState()")
        def st():     return page.evaluate("window.__game.state()")

        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.7)

        # On a fresh board Auto Complete is NOT available (27 tiles, plenty covered)
        # and the three helpers are shown instead.
        a = astate()
        print("on level start:", a)
        assert a["available"] is False and a["autoVisible"] is False and a["helpersVisible"] is True, a

        # Play the level down. At EVERY step the availability flag must equal the
        # exact gate, and the HUD row must mirror it (button replaces helpers).
        seen_available = False
        guard = 0
        while True:
            a = astate()
            s = st()
            expected = (a["total"] <= 12 and a["covered"] == 0 and a["boardCount"] > 0)
            assert a["available"] == expected, ("gate mismatch", a, s)
            assert a["autoVisible"] == a["available"], ("button visibility must mirror availability", a)
            assert a["helpersVisible"] != a["available"], ("helpers hidden exactly when auto shows", a)
            if a["available"]:
                seen_available = True
                break
            if s["overlay"] or s["boardCount"] == 0:
                break
            if page.evaluate("window.__game.solveTap()") == -1:
                break
            time.sleep(0.22)   # let setTimeout(_settle,190) clear each triple (else the rack fills -> lose)
            guard += 1
            assert guard < 400, "descent ran away"

        assert seen_available, "level 1 should reach an auto-completable end state"
        a = astate()
        print("auto available at:", a)
        assert a["total"] <= 12 and a["covered"] == 0, a
        page.screenshot(path=f"{SC}/auto_available.png")

        # Press Auto Complete — the sweep animation runs, then the level is won.
        remaining_before = a["total"]
        page.evaluate("window.__game.autoComplete()")
        time.sleep(2.4)        # Phase A + staggered Phase B + pops for up to 12 tiles
        s = st()
        print("after autoComplete:", s)
        assert s["boardCount"] == 0, ("board cleared", s)
        assert s["tray"] == [], ("rack emptied", s)
        assert s["overlay"] is True, ("win overlay shown", s)
        assert s["locked"] is True, ("scene locked at win", s)
        assert remaining_before <= 12
        page.screenshot(path=f"{SC}/auto_won.png")

        # Continue -> lobby, advanced one level. The overlay button isn't exposed,
        # so fire the same callback it triggers.
        lvl = page.evaluate("window.__game.scene.levelNum")
        page.evaluate("window.__game.scene.onLevelComplete(window.__game.scene.levelNum)")
        time.sleep(0.4)
        assert page.evaluate("window.__game.inLobby()") is True, "returned to the lobby"
        assert page.evaluate("window.__game.currentLevel()") == lvl + 1, "advanced one level"

        # Regression guard: the next level's HUD recovers (the _autoRunning reset).
        # A fresh board is never auto-completable, so helpers must be back.
        page.evaluate("window.__game.startLevel(2)")
        time.sleep(0.7)
        a = astate()
        print("next level HUD:", a)
        assert a["helpersVisible"] is True and a["autoVisible"] is False, ("helper row recovered", a)

        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("AUTO COMPLETE TEST PASSED")
        b.close()
finally:
    srv.terminate()
