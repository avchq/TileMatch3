import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

def ready(page):
    page.wait_for_function("window.__game && window.__game.user", timeout=60000)
    time.sleep(0.4)

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
    ready(page)

    # 1) Fresh profile shape
    u = page.evaluate("window.__game.user()")
    print("FRESH USER:", u)
    assert u["platform"] == "web", u
    assert isinstance(u["id"], str) and len(u["id"]) > 0, u
    assert u["progress"]["level"] == 1, u
    assert u["progress"]["completed"] == 0, u  # never cleared a level -> brand new
    assert u["wallet"] == {"coins": 0, "gems": 0}, u
    # Helpers are not awarded at account creation — they unlock over the first
    # levels (boosterunlock_test.py).
    assert u["boosters"] == {"undo": 0, "shuffle": 0, "wand": 0}, u
    assert u["boosterUnlocks"] == [], u
    assert u["settings"] == {"music": True, "sound": True}, u
    first_id = u["id"]

    # 2) Progress persists across reload (and id is stable)
    page.evaluate("window.__game.setLevel(3)")
    page.evaluate("window.__game.flushSave()")
    time.sleep(0.2)
    page.reload(); ready(page)
    u = page.evaluate("window.__game.user()")
    print("AFTER RELOAD (progress):", u["progress"], u["id"])
    assert u["progress"]["level"] == 3, u
    assert u["id"] == first_id, ("id must be stable", u["id"], first_id)

    # 3) Wallet: credit / debit / insufficient-funds / persistence
    assert page.evaluate("window.__game.credit('coins', 100)") == 100
    assert page.evaluate("window.__game.debit('coins', 30)") is True
    assert page.evaluate("window.__game.balance('coins')") == 70
    assert page.evaluate("window.__game.debit('coins', 1000)") is False, "overspend must fail"
    assert page.evaluate("window.__game.balance('coins')") == 70, "balance unchanged after failed debit"
    page.evaluate("window.__game.credit('gems', 5)")
    page.evaluate("window.__game.flushSave()")
    time.sleep(0.2)
    page.reload(); ready(page)
    u = page.evaluate("window.__game.user()")
    print("AFTER RELOAD (wallet):", u["wallet"])
    assert u["wallet"]["coins"] == 70 and u["wallet"]["gems"] == 5, u

    # 4) Settings split: music and sound are independent + persist
    page.mouse.click(390, 150)  # gesture -> unlock audio context
    page.wait_for_function("window.__game.audioState().ctx === 'running'", timeout=15000)
    a = page.evaluate("window.__game.audioState()")
    print("AUDIO (running):", a)
    assert a["bgmStarted"] is True, a

    page.evaluate("window.__game.setMusic(false)")
    a = page.evaluate("window.__game.audioState()")
    assert a["music"] is False and a["bgmStarted"] is False, ("music off stops bgm", a)
    assert page.evaluate("() => !!window.__game.playSound('btn_01')") is True, "sfx still audible with music off"

    page.evaluate("window.__game.setSound(false)")
    assert page.evaluate("() => !!window.__game.playSound('btn_01')") is False, "sfx muted with sound off"

    page.evaluate("window.__game.flushSave()")
    time.sleep(0.2)
    page.reload(); ready(page)
    u = page.evaluate("window.__game.user()")
    a = page.evaluate("window.__game.audioState()")
    print("AFTER RELOAD (settings):", u["settings"], "| audio:", a)
    assert u["settings"] == {"music": False, "sound": False}, u
    assert a["music"] is False and a["sound"] is False and a["bgmStarted"] is False, a

    print("PAGE ERRORS:", len(errors), errors[:5])
    print("AudioContext warnings:", warnings)
    assert not errors and not warnings
    print("ALL USER CHECKS PASSED")
    browser.close()