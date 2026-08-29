import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
try:
    with sync_playwright() as p:
        # Launch WITHOUT the permissive autoplay flag.
        browser = p.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 780, "height": 1334})
        errors = []
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => { localStorage.removeItem('tm3.level'); localStorage.removeItem('tm3.muted'); }")
        page.reload()
        page.wait_for_function("window.__game && window.__game.audioState", timeout=20000)
        time.sleep(0.6)

        # Force the context suspended + stop bgm, to emulate a real browser that
        # blocks autoplay before any user gesture.
        page.evaluate("""async () => {
          const a = window.__game.audio;
          a._stopBgm();
          await a._ctx.suspend();
        }""")
        time.sleep(0.2)
        a = page.evaluate("window.__game.audioState()")
        print("FORCED SUSPENDED:", a)
        assert a["ctx"] == "suspended" and a["bgmStarted"] is False

        # Calling playBgm while suspended must NOT create a source synchronously...
        started_sync = page.evaluate("""() => {
          window.__game.audio.playBgm('Game_bgm');
          return !!window.__game.audio._bgmSource;   // immediately after
        }""")
        print("source created synchronously while suspended:", started_sync)
        assert started_sync is False, "must not start bgm while suspended"

        # ...but after a real user gesture resumes the context, the deferred bgm
        # should start (a suspended ctx never self-resumes without a gesture).
        page.mouse.click(390, 150)
        page.wait_for_function(
            "window.__game.audioState().ctx === 'running' && window.__game.audioState().bgmStarted === true",
            timeout=5000)
        a = page.evaluate("window.__game.audioState()")
        print("AFTER RESUME SETTLES:", a)
        assert a["bgmStarted"] is True and a["ctx"] == "running"

        print("ERRORS:", len(errors), errors[:5])
        print("DEFERRED-START PASSED" if not errors else "ERRORS PRESENT")
        browser.close()
finally:
    srv.terminate()
