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
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
            "--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page(viewport={"width": 780, "height": 1334})
        errors = []
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.audioState", timeout=20000)
        time.sleep(0.8)

        # 1) Fresh load, in lobby, NO user gesture -> bgm should be playing
        st = page.evaluate("window.__game.state()")
        a = page.evaluate("window.__game.audioState()")
        print("FRESH LOAD (no gesture):", a, "| inLobby:", st["inLobby"])
        assert st["inLobby"] is True
        assert a["bgmStarted"] is True, "bgm should start on initial load in the lobby"
        assert a["ctx"] == "running", f"audio ctx should be running, got {a['ctx']}"
        assert a["muted"] is False

        # 2) User switches sound OFF (master mute) -> bgm stops, preference persisted
        page.evaluate("window.__game.setMuted(true)")
        page.evaluate("window.__game.flushSave()")
        time.sleep(0.3)
        a = page.evaluate("window.__game.audioState()")
        print("AFTER MUTE:", a)
        assert a["bgmStarted"] is False, "bgm should stop when muted"
        assert a["muted"] is True, "both channels off"
        assert page.evaluate("window.__game.user()")["settings"] == {"music": False, "sound": False}, \
            "mute preference should persist to the user profile"

        # 3) Reload -> muted was switched off by user, so NO bgm on load
        page.reload()
        page.wait_for_function("window.__game && window.__game.audioState", timeout=20000)
        time.sleep(0.8)
        a = page.evaluate("window.__game.audioState()")
        print("RELOAD WHILE MUTED:", a)
        assert a["muted"] is True, "mute preference should be restored"
        assert a["bgmStarted"] is False, "no bgm on load when user has muted"

        # 4) User turns sound back ON -> bgm resumes
        page.evaluate("window.__game.setMuted(false)")
        page.evaluate("window.__game.flushSave()")
        time.sleep(0.3)
        a = page.evaluate("window.__game.audioState()")
        print("AFTER UNMUTE:", a)
        assert a["bgmStarted"] is True, "bgm should resume when unmuted"
        assert a["muted"] is False

        # 5) Reload -> unmuted, bgm plays again on load
        page.reload()
        page.wait_for_function("window.__game && window.__game.audioState", timeout=20000)
        time.sleep(0.8)
        a = page.evaluate("window.__game.audioState()")
        print("RELOAD WHILE UNMUTED:", a)
        assert a["bgmStarted"] is True and a["muted"] is False

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        print("ALL BGM CHECKS PASSED" if not errors else "COMPLETED WITH ERRORS")
        browser.close()
finally:
    srv.terminate()
