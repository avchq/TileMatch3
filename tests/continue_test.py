import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# When the tray fills with no match left, the round is "lost" — but instead of a
# dead end we show a strictly MODAL "Out of Moves" overlay that offers a second
# chance via three buttons: Home (lobby) | Replay (restart) | Continue (pay to keep
# playing this board). Continue follows the helper waterfall: spend coins when the
# player can afford the config "continue" price, else watch a rewarded ad (free).
# On Continue, every collected tile returns to its original board cell (in placement
# order, like Undo) and play resumes.
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
        # Play forward past the first-run flow: a brand-new profile is dropped into a
        # GUIDED level 1 that plays two moves of its own (see firstlevel_test.py),
        # which would collide with this test filling the tray by hand.
        page.evaluate("window.__game.completeLevel(5)")
        # Unlocked-but-untaught helpers open a coached first use on the next level
        # entry (boostercoach_test.py), which would park the board this test fills
        # by hand. Take the lesson as read.
        page.evaluate("window.__game.markBoosterCoached('all')")
        time.sleep(0.2)

        def st():      return page.evaluate("window.__game.state()")
        def lst():     return page.evaluate("window.__game.loseState()")

        # Poll until the animated fly-back has landed and play is unlocked again
        # (the tile-return is animated, so this takes ~1s rather than being instant).
        def wait_resumed(timeout=5.0):
            end = time.time() + timeout
            while time.time() < end:
                s = st()
                if s["overlay"] is False and s["locked"] is False:
                    return s
                time.sleep(0.1)
            return st()
        def coins():   return page.evaluate("window.__game.balance('coins')")
        def credit(n): page.evaluate(f"window.__game.credit('coins', {n})")
        def cprice():  return page.evaluate("window.__game.continuePrice()")

        # Fill the bottom tray to capacity WITHOUT completing any triple (collect
        # free tiles, always preferring the least-represented type so no type ever
        # reaches 3) -> a genuine tray-full loss, driven through the game's own
        # _collect/_settle path so _lose() fires for real.
        def fill_tray():
            n = page.evaluate("""() => {
              const s = window.__game.scene;
              let guard = 0;
              while (s.tray.length < 7 && guard++ < 400) {
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
            }""")
            time.sleep(0.45)  # let the last _collect's setTimeout(_settle,190) -> _lose fire
            return n

        # 1) The continue price is sourced from the JSON config, not hard-coded.
        cfg = page.evaluate("() => fetch('assets/config/prices.json').then(r => r.json())")
        print("continue price:", cfg.get("continue"), "scene:", cprice())
        assert cprice() == cfg["continue"], (cprice(), cfg.get("continue"))

        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.7)
        full = st()["boardCount"]     # tiles on a fresh level-1 board
        assert coins() == 0, "a fresh profile starts with no coins"

        # ---- AD TIER (broke player) --------------------------------------------
        filled = fill_tray()
        print("filled tray to:", filled, "lose state:", lst(), "state:", st())
        assert filled == 7, ("the tray reached capacity", filled)
        ls = lst()
        assert ls["loseOverlay"] is True, ("Out of Moves overlay is shown", ls)
        assert st()["locked"] is True, "the scene is locked at the loss"
        assert ls["dimModal"] is True, "the overlay dim is modal (swallows taps)"
        assert ls["continueMode"] == "ad", ("broke player -> Continue on the ad tier", ls)
        assert st()["boardCount"] == full - 7, ("the 7 tiles sit in the tray", st())

        # Capture the tray placement order (oldest-first) so we can verify the tiles
        # fly back in REVERSE order (newest-first, like a run of Undos).
        placement = page.evaluate("window.__game.historyOrder()")
        assert len(placement) == 7, ("history tracks all 7 tray tiles", placement)

        # Continue via the ad (free): overlay closes, every tray tile flies back to
        # the board (animated), coins are unchanged, and play resumes (unlocked +
        # playable) once the sweep lands.
        page.evaluate("window.__game.pressLoseContinue()")
        # Mid-flight: the overlay is already gone and the tray state is restored, but
        # input stays LOCKED while the tiles animate home (the fly-back is animated,
        # not an instant teleport).
        time.sleep(0.2)
        mid = st()
        print("mid-flight:", mid, lst())
        assert mid["overlay"] is False, ("overlay closed immediately", mid)
        assert mid["locked"] is True, ("input locked during the animated fly-back", mid)
        # The tiles are returned in REVERSE placement order (newest-first).
        ret = page.evaluate("window.__game.returnOrder()")
        print("placement:", placement, "return:", ret)
        assert ret == placement[::-1], ("tiles fly back in reverse placement order", ret, placement)
        s = wait_resumed()
        print("after ad-continue:", s, lst())
        assert lst()["loseOverlay"] is False and s["overlay"] is False, ("overlay closed", s)
        assert coins() == 0, "the ad-tier continue costs no coins"
        assert s["tray"] == [], "every tray tile returned to the board"
        assert s["boardCount"] == full, ("the board is restored to full", s, full)
        assert s["locked"] is False, "play resumes"
        assert len(page.evaluate("window.__game.freeTiles()")) > 0, "the board is playable again"

        # ---- COIN TIER (paying player) -----------------------------------------
        price = cprice()
        credit(price + 50)
        assert coins() == price + 50
        fill_tray()
        ls = lst()
        print("paying player lose state:", ls)
        assert ls["loseOverlay"] is True
        assert ls["continueMode"] == "coins", ("affordable -> Continue on the coin tier", ls)
        c0 = coins()
        page.evaluate("window.__game.pressLoseContinue()")
        s = wait_resumed()   # let the animated fly-back land and unlock
        print("after coin-continue:", s, "coins:", coins())
        assert coins() == c0 - price, ("Continue charged exactly the config price", coins(), c0, price)
        assert s["tray"] == [] and s["boardCount"] == full, ("tray returned to the board", s)
        assert s["overlay"] is False and s["locked"] is False, ("play resumed", s)

        # ---- REPLAY button ------------------------------------------------------
        fill_tray()
        assert lst()["loseOverlay"] is True
        page.evaluate("window.__game.pressLoseReplay()")
        time.sleep(0.5)
        # Replay reloads level 1, which opens the "How To Play" popup again (it is
        # tied to the level, not to being new) — dismiss it to keep playing.
        page.evaluate("window.__game.closeTutorial()")
        s = st()
        print("after replay:", s)
        assert s["overlay"] is False, "the overlay closed"
        assert s["inLobby"] is False, "Replay stays in the level"
        assert s["boardCount"] == full and s["tray"] == [], ("the level restarted from scratch", s)

        # ---- HOME button --------------------------------------------------------
        fill_tray()
        assert lst()["loseOverlay"] is True
        page.evaluate("window.__game.pressLoseHome()")
        time.sleep(0.5)
        assert page.evaluate("window.__game.inLobby()") is True, "Home returns to the lobby"
        assert page.evaluate("window.__game.currentLevel()") == 1, "Home keeps the level (no advance)"

        page.screenshot(path=f"{SC}/continue_state.png")
        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("CONTINUE TEST PASSED")
        b.close()
finally:
    srv.terminate()
