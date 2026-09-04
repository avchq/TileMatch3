#!/usr/bin/env python3
# End-to-end test for the WIN OVERLAY'S HEADLINE (src/game.js `_win`).
#
# Clearing a level puts up the level-complete panel. Its headline has two forms:
#
#   "Level Complete!"  — every clear that still leaves campaign to play
#   "🏆 You Win!"      — the LAST level of the level table, and only that one
#
# The campaign length is NOT a tunable: it is `levels.length`, derived in
# src/main.js from assets/config/levels.json and handed to GameScene the same way
# it is handed to LobbyScene (which uses it for its own "all done" celebration).
# The two screens hand off to each other, so they must agree — a scene that
# guesses congratulates the player on finishing the game and then the lobby
# cheerfully offers the next level.
#
# This test reads the level table itself rather than hardcoding a count, so it
# keeps holding when levels are added or removed.

import json, time, os
from playwright.sync_api import sync_playwright

import harness

SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

with open(os.path.join(ROOT, "assets/config/levels.json")) as f:
    LEVELS = json.load(f)
LAST = len(LEVELS)                 # the final level of the campaign
assert LAST >= 3, "the table needs at least three levels for this test"

# The English copy the two forms resolve to (assets/lang/en.json).
with open(os.path.join(ROOT, "assets/lang/en.json")) as f:
    LANG = json.load(f)
YOU_WIN = LANG["you_win"]          # "You Win!"
COMPLETE = LANG["Language2"]       # "Level Complete!"

BASE = harness.serve()
with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    harness.boot(page, "window.__game && window.__game.scene && !!window.__game.winState",
                 timeout=60000, url=BASE)
    time.sleep(0.4)

    def state():     return page.evaluate("window.__game.state()")
    def win_state(): return page.evaluate("window.__game.winState()")

    def start(n):
        # Take the coached first use of every helper as read (else a coach modal
        # parks over the board), enter the level and dismiss any level-1 tutorial.
        page.evaluate("window.__game.markBoosterCoached('all')")
        page.evaluate(f"async () => {{ await window.__game.startLevel({n}); window.__game.closeTutorial(); }}")
        time.sleep(0.5)

    def solve():
        for _ in range(8000):
            s = state()
            if s["overlay"] or s["inLobby"]:
                break
            if page.evaluate("window.__game.solveTap()") == -1:
                time.sleep(0.05)
            time.sleep(0.015)
        time.sleep(0.4)
        assert state()["overlay"], "the level did not reach its win overlay"

    # Every level is unlocked for this run — the whole table has been cleared, so
    # any level below can be entered as a replay.
    page.evaluate(f"window.__game.completeLevel({LAST}); window.__game.flushSave();")

    # The scene knows the campaign length, and it is the table's own length —
    # exactly what the lobby is given, not a constant typed into game.js.
    assert win_state()["maxLevel"] == LAST, ("GameScene must know the campaign length",
                                             win_state(), LAST)
    print(f"campaign length: {LAST} levels; GameScene agrees")

    # ---- 1. an early clear is NOT the end of the game ----
    # This is the regression: a hardcoded `levelNum >= 3` made level 3 (of 28)
    # announce the end of the campaign.
    start(3)
    solve()
    title = win_state()["title"]
    assert title == COMPLETE, (f"level 3 of {LAST} must read '{COMPLETE}'", title)
    assert "🏆" not in title and YOU_WIN not in title, ("no trophy mid-campaign", title)
    page.screenshot(path=os.path.join(SC, "winoverlay_mid_campaign.png"))
    print(f"level 3/{LAST} headline: {title!r}")

    page.evaluate("window.__game.pressWinContinue()")
    time.sleep(0.6)

    # ---- 2. the level BEFORE the last one still isn't ----
    start(LAST - 1)
    solve()
    title = win_state()["title"]
    assert title == COMPLETE, (f"level {LAST - 1} of {LAST} must read '{COMPLETE}'", title)
    print(f"level {LAST - 1}/{LAST} headline: {title!r}")

    page.evaluate("window.__game.pressWinContinue()")
    time.sleep(0.6)

    # ---- 3. the last level is ----
    start(LAST)
    solve()
    title = win_state()["title"]
    assert YOU_WIN in title, (f"the last level ({LAST}) must read '{YOU_WIN}'", title)
    assert "🏆" in title, ("…with its trophy", title)
    page.screenshot(path=os.path.join(SC, "winoverlay_campaign_end.png"))
    print(f"level {LAST}/{LAST} headline: {title!r}")

    assert not errs, errs
    b.close()
print("winoverlay_test: OK")
