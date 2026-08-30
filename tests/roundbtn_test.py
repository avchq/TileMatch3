import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=angle","--use-angle=swiftshader",
        "--enable-unsafe-swiftshader","--ignore-gpu-blocklist"])
    page = b.new_page(viewport={"width":780,"height":1334})
    harness.patient(page)
    errs=[]
    page.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
    page.on("pageerror", lambda e: errs.append("PAGEERROR: "+str(e)))
    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.settings", timeout=60000)
    time.sleep(0.6)
    # Undo/Reshuffle are helpers consumed from inventory — top up so the
    # buttons are enabled for the click test.
    page.evaluate("window.__game.grantBooster('undo', 999)")
    page.evaluate("window.__game.grantBooster('shuffle', 999)")
    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.8)
    page.screenshot(path=f"{SC}/roundbtn_level.png")
    # exercise reshuffle + undo via the actual buttons region
    box = page.eval_on_selector("canvas","c=>{const r=c.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}}")
    before = page.evaluate("window.__game.state()")
    # tap a couple tiles then undo, reshuffle
    page.evaluate("window.__game.solveTap()")
    time.sleep(0.3)
    # click Undo button (575,1270) and Reshuffle (175,1270)
    page.mouse.click(box["x"]+box["w"]*(575/750), box["y"]+box["h"]*(1270/1334)); time.sleep(0.3)
    page.mouse.click(box["x"]+box["w"]*(175/750), box["y"]+box["h"]*(1270/1334)); time.sleep(0.3)
    st = page.evaluate("window.__game.state()")
    print("state after undo+reshuffle:", st)
    print("PAGE ERRORS:", len(errs), errs[:5])
    assert not errs
    print("ROUND BUTTON TEST PASSED")
    b.close()