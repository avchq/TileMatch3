import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

# The Wand ("hint") helper guarantees one instant match: it flies the tiles
# needed to complete a triple from the board into the tray, where they clear —
# relieving tray pressure. It's a consumable like Undo/Shuffle: one charge per
# use, it can't be double-spent while animating, and at zero stock it falls back
# to the acquisition ladder (buy with coins, else watch an ad) rather than
# disabling — while a move exists it stays usable. See boosterbuy_test.
with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    time.sleep(0.5)

    def wcount():  return page.evaluate("window.__game.boosterCount('wand')")
    def bstate():  return page.evaluate("window.__game.boosterState()")
    def st():      return page.evaluate("window.__game.state()")
    def tap():     page.evaluate("window.__game.solveTap()"); time.sleep(0.3)
    def wand():    page.evaluate("window.__game.wand()"); time.sleep(0.6)

    # 1) The Wand is LOCKED in the first levels — a fresh profile owns none.
    #    Play forward past its unlock (which pays out its one-time stock), then
    #    top up to the 3 charges this test spends below. The unlock gate itself
    #    is covered in boosterunlock_test.py.
    assert wcount() == 0, wcount()
    page.evaluate("window.__game.completeLevel(5)")
    time.sleep(0.2)
    grant = page.evaluate("window.__game.config()")["boosters"]["unlocks"]["wand"]["grant"]
    assert wcount() == grant, ("unlocking the wand pays out its scheduled stock", wcount())
    page.evaluate(f"window.__game.grantBooster('wand', {3 - grant})")
    time.sleep(0.1)
    assert wcount() == 3, wcount()
    # Those helpers are unlocked but untaught, so the next level entry would
    # open a coached first use and park the board (boostercoach_test.py owns
    # that flow). This test is about the wand's mechanics — skip the lesson.
    page.evaluate("window.__game.markBoosterCoached('all')")

    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.7)

    # 2) On level start the Wand is usable and NOT greyed even though the tray
    #    is empty — unlike Undo, it works off the board (its badge shows stock).
    s = bstate()
    print("on level start:", s)
    assert s["wandBadge"] == "3", s
    assert s["wandUsable"] is True and s["wandDimmed"] is False, "wand usable with stock + a non-empty board"

    # 2b) Availability-first waterfall: the Wand must complete a triple out of
    #     AVAILABLE (free, top-layer) tiles and only reach into UNAVAILABLE
    #     (greyed-out, still-covered) tiles when a colour hasn't enough free
    #     ones left. On the empty-tray start there are colours with three free
    #     tiles, so the pick must be a fully-available triple — never a colour
    #     that would drag a covered tile out from under others. (Regression:
    #     the old picker chose the lowest face-id colour with >=3 tiles total,
    #     dipping into a covered tile even when a free triple existed.)
    board = page.evaluate("""() => window.__game.scene.tiles
            .filter(t => !t.inTray && !t.matched)
            .map(t => ({type: t.type, free: t.aliveCovers === 0}))""")
    freeByType = {}
    for t in board:
        freeByType.setdefault(t["type"], 0)
        if t["free"]:
            freeByType[t["type"]] += 1
    assert any(n >= 3 for n in freeByType.values()), \
        ("sanity: a fully-available triple exists on the empty-tray board", freeByType)
    prev = page.evaluate("window.__game.wandPreview()")
    print("empty-tray wand preview:", prev)
    assert len(prev["tiles"]) == 3, prev
    assert all(t["free"] for t in prev["tiles"]), \
        ("the Wand must pull an all-available triple, not touch covered tiles", prev)

    # 3) Empty-tray case: the Wand banks a fresh triple off the board. It pulls
    #    three of one colour, they clear, the tray ends empty (space-neutral),
    #    the board shrinks by three, and one charge is spent.
    before = st()
    assert before["tray"] == [], before
    wand()
    after = st()
    print("after empty-tray wand:", after)
    assert after["tray"] == [], "the pulled triple must clear, leaving the tray empty"
    assert before["boardCount"] - after["boardCount"] == 3, "three tiles left the board"
    assert wcount() == 2, "one wand charge spent"

    # 4) Pair case: a waiting pair is the cheapest completion — the Wand pulls
    #    exactly ONE tile to finish it, freeing two tray slots.
    tap(); tap()                       # two of the same type (consecutive solution triple)
    s0 = st()
    assert len(s0["tray"]) == 2 and s0["tray"][0] == s0["tray"][1], ("a pair is waiting", s0)
    b0 = s0["boardCount"]
    wand()
    s1 = st()
    print("after pair wand:", s1)
    assert s1["tray"] == [], "completing the pair clears it -> two slots freed"
    assert b0 - s1["boardCount"] == 1, "only one tile was pulled to finish the pair"
    assert wcount() == 1, "one more charge spent"

    # 5) Rapid double-tap: firing the Wand twice back-to-back (while the first
    #    is still animating) must spend exactly ONE charge, not two.
    tap(); tap()                       # build another pair to complete
    c0 = wcount()
    assert c0 == 1, c0
    page.evaluate("window.__game.wand(); window.__game.wand()")  # two synchronous taps
    time.sleep(0.6)
    c1 = wcount()
    print("charges: before", c0, "after double-tap", c1)
    assert c0 - c1 == 1, "a double-tap during the animation must spend one charge only"
    assert st()["tray"] == [], "the (single) completion still resolved"

    # 6) At zero charges, with the board still up but no coins, the Wand falls
    #    back to the "watch an ad" tier — still usable (not greyed). A tap watches
    #    a (stubbed) rewarded ad for a free charge and spends it, completing a
    #    triple; net stock stays 0 and no coins are spent.
    assert wcount() == 0, wcount()
    assert page.evaluate("window.__game.balance('coins')") == 0
    s = bstate()
    assert s["wandUsable"] is True and s["wandDimmed"] is False, ("wand usable via ad tier at 0 stock", s)
    assert s["wandMode"] == "ad", ("no stock + no coins -> ad tier", s)
    tap(); tap()                       # a pair the Wand can finish
    wand()                             # watches an ad -> completes the pair
    assert st()["tray"] == [], "the ad-funded wand completed the pair (tray cleared)"
    assert wcount() == 0, "ad grant+use nets 0 charges"
    assert page.evaluate("window.__game.balance('coins')") == 0, "watching an ad costs no coins"

    # 7) The spent inventory persists across a reload (it's on the record).
    page.evaluate("window.__game.flushSave()")
    time.sleep(0.2)
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    assert wcount() == 0, "wand stock persisted at 0"

    # 8) A grant re-enables the Wand and updates its bubble live.
    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.6)
    page.evaluate("window.__game.grantBooster('wand', 2)")
    time.sleep(0.1)
    s = bstate()
    print("after grant:", s)
    assert s["wandBadge"] == "2" and s["wandUsable"] is True, s

    page.screenshot(path=f"{SC}/wand_state.png")
    print("PAGE ERRORS:", len(errs), errs[:5])
    assert not errs
    print("WAND TEST PASSED")
    b.close()