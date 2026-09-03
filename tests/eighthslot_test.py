import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

# THE 8th TRAY SLOT — an ad-funded, ONE-PER-LEVEL capacity boost.
#
# Two numbers that are deliberately NOT the same thing:
#   * cells DRAWN   — 7 below the gate, 8 from the config's extraSlot.unlockLevel
#                     onward (read off CAMPAIGN progress, not the board's level),
#                     with the whole row re-centred to make room;
#   * live CAPACITY — still 7 when the 8th cell first appears. The cell is covered
#                     by a "📺 +1" button, and only a completed rewarded video
#                     raises capacity to 8, for the rest of THIS level.
#
# It can be taken once per level (the button is only offered while capacity is at
# base, so there is no route to 9 slots), only during live play, and it is reset
# by every board build (next level, Replay) — but NOT by a revive, which keeps the
# same board. Nothing is charged and nothing is refunded: a failed video just says
# "Ad not ready, please try again later!" and leaves the offer up.
#
# Capacity is also what the tray's pressure warnings are measured against, so
# taking the ad shifts both cues up by exactly one tile (pulse at 5/7 -> 6/8,
# "Insufficient space!" at 6/7 -> 7/8).
with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    time.sleep(0.5)

    def cfg():   return page.evaluate("window.__game.config()")
    def es():    return page.evaluate("window.__game.extraSlotState()")
    def tsz():   return page.evaluate("window.__game.traySize()")
    def warn():  return page.evaluate("window.__game.trayWarning()")
    def st():    return page.evaluate("window.__game.state()")
    def lst():   return page.evaluate("window.__game.loseState()")
    def press(): page.evaluate("window.__game.pressExtraSlot()"); time.sleep(0.25)
    def set_ad(mode): page.evaluate(f"window.__game.setExtraSlotAdResult('{mode}')")

    # Levels other than 1 avoid the "How To Play" popup entirely; closeTutorial()
    # is kept as the harmless no-op the house style uses.
    def start(lvl):
        page.evaluate("async (n) => { await window.__game.startLevel(n); "
                      "window.__game.closeTutorial(); }", lvl)
        time.sleep(0.7)

    # Collect free tiles one at a time until the tray holds `n`, always taking
    # the least-represented type so no triple ever completes — a genuine tray
    # fill through the game's own _collect/_settle path.
    def fill_to(n):
        got = page.evaluate("""(n) => {
              const s = window.__game.scene;
              let guard = 0;
              while (s.tray.length < n && guard++ < 400) {
                const counts = {};
                for (const t of s.tray) counts[t.type] = (counts[t.type] || 0) + 1;
                const cand = s.tiles
                  .filter(t => !t.inTray && !t.matched && t.aliveCovers === 0)
                  .filter(t => (counts[t.type] || 0) < 2)
                  .sort((a, b) => (counts[a.type] || 0) - (counts[b.type] || 0));
                if (!cand.length) break;
                s._collect(cand[0]);
              }
              return s.tray.length;
            }""", n)
        time.sleep(0.45)  # let the last _collect's setTimeout(_settle,190) resolve
        assert got == n, (f"could not fill the tray to {n}", got)
        return got

    def wait_resumed(timeout=5.0):
        end = time.time() + timeout
        while time.time() < end:
            s = st()
            if s["overlay"] is False and s["locked"] is False:
                return s
            time.sleep(0.1)
        return st()

    C = cfg()
    GATE = C["board"]["extraSlot"]["unlockLevel"]
    BASE = C["board"]["traySlots"]
    GRANT = C["board"]["extraSlot"]["grant"]
    PULSE_AT = C["board"]["warnings"]["pulseAtFree"]
    BUBBLE_AT = C["board"]["warnings"]["bubbleAtFree"]
    BOOST = BASE + GRANT
    print("gate:", GATE, "base:", BASE, "boosted:", BOOST,
          "warn free:", PULSE_AT, BUBBLE_AT)

    # ---- 1) BELOW THE GATE: the cell does not exist at all -------------------
    # The gate follows the usual "available from level N onward" convention, so
    # having cleared N-2 is one short of it. Helpers are unlocked-but-untaught
    # by then, and an untaught helper opens a coached first use over the board
    # (boostercoach_test.py owns that) — take the lesson as read.
    page.evaluate(f"window.__game.completeLevel({GATE - 2})")
    page.evaluate("window.__game.markBoosterCoached('all')")
    page.evaluate("window.__game.flushSave()")
    time.sleep(0.3)
    start(3)
    s, t = es(), tsz()
    print("BELOW GATE ->", s, "slots:", len(t["slotXs"]))
    assert s["unlockLevel"] == GATE, s
    assert s["unlocked"] is False and s["drawn"] is False, ("gate shut", s)
    assert s["btnVisible"] is False, ("no +1 button below the gate", s)
    assert s["capacity"] == BASE and s["taken"] is False, s
    assert len(t["slotXs"]) == BASE, ("a plain 7-cell row below the gate", t)

    # ---- 2) AT THE GATE: 8 cells drawn, but capacity is still 7 --------------
    page.evaluate(f"window.__game.completeLevel({GATE - 1})")
    page.evaluate("window.__game.flushSave()")
    time.sleep(0.3)
    start(3)
    s, t = es(), tsz()
    xs_ = t["slotXs"]
    print("AT GATE ->", s, "slots:", len(xs_), "panelW:", round(t["panelW"], 1))
    assert s["unlocked"] is True and s["drawn"] is True, ("gate open", s)
    assert len(xs_) == BOOST, ("the 8th cell is drawn", xs_)
    # …and the whole row is re-centred to make room, still inside the 750 band.
    gaps = [round(xs_[i + 1] - xs_[i], 2) for i in range(len(xs_) - 1)]
    assert all(abs(g - (t["slot"] + 6)) < 0.5 for g in gaps), \
        ("8 cells evenly spaced by slot+gap(6)", gaps, t["slot"])
    assert t["panelW"] <= 750 + 0.5, ("the 8-cell panel still fits the band", t)
    assert abs((xs_[0] + xs_[-1]) / 2 - 375) < 0.5, ("row re-centred", xs_)
    # The cell being visible does NOT mean it is usable.
    assert s["capacity"] == BASE, ("capacity is still the base 7", s)
    assert s["offered"] is True and s["btnVisible"] is True, ("the +1 offer is up", s)
    assert abs(s["btnX"] - xs_[-1]) < 1.0, ("the +1 button covers the LAST cell", s, xs_)
    page.screenshot(path=f"{SC}/eighthslot_offer.png")

    # ---- 3) WARNINGS AT THE BASE CAPACITY (5 pulse / 6 bubble of 7) ----------
    fill_to(BASE - PULSE_AT - 1)                 # 4 of 7 -> 3 free, quiet
    w = warn()
    print("tray 4/7 ->", w)
    assert w["capacity"] == BASE and w["free"] == BASE - 4, w
    assert w["pulsing"] is False, ("no warning three from full", w)
    fill_to(BASE - PULSE_AT)                     # 5 of 7 -> 2 free, pulsing
    w = warn()
    print("tray 5/7 ->", w)
    assert w["pulsing"] is True, ("the tray pulses two from full", w)
    fill_to(BASE - BUBBLE_AT)                    # 6 of 7 -> 1 free, bubble
    w = warn()
    print("tray 6/7 ->", w)
    assert w["pulsing"] is True, w
    assert w["message"] == "Insufficient space!", ("the bubble pops one from full", w)
    assert lst()["loseOverlay"] is False, "6 of 7 is not a loss yet"

    # ---- 4) A FAILED / CANCELLED VIDEO CHANGES NOTHING -----------------------
    set_ad("fail")
    press()
    w, s = warn(), es()
    print("ad fail ->", s, w)
    assert w["message"] == "Ad not ready, please try again later!", ("told so", w)
    assert s["capacity"] == BASE, ("a failed video grants nothing", s)
    assert s["btnVisible"] is True, ("the offer stays up for another attempt", s)
    set_ad("cancel")
    press()
    s = es()
    print("ad cancel ->", s)
    assert s["capacity"] == BASE and s["btnVisible"] is True, ("cancel is a no-op", s)

    # ---- 5) CAPACITY REALLY IS 7 WHILE THE OFFER IS UP ----------------------
    fill_to(BASE)                                 # the 7th tile loses the level
    ls = lst()
    print("tray 7/7 ->", ls, st())
    assert ls["loseOverlay"] is True, ("7 tiles is still a loss with 8 cells drawn", ls)

    # …and it can only be taken during LIVE play: the board is not running.
    press()
    s = es()
    print("press while Out of Moves is up ->", s)
    assert s["capacity"] == BASE, ("refused while the level is not running", s)

    # ---- 6) THE BOOST IS SCOPED TO ONE ATTEMPT: Replay re-offers it ---------
    page.evaluate("window.__game.pressLoseReplay()")
    # Replay rebuilds the board, and the 8th slot cannot be TAKEN while that board
    # is still dealing itself in — _extraSlotTakeable refuses a locked scene. Wait
    # on the deal actually finishing instead of betting 0.6s on it: under load that
    # bet loses, and step 7's press below is then silently refused, which reads as
    # "the ad granted nothing" rather than as the starved renderer it is.
    page.wait_for_function(
        "() => !window.__game.dealState().animating && !window.__game.state().locked",
        timeout=45000)
    harness.frames(page)
    s = es()
    print("after Replay ->", s, st())
    assert s["capacity"] == BASE and s["btnVisible"] is True, ("a fresh offer", s)
    assert st()["tray"] == [], "Replay rebuilt the board"

    # ---- 7) A COMPLETED VIDEO RAISES THE CAPACITY, ONCE ---------------------
    set_ad("succeed")
    press()
    s = es()
    print("after the video ->", s)
    assert s["capacity"] == BOOST, ("the tray holds one more", s)
    assert s["taken"] is True and s["btnVisible"] is False, ("the offer is spent", s)
    assert s["offered"] is False, s
    press()   # there is no way to reach 9 slots
    s = es()
    assert s["capacity"] == BOOST, ("a second press grants nothing", s)
    assert len(tsz()["slotXs"]) == BOOST, "the cell count is unchanged by the grant"

    # ---- 8) THE WARNINGS SHIFT UP BY EXACTLY ONE TILE -----------------------
    fill_to(BOOST - PULSE_AT - 1)                # 5 of 8 -> 3 free, now quiet
    w = warn()
    print("tray 5/8 ->", w)
    assert w["capacity"] == BOOST, w
    assert w["pulsing"] is False, ("5 tiles no longer warns with 8 slots", w)
    fill_to(BOOST - PULSE_AT)                    # 6 of 8 -> 2 free, pulsing
    w = warn()
    print("tray 6/8 ->", w)
    assert w["pulsing"] is True, ("the pulse moved from 5 tiles to 6", w)
    fill_to(BOOST - BUBBLE_AT)                   # 7 of 8 -> 1 free, bubble
    w = warn()
    print("tray 7/8 ->", w)
    assert w["message"] == "Insufficient space!", ("the bubble moved to 7 tiles", w)
    # …and 7 tiles is NOT a loss any more — the 8th slot really is usable.
    assert lst()["loseOverlay"] is False, ("7 of 8 is not a loss", lst())
    assert st()["tray"] and len(st()["tray"]) == BOOST - 1, st()

    # ---- 9) THE 8th TILE STILL LOSES, AND A REVIVE KEEPS THE BOOST ----------
    fill_to(BOOST)
    assert lst()["loseOverlay"] is True, ("a full 8-slot tray loses", lst())
    page.evaluate("window.__game.credit('coins', 5000)")   # take the coin tier
    page.evaluate("window.__game.pressLoseContinue()")
    wait_resumed()
    s = es()
    print("after a revive ->", s, st())
    assert s["capacity"] == BOOST, ("a revive does not rebuild the board", s)
    assert s["btnVisible"] is False, ("…so the offer stays spent", s)
    assert st()["tray"] == [], "the collected tiles flew home"

    # ---- 10) THE NEXT LEVEL STARTS OVER AT 7, WITH A FRESH OFFER ------------
    start(4)
    s = es()
    print("next level ->", s)
    assert s["capacity"] == BASE, ("capacity is reset by every board build", s)
    assert s["btnVisible"] is True and s["taken"] is False, ("a fresh offer", s)
    assert len(tsz()["slotXs"]) == BOOST, ("the cell is still drawn", tsz())

    page.screenshot(path=f"{SC}/eighthslot_next.png")
    print("PAGE ERRORS:", len(errs), errs[:5])
    assert not errs
    print("EIGHTH SLOT TEST PASSED")
    b.close()