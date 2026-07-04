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
        warnings = []
        page.on("console", lambda m: warnings.append(m.text)
                if "AudioContext" in m.text else None)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => { localStorage.removeItem('tilemaster.level'); localStorage.removeItem('tilemaster.muted'); }")
        warnings.clear()
        page.reload()
        page.wait_for_function("window.__game && window.__game.audioState", timeout=20000)
        time.sleep(0.8)

        # Emulate a real browser that starts suspended (headless starts running).
        page.evaluate("""async () => {
          const a = window.__game.audio;
          a._stopBgm();
          await a._ctx.suspend();
        }""")
        time.sleep(0.2)
        warnings.clear()

        # Simulate the on-load bgm selection: must NOT resume (no warning) and
        # must NOT start while suspended.
        page.evaluate("() => window.__game.audio.playBgm('Game_bgm')")
        time.sleep(0.4)
        a = page.evaluate("window.__game.audioState()")
        print("AFTER playBgm() WHILE SUSPENDED:", a, "| AudioContext warnings:", warnings)
        assert a["ctx"] == "suspended", "playBgm must not resume the context on load"
        assert a["bgmStarted"] is False, "must not start while suspended"
        assert not warnings, f"playBgm on load should not warn: {warnings}"

        # Now a real user gesture on an EMPTY area (top of the lobby, not the button).
        page.mouse.click(390, 150)
        page.wait_for_function(
            "window.__game.audioState().ctx === 'running' && window.__game.audioState().bgmStarted === true",
            timeout=5000)
        a = page.evaluate("window.__game.audioState()")
        print("AFTER CLICK ON EMPTY AREA:", a)
        assert a["bgmStarted"] is True and a["ctx"] == "running"

        print("PAGE ERRORS:", len(errors), errors[:5])
        print("GESTURE-UNLOCK PASSED" if not errors else "ERRORS PRESENT")
        browser.close()
finally:
    srv.terminate()
