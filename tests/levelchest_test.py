#!/usr/bin/env python3
# End-to-end test for the Level Chest (src/levelchest.js + the win-overlay bar in
# src/game.js).
#
# Drives the real game headlessly through the window.__game debug API. Covers:
#   - the SCHEDULE MATHS (chestInfo): the 50-milestone table's labels, needed
#     counts, full flags and rewards across the whole schedule and into its
#     looping tail — including the deliberate CORRECTED label (this port fixes the
#     original's negative-progress wrap bug, so a label never goes below 0);
#   - the reward VOCABULARY (0=coins, 10=undo, 11=wand[Hint], 12=shuffle,
#     20=lightning→coins);
#   - the WIN-OVERLAY behaviour: a genuinely new clear shows the bar and, on a
#     milestone level, opens the chest and pays out (with the "double it" ad path
#     doubling the amount); a new NON-milestone clear shows a partial bar and does
#     not open; a REPLAY of an already-cleared level shows no chest at all.
#
# Chest progress is DERIVED from the highest level cleared (nothing is stored), so
# a completeLevel jump lands straight on the right chest.

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
    page.wait_for_function(
        "window.__game && window.__game.scene && !!window.__game.chestInfo", timeout=60000)
    time.sleep(0.4)

    def info(lv):  return page.evaluate(f"window.__game.chestInfo({lv})")
    def state():   return page.evaluate("window.__game.state()")
    def chest():   return page.evaluate("window.__game.chestState()")
    def coins():   return page.evaluate("window.__game.balance('coins')")
    def snap(n):   page.screenshot(path=os.path.join(SC, f"chest_{n}.png"))

    # ================================================================
    #  PART A — the schedule maths (pure, no play)
    # ================================================================
    assert page.evaluate("window.__game.chestCount()") == 50, "50 milestones ship"

    # The authored schedule: first the short hand-tuned chests, then a steady
    # 16-win rhythm; each milestone's own reward. (level, label, needed, full,
    # reward-type, reward-amount)
    AUTHORED = [
        (4,   "4 / 4",   4,  True,  "coins",     25),   # first chest, 4 wins
        (8,   "4 / 4",   4,  True,  "coins",     25),
        (12,  "4 / 4",   4,  True,  "coins",     25),
        (20,  "8 / 8",   8,  True,  "undo",       2),   # 8 wins → 2 Undos
        (32,  "12 / 12", 12, True,  "coins",     25),
        (48,  "16 / 16", 16, True,  "coins",     25),
        (69,  "5 / 16",  16, False, "wand",       2),   # the "5 / 16" bar, mid-fill
        (80,  "16 / 16", 16, True,  "wand",       2),   # Hint = wand in this port
        (144, "16 / 16", 16, True,  "lightning",  6),   # Lightning → a coins bonus
        (208, "16 / 16", 16, True,  "shuffle",    2),
        (288, "16 / 16", 16, True,  "coins",    100),   # the lone 100-coin chest
        (352, "16 / 16", 16, True,  "undo",       2),
        (416, "16 / 16", 16, True,  "wand",       2),
        (496, "16 / 16", 16, True,  "lightning",  6),
        (576, "16 / 16", 16, True,  "shuffle",    2),
        (656, "16 / 16", 16, True,  "wand",       2),
        (720, "16 / 16", 16, True,  "undo",       2),
        (752, "16 / 16", 16, True,  "coins",     25),   # last authored milestone
    ]
    for lv, label, needed, full, rtype, ramt in AUTHORED:
        i = info(lv)
        assert i["label"] == label, (lv, "label", i)
        assert i["needed"] == needed, (lv, "needed", i)
        assert i["full"] is full, (lv, "full", i)
        assert i["reward"]["type"] == rtype and i["reward"]["amount"] == ramt, (lv, "reward", i)
    print("PART A: 18 authored milestones check out")

    # Below the first milestone's fill window there is no chest.
    assert info(0) is None, ("no chest at level 0", info(0))

    # The looping tail: past level 752 chests keep arriving on the correct
    # 16-win cadence, carrying the wrapped milestone's reward. 768 repeats the
    # tail's first chest (25 coins); 784 repeats the 80-level chest (2 wands).
    assert info(753) == {**info(753), "label": "1 / 16", "full": False}, info(753)
    assert info(753)["reward"] == {"type": "coins", "amount": 25}, info(753)
    assert info(768)["full"] is True and info(768)["reward"]["type"] == "coins", info(768)
    assert info(784)["full"] is True and info(784)["reward"] == {"type": "wand", "amount": 2}, info(784)
    assert info(800)["label"] == "16 / 16" and info(800)["full"] is True, info(800)
    assert info(801)["label"] == "1 / 16" and info(801)["full"] is False, info(801)
    # The whole thing repeats with a 704-level period: 1456 is like 752, 1472 like 64.
    assert info(1456)["reward"] == info(752)["reward"], (info(1456), info(752))

    # The CORRECTED label: it never goes negative anywhere (the original's wrap
    # bug is deliberately fixed in this port). Read all labels in one batch.
    labels = page.evaluate(
        "() => { const o={}; for (let lv=1; lv<1600; lv++) o[lv]=window.__game.chestInfo(lv).label; return o; }")
    neg = [lv for lv, s in labels.items() if int(s.split(" / ")[0]) < 0]
    assert neg == [], ("labels must never go negative (corrected wrap)", neg[:8])
    print("PART A: looping tail + corrected (never-negative) label verified")

    # ================================================================
    #  PART B — the win-overlay bar / open / reward
    # ================================================================
    def solve():
        for _ in range(6000):
            s = state()
            if s["overlay"] or s["inLobby"]:
                break
            if page.evaluate("window.__game.solveTap()") == -1:
                time.sleep(0.05)
            time.sleep(0.015)
        time.sleep(0.3)

    def start(n):
        # Take every helper's coaching as read so no coach modal parks over the
        # board (README lines 91-113), then enter the level and dismiss any
        # level-1 tutorial (a no-op elsewhere).
        page.evaluate("window.__game.markBoosterCoached('all')")
        page.evaluate(f"async () => {{ await window.__game.startLevel({n}); window.__game.closeTutorial(); }}")
        time.sleep(0.5)

    # A profile that has cleared up to level 3 (derived — nothing stored).
    page.evaluate("() => { window.__game.completeLevel(3); window.__game.flushSave(); }")
    assert page.evaluate("window.__game.completedLevel()") == 3

    # ---- B1. A milestone clear opens the chest and pays out (doubled) ----
    start(4)                       # level 4 completes chest #1 (4 wins → 25 coins)
    solve()
    s = chest()
    assert s["shown"] is True, ("bar shown on a new milestone clear", s)
    assert s["needed"] == 4 and s["reward"] == {"type": "coins", "amount": 25}, s
    # The chest fills, then pops open on its own — wait for the reward popup.
    page.wait_for_function("window.__game.chestState().popup === true", timeout=24000)
    s = chest()
    assert s["full"] is True and s["opened"] is True, ("milestone chest opened", s)
    snap("b1_reward_popup")

    base = coins()                 # the win itself pays nothing — only the chest does
    assert base == 0, ("a level win credits no coins of its own", base)
    page.evaluate("window.__game.setChestAdResult('succeed')")
    page.evaluate("window.__game.pressChestDouble()")   # doubles 25 → 50, then grants
    page.wait_for_function("window.__game.chestState().claimed === true", timeout=24000)
    time.sleep(0.2)
    assert coins() == base + 50, ("doubled 25-coin chest grants +50", base, coins())
    # Finish up: Continue advances to the lobby (completed becomes 4).
    page.evaluate("window.__game.pressWinContinue()")
    time.sleep(0.5)
    assert page.evaluate("window.__game.completedLevel()") == 4
    print("PART B1: milestone chest opened + doubled reward granted")

    # ---- B2. A new NON-milestone clear shows a partial bar, no open ----
    start(5)                       # level 5 is mid-fill toward the level-8 chest
    solve()
    s = chest()
    assert s["shown"] is True, ("bar shown on a new clear", s)
    assert s["label"] == "1 / 4" and s["full"] is False, ("partial bar, not full", s)
    assert s["opened"] is False and s["popup"] is False, ("no open on a partial chest", s)
    page.evaluate("window.__game.pressWinContinue()")
    time.sleep(0.5)
    assert page.evaluate("window.__game.completedLevel()") == 5
    print("PART B2: partial bar on a non-milestone clear, no open")

    # ---- B3. A REPLAY of an already-cleared level shows no chest ----
    start(3)                       # already cleared → no new progress
    solve()
    s = chest()
    assert s["shown"] is False, ("no chest on a replay", s)
    assert state()["overlay"] is True, ("the win overlay is still up", state())
    print("PART B3: replay shows no chest bar")

    # ================================================================
    #  PART C — the persistent LOBBY progress bar
    # ================================================================
    # The bar is derived from the highest level cleared, so drive it with
    # completeLevel jumps (no play needed) and read it through lobbyChestState.
    page.evaluate("() => window.__game.reset()")
    page.reload()
    page.wait_for_function(
        "window.__game && window.__game.scene && !!window.__game.lobbyChestState", timeout=60000)
    time.sleep(0.4)

    def lchest(): return page.evaluate("window.__game.lobbyChestState()")

    # A brand-new profile has no chest yet → the bar is hidden.
    lc = lchest()
    assert lc["completed"] == 0 and lc["visible"] is False, ("hidden for a new player", lc)

    # Clearing level 1 fills the first chest by a notch — the bar shows live.
    page.evaluate("() => window.__game.completeLevel(1)")
    lc = lchest()
    assert lc["visible"] is True and lc["label"] == "1 / 4", ("live 1 / 4 after level 1", lc)

    # On a MILESTONE the just-opened chest rolls forward to the next, empty.
    page.evaluate("() => window.__game.completeLevel(4)")
    assert lchest()["label"] == "0 / 4", ("milestone rolls to the next chest at 0", lchest())

    # Mid-chest again.
    page.evaluate("() => window.__game.completeLevel(5)")
    assert lchest()["label"] == "1 / 4", ("1 / 4 toward the level-8 chest", lchest())

    # Deep into the campaign the bar reads the looping 16-win chests.
    page.evaluate("() => window.__game.completeLevel(64)")
    assert lchest()["label"] == "0 / 16", ("0 / 16 after the level-64 milestone", lchest())

    # And it really renders on the visible lobby (not just the flag): reload to
    # the lobby and confirm the bar is a listed, visible control there.
    page.evaluate("() => window.__game.flushSave()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.lobby && window.__game.inLobby()", timeout=60000)
    time.sleep(0.4)
    lc = lchest()
    assert lc["visible"] is True and lc["label"] == "0 / 16", ("bar persists on the lobby", lc)
    names = [c["name"] for c in page.evaluate("window.__game.controls()") if c["scene"] == "lobby"]
    assert "chestBar" in names, ("the chest bar is a live lobby control", names)
    print("PART C: lobby progress bar shows, updates live and rolls milestones")

    assert not errs, ("no console/page errors", errs)
    print("\nALL LEVEL CHEST TESTS PASSED")