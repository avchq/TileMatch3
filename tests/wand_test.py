import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# The Wand ("hint") helper guarantees one instant match: it flies the tiles
# needed to complete a triple from the board into the tray, where they clear —
# relieving tray pressure. It's a consumable like Undo/Shuffle: one charge per
# use, disabled/greyed at zero, and it can't be double-spent while animating.
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

        def wcount():  return page.evaluate("window.__game.boosterCount('wand')")
        def bstate():  return page.evaluate("window.__game.boosterState()")
        def st():      return page.evaluate("window.__game.state()")
        def tap():     page.evaluate("window.__game.solveTap()"); time.sleep(0.3)
        def wand():    page.evaluate("window.__game.wand()"); time.sleep(0.6)

        # 1) A fresh profile carries a Wand in the starter inventory.
        assert wcount() == 3, wcount()

        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.7)

        # 2) On level start the Wand is usable and NOT greyed even though the tray
        #    is empty — unlike Undo, it works off the board (its badge shows stock).
        s = bstate()
        print("on level start:", s)
        assert s["wandBadge"] == "3", s
        assert s["wandUsable"] is True and s["wandDimmed"] is False, "wand usable with stock + a non-empty board"

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

        # 6) At zero charges the Wand is disabled/greyed and a tap is a no-op —
        #    even with a completable pair sitting in the tray.
        assert wcount() == 0, wcount()
        s = bstate()
        assert s["wandUsable"] is False and s["wandDimmed"] is True and s["wandBadge"] == "0", \
            ("wand disabled/greyed at 0 stock", s)
        tap(); tap()                       # a pair the Wand *could* finish if it had a charge
        before = st()
        wand()
        assert st() == before, "wand at 0 charges must do nothing"
        assert wcount() == 0, "a no-op wand must not go negative"

        # 7) The spent inventory persists across a reload (it's on the record).
        page.evaluate("window.__game.flushSave()")
        time.sleep(0.2)
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        assert wcount() == 0, "wand stock persisted at 0"

        # 8) A grant re-enables the Wand and updates its bubble live.
        page.evaluate("window.__game.startLevel(1)")
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
finally:
    srv.terminate()
