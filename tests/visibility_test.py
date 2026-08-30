import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

def set_visibility(page, state):
    page.evaluate("""(s) => {
      Object.defineProperty(document, 'visibilityState', {configurable:true, get:()=>s});
      document.dispatchEvent(new Event('visibilitychange'));
    }""", state)

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": 780, "height": 1334})
    harness.patient(page)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    warnings = []
    page.on("console", lambda m: warnings.append(m.text) if "AudioContext" in m.text else None)

    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.audioState", timeout=60000)

    # Unlock audio with a gesture -> music running
    page.mouse.click(390, 150)
    page.wait_for_function("window.__game.audioState().ctx === 'running' && window.__game.audioState().bgmStarted === true", timeout=15000)
    before = page.evaluate("window.__game.user().settings")
    print("PLAYING:", page.evaluate("window.__game.audioState()"), "| settings:", before)

    # 1) Switch to another tab -> context suspended (music inaudible), settings untouched
    set_visibility(page, "hidden")
    page.wait_for_function("window.__game.audioState().ctx === 'suspended'", timeout=15000)
    a = page.evaluate("window.__game.audioState()")
    s = page.evaluate("window.__game.user().settings")
    print("HIDDEN:", a, "| settings:", s)
    assert a["ctx"] == "suspended", "audio must be suspended (inaudible) when tab hidden"
    assert s == before == {"music": True, "sound": True}, "settings must NOT change"

    # 2) Return to the tab -> context resumes, music audible again, settings still untouched
    set_visibility(page, "visible")
    page.wait_for_function("window.__game.audioState().ctx === 'running'", timeout=15000)
    a = page.evaluate("window.__game.audioState()")
    s = page.evaluate("window.__game.user().settings")
    print("VISIBLE AGAIN:", a, "| settings:", s)
    assert a["ctx"] == "running" and a["bgmStarted"] is True, "music must resume on return"
    assert s == {"music": True, "sound": True}, "settings must still be unchanged"

    # 3) With music switched OFF by the user, a hide/show cycle must not turn it back on
    page.evaluate("window.__game.setMusic(false)")
    set_visibility(page, "hidden")
    time.sleep(0.2)
    set_visibility(page, "visible")
    time.sleep(0.3)
    a = page.evaluate("window.__game.audioState()")
    s = page.evaluate("window.__game.user().settings")
    print("AFTER CYCLE (music off):", a, "| settings:", s)
    assert a["music"] is False and a["bgmStarted"] is False, "music stays off across visibility cycle"
    assert s["music"] is False, "user's music=off preference preserved"

    print("PAGE ERRORS:", len(errors), errors[:5])
    print("AudioContext warnings:", warnings)
    assert not errors and not warnings
    print("ALL VISIBILITY CHECKS PASSED")
    browser.close()