import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

# First-run (brand-new user) flow: a player who never played, has no progress and
# never completed level 1 is dropped STRAIGHT into level 1 on boot — no lobby in
# the way. Completing that first level lands them on the lobby, and from then on
# every boot lands on the lobby (they are no longer new).

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
        page = browser.new_page(viewport={"width": 750, "height": 1334})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
        os.makedirs(OUT, exist_ok=True)
        def snap(tag):
            page.screenshot(path=f"{OUT}/newuser_{tag}.png")

        def boot():
            page.wait_for_function("window.__game && window.__game.lobby", timeout=15000)
            time.sleep(0.8)
            # Landing in level 1 opens the modal "How To Play" popup (howtoplay_test
            # owns it); dismiss it so the level is playable. A no-op in the lobby.
            page.evaluate("window.__game.closeTutorial()")

        # A fresh browser profile has no saved record at all -> brand-new player.
        page.goto("http://localhost:8099/index.html")
        boot()

        st = page.evaluate("window.__game.state()")
        new = page.evaluate("window.__game.isNewPlayer()")
        done = page.evaluate("window.__game.completedLevel()")
        print("BRAND NEW -> isNewPlayer:", new, "completed:", done,
              "inLobby:", st["inLobby"], "level:", st["level"],
              "boardCount:", st["boardCount"])
        snap("first_run")
        assert new is True, "a fresh profile must be a new player"
        assert done == 0, f"nothing completed yet, got {done}"
        assert st["inLobby"] is False, "a brand-new user must skip the lobby"
        assert st["level"] == 1, f"must land in level 1, got {st['level']}"
        assert st["boardCount"] > 0, "level 1 must actually be dealt"

        # Leaving mid-level-1 (Back) shows the lobby, but the player is STILL new:
        # a reload sends them right back into level 1 (they never completed it).
        page.evaluate("window.__game.exitLevel()")
        time.sleep(0.5)
        assert page.evaluate("window.__game.inLobby()") is True, "Back should show the lobby"
        assert page.evaluate("window.__game.isNewPlayer()") is True, \
            "quitting level 1 must not end the first-run flow"
        page.evaluate("window.__game.flushSave()")
        page.reload()
        boot()
        st = page.evaluate("window.__game.state()")
        print("AFTER QUIT+RELOAD -> inLobby:", st["inLobby"], "level:", st["level"])
        assert st["inLobby"] is False and st["level"] == 1, \
            "an unfinished level 1 must still route back into the level"

        # Solve level 1 -> win overlay -> Continue -> the lobby, at level 2.
        for _ in range(4000):
            s = page.evaluate("window.__game.state()")
            if s["overlay"] or s["inLobby"]:
                break
            if page.evaluate("window.__game.solveTap()") == -1:
                time.sleep(0.05)
            time.sleep(0.02)
        time.sleep(0.5)
        s = page.evaluate("window.__game.state()")
        print("L1 SOLVED -> overlay:", s["overlay"], "boardCount:", s["boardCount"])
        assert s["overlay"] is True and s["boardCount"] == 0

        page.evaluate("window.__game.pressWinContinue()")
        time.sleep(0.9)
        st = page.evaluate("window.__game.state()")
        new = page.evaluate("window.__game.isNewPlayer()")
        done = page.evaluate("window.__game.completedLevel()")
        btn = page.evaluate("window.__game.lobbyButtonText()")
        print("AFTER L1 WIN -> inLobby:", st["inLobby"], "isNewPlayer:", new,
              "completed:", done, "button:", repr(btn))
        snap("lobby_after_first_win")
        assert st["inLobby"] is True, "completing level 1 must land on the lobby"
        assert done == 1, f"level 1 should be recorded as completed, got {done}"
        assert new is False, "completing level 1 ends the first-run flow"
        assert btn == "Level 2", f"expected 'Level 2', got {btn!r}"

        # ...and it sticks: every later boot lands on the lobby.
        page.evaluate("window.__game.flushSave()")
        page.reload()
        boot()
        st = page.evaluate("window.__game.state()")
        prof = page.evaluate("window.__game.user()")
        print("AFTER RELOAD -> inLobby:", st["inLobby"],
              "isNewPlayer:", page.evaluate("window.__game.isNewPlayer()"),
              "progress:", prof["progress"])
        assert st["inLobby"] is True, "a returning player must land on the lobby"
        assert prof["progress"]["completed"] == 1, "completion must persist"

        # Resetting the profile makes the player brand-new again -> back to level 1.
        page.evaluate("window.__game.reset()")
        time.sleep(0.6)
        assert page.evaluate("window.__game.isNewPlayer()") is True, "reset -> new player"
        page.evaluate("window.__game.flushSave()")
        page.reload()
        boot()
        st = page.evaluate("window.__game.state()")
        print("AFTER RESET+RELOAD -> inLobby:", st["inLobby"], "level:", st["level"])
        assert st["inLobby"] is False and st["level"] == 1, \
            "a reset profile must go through the first-run flow again"

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        assert not errors, "console errors during the first-run flow"
        print("ALL NEW-USER CHECKS PASSED")
        browser.close()
finally:
    srv.terminate()
