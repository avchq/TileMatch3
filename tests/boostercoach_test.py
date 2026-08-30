import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

# BOOSTER COACHING — the guided first use of each helper.
#
# Unlocking a helper is only half the lesson (boosterunlock_test.py owns the
# schedule itself); this covers the other half. On the level a helper unlocks,
# the screen dims, that one button is lifted out of the dim with a caption and a
# pulsing tap effect, and the ONLY thing the player can do is use it for real:
#   * wand / shuffle coach the instant the board finishes building;
#   * undo waits for the first collected tile — there is nothing to undo before
#     that — and then a short beat (CONFIG.boosters.coach.undoDelayMs);
#   * everything else is inert while it is up, and there is NO dismissal path:
#     tapping the dim does nothing, only using the helper closes it;
#   * the tap is a genuine use — stock is spent and the helper actually acts;
#   * it happens once per helper, ever, and the flag survives a reload;
#   * a helper whose unlock level was skipped is still owed its coaching, and
#     only ONE coached moment happens per level entry.
#
# The captions are the scene's copy (BOOSTER_COACH in src/boostercoach.js); the
# unlock levels come from the config via boosterUnlockLevel(), so retiming the
# schedule does not touch this file.

CAPTIONS = {
    "undo": "Undo the last move",
    "wand": "Auto match a group of tiles",
    "shuffle": "Reset the remaining tiles in this level",
}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errors = harness.launch(p, viewport=(750, 1334))

    OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(OUT, exist_ok=True)
    def snap(tag):
        page.screenshot(path=f"{OUT}/boostercoach_{tag}.png")

    def boot():
        page.wait_for_function("window.__game && window.__game.lobby", timeout=45000)
        time.sleep(0.6)

    def coach():  return page.evaluate("window.__game.boosterCoachState()")
    def st():     return page.evaluate("window.__game.state()")
    def count(k): return page.evaluate(f"window.__game.boosterCount('{k}')")
    def hist():   return page.evaluate("window.__game.historyOrder()")

    def enter(level):
        page.evaluate("async (n) => { await window.__game.startLevel(n);"
                      " window.__game.closeTutorial(); }", level)
        time.sleep(0.8)

    def fresh():
        """A brand-new profile, booted into the first-run level 1."""
        page.evaluate("() => localStorage.clear()")
        page.reload()
        boot()

    def wait_coach(kind):
        page.wait_for_function(
            "k => { const c = window.__game.boosterCoachState();"
            " return c.visible && c.kind === k; }", arg=kind, timeout=24000)

    page.goto(f"{BASE}/index.html")
    fresh()

    # ------------------------------------------------------------------
    # 1) Level 1 is untouched — it runs its own guided opening and every
    #    helper is still locked, so nothing is owed a coaching.
    # ------------------------------------------------------------------
    c = coach()
    print("GUIDED L1 -> coach:", c, "firstRun:", page.evaluate("window.__game.firstRun()"))
    assert c["visible"] is False, ("no booster coaching on the teaching level", c)
    page.evaluate("window.__game.closeTutorial()")
    page.wait_for_function("window.__game.handState().visible === true", timeout=24000)
    assert coach()["visible"] is False, "the guided opening is not interrupted by coaching"

    # ------------------------------------------------------------------
    # 2) UNDO coaches on its unlock level, and waits for the first collect.
    # ------------------------------------------------------------------
    undo_at = page.evaluate("window.__game.boosterUnlockLevel('undo')")
    page.evaluate(f"window.__game.completeLevel({undo_at - 1})")
    enter(undo_at)
    c = coach()
    print(f"ENTERED L{undo_at} -> coach:", c, "undo stock:", count("undo"))
    assert c["visible"] is False, \
        ("undo has nothing to undo on a fresh board, so it must wait", c)

    page.evaluate("window.__game.solveTap()")
    wait_coach("undo")
    c = coach()
    print("AFTER FIRST COLLECT -> coach:", c)
    snap("undo_coach")
    assert c["caption"] == CAPTIONS["undo"], c
    # The lifted button really is the undo button, sitting on its own row.
    assert page.evaluate("() => { const s = window.__game.scene;"
                         " return s.undoBtn.parent !== s.hudBottom; }") is True, \
        "the coached button is lifted out of the HUD, above the dim"

    # ------------------------------------------------------------------
    # 3) Everything is blocked and there is no way to dismiss it.
    # ------------------------------------------------------------------
    before, hist_before, stock_before = st(), hist(), count("undo")
    page.evaluate("window.__game.tapCoachDim()")
    time.sleep(0.3)
    assert coach()["visible"] is True, "tapping the dim must not dismiss the coaching"
    page.evaluate("window.__game.solveTap()")
    time.sleep(0.4)
    print("WHILE COACHED -> state:", st(), "coach:", coach()["visible"])
    assert st() == before, ("the board is inert while coaching", st(), before)
    # The other two helpers are inert too — only the coached one responds.
    for kind in ("wand", "shuffle"):
        page.evaluate(f"window.__game.pressBooster('{kind}')")
    time.sleep(0.4)
    assert st() == before, ("other helpers do nothing while coaching", st(), before)
    assert coach()["visible"] is True, "and none of that closed it"

    # ------------------------------------------------------------------
    # 4) The tap is a REAL use: stock is spent and undo actually acts.
    # ------------------------------------------------------------------
    page.evaluate("window.__game.pressCoachedBooster()")
    time.sleep(0.8)
    print("AFTER COACHED PRESS -> coach:", coach()["visible"],
          "stock:", stock_before, "->", count("undo"),
          "history:", hist_before, "->", hist())
    snap("undo_used")
    assert coach()["visible"] is False, "using the helper is what closes the coaching"
    assert count("undo") == stock_before - 1, \
        ("a coached use spends a charge like any other", count("undo"), stock_before)
    assert len(hist()) == len(hist_before) - 1, \
        ("the undo really rolled the move back", hist(), hist_before)
    assert st()["boardCount"] == before["boardCount"] + 1, \
        ("...and the tile went back to the board", st(), before)
    # The button is back on its row, and play has resumed.
    assert page.evaluate("() => { const s = window.__game.scene;"
                         " return s.undoBtn.parent === s.hudBottom; }") is True, \
        "the lifted button is restored to the helper row"
    page.evaluate("window.__game.solveTap()")
    time.sleep(0.5)
    assert hist() != [], "play resumes once the coaching closes"

    # Only ONE coached moment per level entry — wand is not owed here yet,
    # but nothing else may pop up in this level either.
    assert coach()["visible"] is False, "no second coaching in the same level"

    # ------------------------------------------------------------------
    # 5) WAND coaches on its own unlock level, immediately on board-ready.
    # ------------------------------------------------------------------
    wand_at = page.evaluate("window.__game.boosterUnlockLevel('wand')")
    page.evaluate(f"window.__game.completeLevel({wand_at - 1})")
    enter(wand_at)
    wait_coach("wand")
    c = coach()
    print(f"ENTERED L{wand_at} -> coach:", c)
    snap("wand_coach")
    assert c["caption"] == CAPTIONS["wand"], c
    stock_before, before = count("wand"), st()
    page.evaluate("window.__game.pressCoachedBooster()")
    time.sleep(1.2)
    print("AFTER WAND -> coach:", coach()["visible"], "stock:", stock_before,
          "->", count("wand"), "board:", before["boardCount"], "->", st()["boardCount"])
    assert coach()["visible"] is False, c
    assert count("wand") == stock_before - 1, (count("wand"), stock_before)
    assert st()["boardCount"] < before["boardCount"], \
        ("the wand really pulled a triple off the board", st(), before)

    # ------------------------------------------------------------------
    # 6) SHUFFLE coaches on its unlock level; it re-deals without losing tiles.
    # ------------------------------------------------------------------
    shuffle_at = page.evaluate("window.__game.boosterUnlockLevel('shuffle')")
    page.evaluate(f"window.__game.completeLevel({shuffle_at - 1})")
    enter(shuffle_at)
    wait_coach("shuffle")
    c = coach()
    print(f"ENTERED L{shuffle_at} -> coach:", c)
    snap("shuffle_coach")
    assert c["caption"] == CAPTIONS["shuffle"], c
    stock_before, before = count("shuffle"), st()
    page.evaluate("window.__game.pressCoachedBooster()")
    time.sleep(0.8)
    print("AFTER SHUFFLE -> coach:", coach()["visible"], "stock:", stock_before,
          "->", count("shuffle"), "board:", before["boardCount"], "->", st()["boardCount"])
    assert coach()["visible"] is False, c
    assert count("shuffle") == stock_before - 1, (count("shuffle"), stock_before)
    assert st()["boardCount"] == before["boardCount"], \
        ("a re-deal keeps every tile on the board", st(), before)

    # ------------------------------------------------------------------
    # 7) Once only — and the flag survives a reload.
    # ------------------------------------------------------------------
    for kind in ("undo", "wand", "shuffle"):
        assert page.evaluate(f"window.__game.boosterCoached('{kind}')") is True, kind
    enter(shuffle_at)
    time.sleep(0.6)
    assert coach()["visible"] is False, "a helper is coached once, not every visit"
    page.evaluate("window.__game.flushSave()")
    time.sleep(0.4)
    page.reload()
    boot()
    coached = {k: page.evaluate(f"window.__game.boosterCoached('{k}')")
               for k in ("undo", "wand", "shuffle")}
    print("AFTER RELOAD -> coached:", coached)
    assert all(coached.values()), coached
    enter(shuffle_at)
    assert coach()["visible"] is False, "the coaching record persists across a reload"

    # ------------------------------------------------------------------
    # 8) Still owed -> fires again. Leaving mid-coaching restores the button
    #    and does NOT count as having seen it.
    # ------------------------------------------------------------------
    fresh()
    page.evaluate(f"window.__game.completeLevel({wand_at - 1})")
    page.evaluate("window.__game.markBoosterCoached('undo')")  # isolate the wand
    enter(wand_at)
    wait_coach("wand")
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.6)
    print("EXITED MID-COACH -> coach:", coach(),
          "coached:", page.evaluate("window.__game.boosterCoached('wand')"))
    assert coach()["visible"] is False, "leaving tears the coaching down"
    assert page.evaluate("window.__game.boosterCoached('wand')") is False, \
        "walking away is not the same as being taught"
    assert page.evaluate("() => { const s = window.__game.scene;"
                         " return s.wandBtn.parent === s.hudBottom; }") is True, \
        "the lifted button is restored even on the exit path"
    enter(wand_at)
    wait_coach("wand")
    print("RE-ENTERED -> coach:", coach())
    assert coach()["caption"] == CAPTIONS["wand"], coach()

    # ------------------------------------------------------------------
    # 9) A skipped unlock level is still owed its coaching: jumping straight
    #    past every gate coaches the lowest-unlock helper first, one per level.
    # ------------------------------------------------------------------
    fresh()
    page.evaluate(f"window.__game.completeLevel({shuffle_at})")
    owed = {k: page.evaluate(f"window.__game.boosterCoached('{k}')")
            for k in ("undo", "wand", "shuffle")}
    print("JUMPED PAST EVERY GATE -> coached:", owed)
    assert not any(owed.values()), owed
    enter(shuffle_at + 1)
    # undo has the lowest unlock level, so it is taught first — and it still
    # waits for a collected tile before it can be demonstrated.
    assert coach()["visible"] is False, coach()
    page.evaluate("window.__game.solveTap()")
    wait_coach("undo")
    print("OWED COACHING ON A LATER LEVEL -> coach:", coach())
    snap("owed_undo")
    page.evaluate("window.__game.pressCoachedBooster()")
    time.sleep(0.8)
    assert coach()["visible"] is False, coach()
    # ...and the other two wait for their own levels rather than queueing here.
    time.sleep(0.8)
    assert coach()["visible"] is False, "only one coached moment per level entry"
    assert page.evaluate("window.__game.boosterCoached('wand')") is False, \
        "the rest are still owed, on later levels"

    print("ERRORS:", len(errors))
    for e in errors[:10]:
        print("  ", e)
    assert not errors, "console errors during booster coaching"
    print("ALL BOOSTER-COACH CHECKS PASSED")
    browser.close()