import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# In-level booster acquisition ladder (own -> buy with coins -> watch an ad): when a
# helper's stock hits 0, tapping it BUYS one with gold coins (price from the JSON
# config assets/config/prices.json) and uses it in the same tap. Buying only kicks in
# at 0 (owned stock is spent first, for free). When the player also can't afford one,
# the helper drops to the "watch an ad" tier — still usable, granting a free use.
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 780, "height": 1334})
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        time.sleep(0.5)

        def coins():    return page.evaluate("window.__game.balance('coins')")
        def credit(n):  page.evaluate(f"window.__game.credit('coins', {n})")
        def debit(n):   page.evaluate(f"window.__game.debit('coins', {n})")
        def count(k):   return page.evaluate(f"window.__game.boosterCount('{k}')")
        def price(k):   return page.evaluate(f"window.__game.boosterPrice('{k}')")
        def bstate():   return page.evaluate("window.__game.boosterState()")
        def st():       return page.evaluate("window.__game.state()")
        def tap():      page.evaluate("window.__game.solveTap()"); time.sleep(0.3)
        def undo():     page.evaluate("window.__game.scene.undo()"); time.sleep(0.3)
        def shuffle():  page.evaluate("window.__game.reshuffle()"); time.sleep(0.3)

        # Helpers are locked in the first levels; play forward to level 5 so all
        # three are unlocked (each paying out its one-time stock), then top Shuffle
        # up to the 3 this test's depletion walk expects. See boosterunlock_test.
        page.evaluate("window.__game.completeLevel(5)")
        time.sleep(0.2)
        grant = page.evaluate("window.__game.config()")["boosters"]["unlocks"]["shuffle"]["grant"]
        page.evaluate(f"window.__game.grantBooster('shuffle', {3 - grant})")
        time.sleep(0.1)
        # Unlocked but untaught helpers open a coached first use on the next level
        # entry (boostercoach_test.py), which parks the board. Not this test's
        # subject — take the lesson as read.
        page.evaluate("window.__game.markBoosterCoached('all')")

        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.7)

        # 1) Prices are sourced from the JSON config, not hard-coded.
        cfg = page.evaluate("() => fetch('assets/config/prices.json').then(r => r.json())")
        print("config prices:", cfg["boosters"])
        for k in ("undo", "shuffle", "wand"):
            assert price(k) == cfg["boosters"][k], (k, price(k), cfg["boosters"][k])

        # 2) While stock remains, using a helper costs NO coins (buying is a
        #    zero-stock-only fallback). Spend one shuffle: stock drops, wallet holds.
        credit(1000)
        assert count("shuffle") == 3, count("shuffle")
        c0 = coins()
        shuffle()
        assert count("shuffle") == 2, "used owned stock"
        assert coins() == c0, "using owned stock must not spend coins"

        # 3) Deplete the rest of the shuffle stock (still free), reaching 0.
        shuffle(); shuffle()
        assert count("shuffle") == 0, count("shuffle")
        sp = price("shuffle")

        # 4) At 0 stock WITH enough coins, the helper is on the "buy" tier: the button
        #    is live (not greyed) and its badge shows the coin buy-price. Tapping it
        #    buys one and uses it in the same press: coins drop by exactly the price,
        #    stock nets back to 0.
        s = bstate()
        print("empty + affordable:", s["shuffleUsable"], s["shuffleDimmed"], s["shuffleBadge"], s["shuffleMode"])
        assert s["shuffleMode"] == "buy", ("affordable empty helper -> buy tier", s)
        assert s["shuffleUsable"] is True, "empty helper is buyable when affordable"
        assert s["shuffleDimmed"] is False, "affordable buy is not greyed"
        assert s["shuffleBadge"] == str(sp), "badge shows the coin price when empty"
        c1 = coins()
        shuffle()
        assert coins() == c1 - sp, ("buying one spends exactly the config price", coins(), c1, sp)
        assert count("shuffle") == 0, "bought one and used it in the same tap (net 0 stock)"

        # 5) Drain the wallet to just under one purchase: the empty helper drops from
        #    the "buy" tier to the "ad" tier. It stays USABLE (never disabled while a
        #    move exists) and a tap watches a (stubbed) rewarded ad for a free use —
        #    spending NO coins, netting 0 stock.
        debit(coins() - (sp - 1))
        assert coins() == sp - 1, coins()
        s = bstate()
        assert s["shuffleMode"] == "ad", ("can't afford -> ad tier", s)
        assert s["shuffleUsable"] is True and s["shuffleDimmed"] is False, \
            ("ad tier is still usable (not greyed)", s)
        before = coins()
        shuffle()  # watches an ad
        assert coins() == before, "the ad tier costs no coins"
        assert count("shuffle") == 0, "ad grant+use nets 0 stock"

        # 6) Undo shares the buy-and-use path, but is gated on having a move (a
        #    non-empty tray). Deplete undo to 0, then a coin-funded undo buys+uses.
        credit(1000)
        for _ in range(3):
            if st()["tray"] == []:
                tap()
            undo()
        assert count("undo") == 0, count("undo")
        up = price("undo")
        tap()  # history non-empty -> undo has something to do
        s = bstate()
        assert s["undoMode"] == "buy" and s["undoUsable"] is True and s["undoBadge"] == str(up), \
            ("empty undo on the buy tier", s)
        c2 = coins()
        undo()
        assert coins() == c2 - up, "undo bought one for coins"
        assert count("undo") == 0, "undo bought and used in one tap (net 0 stock)"
        assert st()["tray"] == [], "the purchased undo actually ran (tile returned to board)"

        page.screenshot(path=f"{SC}/boosterbuy_state.png")
        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("BOOSTERBUY TEST PASSED")
        b.close()
finally:
    srv.terminate()
