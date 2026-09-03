#!/usr/bin/env python3
# The SUPER WAND'S LOBBY READ-OUT — its progress button on the left feature rail.
#
# The Super Wand is earned by a streak of new level clears, but the streak is
# only ever mentioned on the level-complete screen, which is gone the moment the
# player taps through it. So the lobby carries a standing read-out: a wand on the
# left-edge rail, under Free Spin and Daily Bonus, with a "streak / needed" pill.
# Once the reward is banked the whole face goes gold and the glyph swaps to the
# upgraded one — the same pair the shared helper-row button wears in a level.
#
# What this guards:
#   * the gate — nothing on the rail before CONFIG.boosters.superWand.unlockLevel
#   * the rail packing — it takes the slot BELOW whatever else is offered, and
#     never displaces a claimable daily gift
#   * the pill counts a win live, without a scene rebuild
#   * a banked charge pins the pill full and repaints the face
#   * it survives a reload (the streak is on the profile, not on the scene)
#   * USING it changes nothing — only an accepted loss empties the meter
#
# See tests/README.md; the sweep itself is superwand_test.py's business.

import time, os
from playwright.sync_api import sync_playwright

import harness
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

RAIL_Y0 = 214.0    # featurerail.js — first slot's design-space y
RAIL_GAP = 182.0
TOL = 1.0

with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    harness.boot(page, "window.__game && window.__game.lobby", url=BASE)

    ev = page.evaluate
    def rail():   return ev("window.__game.superWandRail()")
    def slots():  return {e["key"]: e for e in ev("window.__game.featureRail()")}
    def state():  return ev("window.__game.superWandState()")
    def lobby():
        harness.settle(page, "window.__game.inLobby()", timeout=10000)
        harness.frames(page, 3)

    # A returning player in the lobby: a profile that never cleared level 1 is
    # routed straight into the level by the first-run flow (see tests/README).
    ev("window.__game.completeLevel(1); window.__game.flushSave();")
    page.reload()
    harness.ready(page, "window.__game && window.__game.lobby", timeout=60000)
    lobby()

    # ---- 1. The gate -----------------------------------------------------
    # The read-out is progression-gated exactly like the reward it reports, on
    # the profile's derived rule (completedLevel() >= unlockLevel - 1), so a QA
    # level jump opens it with nothing to repair.
    unlock = state()["unlockLevel"]
    needed = state()["needed"]
    r = rail()
    assert r["available"] is False and r["visible"] is False, \
        ("no read-out before the Super Wand unlocks", r)
    assert "superWand" not in [k for k, e in slots().items() if e["available"]], \
        ("the locked read-out holds no rail slot", slots())

    ev(f"window.__game.completeLevel({unlock - 2})")
    harness.frames(page, 3)
    assert rail()["available"] is False, \
        (f"still locked one clear short of level {unlock}", rail())

    ev(f"window.__game.completeLevel({unlock - 1})")
    harness.frames(page, 3)
    r = rail()
    assert r["available"] is True, (f"unlocked by clearing level {unlock - 1}", r)
    assert r["label"] == f"0/{needed}", ("an untouched streak reads as empty", r)
    assert r["charged"] is False, ("nothing banked yet", r)
    page.screenshot(path=f"{SC}/swrail_1_unlocked.png")

    # ---- 2. It sits UNDER the other rail entries --------------------------
    # Registration order is priority order, and the read-out is registered last:
    # it must never push a claimable daily gift down the column.
    s = slots()
    mine = s["superWand"]
    others = [e["slot"] for k, e in s.items() if k != "superWand" and e["available"]]
    assert others, ("this check needs another rail entry offered", s)
    assert mine["slot"] > max(others), \
        ("the read-out takes the slot below everything else offered", s)
    assert abs(mine["y"] - (RAIL_Y0 + mine["slot"] * RAIL_GAP)) < TOL, \
        ("parked on the slot ladder", mine)
    assert abs(ev("window.__game.lobby.superWandBtn.y") - mine["y"]) < TOL, \
        "the live display object agrees with the rail snapshot"

    # ---- 3. A win moves the pill, live -----------------------------------
    # The lobby subscribes to the profile's "superWand" domain, so the meter
    # ticks over where it stands — no scene rebuild, no trip through a level.
    ev("window.__game.superWandWin()")
    harness.frames(page, 3)
    assert rail()["label"] == f"1/{needed}", ("one counted win = one notch", rail())
    ev("window.__game.superWandWin()")
    harness.frames(page, 3)
    assert rail()["label"] == f"2/{needed}", ("and again", rail())

    # ---- 4. A banked charge repaints the face ----------------------------
    plain = rail()["icon"]
    assert ev("window.__game.chargeSuperWand()") is True, "charged"
    harness.frames(page, 3)
    r = rail()
    assert r["label"] == f"{needed}/{needed}", ("a banked charge pins the meter full", r)
    assert r["charged"] is True, ("the gold/upgraded face", r)
    assert r["icon"] != plain, ("the glyph swaps to the upgraded one", r, plain)
    assert r["available"] is True and r["visible"] is True, \
        ("a charged read-out stays on the rail", r)
    page.screenshot(path=f"{SC}/swrail_2_charged.png")

    # ---- 5. It survives a reload -----------------------------------------
    ev("window.__game.flushSave()")
    page.reload()
    harness.ready(page, "window.__game && window.__game.lobby", timeout=60000)
    lobby()
    r = rail()
    assert r["charged"] is True and r["label"] == f"{needed}/{needed}", \
        ("the banked charge is still shown after a restart", r)

    # ---- 6. USING it changes nothing --------------------------------------
    # The real round trip: carry the charge into a level, sweep with it, come
    # back. A Super Wand is the win streak itself, not a single-shot token, so the
    # meter must still read full and the face must still be the upgraded one.
    ev("window.__game.markBoosterCoached('all')")
    ev("async () => { await window.__game.startLevel(12); window.__game.closeTutorial(); }")
    harness.settle(page, "window.__game.state().level === 12", timeout=20000)
    harness.settle(page, "window.__game.superWandState().announced", timeout=10000)
    assert state()["active"] is True, ("the charge came into the level", state())
    before = ev("window.__game.state()")["boardCount"]
    ev("window.__game.superWand()")
    harness.settle(page, "!window.__game.superWandState().running"
                         " && !window.__game.state().locked", timeout=20000)
    after = ev("window.__game.state()")["boardCount"]
    assert before - after >= 6 and (before - after) % 3 == 0, \
        ("the sweep really ran — whole sets off the board", before, after)
    assert state()["charged"] is True, ("…and consumed nothing", state())

    ev("window.__game.exitLevel()")
    lobby()
    r = rail()
    assert r["charged"] is True, ("the read-out still wears the charged face", r)
    assert r["label"] == f"{needed}/{needed}", ("using it does not empty the meter", r)
    page.screenshot(path=f"{SC}/swrail_3_after_use.png")

    # ---- 7. An accepted loss is the ONE thing that empties it --------------
    ev("async () => { await window.__game.startLevel(12); window.__game.closeTutorial(); }")
    harness.settle(page, "window.__game.state().level === 12", timeout=20000)
    # Fill the tray without ever completing a triple -> a genuine out-of-moves.
    ev("""() => { const s = window.__game.scene; let g = 0;
          while (s.tray.length < s.traySlots && g++ < 400) {
            const c = {}; for (const t of s.tray) c[t.type] = (c[t.type] || 0) + 1;
            const cand = s.tiles.filter(t => !t.inTray && !t.matched && t.aliveCovers === 0)
              .filter(t => (c[t.type] || 0) < 2)
              .sort((a, b) => (c[a.type] || 0) - (c[b.type] || 0));
            if (!cand.length) break; s._collect(cand[0]); } }""")
    harness.settle(page, "window.__game.loseState().loseOverlay", timeout=10000)
    ev("window.__game.pressLoseHome()")
    lobby()
    r = rail()
    assert r["charged"] is False, ("the read-out reverted to the ordinary face", r)
    assert r["icon"] == plain, ("and to the ordinary glyph", r)
    assert r["label"] == f"0/{needed}", ("an accepted loss empties the meter", r)
    assert r["available"] is True, ("but the read-out itself stays — it is progress", r)
    page.screenshot(path=f"{SC}/swrail_4_after_loss.png")

    # ---- 8. Tapping the read-out explains it ------------------------------
    # The pill can only ever show a number. A tap opens the promo that says what
    # the number is FOR: what the sweep does, and how the meter is filled.
    promo = lambda: ev("window.__game.superWandPromo()")
    assert promo()["open"] is False, ("the promo starts closed", promo())
    ev("window.__game.pressSuperWandRail()")      # the real pointer path
    harness.frames(page, 6)
    pr = promo()
    print("promo:", pr)
    assert pr["open"] is True, ("a tap on the read-out opens the promo", pr)
    for field in ("title", "line", "caption", "button"):
        assert pr[field] and not pr[field].startswith("superwand_") \
            and not pr[field].startswith("ui_"), \
            (f"{field} is localized copy, not a raw key", pr)
    assert pr["label"] == f"0 / {needed}", \
        ("the promo's meter shows the same streak the pill does", pr)
    page.screenshot(path=f"{SC}/swrail_5_promo.png")

    # The meter is live: it tracks the streak, and a banked charge swaps the
    # caption to the "ready" one and pins it full.
    empty_caption = pr["caption"]
    ev("window.__game.superWandWin(); window.__game.superWandWin();")
    harness.frames(page, 3)
    assert promo()["label"] == f"2 / {needed}", ("the promo follows the streak", promo())
    assert ev("window.__game.chargeSuperWand()") is True
    harness.frames(page, 3)
    pr = promo()
    assert pr["label"] == f"{needed} / {needed}", ("a banked charge pins it full", pr)
    assert pr["caption"] != empty_caption, \
        ("…and the caption becomes the 'ready' one", pr, empty_caption)
    page.screenshot(path=f"{SC}/swrail_6_promo_ready.png")

    # It is modal and it closes: the OK button, and a tap on the dim around it.
    ev("() => window.__game.lobby.superWandPromo.okBtn.emit('pointertap')")
    harness.frames(page, 3)
    assert promo()["open"] is False, ("the button closes it", promo())
    ev("window.__game.pressSuperWandRail()")
    harness.frames(page, 3)
    assert promo()["open"] is True, promo()
    ev("() => window.__game.lobby.superWandPromo.dim.emit('pointertap')")
    harness.frames(page, 3)
    assert promo()["open"] is False, ("a tap outside the panel closes it too", promo())

    # And leaving the lobby closes it, so coming back never lands on a modal the
    # player opened two screens ago.
    ev("window.__game.pressSuperWandRail()")
    harness.frames(page, 3)
    assert promo()["open"] is True, promo()
    ev("async () => { await window.__game.startLevel(11); window.__game.closeTutorial(); }")
    harness.settle(page, "window.__game.state().level === 11", timeout=20000)
    ev("window.__game.exitLevel()")
    lobby()
    assert promo()["open"] is False, ("a trip through a level closes it", promo())

    assert not errs, ("no console/page errors", errs)
    print("SUPER WAND RAIL TEST PASSED")
    b.close()
