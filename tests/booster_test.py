import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# Boosters (helpers) — Undo and Shuffle — are an inventory on the USER record.
# Each use consumes one; counts show in a bubble and persist through the storage
# adapter. At zero stock the helper doesn't disable — it falls back to the
# acquisition ladder (buy with coins, else watch an ad); it's only disabled/greyed
# when there's no move to make (e.g. Undo with an empty tray). See boosterbuy_test.
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

        def boosters(): return page.evaluate("window.__game.user().boosters")
        def bstate():   return page.evaluate("window.__game.boosterState()")
        def st():       return page.evaluate("window.__game.state()")
        def tap():      page.evaluate("window.__game.solveTap()"); time.sleep(0.3)
        def undo():     page.evaluate("window.__game.scene.undo()"); time.sleep(0.3)
        def shuffle():  page.evaluate("window.__game.reshuffle()"); time.sleep(0.3)

        # 1) A fresh profile carries the starter inventory, and it's serialized.
        inv = boosters()
        print("STARTER inventory:", inv)
        assert inv == {"undo": 3, "shuffle": 3, "wand": 3}, inv

        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.7)

        # 2) Bubbles show the stock; Shuffle is usable, Undo is NOT yet — even
        #    though the player OWNS undo helpers, the tray is empty so there's
        #    nothing to undo. It must be both non-functional AND appear disabled
        #    (greyed-out), while its bubble still shows the owned stock.
        s = bstate()
        print("on level start:", s)
        assert s["shuffleBadge"] == "3" and s["undoBadge"] == "3", s
        assert s["shuffleUsable"] is True and s["shuffleDimmed"] is False, "shuffle usable with stock"
        assert s["undoUsable"] is False, "undo not usable with an empty tray"
        assert s["undoDimmed"] is True, "undo must LOOK disabled when the tray is empty (no moves)"

        # An undo() call in this state must be a no-op even with stock in hand.
        before = st()
        undo()
        assert st() == before, "undo with an empty tray must do nothing (despite owned stock)"
        assert page.evaluate("window.__game.boosterCount('undo')") == 3, "no-op undo must not spend a booster"

        # 3) Collecting a tile makes Undo usable AND it stops looking disabled.
        tap()
        s = bstate()
        assert s["undoUsable"] is True and s["undoDimmed"] is False, \
            "undo becomes usable/undimmed once the tray is non-empty"

        # ...and undoing back to an empty tray disables/greys it again (stock stays).
        undo()
        s = bstate()
        assert st()["tray"] == [], "tray is empty again after the undo"
        assert s["undoUsable"] is False and s["undoDimmed"] is True, \
            "undo re-disables/greys when the tray empties, even with stock left"
        assert page.evaluate("window.__game.boosterCount('undo')") == 2, "that real undo spent one booster"

        # 4) Deplete the remaining Undo stock (2 left): each undo consumes exactly
        #    one. (collect one tile, undo it — history never matches, so it's a
        #    clean single-step each time.)
        for expect_after in (1, 0):
            if st()["tray"] == []:
                tap()
            undo()
            got = page.evaluate("window.__game.boosterCount('undo')")
            print("  after undo -> undo stock:", got, "badge:", bstate()["undoBadge"])
            assert got == expect_after, f"undo stock should be {expect_after}, got {got}"
            assert bstate()["undoBadge"] == str(expect_after), "badge tracks the stock"

        # 5) At zero stock WITH a move available (a filled tray) but no coins, Undo
        #    doesn't disable — it enters the "watch an ad" tier: still usable, and a
        #    tap grants a free use via the (stubbed) rewarded ad and spends it, so the
        #    undo actually runs while net stock stays 0 (and no coins are spent).
        tap()  # make history non-empty
        assert page.evaluate("window.__game.balance('coins')") == 0, "fresh profile has no coins"
        s = bstate()
        assert s["undoUsable"] is True and s["undoDimmed"] is False, "undo usable via the ad tier at 0 stock"
        assert s["undoMode"] == "ad", ("no stock + no coins -> ad tier", s)
        undo()
        assert st()["tray"] == [], "the ad-funded undo actually ran (tile returned to board)"
        assert page.evaluate("window.__game.boosterCount('undo')") == 0, "ad grant+use nets 0 stock"
        assert page.evaluate("window.__game.balance('coins')") == 0, "watching an ad costs no coins"

        # 6) Deplete Shuffle the same way (free while stock lasts).
        for expect_after in (2, 1, 0):
            shuffle()
            got = page.evaluate("window.__game.boosterCount('shuffle')")
            print("  after shuffle -> shuffle stock:", got, "badge:", bstate()["shuffleBadge"])
            assert got == expect_after, f"shuffle stock should be {expect_after}, got {got}"
        # At 0 stock (board up, no coins) Shuffle also falls back to the ad tier:
        # still usable, and a tap watches an ad for a free reshuffle (net stock 0).
        s = bstate()
        assert s["shuffleUsable"] is True and s["shuffleMode"] == "ad", ("shuffle ad tier at 0 stock", s)
        c_before = page.evaluate("window.__game.balance('coins')")
        shuffle()  # watches an ad -> reshuffles
        assert page.evaluate("window.__game.boosterCount('shuffle')") == 0, "ad grant+use nets 0 stock"
        assert page.evaluate("window.__game.balance('coins')") == c_before, "watching an ad costs no coins"

        # 7) The depleted inventory persists across a reload (it's on the record).
        page.evaluate("window.__game.flushSave()")
        time.sleep(0.2)
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        inv = boosters()
        print("AFTER reload inventory:", inv)
        assert inv["undo"] == 0 and inv["shuffle"] == 0, inv

        # 8) A grant re-enables the helper and updates the bubble live.
        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.6)
        page.evaluate("window.__game.grantBooster('shuffle', 2)")
        time.sleep(0.1)
        s = bstate()
        print("after grant:", s)
        assert s["shuffleBadge"] == "2" and s["shuffleUsable"] is True, s

        page.screenshot(path=f"{SC}/booster_state.png")
        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("BOOSTER TEST PASSED")
        b.close()
finally:
    srv.terminate()
