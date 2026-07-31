#!/usr/bin/env python3
# End-to-end test for the Lucky Wheel (src/luckywheel.js).
#
# Drives the real game headlessly through the window.__game debug API. Covers:
# progression gating + badges, the free spin (grant + won-mark + pip + rapid-tap
# guard), no-repeat across a cycle, the ad path (cancel/fail spend nothing;
# succeed spins), last-spin auto-close, per-cycle persistence across a reload, and
# the daily rollover (group advance + wrap + state reset).

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
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 780, "height": 1334})
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene && !!window.__game.wheelState", timeout=20000)
        time.sleep(0.5)

        def st():        return page.evaluate("window.__game.wheelState()")
        def badges():    return page.evaluate("window.__game.wheelBadges()")
        def coins():     return page.evaluate("window.__game.balance('coins')")
        def undo():      return page.evaluate("window.__game.boosterCount('undo')")
        def unlock5():   page.evaluate("window.__game.store.user.setLevel(5)")
        def open_w():    page.evaluate("window.__game.openWheel()")
        def force(i):    page.evaluate(f"window.__game.forceWheelPrize({i})")
        def admode(m):   page.evaluate(f"window.__game.setWheelAdResult('{m}')")
        def press():     page.evaluate("window.__game.pressWheelSpin()")
        def spin():      page.evaluate("window.__game.spinWheel()")  # awaits the settle
        def setday(k):   page.evaluate(f"window.__game.setWheelToday('{k}')")

        def wait_idle(timeout=10):
            end = time.time() + timeout
            while time.time() < end:
                if not st()["spinning"]:
                    return st()
                time.sleep(0.1)
            return st()

        def wait_spins(n, timeout=10):
            end = time.time() + timeout
            while time.time() < end:
                s = st()
                if s["spinsUsed"] >= n and not s["spinning"]:
                    return s
                time.sleep(0.1)
            return st()

        # ---- 1. Gating -----------------------------------------------------
        s = st()
        assert s["unlocked"] is False, ("locked below the unlock level", s)
        assert s["buttonVisible"] is False, ("no lobby button before unlock", s)

        unlock5()
        s = st()
        assert s["unlocked"] is True, ("unlocked at level 5", s)
        assert s["buttonVisible"] is True, ("lobby button appears once unlocked", s)
        bd = badges()
        assert bd["new"] is True, ("carries the NEW badge until first open", bd)
        assert bd["free"] is True, ("carries the free-spin badge", bd)

        # ---- 2. Open + free spin (with a rapid double-tap guard) -----------
        open_w()
        time.sleep(0.35)
        s = st()
        assert s["overlayOpen"] is True, ("wheel opened", s)
        assert s["group"] == 1, ("first cycle is group 1", s)
        assert s["seen"] is True, ("opening clears the NEW badge state", s)
        assert s["slices"] == 8, ("wheel is built from the group (8 prizes)", s)
        assert coins() == 0, ("no coins yet", coins())

        force(0)                      # group 1 slice 0 = coins x30
        press(); press()              # two rapid taps — must spend only ONE spin
        s = wait_spins(1)
        assert s["spinsUsed"] == 1, ("rapid double-tap spends exactly one spin", s)
        assert s["won"] == [0], ("slice 0 is recorded won", s)
        assert coins() == 30, ("the 30-coin prize landed in the wallet", coins())
        bd = badges()
        assert bd["free"] is False, ("free badge drops the moment the free spin is used", bd)
        assert s["buttonVisible"] is True, ("button stays — ad spins remain", s)

        # ---- 3. Persistence across a reload --------------------------------
        page.evaluate("window.__game.flushSave()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene && !!window.__game.wheelState", timeout=20000)
        time.sleep(0.4)
        s = st()
        assert s["group"] == 1 and s["spinsUsed"] == 1 and s["won"] == [0], ("cycle state survives a reload", s)
        assert s["seen"] is True and coins() == 30, ("seen flag + wallet survive a reload", s, coins())
        assert s["unlocked"] is True, ("level (progress) survived", s)

        # ---- 4. Ad path: cancel/fail spend nothing; succeed spins ----------
        open_w()
        time.sleep(0.3)
        admode("cancel")
        before = st()["spinsUsed"]
        spin()
        s = wait_idle()
        assert s["spinsUsed"] == before and s["won"] == [0], ("cancel spends no spin, wins nothing", s)

        admode("fail")
        spin()
        s = wait_idle()
        assert s["spinsUsed"] == before, ("ad failure spends no spin", s)

        # succeed for the rest of the cycle; every prize must be distinct (no-repeat)
        admode("succeed")
        guard = 0
        while st()["canSpin"] and st()["overlayOpen"] and guard < 20:
            guard += 1
            spin()
            wait_idle()
        s = st()
        assert s["spinsUsed"] == 6, ("the cycle allows exactly 6 spins", s)
        won = s["won"]
        assert len(won) == 6 and len(set(won)) == 6, ("a prize can only be won once per cycle", won)

        # ---- 5. Last-spin auto-close --------------------------------------
        assert s["overlayOpen"] is False, ("the wheel closes itself after the last spin", s)
        assert s["canSpin"] is False, ("no spins left", s)
        assert s["buttonVisible"] is False, ("lobby button hides once the day's spins are used", s)

        # ---- 6. Daily rollover: advance group, reset the cycle -------------
        setday("2099-01-02")
        s = st()
        assert s["group"] == 2, ("the rollover advances to the next group", s)
        assert s["spinsUsed"] == 0 and s["won"] == [], ("rollover clears the cycle state", s)
        assert s["canSpin"] is True and s["buttonVisible"] is True, ("fresh cycle re-shows the button", s)
        assert badges()["free"] is True, ("a fresh free spin is available again", badges())

        # wrap: keep advancing the day; after the last group (5) it wraps to 1.
        seq = []
        for i, day in enumerate(["2099-02-01", "2099-03-01", "2099-04-01", "2099-05-01"]):
            setday(day)
            seq.append(st()["group"])
        assert seq == [3, 4, 5, 1], ("group order wraps after the last group", seq)

        page.screenshot(path=f"{SC}/luckywheel.png")
        assert not errs, ("no console/page errors", errs)
        print("LUCKY WHEEL TEST PASSED")
        b.close()
finally:
    srv.terminate()
