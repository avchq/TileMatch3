#!/usr/bin/env python3
# End-to-end test for the SHARED reward module (src/rewards.js).
#
# Four features pay out a `{ type, amount }` reward — the Fortune Wheel, the
# Daily Bonus, Tasks and the Level Chest. They used to carry four private copies
# of the grant table, the glyph table, the icon factory and the fly-to-counter
# arc, and the copies had drifted. `src/rewards.js` is the single owner now.
#
# This file guards the two defects that fell out of that duplication, plus the
# duplication itself:
#
#   1. An unknown reward `type` used to be dropped in SILENCE. Each private
#      grant map was `const g = MAP[type]; if (!g) return;` — no log, no throw.
#      The daily gift's map had no `lightning`, so a `dailybonus.json` row typed
#      "lightning" (perfectly valid in turntable.json, a natural copy) cost the
#      player their whole gift and showed a `❔`. One table with every type in
#      it closes that; grantReward() also warns rather than returning quietly.
#
#   2. The wheel never got the try/catch its three copies have. An unmeasurable
#      fly target threw out of `_collect` — AFTER recordWheelSpin() had already
#      spent the spin, so the prize was simply gone. flyReward() owns the
#      measurement now and reports failure instead of throwing; the caller
#      grants outright.
#
#   3. The duplication itself, as pure source analysis: only src/rewards.js may
#      declare a reward grant/glyph table.
#
# Checks 1 and 2 drive the real game headlessly through window.__game; check 3
# needs no browser and runs in milliseconds.

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
#  3. No second copy of the reward vocabulary  (source analysis, no browser)
# ---------------------------------------------------------------------------
# Run first: it is instant, and a failure here means the extraction was undone.

# `PRIZE_GRANT` / `REWARD_GRANT` / `CHEST_REWARD_EMOJI` / `TYPE_IS_COINS` — the
# five spellings the private copies used. Any of them reappearing outside
# src/rewards.js is the duplication growing back.
PRIVATE_TABLE = re.compile(
    r"^\s*const\s+(?:[A-Z_]*(?:PRIZE|REWARD)_(?:GRANT|EMOJI)|TYPE_IS_COINS)\s*=", re.M)

OWNER = "src/rewards.js"
# The four features that PAY a reward out. src/levelchest.js deliberately does
# NOT import it: it only decodes `"itemId|count"` into a type, and staying free
# of the UI-side reward code is what keeps it a pure, UI-free module.
SHARERS = ["src/fortunewheel.js", "src/dailybonus.js", "src/tasks.js", "src/game.js"]

failures = []

for name in sorted(os.listdir(os.path.join(ROOT, "src"))):
    if not name.endswith(".js"):
        continue
    path = f"src/{name}"
    if path == OWNER:
        continue
    hit = PRIVATE_TABLE.search(text(path))
    assert not hit, (
        path + " declares its own reward table (" + hit.group(0).strip() + ") — "
        "the grant map and the glyph map belong to src/rewards.js alone")
print("  ok   only src/rewards.js declares a reward grant/glyph table")

assert os.path.exists(os.path.join(ROOT, OWNER)), "src/rewards.js must exist"
for path in SHARERS:
    assert re.search(r'from\s+"\./rewards\.js"', text(path)), (
        path + " must take its reward vocabulary from ./rewards.js")
print("  ok   all four paying features import ./rewards.js")

# lightning is the type the copies disagreed about — the one table must have it.
rewards_src = text(OWNER)
assert re.search(r"^\s*lightning:", rewards_src, re.M), (
    "src/rewards.js's grant table must carry `lightning` — the type the daily "
    "gift used to drop silently")
print("  ok   the one grant table carries `lightning`")


# ---------------------------------------------------------------------------
#  The live checks
# ---------------------------------------------------------------------------
BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errs = harness.launch(p, viewport=(780, 1334))
    harness.boot(page, "window.__game && window.__game.scene "
                       "&& !!window.__game.dailyBonusState "
                       "&& !!window.__game.wheelState", url=BASE)

    def coins():
        return page.evaluate("window.__game.balance('coins')")

    def wait_coins(n, timeout=10):
        end = time.time() + timeout
        while time.time() < end:
            if coins() >= n:
                break
            time.sleep(0.1)
        return coins()

    # ---- 1. A `lightning` daily prize pays out instead of vanishing -----
    # Before src/rewards.js this was a silent total loss: the day was already
    # spent (recordDailyClaim runs at box-open), the grant ~2s later found no
    # entry for "lightning" in the daily gift's private map, and returned.
    T0 = "2050-06-15"
    page.evaluate(f"window.__game.setDailyToday('{T0}')")
    assert coins() == 0, ("a fresh profile starts broke", coins())

    # The pool and the pin are both read by open() (it rolls the three boxes
    # right there), so both go in first — the ordering dailybonus_test.py uses.
    page.evaluate("""window.__game.setDailyPrizes(
        [{ type: "lightning", amount: 50, weight: 1 }])""")
    page.evaluate("window.__game.forceDailyPrize(0)")
    page.evaluate("window.__game.openDailyBonus()")
    harness.settle(page, "window.__game.dailyBonusState().overlayOpen === true")

    s = page.evaluate("window.__game.dailyBonusState()")
    assert s["prizes"][0]["type"] == "lightning", ("the pool override took", s)

    page.evaluate("window.__game.pickDailyBox(0)")     # awaits the reveal
    page.evaluate("window.__game.takeDailyBonus()")    # awaits collect + close
    assert wait_coins(50) == 50, (
        "a `lightning` daily prize credits the wallet — the one grant table "
        "knows the type the daily gift's private copy did not", coins())
    print("  ok   an unknown-to-the-old-map reward type still pays out")

    # ...and a type nothing grants is now LOUD. It still pays nothing (there is
    # nothing to pay), but it leaves a diagnostic instead of vanishing.
    warns = []
    page.on("console", lambda m: warns.append(m.text) if m.type == "warning" else None)
    page.evaluate("window.__game.setDailyToday('2050-06-16')")
    page.evaluate("""window.__game.setDailyPrizes(
        [{ type: "gems", amount: 7, weight: 1 }])""")
    page.evaluate("window.__game.forceDailyPrize(0)")
    page.evaluate("window.__game.openDailyBonus()")
    harness.settle(page, "window.__game.dailyBonusState().overlayOpen === true")
    page.evaluate("window.__game.pickDailyBox(0)")
    page.evaluate("window.__game.takeDailyBonus()")
    harness.frames(page, 3)
    assert any("gems" in w and "rewards" in w for w in warns), (
        "an ungrantable reward type must leave a console warning, not vanish", warns)
    assert coins() == 50, ("...and must not credit anything either", coins())
    print("  ok   an ungrantable reward type warns instead of vanishing silently")

    # ---- 2. The wheel pays out even when it cannot fly the prize -------
    # The three sibling collects have always granted outright when the geometry
    # can't be measured; the wheel — the ORIGINAL the other three say they copy
    # — never got the fix back-ported, and threw with the spin already spent.
    page.evaluate("window.__game.setCompleted(4)")   # opens the wheel's gate
    page.evaluate("window.__game.setWheelToday('2050-06-15')")
    page.evaluate("window.__game.openWheel()")
    harness.settle(page, "window.__game.wheelState().overlayOpen === true")

    before = coins()
    page.evaluate("window.__game.breakWheelFlyTarget()")   # unmeasurable target
    page.evaluate("window.__game.forceWheelPrize(0)")      # group 1 slice 0 = coins x30
    page.evaluate("window.__game.spinWheel()")             # awaits the settle + collect

    got = wait_coins(before + 30)
    assert got == before + 30, (
        "the wheel's 30-coin prize must land even when the fly target cannot be "
        "measured — the spin was already spent", before, got)
    s = page.evaluate("window.__game.wheelState()")
    assert s["spinsUsed"] == 1, ("exactly one spin was spent", s)
    print("  ok   an unmeasurable wheel fly target grants outright, no throw")

    assert not errs, ("console errors / uncaught exceptions", errs[:5])
    print("ALL REWARDS CHECKS PASSED")
    browser.close()
