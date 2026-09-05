#!/usr/bin/env python3
# End-to-end test for the Fortune Wheel (src/fortunewheel.js).
#
# Drives the real game headlessly through the window.__game debug API. Covers:
# progression gating + badges, the free spin (grant + won-mark + pip + rapid-tap
# guard), no-repeat across a cycle, the ad path (cancel/fail spend nothing;
# succeed spins), last-spin auto-close, per-cycle persistence across a reload, and
# the daily rollover (group advance + wrap + state reset).

import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

BASE = harness.serve()
with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene && !!window.__game.wheelState", timeout=60000)
    time.sleep(0.5)

    # A fixed test day, injected via setWheelToday so the wheel's clock is
    # deterministic — otherwise a real midnight crossing (or the main-loop
    # rollover ticker) could advance the cycle mid-test and make it flaky.
    T0 = "2050-06-15"

    def st():        return page.evaluate("window.__game.wheelState()")
    def badges():    return page.evaluate("window.__game.wheelBadges()")
    def coins():     return page.evaluate("window.__game.balance('coins')")
    def undo():      return page.evaluate("window.__game.boosterCount('undo')")
    # The gate is the profile's: cleared unlockLevel - 1, like every other
    # feature (unlockgate_test.py owns the convention).
    def unlock5():   page.evaluate("window.__game.setCompleted(4)")
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

    # The pointer is a spring: it lets go and swings back to centre a beat
    # after the wheel itself stops, so `spinning === false` is not yet "still".
    def wait_pointer_centre(timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            pt = page.evaluate("window.__game.wheelPointer()")
            if abs(pt["pointer"]) < 1e-6:
                return pt
            time.sleep(0.05)
        return page.evaluate("window.__game.wheelPointer()")

    # The prize is credited on the fly-back animation's landing, which happens
    # a beat after the wheel stops spinning — poll rather than reading instantly.
    def wait_coins(n, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            if coins() >= n:
                return coins()
            time.sleep(0.1)
        return coins()

    # ---- 1. Gating -----------------------------------------------------
    s = st()
    assert s["unlocked"] is False, ("locked below the unlock level", s)
    assert s["buttonVisible"] is False, ("no lobby button before unlock", s)

    unlock5()
    setday(T0)                    # pin the wheel's clock for the rest of the run
    s = st()
    assert s["unlocked"] is True, ("unlocked once level 4 is cleared", s)
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
    assert wait_coins(30) == 30, ("the 30-coin prize landed in the wallet", coins())
    bd = badges()
    assert bd["free"] is False, ("free badge drops the moment the free spin is used", bd)
    assert s["buttonVisible"] is True, ("button stays — ad spins remain", s)

    # ---- 2b. Pointer leans WITH the spin -------------------------------
    # The pointer's tip rests on the wheel's top rim and it pivots about that
    # tip, so a clockwise wheel (rotation increasing) must swing the pointer
    # counter-clockwise (negative rotation) — leaning in the direction of
    # travel, not against it. It must also come back to rest at 0.
    open_w()
    time.sleep(0.3)
    force(1)
    press()
    samples = []
    sfx = []
    end = time.time() + 6
    while time.time() < end:
        samples.append(page.evaluate("window.__game.wheelPointer()"))
        sfx.append(page.evaluate("window.__game.wheelSpinSfx()"))
        if not st()["spinning"] and len(samples) > 3:
            break
        time.sleep(0.03)
    moving = [s for s in samples if abs(s["pointer"]) > 0.02]
    assert len(moving) >= 5, ("the pointer visibly deflects while spinning", len(moving), len(samples))
    # the wheel only ever turns clockwise, so every deflection is negative
    assert all(s["pointer"] < 0 for s in moving), \
        ("the pointer leans with the spin, never against it", [round(s["pointer"], 3) for s in moving[:12]])
    assert min(s["pointer"] for s in moving) < -0.2, \
        ("the deflection reaches full lean at speed", min(s["pointer"] for s in moving))
    rots = [s["wheel"] for s in samples]
    assert all(b >= a for a, b in zip(rots, rots[1:])), ("the wheel turns clockwise throughout", rots[:12])
    wait_spins(2)
    assert abs(wait_pointer_centre()["pointer"]) < 1e-6, \
        ("the pointer returns to centre once the wheel settles",
         page.evaluate("window.__game.wheelPointer()"))

    # ---- 2c. The spin-click sound bed (sampled through the same spin) ---
    # A looping click bed runs for exactly as long as the wheel turns, and its
    # playback rate rides the wheel's live speed: near full cadence at peak,
    # slowing to a sparse tick as it settles.
    on = [s for s in sfx if s["active"]]
    assert len(on) >= 5, ("the click bed runs while the wheel spins", len(on), len(sfx))
    assert all(s["loops"] == 1 for s in on), ("exactly one bed, never stacked", on[:6])
    rates = [s["rate"] for s in on]
    assert max(rates) > 0.9, ("the clicks reach full cadence at speed", max(rates))
    assert min(rates) < 0.6, ("and thin out as the wheel slows", min(rates))
    assert rates[-1] < max(rates), ("the bed ends slower than its peak", rates[-1], max(rates))
    s_sfx = page.evaluate("window.__game.wheelSpinSfx()")
    assert s_sfx["active"] is False and s_sfx["loops"] == 0, \
        ("the bed stops with the wheel — no loop left running", s_sfx)
    assert "wheel_spin" in page.evaluate("window.__game.soundLog()"), \
        ("the spin cue was actually emitted", page.evaluate("window.__game.soundLog()")[-8:])

    # ---- 3. Persistence across a reload --------------------------------
    page.evaluate("window.__game.flushSave()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene && !!window.__game.wheelState", timeout=60000)
    setday(T0)                    # re-pin the clock — the override doesn't persist across a reload
    time.sleep(0.4)
    s = st()
    assert s["group"] == 1 and s["spinsUsed"] == 2 and s["won"] == [0, 1], ("cycle state survives a reload", s)
    assert s["seen"] is True and coins() == 30, ("seen flag + wallet survive a reload", s, coins())
    assert s["unlocked"] is True, ("progress (the gate) survived", s)

    # ---- 4. Ad path: cancel/fail spend nothing; succeed spins ----------
    open_w()
    time.sleep(0.3)
    admode("cancel")
    before = st()["spinsUsed"]
    won_before = st()["won"]
    spin()
    s = wait_idle()
    assert s["spinsUsed"] == before and s["won"] == won_before, ("cancel spends no spin, wins nothing", s)

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
    setday("2050-06-16")
    s = st()
    assert s["group"] == 2, ("the rollover advances to the next group", s)
    assert s["spinsUsed"] == 0 and s["won"] == [], ("rollover clears the cycle state", s)
    assert s["canSpin"] is True and s["buttonVisible"] is True, ("fresh cycle re-shows the button", s)
    assert badges()["free"] is True, ("a fresh free spin is available again", badges())

    # wrap: keep advancing the day; after the last group (5) it wraps to 1.
    seq = []
    for day in ["2050-06-17", "2050-06-18", "2050-06-19", "2050-06-20"]:
        setday(day)
        seq.append(st()["group"])
    assert seq == [3, 4, 5, 1], ("group order wraps after the last group", seq)

    # ---- 7. The click bed obeys the Sound setting ----------------------
    # Switching sound off mid-spin cuts the bed there and then (a loop, unlike
    # a one-shot, would otherwise keep clicking), and a spin started with sound
    # off never opens one at all.
    open_w()
    time.sleep(0.3)
    force(0)
    press()
    end = time.time() + 4
    while time.time() < end and not page.evaluate("window.__game.wheelSpinSfx()")["active"]:
        time.sleep(0.03)
    assert page.evaluate("window.__game.wheelSpinSfx()")["active"] is True, "bed running before the mute"
    page.evaluate("window.__game.setSound(false)")
    a = page.evaluate("window.__game.wheelSpinSfx()")
    assert a["active"] is False and a["loops"] == 0, \
        ("switching sound off stops the bed immediately", a)
    wait_spins(1)

    press()                        # a whole spin with sound off
    muted = []
    end = time.time() + 6
    while time.time() < end:
        muted.append(page.evaluate("window.__game.wheelSpinSfx()"))
        if not st()["spinning"] and len(muted) > 3:
            break
        time.sleep(0.03)
    assert not any(m["active"] or m["loops"] for m in muted), \
        ("no click bed while sound is off", [m for m in muted if m["active"]][:3])
    page.evaluate("window.__game.setSound(true)")

    page.screenshot(path=f"{SC}/fortunewheel.png")
    assert not errs, ("no console/page errors", errs)
    print("FORTUNE WHEEL TEST PASSED")
    b.close()