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
# Each use consumes one; at zero the button is disabled and the action is a
# no-op. Counts show in a bubble and persist through the storage adapter.
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

        # 5) At zero, Undo is disabled/greyed and a call is a no-op (even with a
        #    full tray — now it's the empty INVENTORY, not an empty tray, gating it).
        tap()  # make history non-empty
        s = bstate()
        assert s["undoUsable"] is False and s["undoDimmed"] is True, "undo disabled/greyed at 0 stock"
        before = st()
        undo()
        after = st()
        assert after["boardCount"] == before["boardCount"] and after["tray"] == before["tray"], \
            "undo at 0 stock must do nothing"
        assert page.evaluate("window.__game.boosterCount('undo')") == 0, "stock stays at 0"

        # 6) Deplete Shuffle the same way; the board must be unchanged by the 4th.
        for expect_after in (2, 1, 0):
            shuffle()
            got = page.evaluate("window.__game.boosterCount('shuffle')")
            print("  after shuffle -> shuffle stock:", got, "badge:", bstate()["shuffleBadge"])
            assert got == expect_after, f"shuffle stock should be {expect_after}, got {got}"
        assert bstate()["shuffleUsable"] is False, "shuffle disabled at 0 stock"

        def board_faces():
            return page.evaluate(
                "window.__game.scene.tiles.filter(t=>!t.matched&&!t.inTray).map(t=>t.type)")
        faces_before = board_faces()
        shuffle()  # no stock -> must be a no-op
        assert board_faces() == faces_before, "shuffle at 0 stock must not touch the board"
        assert page.evaluate("window.__game.boosterCount('shuffle')") == 0, "stock stays at 0"

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
