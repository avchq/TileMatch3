#!/usr/bin/env python3
# ONE SPELLING FOR EVERY UNLOCK GATE  (review finding DATA-02).
#
# src/config.js states the convention for every `unlockLevel` it declares:
#
#     a gate of N reads "available from level N onward", i.e. it opens once the
#     player has CLEARED level N-1 (`user.completedLevel() >= N - 1`)
#
# Five gates followed it (shop, tasks, helpers, Super Wand, the 8th tray slot).
# The Fortune Wheel and the Daily Bonus did not: they compared the STORED
# `progress.level` against their `unlockLevel` inline, in four places across
# three scenes. `progress.level` is fully derived — main.js writes it as
# `min(completed + 1, maxLevel)` and nothing else does — so under normal play
# the two spellings agree, which is exactly why the divergence survived.
#
# They stop agreeing the moment `progress.level` is moved on its own:
#
#   * a QA jump (`setLevel`) used to open the wheel while `completed` said the
#     player had cleared nothing;
#   * walking the level back — a level-select or "replay an earlier level"
#     screen, which `setLevel` permits and `completeLevel` forbids — used to
#     RE-LOCK the wheel and the gift while the shop, tasks, helpers, Super Wand
#     and the 8th slot stayed open.
#
# Both are asserted below, and both fail on the old spelling. The gates live in
# src/user/User.js now (isFortuneWheelUnlocked / isDailyBonusUnlocked beside
# their five siblings) and no scene knows the convention at all.
#
# Two halves: the browser half drives the real gates through window.__game;
# the source half (no browser, instant) then guards the spelling itself, so a
# sixth gate written the old way fails here rather than a year from now.

import os
import re
import sys
import time

from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)


def text(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return fh.read()


# ---------------------------------------------------------------------------
#  1. The live gates  (the real game, through window.__game)
# ---------------------------------------------------------------------------
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)

BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errs = harness.launch(p, viewport=(750, 1334))

    def wheel():   return page.evaluate("window.__game.wheelState()")
    def daily():   return page.evaluate("window.__game.dailyBonusState()")
    def shop():    return page.evaluate("window.__game.shopState()")
    def tasks():   return page.evaluate("window.__game.tasksState()")
    def swand():   return page.evaluate("window.__game.superWandState()")
    def done():    return page.evaluate("window.__game.completedLevel()")
    def lvl():     return page.evaluate("window.__game.user()")["progress"]["level"]

    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.wheelState", timeout=60000)
    # A brand-new profile is routed straight into the guided level 1. Clear that
    # flow so the lobby (and its feature rail) is what the assertions below read.
    page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
    page.reload()
    page.wait_for_function("window.__game && window.__game.wheelState", timeout=60000)
    time.sleep(0.6)
    # Pin the wheel's and the gift's clock so a real midnight can't move either.
    page.evaluate("window.__game.setWheelToday('2050-06-15')")
    page.evaluate("window.__game.setDailyToday('2050-06-15')")
    time.sleep(0.3)

    GATE = page.evaluate("window.__game.config()")["features"]["fortuneWheel"]["unlockLevel"]
    w = wheel()
    assert w["unlockLevel"] == GATE, ("the seam reports the configured gate", w)
    assert GATE >= 3, ("this test needs a gate with room below it", GATE)

    # ---- 1. One level cleared: below the gate --------------------------
    print("CLEARED 1 ->", done(), lvl(), w["unlocked"], w["buttonVisible"])
    assert done() == 1 and w["unlocked"] is False and w["buttonVisible"] is False, (
        "the wheel is locked one clear in", done(), w)

    # ---- 2. Moving progress.level ALONE must not open the gate ---------
    # THE regression anchor. `setLevel` walks the derived field without clearing
    # anything; the old gate read that field and opened on the spot.
    page.evaluate(f"window.__game.setLevel({GATE})")
    time.sleep(0.4)
    w = wheel()
    print("setLevel(GATE) ->", done(), lvl(), w["unlocked"], w["buttonVisible"])
    assert lvl() >= GATE, ("the level really moved", lvl(), GATE)
    assert done() == 1, ("...without clearing anything", done())
    assert w["unlocked"] is False, (
        "reaching level N without CLEARING N-1 must not unlock the wheel — the "
        "gate is the profile's completedLevel(), not the derived progress.level",
        {"completed": done(), "level": lvl(), "state": w})
    assert w["buttonVisible"] is False, ("...and the rail offers no button", w)
    print("  ok   a bare setLevel jump does not open the gate")

    # ---- 3. Clearing up to the gate opens it ---------------------------
    page.evaluate(f"window.__game.setCompleted({GATE - 2})")
    time.sleep(0.4)
    w = wheel()
    print("COMPLETED GATE-2 ->", done(), w["unlocked"])
    assert w["unlocked"] is False, ("one clear short of the gate", done(), w)

    page.evaluate(f"window.__game.setCompleted({GATE - 1})")
    time.sleep(0.8)
    w = wheel()
    print("COMPLETED GATE-1 ->", done(), w["unlocked"], w["buttonVisible"], w["spinsLeft"])
    assert w["unlocked"] is True, ("cleared level N-1 opens it", done(), w)
    assert w["buttonVisible"] is True, ("...and the rail offers the button", w)
    # The daily cycle rollover is gated on the same predicate — it really ran.
    assert w["spinsLeft"] == page.evaluate(
        "window.__game.config()")["features"]["fortuneWheel"]["spinsPerCycle"], w
    page.screenshot(path=f"{SC}/unlockgate_wheel_open.png")
    print("  ok   clearing level N-1 opens the wheel, rollover included")

    # ---- 4. Walking progress.level BACK must not re-lock it ------------
    # The divergence the finding named: a level-select or "replay an earlier
    # level" screen sets the level backwards (setLevel permits it, completeLevel
    # does not). The old gate re-locked the wheel and the gift while the shop,
    # tasks, helpers, Super Wand and the 8th slot all stayed open.
    page.evaluate("window.__game.setLevel(1)")
    time.sleep(0.5)
    w, d, s = wheel(), daily(), shop()
    print("BACK TO LEVEL 1 ->", done(), lvl(), w["unlocked"], d["unlocked"], s["unlocked"])
    assert lvl() == 1 and done() == GATE - 1, ("level walked back, clears kept", lvl(), done())
    assert w["unlocked"] is True, (
        "replaying an earlier level must not take the wheel away — every other "
        "gate is derived from clears and stays open", {"level": lvl(), "state": w})
    assert w["buttonVisible"] is True, ("...and its button stays on the rail", w)
    assert d["unlocked"] is True, ("nor the daily gift", d)
    assert s["unlocked"] is True, ("the shop was never at risk — same rule now", s)
    print("  ok   walking the level back keeps every earned unlock")

    # ---- 5. The gift's gate of 1 still means "from the very start" -----
    page.evaluate("window.__game.setCompleted(0)")
    time.sleep(0.5)
    d = daily()
    print("NOTHING CLEARED ->", done(), d["unlocked"], d["buttonVisible"], d["canClaim"])
    assert d["unlockLevel"] == 1, ("the shipped gift gate", d)
    assert d["unlocked"] is True and d["canClaim"] is True, (
        "unlockLevel 1 must still read as 'available from the very start'", done(), d)
    assert d["buttonVisible"] is True, ("...and the gift is the rail's only button", d)
    assert wheel()["unlocked"] is False, ("while the wheel is locked again", wheel())
    print("  ok   a gate of 1 opens with nothing cleared")

    # ---- 6. One rule, every feature ------------------------------------
    # Each gate answers `completedLevel() >= unlockLevel - 1` and nothing else,
    # at every clear count from a fresh profile up past the last gate.
    gates = [("wheel", wheel), ("daily", daily), ("shop", shop),
             ("tasks", tasks), ("superWand", swand)]
    highest = max(g[1]()["unlockLevel"] for g in gates)
    for c in range(0, highest + 1):
        page.evaluate(f"window.__game.setCompleted({c})")
        time.sleep(0.12)
        for name, read in gates:
            st = read()
            want = c >= st["unlockLevel"] - 1
            assert st["unlocked"] is want, (
                name + " disagrees with completedLevel() >= unlockLevel - 1",
                {"completed": c, "unlockLevel": st["unlockLevel"], "unlocked": st["unlocked"]})
    print("  ok   all", len(gates), "feature gates agree on one rule across 0..%d clears" % highest)

    assert not errs, ("console errors / uncaught exceptions", errs[:5])
    browser.close()


# ---------------------------------------------------------------------------
#  2. The spelling  (source analysis, no browser)
# ---------------------------------------------------------------------------
# The durable guard: the checks above prove the gates behave, these prove nobody
# can write the second spelling again. No browser — instant.

# `progress.level` is the profile's own field. Only the MODEL that owns it and
# the BOOT sequence that derives the level to play from it may read it; a scene
# reading it is, by construction, a gate written in the wrong convention.
PROGRESS_LEVEL_OWNERS = {"src/user/User.js", "src/main.js"}

src_files = []
for dirpath, _dirs, names in os.walk(os.path.join(ROOT, "src")):
    for name in sorted(names):
        if name.endswith(".js"):
            src_files.append(os.path.relpath(os.path.join(dirpath, name), ROOT))
src_files.sort()

offenders = []
for path in src_files:
    for i, line in enumerate(text(path).splitlines(), 1):
        if "progress.level" not in line:
            continue
        # Prose about the field is fine — and there is a fair amount of it now,
        # because the WHY is the part that keeps this from growing back.
        if line.lstrip().startswith(("//", "*", "/*")):
            continue
        if path not in PROGRESS_LEVEL_OWNERS:
            offenders.append((path, i, line.strip()))
        elif "unlockLevel" in line or "Unlocked" in line:
            # Even in an owner file, `progress.level` next to a gate is the bug.
            offenders.append((path, i, line.strip()))
assert not offenders, (
    "progress.level is stored but DERIVED (min(completed+1, maxLevel)); an unlock "
    "gate must read user.completedLevel() >= unlockLevel - 1 instead — see "
    "src/config.js's level-convention note", offenders)
print("  ok   only the model and the boot sequence read progress.level")

# Every gate helper on the profile is spelled the one way. A sixth one written
# against progress.level fails here rather than a year from now.
USER_JS = text("src/user/User.js")
# Non-greedy to the first closing brace: isBoosterUnlocked's body spans lines,
# the other six are one-liners, and none of them contains a nested block.
GATE_HELPER = re.compile(
    r"^[ \t]*(is[A-Za-z]*Unlocked)\s*\(([^)]*)\)\s*\{(.*?)\}", re.M | re.S)
helpers = GATE_HELPER.findall(USER_JS)
names = sorted(h[0] for h in helpers)
EXPECTED = sorted([
    "isSuperWandUnlocked", "isBoosterUnlocked", "isShopUnlocked",
    "isTasksUnlocked", "isExtraSlotUnlocked",
    "isFortuneWheelUnlocked", "isDailyBonusUnlocked",
])
assert names == EXPECTED, ("the roster of profile gate helpers", names, EXPECTED)
for name, _args, body in helpers:
    assert "completedLevel()" in body and "- 1" in body, (
        name + " must be the documented `completedLevel() >= unlockLevel - 1`", body)
print("  ok   all", len(helpers), "profile gate helpers use completedLevel() >= N-1")

# The scenes must not keep a private copy of the gate value either — that field
# only ever existed to be compared against progress.level.
for path in ("src/fortunewheel.js", "src/dailybonus.js"):
    assert "this.unlockLevel" not in text(path), (
        path + " must not carry its own unlockLevel — the gate is the profile's")
print("  ok   the wheel and the gift keep no private copy of their gate")

print("ALL UNLOCK-GATE CHECKS PASSED")
