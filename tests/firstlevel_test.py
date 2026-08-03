import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

# The GUIDED first level — what a brand-new player actually sees after the
# first-run flow drops them into level 1 (routing itself is newuser_test.py):
#   * the top bar is stripped to the coin counter alone — no settings cog, no
#     shop affordance on the pill, and NO Back button, so the level can't be left
#     before it's played;
#   * once the board is built the game plays the first two moves itself (two of
#     three identical free tiles fly into the tray) and puts an animated pointing
#     hand on the third, so the player's very first tap completes a match;
#   * the hand goes away the moment any tile is collected, and on leaving;
#   * the three helpers are visible but LOCKED — lock badge, dimmed, and a tap
#     refuses with a floating "Unlocks at Level N" hint instead of acting.
# The full HUD comes back for a returning player. Unlock timing: boosterunlock_test.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 750, "height": 1334})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
        os.makedirs(OUT, exist_ok=True)
        def snap(tag):
            page.screenshot(path=f"{OUT}/firstlevel_{tag}.png")

        def boot():
            page.wait_for_function("window.__game && window.__game.lobby", timeout=15000)
            time.sleep(0.6)
            # Level 1 opens the modal "How To Play" popup first (howtoplay_test owns
            # it, including the handoff to the guided opening below); dismiss it so
            # the guided flow can run. A no-op in the lobby.
            page.evaluate("window.__game.closeTutorial()")

        def st():   return page.evaluate("window.__game.state()")
        def hud():  return page.evaluate("window.__game.hudState()")
        def hand(): return page.evaluate("window.__game.handState()")
        def bst():  return page.evaluate("window.__game.boosterState()")

        # A fresh browser profile has no saved record -> brand-new player -> the
        # first-run flow boots straight into the guided level 1.
        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        boot()

        # 1) Stripped-down chrome.
        s, h = st(), hud()
        print("GUIDED L1 -> state:", s, "hud:", h,
              "firstRun:", page.evaluate("window.__game.firstRun()"))
        assert s["inLobby"] is False and s["level"] == 1, s
        assert page.evaluate("window.__game.firstRun()") is True, "level 1 must be the guided one"
        assert h["coinPill"] is True, "the coin counter stays"
        assert h["cog"] is False, "the settings button is hidden on the first level"
        assert h["back"] is False, "the back button is removed on the first level"
        assert h["shopEnabled"] is False, "the coin pill must not open the shop here"
        # The hidden controls really are gone from the level's reported interface.
        names = [c["name"] for c in page.evaluate("window.__game.controls()")
                 if c["scene"] == "level"]
        print("level controls:", names)
        assert "cog" not in names and "back" not in names, names
        assert "coinPill" in names, names

        # 2) The guided opening: two moves played for the player, hand on the third.
        page.wait_for_function("window.__game.handState().visible === true", timeout=8000)
        s, hd = st(), hand()
        print("AFTER GUIDE -> tray:", s["tray"], "hand:", hd, "locked:", s["locked"])
        snap("guided_opening")
        assert len(s["tray"]) == 2, ("exactly two moves are played for you", s["tray"])
        assert s["tray"][0] == s["tray"][1], ("both are the same tile type", s["tray"])
        assert s["locked"] is False, "input is handed back once the demo moves land"
        free = page.evaluate("window.__game.freeTiles()")
        target = next((t for t in free if t["id"] == hd["tileId"]), None)
        assert target is not None, ("the hand points at a tile that is free to tap", hd, free)
        assert target["type"] == s["tray"][0], \
            ("...and it completes the waiting pair", target, s["tray"])

        # 3) One tap on that tile completes the match: the tray clears, three tiles
        #    leave the board, and the hand has done its job.
        board_before = s["boardCount"]
        page.evaluate(f"window.__game.scene._onTapTile(window.__game.scene.tiles[{hd['tileId']}])")
        time.sleep(0.8)
        s = st()
        print("AFTER FIRST TAP -> tray:", s["tray"], "boardCount:", s["boardCount"],
              "hand:", hand())
        snap("after_first_match")
        assert s["tray"] == [], ("the first tap clears the triple", s["tray"])
        assert board_before - s["boardCount"] == 1, \
            ("only the tapped tile left the board", board_before, s["boardCount"])
        assert hand()["visible"] is False, "the hand disappears once a tile is collected"

        # 4) The helpers are shown but locked, and refuse to act.
        b = bst()
        print("HELPERS ON L1:", b)
        assert b["undoLocked"] and b["shuffleLocked"] and b["wandLocked"], b
        assert b["undoDimmed"] and b["shuffleDimmed"] and b["wandDimmed"], \
            ("a locked helper looks disabled", b)
        vis = page.evaluate("() => { const s = window.__game.scene; return ["
                            "s.undoBtn.visible, s.shuffleBtn.visible, s.wandBtn.visible]; }")
        assert vis == [True, True, True], ("locked helper icons stay visible", vis)

        # Collect a tile so Undo would have something to do, then press it: nothing
        # happens and the hint says when it unlocks.
        page.evaluate("window.__game.solveTap()")
        time.sleep(0.4)
        hist_before = page.evaluate("window.__game.historyOrder()")
        assert hist_before, "a tile is waiting in the tray for undo to act on"
        page.evaluate("window.__game.pressBooster('undo')")
        time.sleep(0.3)
        hint = page.evaluate("window.__game.boosterHint()")
        print("LOCKED UNDO PRESS -> hint:", repr(hint),
              "history:", page.evaluate("window.__game.historyOrder()"))
        snap("locked_helper_hint")
        assert page.evaluate("window.__game.historyOrder()") == hist_before, \
            "a locked helper must not act"
        # The hint names the helper's own unlock level, whatever the schedule says
        # (boosterunlock_test.py owns the exact numbers).
        undo_at = page.evaluate("window.__game.boosterUnlockLevel('undo')")
        assert hint == f"Unlocks at Level {undo_at}", f"expected the unlock hint, got {hint!r}"
        # Reshuffle and Wand are refused the same way (they act on the board, so a
        # successful press would be visible in the board/tray state).
        for kind in ("shuffle", "wand"):
            level = page.evaluate(f"window.__game.boosterUnlockLevel('{kind}')")
            before = st()
            page.evaluate(f"window.__game.pressBooster('{kind}')")
            time.sleep(0.4)
            assert st() == before, (f"locked {kind} must not act", st(), before)
            assert page.evaluate("window.__game.boosterHint()") == f"Unlocks at Level {level}", \
                (kind, page.evaluate("window.__game.boosterHint()"))

        # 5) Re-entering level 1 while still new keeps the guided treatment...
        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.6)
        h = hud()
        print("RE-ENTERED L1 (still new) -> hud:", h)
        assert page.evaluate("window.__game.firstRun()") is True, \
            "level 1 stays guided until it is completed"
        assert h["cog"] is False and h["back"] is False, h

        # ...and a returning player gets the ordinary level back: full top bar, no
        # demo moves, no hand.
        page.evaluate("window.__game.completeLevel(1)")
        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(1.8)
        s, h = st(), hud()
        print("RETURNING PLAYER L1 -> hud:", h, "tray:", s["tray"], "hand:", hand())
        snap("returning_player")
        assert page.evaluate("window.__game.firstRun()") is False, "no longer the guided level"
        assert h["cog"] is True and h["back"] is True and h["shopEnabled"] is True, h
        assert s["tray"] == [], ("no moves are played for a returning player", s["tray"])
        assert hand()["visible"] is False, "no guidance hand for a returning player"

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        assert not errors, "console errors during the guided first level"
        print("ALL FIRST-LEVEL CHECKS PASSED")
        browser.close()
finally:
    srv.terminate()
