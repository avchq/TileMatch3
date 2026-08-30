import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

# Auto Complete is a FREE endgame button (no booster/inventory). It appears —
# replacing the three helpers in the row — only when the board is trivially
# solvable: total remaining tiles (board + rack) <= 12 AND nothing left covered.
# Pressing it sweeps every tile into the first tray slot and wins the level.
#
# LEVEL 1 IS EXEMPT: the teaching level is played by hand to the win, so the
# button must stay away there even once the endgame gate holds. It joins the
# helper row from level 2 onward.
with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    # Boot into the lobby with the ordinary interface: a profile that never
    # cleared level 1 is routed into the guided first level and its helpers are
    # locked (see firstlevel_test.py). Record a level-5 clear so the helper row
    # below is the normal one, and level 1 is an ordinary replay.
    page.evaluate("window.__game.completeLevel(5); window.__game.flushSave();")
    # Those helpers are unlocked but untaught, so entering a level would open a
    # coached first use and park the board (boostercoach_test.py owns it). This
    # test drives full level descents — take the lesson as read.
    page.evaluate("window.__game.markBoosterCoached('all')")
    time.sleep(0.5)

    def astate(): return page.evaluate("window.__game.autoState()")
    def st():     return page.evaluate("window.__game.state()")

    def descend(gate_should_show):
        """Play a level down with the solver. At EVERY step the availability flag
            must equal the gate (level 1: never), and the HUD row must mirror it.
            Returns True once Auto Complete appears, False if the level ran out."""
        guard = 0
        gate_held = False
        while True:
            a = astate()
            s = st()
            gate = (a["total"] <= 12 and a["covered"] == 0 and a["boardCount"] > 0)
            gate_held = gate_held or gate
            expected = gate and gate_should_show
            assert a["available"] == expected, ("gate mismatch", a, s)
            assert a["autoVisible"] == a["available"], ("button visibility must mirror availability", a)
            assert a["helpersVisible"] != a["available"], ("helpers hidden exactly when auto shows", a)
            if a["available"]:
                return True, gate_held
            if s["overlay"] or s["boardCount"] == 0:
                return False, gate_held
            if page.evaluate("window.__game.solveTap()") == -1:
                return False, gate_held
            time.sleep(0.22)   # let setTimeout(_settle,190) clear each triple (else the rack fills -> lose)
            guard += 1
            assert guard < 400, "descent ran away"

    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.7)

    # On a fresh board Auto Complete is NOT available (27 tiles, plenty covered)
    # and the three helpers are shown instead.
    a = astate()
    print("on level 1 start:", a)
    assert a["level"] == 1, a
    assert a["available"] is False and a["autoVisible"] is False and a["helpersVisible"] is True, a

    # ---- Level 1 is exempt -------------------------------------------------
    # Play it all the way down: the endgame gate DOES hold near the end, but the
    # button must never show — the first level is finished by hand.
    shown, gate_held = descend(gate_should_show=False)
    print("level 1 descent:", {"shown": shown, "gate_held": gate_held, **astate()})
    assert gate_held, "level 1 should reach the ≤12-tiles/none-covered endgame"
    assert not shown, "Auto Complete must never appear on level 1"
    page.screenshot(path=f"{SC}/auto_level1_withheld.png")

    # ---- From level 2 onward it behaves as designed -------------------------
    page.evaluate("window.__game.startLevel(2)")
    time.sleep(0.7)
    a = astate()
    assert a["level"] == 2 and a["available"] is False, ("fresh level 2 board", a)
    seen_available, _ = descend(gate_should_show=True)

    assert seen_available, "level 2 should reach an auto-completable end state"
    a = astate()
    print("auto available at:", a)
    assert a["total"] <= 12 and a["covered"] == 0, a
    page.screenshot(path=f"{SC}/auto_available.png")

    # Press Auto Complete — the sweep animation runs, then the level is won.
    remaining_before = a["total"]
    page.evaluate("window.__game.clearSoundLog()")
    page.evaluate("window.__game.autoComplete()")
    time.sleep(2.4)        # Phase A + staggered Phase B + pops for up to 12 tiles
    s = st()
    print("after autoComplete:", s)

    # Every tile that lands in the tray bops — the same landing cue a
    # hand-collected tile makes — so the sweep sounds like the moves it stands
    # in for instead of going silent after the single gather cue. Expect one
    # bop per swept tile PLUS the one that starts the gather (phase A).
    log = page.evaluate("window.__game.soundLog()")
    bops = log.count("tile_bop")
    print("sweep sounds:", {"tiles": remaining_before, "bops": bops, "log": log})
    assert bops == remaining_before + 1, (
        "one tile_bop per tile landing in the tray, plus the gather cue",
        remaining_before, bops, log)
    assert s["boardCount"] == 0, ("board cleared", s)
    assert s["tray"] == [], ("rack emptied", s)
    assert s["overlay"] is True, ("win overlay shown", s)
    assert s["locked"] is True, ("scene locked at win", s)
    assert remaining_before <= 12
    page.screenshot(path=f"{SC}/auto_won.png")

    # Continue -> lobby, advanced one level. The overlay button isn't exposed,
    # so fire the same callback it triggers.
    lvl = page.evaluate("window.__game.scene.levelNum")
    page.evaluate("window.__game.scene.onLevelComplete(window.__game.scene.levelNum)")
    time.sleep(0.4)
    assert page.evaluate("window.__game.inLobby()") is True, "returned to the lobby"
    assert page.evaluate("window.__game.currentLevel()") == lvl + 1, "advanced one level"

    # Regression guard: the next level's HUD recovers (the _autoRunning reset).
    # A fresh board is never auto-completable, so helpers must be back.
    page.evaluate("window.__game.startLevel(3)")
    time.sleep(0.7)
    a = astate()
    print("next level HUD:", a)
    assert a["helpersVisible"] is True and a["autoVisible"] is False, ("helper row recovered", a)

    print("PAGE ERRORS:", len(errs), errs[:5])
    assert not errs
    print("AUTO COMPLETE TEST PASSED")
    b.close()