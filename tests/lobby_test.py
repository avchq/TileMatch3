import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 780, "height": 1334})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
        # clear saved level so we start fresh at level 1
        page.goto("http://localhost:8099/index.html")
        page.evaluate("localStorage.removeItem('tilemaster.level')")
        page.reload()
        page.wait_for_function("window.__game && window.__game.lobby", timeout=15000)
        time.sleep(1)

        OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
        os.makedirs(OUT, exist_ok=True)
        def snap(tag):
            page.screenshot(path=f"{OUT}/lobby_{tag}.png")

        st = page.evaluate("window.__game.state()")
        btn = page.evaluate("window.__game.lobbyButtonText()")
        print("ON LOAD -> inLobby:", st["inLobby"], "button:", repr(btn),
              "currentLevel:", page.evaluate("window.__game.currentLevel()"))
        snap("load")
        assert st["inLobby"] is True, "should land in lobby"
        assert btn == "Level 1", f"expected 'Level 1', got {btn!r}"

        # start level 1 via the API (equivalent to tapping the button)
        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.6)
        st = page.evaluate("window.__game.state()")
        print("STARTED L1 -> inLobby:", st["inLobby"], "level:", st["level"],
              "boardCount:", st["boardCount"])
        assert st["inLobby"] is False
        snap("playing_l1")

        # auto-solve level 1
        def solve(level):
            for _ in range(4000):
                s = page.evaluate("window.__game.state()")
                if s["overlay"] or s["inLobby"]:
                    break
                r = page.evaluate("window.__game.solveTap()")
                if r == -1:
                    time.sleep(0.05)
                time.sleep(0.02)
            time.sleep(0.4)

        solve(1)
        s = page.evaluate("window.__game.state()")
        print("L1 SOLVED -> overlay:", s["overlay"], "boardCount:", s["boardCount"])
        snap("l1_win_overlay")
        assert s["overlay"] is True and s["boardCount"] == 0

        # click the "Continue" button on the win overlay -> should go to lobby @ level 2
        # find the overlay button by tapping center of its known location (750/2, 780) in canvas space
        # easier: drive via the overlay button; we invoke onLevelComplete path by clicking canvas.
        # Use the game's overlay button coordinates mapped to the CSS-scaled canvas.
        box = page.eval_on_selector("canvas", "c => { const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
        # design (375,780) -> css
        cx = box["x"] + box["w"] * (375/750)
        cy = box["y"] + box["h"] * (780/1334)
        page.mouse.click(cx, cy)
        time.sleep(0.9)
        st = page.evaluate("window.__game.state()")
        btn = page.evaluate("window.__game.lobbyButtonText()")
        print("AFTER L1 WIN -> inLobby:", st["inLobby"], "button:", repr(btn),
              "currentLevel:", page.evaluate("window.__game.currentLevel()"))
        snap("lobby_after_l1")
        assert st["inLobby"] is True, "should return to lobby after win"
        assert btn == "Level 2", f"expected 'Level 2', got {btn!r}"

        # verify persistence: reload should keep us at level 2 in the lobby
        page.reload()
        page.wait_for_function("window.__game && window.__game.lobby", timeout=15000)
        time.sleep(0.6)
        btn = page.evaluate("window.__game.lobbyButtonText()")
        inl = page.evaluate("window.__game.inLobby()")
        print("AFTER RELOAD -> inLobby:", inl, "button:", repr(btn))
        assert inl is True and btn == "Level 2", "level not persisted"

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        print("ALL LOBBY CHECKS PASSED" if not errors else "COMPLETED WITH ERRORS")
        browser.close()
finally:
    srv.terminate()
