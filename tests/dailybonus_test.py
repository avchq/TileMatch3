#!/usr/bin/env python3
# End-to-end test for the Daily Bonus (src/dailybonus.js).
#
# Drives the real game headlessly through the window.__game debug API. Covers:
# the pulsing lobby button available from level 1, the three-box pick + reveal,
# commit-on-tap (today's draw is spent the moment a box opens — no re-roll), the
# grant into wallet/boosters, the "double with an ad" path (succeed doubles;
# fail/cancel leave the base claim), persistence of a claim across a reload, and
# the daily rollover re-showing the gift.

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
    page.wait_for_function("window.__game && window.__game.scene && !!window.__game.dailyBonusState", timeout=60000)
    time.sleep(0.5)

    # A fixed test day so the feature's clock is deterministic — a real midnight
    # crossing (or the main-loop refresh) could otherwise flip eligibility mid-test.
    T0 = "2050-06-15"

    def st():        return page.evaluate("window.__game.dailyBonusState()")
    def coins():     return page.evaluate("window.__game.balance('coins')")
    def shuffles():  return page.evaluate("window.__game.boosterCount('shuffle')")
    def open_d():    page.evaluate("window.__game.openDailyBonus()")
    def force(i):    page.evaluate(f"window.__game.forceDailyPrize({i})")
    def admode(m):   page.evaluate(f"window.__game.setDailyAdResult('{m}')")
    def pick(i):     page.evaluate(f"window.__game.pickDailyBox({i})")   # awaits the reveal
    def take():      page.evaluate("window.__game.takeDailyBonus()")     # awaits collect + close
    def double():    page.evaluate("window.__game.doubleDailyBonus()")   # awaits (succeed => take)
    def setday(k):   page.evaluate(f"window.__game.setDailyToday('{k}')")

    # Prize pool indices (assets/config/dailybonus.json): 0 = shuffle x2, 9 = coins 50.
    COINS50 = 9
    SHUFFLE2 = 0

    # ---- 1. Available from level 1 (spec-faithful) ---------------------
    setday(T0)
    s = st()
    assert s["unlocked"] is True, ("unlocked from level 1", s)
    assert s["canClaim"] is True, ("a fresh profile can claim today", s)
    assert s["buttonVisible"] is True, ("the gift button shows while unclaimed", s)
    assert s["lastDay"] == "", ("never claimed yet", s)
    assert coins() == 0, ("no coins yet", coins())

    # ---- 1b. The gift hops to draw the eye -----------------------------
    # At rest the gift arcs up and back down (on a ~5s cadence in real play).
    # We trigger a hop directly rather than waiting out the idle timer — that
    # timer is frame-rate bound, so a wall-clock wait flakes under suite CPU
    # load. Sample the offset in-page via rAF (no round-trip gaps) and confirm
    # the gift lifts off; hops move it UP => negative y.
    page.evaluate("window.__game.forceDailyHop()")
    peak = page.evaluate("""() => new Promise(resolve => {
            const gift = window.__game.lobby.dailyBtn.gift;
            let peak = 0, until = performance.now() + 8000;
            (function tick() {
                peak = Math.min(peak, gift.position.y);
                if (peak < -12 || performance.now() >= until) resolve(peak);
                else requestAnimationFrame(tick);
            })();
        })""")
    assert peak < -5, ("the gift hops up when triggered", peak)

    # ---- 2. Open: three boxes pre-rolled -------------------------------
    force(COINS50)                 # pin the prize behind every box
    open_d()
    time.sleep(0.4)
    s = st()
    assert s["overlayOpen"] is True, ("overlay opened", s)
    assert s["opened"] is False, ("no box tapped yet", s)
    assert len(s["prizes"]) == 3, ("three boxes rolled", s)
    assert all(p == {"type": "coins", "amount": 50} for p in s["prizes"]), ("forced prize behind each box", s)

    # ---- 3. Pick a box: commits the claim, reveals, no re-roll ----------
    pick(1)                        # page.evaluate auto-awaits the reveal promise
    s = st()
    assert s["opened"] is True and s["chosen"] == 1, ("box 1 opened", s)
    assert s["canClaim"] is False, ("opening a box commits today's draw (no re-roll)", s)
    assert s["lastDay"] == T0, ("the claim day-key was stamped on box open", s)
    assert s["buttonVisible"] is False, ("the gift button hides the moment it's claimed", s)
    assert coins() == 0, ("nothing credited until the reward is taken", coins())

    # ---- 4. Claim the base prize --------------------------------------
    take()
    s = st()
    assert s["taken"] is True and s["overlayOpen"] is False, ("popup closes after taking", s)
    assert coins() == 50, ("the 50-coin prize landed in the wallet", coins())

    # ---- 5. Persistence: claimed-today survives a reload ---------------
    page.evaluate("window.__game.flushSave()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene && !!window.__game.dailyBonusState", timeout=60000)
    setday(T0)                     # re-pin — the override doesn't persist across a reload
    time.sleep(0.4)
    s = st()
    assert s["lastDay"] == T0 and s["canClaim"] is False, ("claim persists across a reload", s)
    assert s["buttonVisible"] is False, ("still hidden after reload (already claimed today)", s)
    assert coins() == 50, ("wallet survived the reload", coins())

    # ---- 6. Rollover: a new day re-shows the gift ---------------------
    setday("2050-06-16")
    s = st()
    assert s["canClaim"] is True, ("a new calendar day makes it claimable again", s)
    assert s["buttonVisible"] is True, ("the gift button returns at the daily rollover", s)

    # ---- 7. Double with an ad (succeed) -> x2 -------------------------
    force(COINS50)
    open_d()
    time.sleep(0.35)
    admode("succeed")
    pick(0)
    double()                       # succeed => grants x2 and closes
    s = st()
    assert s["doubled"] is True and s["taken"] is True, ("double succeeded and took the reward", s)
    assert coins() == 150, ("50 base + 100 doubled = 150", coins())

    # ---- 8. Double ad FAILS: base claim still available --------------
    setday("2050-06-17")
    force(COINS50)
    open_d()
    time.sleep(0.35)
    admode("fail")
    pick(2)
    double()                       # fail => toast, nothing granted, not taken
    s = st()
    assert s["taken"] is False and s["overlayOpen"] is True, ("ad failure leaves the popup open, unTaken", s)
    assert coins() == 150, ("ad failure grants nothing extra", coins())
    take()                         # take the base prize instead
    assert coins() == 200, ("base prize still claimable after a failed ad", coins())

    # ---- 9. Double ad CANCEL: base claim still available -------------
    setday("2050-06-18")
    force(COINS50)
    open_d()
    time.sleep(0.35)
    admode("cancel")
    pick(1)
    double()                       # cancel => nothing at all
    s = st()
    assert s["taken"] is False, ("cancelling the ad takes nothing", s)
    assert coins() == 200, ("cancel grants nothing", coins())
    take()
    assert coins() == 250, ("base prize claimable after cancel", coins())

    # ---- 10. Booster prize grants to the inventory ------------------
    start_shuf = shuffles()
    setday("2050-06-19")
    force(SHUFFLE2)                # shuffle x2
    open_d()
    time.sleep(0.35)
    s = st()
    assert s["prizes"][0] == {"type": "shuffle", "amount": 2}, ("booster prize rolled", s)
    pick(0)
    take()
    assert shuffles() == start_shuf + 2, ("a shuffle x2 prize added 2 to the inventory", (start_shuf, shuffles()))

    # ---- 11. The reveal plays as an ordered sequence ------------------
    # 3 boxes -> pick -> the other two disappear -> the picked one opens ->
    # the award comes up in the foreground -> the opened box fades out behind it.
    # Sampled in-page via rAF (no round-trip gaps) so the ORDER is what's asserted,
    # not a wall-clock guess. `pickDailyBox` is fired without awaiting it — the
    # trailing `null` keeps page.evaluate from waiting on its promise.
    setday("2050-06-20")
    force(COINS50)
    open_d()
    time.sleep(0.35)
    pre = page.evaluate("window.__game.dailyBoxState()")
    assert all(b["visible"] and b["alpha"] > 0.9 for b in pre["boxes"]), ("three boxes visible before the pick", pre)
    assert pre["reveal"]["visible"] is False, ("no award on screen yet", pre)

    ev = page.evaluate("""() => new Promise(resolve => {
            const CH = 2;                       // the box we tap
            window.__game.pickDailyBox(CH); null;
            const gone = (b) => !b.visible || b.alpha <= 0.02;
            const ev = {}, t0 = performance.now();
            (function tick() {
                const s = window.__game.dailyBoxState(), now = performance.now() - t0;
                const others = s.boxes.filter((_, i) => i !== CH);
                if (ev.othersGone == null && others.every(gone)) ev.othersGone = now;
                if (ev.lidOpen == null && s.boxes[CH].lidY < -5) ev.lidOpen = now;
                if (ev.awardShown == null && s.reveal.visible && s.reveal.alpha > 0.5) ev.awardShown = now;
                if (ev.chosenGone == null && gone(s.boxes[CH])) ev.chosenGone = now;
                if (ev.chosenGone != null || now > 15000) resolve(ev);
                else requestAnimationFrame(tick);
            })();
        })""")
    for k in ("othersGone", "lidOpen", "awardShown", "chosenGone"):
        assert ev.get(k) is not None, (f"the sequence reached {k}", ev)
    assert ev["othersGone"] <= ev["lidOpen"], ("the two unchosen boxes go BEFORE the picked one opens", ev)
    assert ev["lidOpen"] < ev["awardShown"], ("the box opens BEFORE the award is shown", ev)
    assert ev["awardShown"] <= ev["chosenGone"], ("the award is up BEFORE the opened box fades out", ev)
    assert ev["lidOpen"] < ev["chosenGone"], ("the opened box only leaves after it has opened", ev)

    s = st()
    assert s["opened"] is True and s["chosen"] == 2, ("box 2 is the one that opened", s)
    post = page.evaluate("window.__game.dailyBoxState()")
    assert all(not b["visible"] or b["alpha"] <= 0.02 for b in post["boxes"]), ("no box left on screen", post)
    assert post["reveal"]["visible"] and post["reveal"]["alpha"] > 0.9, ("the award stands alone in the foreground", post)
    take()
    assert coins() == 300, ("the award still credits after the new sequence", coins())

    page.screenshot(path=f"{SC}/dailybonus.png")
    assert not errs, ("no console/page errors", errs)
    print("DAILY BONUS TEST PASSED")
    b.close()