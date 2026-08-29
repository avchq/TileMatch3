import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
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

        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=20000)
        # Boot into the LOBBY: a profile that never cleared level 1 is routed
        # straight into the level by the first-run flow (see newuser_test.py), so
        # record a level-1 clear to get the lobby-side cog under test.
        page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=20000)
        time.sleep(0.6)

        box = page.eval_on_selector("canvas", "c => { const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
        def click_design(dx, dy):
            page.mouse.click(box["x"] + box["w"] * (dx / 750), box["y"] + box["h"] * (dy / 1334))
            time.sleep(0.35)

        def snap(tag):
            page.screenshot(path=f"{SC}/settings_{tag}.png")

        COG = (60, 84)  # settings cog moved to top-left
        MUSIC_TOGGLE = (583, 627)
        SOUND_TOGGLE = (583, 737)
        # The panel grew downward to make room for the Language row (which sits
        # between Sound and Back — see languagepicker_test.py), so Back moved
        # while the two toggles kept their offsets from the panel centre.
        BACK = (375, 933)

        # -- Lobby: cog opens settings ---------------------------------------
        assert page.evaluate("window.__game.settingsVisible()") is False
        assert page.evaluate("window.__game.inLobby()") is True
        snap("lobby")
        click_design(*COG)
        assert page.evaluate("window.__game.settingsVisible()") is True, "cog must open settings from lobby"
        snap("open_lobby")
        st = page.evaluate("window.__game.audioState()")
        print("settings open (lobby) audio:", st)
        assert st["music"] is True and st["sound"] is True

        # -- Toggle Music off -> bgm channel off + persisted ------------------
        click_design(*MUSIC_TOGGLE)
        st = page.evaluate("window.__game.audioState()")
        us = page.evaluate("window.__game.user().settings")
        print("after Music toggle:", st, "| user.settings:", us)
        assert st["music"] is False and us["music"] is False, "Music toggle must turn off music + persist"
        assert st["sound"] is True and us["sound"] is True, "Sound must be unaffected"

        # -- Toggle Sound off -------------------------------------------------
        click_design(*SOUND_TOGGLE)
        st = page.evaluate("window.__game.audioState()")
        us = page.evaluate("window.__game.user().settings")
        print("after Sound toggle:", st, "| user.settings:", us)
        assert st["sound"] is False and us["sound"] is False, "Sound toggle must turn off SFX + persist"
        snap("both_off")

        # -- Back returns to the lobby ---------------------------------------
        click_design(*BACK)
        assert page.evaluate("window.__game.settingsVisible()") is False, "Back must close settings"
        assert page.evaluate("window.__game.inLobby()") is True, "should be back on the lobby"

        # -- Persistence + toggles reflect live state on reopen --------------
        page.evaluate("window.__game.flushSave()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=20000)
        time.sleep(0.5)
        us = page.evaluate("window.__game.user().settings")
        print("after reload user.settings:", us)
        assert us == {"music": False, "sound": False}, "settings must persist across reload"
        box = page.eval_on_selector("canvas", "c => { const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
        click_design(*COG)
        snap("reopen_both_off")  # both toggles should visually read OFF (synced from state)

        # turn Music back on to confirm two-way control
        click_design(*MUSIC_TOGGLE)
        st = page.evaluate("window.__game.audioState()")
        assert st["music"] is True, "toggling Music again must turn it back on"
        click_design(*BACK)

        # -- Settings also reachable from inside the level scene -------------
        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.6)
        assert page.evaluate("window.__game.state()")["inLobby"] is False
        snap("level")
        box = page.eval_on_selector("canvas", "c => { const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
        click_design(*COG)
        assert page.evaluate("window.__game.settingsVisible()") is True, "cog must open settings from the level"
        snap("open_level")
        click_design(*BACK)
        assert page.evaluate("window.__game.settingsVisible()") is False
        assert page.evaluate("window.__game.state()")["inLobby"] is False, "Back returns to the level, not the lobby"

        print("PAGE ERRORS:", len(errors), errors[:5])
        assert not errors
        print("ALL SETTINGS CHECKS PASSED")
        browser.close()
finally:
    srv.terminate()
