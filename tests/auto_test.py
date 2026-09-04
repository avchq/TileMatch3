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

    # ---- PRAC-01: Back is DISABLED for the duration of the sweep -----------
    # The sweep stages every remaining tile on fxLayer and animates it for ~2s.
    # Leaving the level mid-sweep destroys those containers while the tween is
    # still writing to them, and that throw happens inside a Pixi ticker
    # listener — Ticker._tick re-arms requestAnimationFrame only AFTER update()
    # returns, so the rAF loop never restarts: frozen canvas, dead input, only a
    # reload recovers. Auto Complete + Back + Play was three ordinary taps.
    # So the sweep takes the Back button with the helper row: greyed and
    # event-dead (NOT hidden — it stays exactly where it was), re-armed by
    # _applyFirstRunChrome on the next board.
    #
    # Level 2 is used again because the descent above already proved that board
    # reaches the gate (levels are seeded, so it does so identically).
    page.evaluate("window.__game.startLevel(2)")
    time.sleep(0.7)
    reached, _ = descend(gate_should_show=True)
    assert reached, "level 2 should reach an auto-completable end state again"

    # Real pointer events only: emit('pointertap') calls the listener directly
    # and would sail straight past eventMode "none", proving nothing.
    box = page.eval_on_selector(
        "canvas", "c => { const r=c.getBoundingClientRect(); return {x:r.x,y:r.y}; }")
    scale = page.evaluate("window.__game.view()")["rootScale"]

    def rect(scene, name):
        for c in page.evaluate("window.__game.controls()"):
            if c["scene"] == scene and c["name"] == name:
                return c
        raise AssertionError(f"no visible control {scene}/{name}")

    def tap(r):
        """Click the centre of a controls() rect. No sleep — the caller is
        racing a ~2s animation and needs the tap to land inside it."""
        page.mouse.click(box["x"] + (r["x"] + r["w"] / 2) * scale,
                         box["y"] + (r["y"] + r["h"] / 2) * scale)

    def backstate():
        return page.evaluate("""() => {
            const b = window.__game.scene.backBtn;
            return { visible: b.visible, eventMode: b.eventMode, alpha: b.alpha,
                     running: window.__game.scene._autoRunning };
        }""")

    auto_rect = rect("level", "autoBtn")
    back_rect = rect("level", "back")
    assert backstate()["eventMode"] == "static", "Back is live before the sweep"

    t0 = page.evaluate("window.__game.app.ticker.lastTime")
    tap(auto_rect)                      # a real tap on Auto Complete

    bs = backstate()
    print("back during sweep:", bs)
    assert bs["running"] is True, ("the sweep should be running", bs)
    assert bs["visible"] is True, ("Back stays on screen — disabled, not hidden", bs)
    assert bs["eventMode"] == "none", ("Back must not accept taps mid-sweep", bs)
    assert bs["alpha"] < 1, ("…and must read as disabled", bs)

    # Nothing slow between here and the tap: the sweep is only ~1.5s on a
    # six-tile board, and the tap has to land inside it to mean anything.
    tap(back_rect)                      # tap it anyway: nothing must happen
    assert page.evaluate("window.__game.inLobby()") is False, \
        "Back must not leave the level mid-sweep"
    assert page.evaluate("window.__game.scene._autoRunning") is True, \
        "…and must not interrupt the sweep either"
    page.screenshot(path=f"{SC}/auto_back_disabled.png")

    # The sweep still finishes exactly as it did before.
    harness.settle(page, "window.__game.state().overlay === true", timeout=15000)
    s = st()
    print("after interrupted-then-finished sweep:", s)
    assert s["boardCount"] == 0 and s["tray"] == [], ("sweep completed normally", s)

    # The freeze itself. harness.frames() CANNOT see this: it drives its own
    # requestAnimationFrame, which keeps working after Pixi's rAF loop has died.
    harness.settle(page, f"window.__game.app.ticker.lastTime > {t0}", timeout=5000)
    assert page.evaluate("window.__game.app.ticker.started") is True, \
        "the Pixi ticker must still be running"

    # Back is re-armed once the sweep hands over, and again on the next board.
    bs = backstate()
    assert bs["eventMode"] == "static" and bs["alpha"] == 1, ("Back re-armed at the win", bs)
    page.evaluate("window.__game.pressWinContinue()")
    harness.settle(page, "window.__game.inLobby() === true", timeout=5000)
    page.evaluate("window.__game.startLevel(2)")
    harness.settle(page, "window.__game.inLobby() === false", timeout=15000)
    bs = backstate()
    assert bs["eventMode"] == "static" and bs["alpha"] == 1, ("fresh board has a live Back", bs)

    print("PAGE ERRORS:", len(errs), errs[:5])
    assert not errs
    print("AUTO COMPLETE TEST PASSED")
    b.close()