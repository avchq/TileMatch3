#!/usr/bin/env python3
# End-to-end test for the SHARED PILL BUTTON's click cue (src/layout.js makeButton).
#
# Every screen in the game is closed by the same rounded, white-hairlined button.
# It used to be a private `_makeButton` method copied into nine modules, and the
# copies disagreed on the one thing that matters here: six of them were silent,
# so each of their CALLERS played `btn_01` by hand to make up for it. That is not
# a stable arrangement — the compensation is invisible from the button, so it was
# already both forgotten (Daily Bonus's "Double It" made no sound at all when the
# ad was cancelled) and doubled up (the language picker's Back played the cue
# twice: once from its own copy, once again from `_close`).
#
# The invariant this file pins: pressing ANY button built by the shared factory
# emits the click cue EXACTLY ONCE. Not zero (a dead-feeling press), not two (an
# audible flam). It presses the real hit path — `pressPillButton` emits
# `pointertap` on the actual container — and counts what the audio manager really
# emitted, via soundLog().
#
# Covers the buttons of settings, shop (Back + Buy), fortune wheel, tasks, daily
# bonus (Back + Claim + Double), the language picker (Back + Confirm), the Super
# Wand promo, and the level's own win-overlay Continue.

import time, os
from playwright.sync_api import sync_playwright

import harness

SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

CUE = "btn_01"

# A fixed day/level so the daily gift and the gated screens are deterministic.
T0 = "2050-06-15"

BASE = harness.serve()
with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    harness.boot(page, "window.__game && !!window.__game.pressPillButton", timeout=60000,
                 url=BASE)
    # Boot into the LOBBY: a profile that never cleared level 1 is routed straight
    # into the level by the first-run flow (see newuser_test.py). Level 12 also
    # clears every progression gate the overlays sit behind.
    page.evaluate("window.__game.completeLevel(12); window.__game.flushSave();")
    page.reload()
    page.wait_for_function("window.__game && !!window.__game.pressPillButton", timeout=60000)
    time.sleep(0.6)

    def names():      return page.evaluate("window.__game.pillButtonNames()")
    def log():        return page.evaluate("window.__game.soundLog()")
    def clear():      page.evaluate("window.__game.clearSoundLog()")
    def ev(js):       return page.evaluate(js)

    def press(name):
        assert ev(f"window.__game.pressPillButton({name!r})") is True, \
            f"{name} must exist and be pressable"

    def cues(name, settle=0.45):
        """Press `name` on the real hit path and count the click cues it emitted."""
        clear()
        press(name)
        time.sleep(settle)
        return log().count(CUE)

    def one(name, **kw):
        n = cues(name, **kw)
        assert n == 1, (f"{name}: a press must emit exactly one {CUE}", n, log())

    # ---- 0. The factory's buttons are all reachable ---------------------
    EXPECTED = {
        "settings.back", "shop.back", "shop.buy", "wheel.back", "tasks.back",
        "daily.back", "daily.claim", "daily.double",
        "language.back", "language.confirm", "promo.ok",
    }
    assert set(names()) == EXPECTED, ("the pill-button roster drifted", names())

    # ---- 1. Settings -----------------------------------------------------
    ev("window.__game.openSettings()")
    assert ev("window.__game.settingsVisible()") is True
    one("settings.back")
    assert ev("window.__game.settingsVisible()") is False, "Back must close settings"

    # ---- 2. Shop: Back, and a package's Buy ------------------------------
    ev("window.__game.openShop()")
    one("shop.back")

    ev("window.__game.openShop()")
    one("shop.buy")
    ev("window.__game.closeShop()")

    # ---- 3. Fortune wheel ------------------------------------------------
    ev("window.__game.openWheel()")
    one("wheel.back")

    # ---- 4. Tasks --------------------------------------------------------
    ev("window.__game.openTasks()")
    one("tasks.back")

    # ---- 5. Super Wand promo --------------------------------------------
    ev("window.__game.openSuperWandPromo()")
    one("promo.ok")

    # ---- 6. Language picker ---------------------------------------------
    # Back went through the one copy that DID play the cue and then through a
    # `_close` that played it again — two cues for one press.
    ev("window.__game.openLanguagePicker()")
    one("language.back")

    ev("window.__game.openLanguagePicker()")
    one("language.confirm")
    time.sleep(0.4)

    # ---- 7. Daily bonus: Back, Double (cancelled ad), Claim --------------
    ev(f"window.__game.setDailyToday('{T0}')")
    ev("window.__game.openDailyBonus()")
    assert ev("window.__game.dailyBonusState()")["overlayOpen"] is True
    one("daily.back")
    # Backing out before a box is opened must not spend the day.
    assert ev("window.__game.dailyBonusState()")["canClaim"] is True

    ev("window.__game.openDailyBonus()")
    ev("window.__game.pickDailyBox(0)")
    time.sleep(0.6)
    # A CANCELLED ad changes nothing and returns — the press itself is the only
    # thing that can make a sound, and it used to make none.
    ev("window.__game.setDailyAdResult('cancel')")
    one("daily.double")
    assert ev("window.__game.dailyBonusState()")["taken"] is False, \
        "a cancelled ad must leave the plain Claim available"

    # Claim collects and closes; count once the whole sequence has landed, so
    # this holds wherever in it the cue fires.
    clear()
    press("daily.claim")
    page.wait_for_function("window.__game.dailyBonusState().taken === true", timeout=8000)
    time.sleep(0.8)
    n = log().count(CUE)
    assert n == 1, ("daily.claim: a press must emit exactly one cue", n, log())

    # ---- 8. The level's win overlay -------------------------------------
    page.evaluate("window.__game.markBoosterCoached('all')")
    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.5)
    for _ in range(8000):
        s = ev("window.__game.state()")
        if s["overlay"] or s["inLobby"]:
            break
        if ev("window.__game.solveTap()") == -1:
            time.sleep(0.05)
        time.sleep(0.015)
    time.sleep(0.4)
    assert ev("window.__game.state()")["overlay"], "the level did not reach its win overlay"
    clear()
    ev("window.__game.pressWinContinue()")
    time.sleep(0.45)
    n = log().count(CUE)
    assert n == 1, ("win Continue: a press must emit exactly one cue", n, log())

    page.screenshot(path=f"{SC}/buttonsound_end.png")
    assert not errs, errs
    b.close()

print("buttonsound_test: PASS")
