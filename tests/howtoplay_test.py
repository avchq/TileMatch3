import json, subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

# The "How To Play" popup — the modal tutorial that opens at the very start of
# LEVEL 1, before the player is handed any control:
#   * it opens over the dealt board and locks the level behind it (taps do
#     nothing, and the guided opening's demo moves do NOT start yet);
#   * it carries the title "How To Play" and the single rule
#     "Collect 3 identical tiles to remove them" over a looping demonstration —
#     a mini 3x3 board whose tiles the hand collects into a mini tray, three of a
#     kind at a time, clearing them exactly as the real game does;
#   * its pieces fade in one after another; only once that sequence has finished
#     does a tap ANYWHERE close it. OK closes it whenever it is up, and there is
#     no skip button anywhere;
#   * closing hands straight over to the guided opening (two demo moves + the
#     pointing hand — firstlevel_test.py owns that behaviour) and writes a
#     "tutorial done" marker into localStorage that nothing ever reads back;
#   * it is tied to being on level 1, NOT to being a new player: a returning
#     player re-entering level 1 sees it again, and no other level shows it.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errors = harness.launch(p, viewport=(750, 1334))

    OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(OUT, exist_ok=True)
    def snap(tag):
        page.screenshot(path=f"{OUT}/howtoplay_{tag}.png")

    def boot():
        page.wait_for_function("window.__game && window.__game.lobby", timeout=45000)
        time.sleep(0.4)

    def tut():  return page.evaluate("window.__game.tutorialState()")
    def st():   return page.evaluate("window.__game.state()")
    def hand(): return page.evaluate("window.__game.handState()")

    # A fresh browser profile is a brand-new player, so boot drops straight
    # into level 1 — where the tutorial is waiting.
    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    boot()

    # 1) It is up, it says the right thing, and the level is locked behind it.
    t, s = tut(), st()
    print("ON LEVEL 1 ->", t)
    snap("opened")
    assert s["level"] == 1 and s["inLobby"] is False, s
    assert t["visible"] is True, "the How To Play popup must open on level 1"
    assert t["title"] == "How To Play", t["title"]
    assert t["line"] == "Collect 3 identical tiles to remove them", t["line"]
    assert s["locked"] is True, "the level is locked while the popup is up"
    assert page.evaluate("window.__game.tutorialMarker()") is None, \
        "the marker is only written on close"

    # Nothing on the board reacts, and the guided opening has not begun.
    board_before = s["boardCount"]
    page.evaluate("window.__game.solveTap()")
    time.sleep(0.3)
    s = st()
    assert s["boardCount"] == board_before and s["tray"] == [], \
        ("no tile can be collected behind the popup", s)
    assert hand()["visible"] is False, "the guidance hand waits for the popup"

    # 2) Before the fade-in sequence has finished, a tap anywhere does nothing.
    #
    #    Re-enter level 1 first, so the ~1.6s sequence starts FRESH. The checks
    #    above cost a screenshot and several round-trips, and on a loaded
    #    machine those alone can outlast the sequence — the window this section
    #    has to observe would already have closed before we looked. Restarting
    #    resets that clock; taking the reading and the tap in ONE evaluate means
    #    no round-trip can lose it either.
    page.evaluate("async () => { await window.__game.startLevel(1); }")
    mid = page.evaluate("""() => {
        const before = window.__game.tutorialState().introDone;
        window.__game.tapTutorialDim();
        return { before: before, visible: window.__game.tutorialState().visible };
    }""")
    assert mid["before"] is False, ("checked too late — the intro already finished", mid)
    assert mid["visible"] is True, "a tap must not close it mid fade-in"

    # 3) Once the sequence finishes: every row is in, OK is showing, and OK is
    #    the ONLY button — there is no skip anywhere in this sequence.
    page.wait_for_function("window.__game.tutorialState().introDone === true", timeout=24000)
    t = tut()
    print("INTRO DONE ->", t)
    assert t["rowsShown"] == 3, ("all three rows fade in", t)
    assert t["okVisible"] is True, t
    assert t["buttons"] == ["OK"], ("OK is the only button — no skip", t["buttons"])

    # 4) The demonstration actually runs: tiles travel into the mini tray and a
    #    triple clears off the mini board.
    max_tray, min_board = 0, 9
    deadline = time.time() + 20
    while time.time() < deadline:
        t = tut()
        if not t["visible"]:
            break
        max_tray = max(max_tray, len(t["demoTray"]))
        min_board = min(min_board, t["demoBoard"])
        if max_tray >= 3 and min_board <= 6:
            break
        time.sleep(0.12)
    print("DEMO -> max tray:", max_tray, "min board:", min_board)
    snap("demo_running")
    assert max_tray >= 3, f"three tiles must reach the demo tray, saw {max_tray}"
    assert min_board <= 6, f"a matched triple must leave the demo board, saw {min_board}"

    # 5) It re-centres on a resize (its dim covers the whole view).
    page.set_viewport_size({"width": 900, "height": 1334})
    time.sleep(0.5)
    t, v = tut(), page.evaluate("window.__game.view()")
    print("AFTER RESIZE -> tutorial:", {k: t[k] for k in ("cx", "cy", "dimW", "dimH")},
          "view:", {k: v[k] for k in ("designW", "designH")})
    assert abs(t["cx"] - v["designW"] / 2) < 2 and abs(t["cy"] - v["designH"] / 2) < 2, \
        ("the popup stays centred on the new view", t, v)
    assert t["dimW"] >= v["designW"] - 1 and t["dimH"] >= v["designH"] - 1, \
        ("the dim covers the whole view", t, v)
    page.set_viewport_size({"width": 750, "height": 1334})
    time.sleep(0.4)

    # 6) OK closes it, writes the marker, and hands over to the guided opening:
    #    the two demo moves play and the pointing hand appears on the third tile.
    page.evaluate("window.__game.pressTutorialOk()")
    time.sleep(0.4)
    assert tut()["visible"] is False, "OK closes the popup"
    assert page.evaluate("window.__game.tutorialMarker()") == "1", \
        "closing writes the tutorial-done marker"
    # ...and the marker lives outside the save record.
    assert "tutorial" not in json.dumps(page.evaluate("window.__game.user()")).lower(), \
        "the marker must not be part of the user profile"

    page.wait_for_function("window.__game.handState().visible === true", timeout=24000)
    s = st()
    print("AFTER OK -> tray:", s["tray"], "locked:", s["locked"], "hand:", hand())
    snap("handoff_to_guide")
    assert len(s["tray"]) == 2 and s["tray"][0] == s["tray"][1], \
        ("the guided opening runs once the popup closes", s["tray"])
    assert s["locked"] is False, "input is back with the player"

    # 7) Tapping anywhere closes it too, once the intro has finished.
    page.evaluate("window.__game.startLevel(1)")
    page.wait_for_function("window.__game.tutorialState().introDone === true", timeout=30000)
    page.evaluate("window.__game.tapTutorialDim()")
    time.sleep(0.4)
    print("AFTER TAP-ANYWHERE ->", tut())
    assert tut()["visible"] is False, "a tap anywhere closes it after the intro"

    # 8) It is tied to level 1: no other level opens it...
    page.evaluate("window.__game.completeLevel(1)")
    page.evaluate("window.__game.startLevel(2)")
    time.sleep(0.8)
    s, t = st(), tut()
    print("LEVEL 2 -> level:", s["level"], "tutorial:", t["visible"], "locked:", s["locked"])
    assert s["level"] == 2 and t["visible"] is False, ("no tutorial outside level 1", s, t)
    assert s["locked"] is False, "level 2 starts unlocked"

    # ...and a RETURNING player re-entering level 1 gets it again: the marker
    # is written but nothing ever reads it back.
    page.evaluate("window.__game.startLevel(1)")
    time.sleep(0.8)
    t = tut()
    assert page.evaluate("window.__game.firstRun()") is False, \
        "level 1 is no longer the guided one for this player"
    print("RETURNING PLAYER L1 ->", t["visible"], "marker:",
          page.evaluate("window.__game.tutorialMarker()"))
    snap("returning_player")
    assert t["visible"] is True, \
        "the popup is tied to level 1, not to being new (the marker is never read)"
    assert st()["locked"] is True, "it locks the level for a returning player too"

    # Leaving the level takes the popup with it (no stale modal on a hidden scene).
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.5)
    print("AFTER EXIT -> inLobby:", page.evaluate("window.__game.inLobby()"),
          "tutorial:", tut()["visible"])
    assert page.evaluate("window.__game.inLobby()") is True
    assert tut()["visible"] is False, "the popup must not survive leaving the level"

    print("ERRORS:", len(errors))
    for e in errors[:10]:
        print("  ", e)
    assert not errors, "console errors during the How To Play flow"
    print("ALL HOW-TO-PLAY CHECKS PASSED")
    browser.close()