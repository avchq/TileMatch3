#!/usr/bin/env python3
# End-to-end test for the lobby's feature-button rail (src/featurerail.js).
#
# The rail arranges the feature entry buttons (1. Free Spin, 2. Daily Bonus) in
# CONSECUTIVE slots down an outer edge, in that fixed priority order, filled by
# whichever buttons are currently available. The regression it guards: the two
# buttons used to hard-code their y (214 / 396) and hide independently, so an
# unavailable Free Spin left a HOLE with the gift button floating below it —
# which is what every new player saw (the wheel opens after clearing level 4,
# the gift from the very start). Now #2 takes #1's slot when #1 goes away, and gives it back when #1
# returns, and both movements are animated.

import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

SLOT0 = 214.0   # first slot's design-space y (RAIL_Y0)
SLOT1 = 396.0   # second slot (RAIL_Y0 + RAIL_GAP)
TOL = 1.0

BASE = harness.serve()
with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    # A fresh profile is a brand-new player routed straight into level 1 — clear
    # the first-run flow so every reload below lands on the LOBBY (see tests/README).
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
    page.reload()
    page.wait_for_function(
        "window.__game && window.__game.scene && !!window.__game.featureRail", timeout=60000)
    time.sleep(0.5)

    T0 = "2050-06-15"   # fixed test day, so the gift's clock can't flip mid-test

    def rail():      return {e["key"]: e for e in page.evaluate("window.__game.featureRail()")}
    # Read the live display objects too, so the core position assertions don't
    # depend on the new debug hook alone.
    def y(name):     return page.evaluate(f"window.__game.lobby.{name}.y")
    def shown(name): return page.evaluate(f"window.__game.lobby.{name}.visible")
    def setday(k):   page.evaluate(f"window.__game.setDailyToday('{k}')")
    # The wheel's gate is the profile's (completedLevel() >= unlockLevel - 1),
    # so CLEARS are what open and close it — setLevel moves a derived field and
    # no longer touches any gate (see unlockgate_test.py).
    def setcompleted(n): page.evaluate(f"window.__game.setCompleted({n})")

    def wait_still(timeout=15):
        """Wait for the rail's tweens to land instead of sleeping a guess at
        how long they take. `moving` is exposed per entry for exactly this: on
        a loaded machine a slide or fade gets fewer frames and a stopwatch
        samples it mid-flight, which reads as a layout bug rather than as the
        starved renderer it is."""
        end = time.time() + timeout
        while time.time() < end:
            r = rail()
            if not any(e["moving"] for e in r.values()):
                return r
            time.sleep(0.05)
        return rail()

    setday(T0)
    time.sleep(0.4)

    # ---- 1. Free Spin unavailable => Daily Bonus takes slot #1 ----------
    # The wheel is locked below level 5; the gift is claimable from level 1.
    # THE regression anchor: the gift must sit in the FIRST slot, not float in
    # the second one under an empty slot (the pre-rail behaviour).
    r = rail()
    assert r["freeSpin"]["available"] is False, ("wheel still locked at level 2", r)
    assert r["dailyBonus"]["available"] is True, ("gift claimable from level 1", r)
    assert shown("wheelBtn") is False, "Free Spin button hidden while unavailable"
    assert abs(y("dailyBtn") - SLOT0) < TOL, \
        ("Daily Bonus must take the vacant first slot", y("dailyBtn"))
    assert r["dailyBonus"]["slot"] == 0, ("gift promoted to slot 0", r)
    page.screenshot(path=f"{SC}/rail_1_daily_promoted.png")

    # ---- 2. Free Spin becomes available => it reclaims slot #1 ----------
    # Sample the gift's y every frame while it is demoted, to prove the move is
    # ANIMATED (a teleport would land on the target in a single frame).
    seen = page.evaluate("""() => new Promise(resolve => {
            const btn = window.__game.lobby.dailyBtn;
            const seen = [];
            window.__game.setCompleted(4);      // cleared the wheel's unlockLevel - 1
            (function tick() {
                seen.push(btn.y);
                if (btn.y >= 395 || seen.length > 300) resolve(seen);
                else requestAnimationFrame(tick);
            })();
        })""")
    assert len(seen) > 3, ("the demotion is animated, not a teleport", seen[:8])
    assert any(SLOT0 + 2 < v < SLOT1 - 2 for v in seen), \
        ("the gift was seen mid-slide between the slots", seen[:12])
    time.sleep(0.6)
    r = rail()
    assert r["freeSpin"]["available"] is True and r["freeSpin"]["slot"] == 0, \
        ("Free Spin reclaims slot 0 by priority order", r)
    assert r["dailyBonus"]["slot"] == 1, ("Daily Bonus falls back to slot 1", r)
    assert abs(y("wheelBtn") - SLOT0) < TOL, ("Free Spin at slot 0", y("wheelBtn"))
    assert abs(y("dailyBtn") - SLOT1) < TOL, ("Daily Bonus at slot 1", y("dailyBtn"))
    assert shown("wheelBtn") is True and r["freeSpin"]["alpha"] > 0.99, \
        ("Free Spin faded fully in", r)
    page.screenshot(path=f"{SC}/rail_2_both.png")

    # ---- 2b. The reflow never stacks two buttons on top of each other ---
    # Slots are only ~1.2 button-heights apart, so a button arriving in slot 0
    # would sit on the neighbour sliding past it for most of the move. An
    # entering button therefore waits out the reflow before it fades in.
    # Sample both buttons every frame through the whole transition and assert
    # their bounds never intersect while both are on screen.
    setcompleted(1)
    time.sleep(0.7)
    worst = page.evaluate("""() => new Promise(resolve => {
            const L = window.__game.lobby, s = window.__game.app.stage.scale.x || 1;
            const box = (b) => b.visible
                ? (() => { const r = b.getBounds(); return {x: r.x, y: r.y, w: r.width, h: r.height}; })()
                : null;
            let worst = 0, until = performance.now() + 3000;
            window.__game.setCompleted(4);       // Free Spin returns -> full reflow
            (function tick() {
                const a = box(L.wheelBtn), b = box(L.dailyBtn);
                if (a && b) {
                    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
                    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
                    if (ox > 0 && oy > 0) worst = Math.max(worst, Math.min(ox, oy));
                }
                if (performance.now() >= until) resolve(worst);
                else requestAnimationFrame(tick);
            })();
        })""")
    assert worst < 8, ("the two buttons never overlap during a reflow", worst)
    time.sleep(0.4)
    assert abs(y("wheelBtn") - SLOT0) < TOL and abs(y("dailyBtn") - SLOT1) < TOL, \
        ("settled into both slots after the reflow", y("wheelBtn"), y("dailyBtn"))

    # ---- 3. Free Spin goes away again => the gift animates back up ------
    seen = page.evaluate("""() => new Promise(resolve => {
            const btn = window.__game.lobby.dailyBtn;
            const seen = [];
            window.__game.setCompleted(1);      // re-locks the wheel
            (function tick() {
                seen.push(btn.y);
                if (btn.y <= 215 || seen.length > 300) resolve(seen);
                else requestAnimationFrame(tick);
            })();
        })""")
    assert len(seen) > 3, ("the promotion is animated, not a teleport", seen[:8])
    assert any(SLOT0 + 2 < v < SLOT1 - 2 for v in seen), \
        ("the gift was seen mid-slide between the slots", seen[:12])
    time.sleep(0.6)
    r = rail()
    assert abs(y("dailyBtn") - SLOT0) < TOL, ("gift back in slot 0", y("dailyBtn"))
    assert shown("wheelBtn") is False and r["freeSpin"]["alpha"] < 0.01, \
        ("Free Spin faded out and is hidden", r)
    assert r["freeSpin"]["slot"] == -1, ("an unavailable button holds no slot", r)
    page.screenshot(path=f"{SC}/rail_3_daily_promoted_again.png")

    # ---- 4. Only Free Spin available => it keeps slot #1, gift is gone ---
    # Claim today's gift for real (tapping a box commits the claim), then
    # unlock the wheel: the rail is left with a single occupant in slot 0.
    setcompleted(4)
    time.sleep(0.6)
    page.evaluate("window.__game.forceDailyPrize(9)")   # coins 50 — deterministic
    page.evaluate("window.__game.openDailyBonus()")
    time.sleep(0.4)
    page.evaluate("window.__game.pickDailyBox(0)")
    page.evaluate("window.__game.takeDailyBonus()")
    time.sleep(0.6)
    r = rail()
    assert r["dailyBonus"]["available"] is False, ("today's gift is claimed", r)
    assert shown("dailyBtn") is False, "claimed gift button hidden"
    assert r["freeSpin"]["slot"] == 0 and abs(y("wheelBtn") - SLOT0) < TOL, \
        ("Free Spin stays put — nothing above it to close up", r, y("wheelBtn"))
    page.screenshot(path=f"{SC}/rail_4_freespin_only.png")

    # ---- 5. Idle rail is stable ----------------------------------------
    # main.js polls the day-rollover every 4s and refreshes the rail through it.
    # A refresh with unchanged targets must NOT restart the tweens, or a button
    # would twitch forever. Wait past one poll and check nothing is moving.
    time.sleep(5.0)
    r = rail()
    assert r["freeSpin"]["moving"] is False, ("an idle rail re-refresh restarts no tween", r)
    assert abs(y("wheelBtn") - SLOT0) < TOL, ("Free Spin still parked in slot 0", y("wheelBtn"))

    # ---- 6. Empty rail, then a return ----------------------------------
    setcompleted(1)                               # both features now unavailable
    r = wait_still()
    assert shown("wheelBtn") is False and shown("dailyBtn") is False, ("empty rail", r)
    setday("2050-06-16")                          # a new day re-arms the gift
    r = wait_still()
    assert r["dailyBonus"]["slot"] == 0 and abs(y("dailyBtn") - SLOT0) < TOL, \
        ("the returning gift lands in the first free slot", r, y("dailyBtn"))
    assert r["dailyBonus"]["alpha"] > 0.99, ("it faded in", r)

    # ---- 7. The arrangement survives a trip through a level -------------
    # show() re-snaps the rail (no slide on lobby entry), so the order must
    # still be right when the player comes back.
    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.5)
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.6)
    setday("2050-06-16")
    time.sleep(0.3)
    assert page.evaluate("window.__game.inLobby()") is True, "back in the lobby"
    assert abs(y("dailyBtn") - SLOT0) < TOL, ("gift still in slot 0 after a level", y("dailyBtn"))
    page.screenshot(path=f"{SC}/rail_7_after_level.png")

    assert not errs, ("no console/page errors", errs)
    print("FEATURE RAIL TEST PASSED")
    b.close()