import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness

# The COIN SHOP is a progression unlock: the shopping-cart affordance on the
# top-right coin pill only appears once the player has PASSED LEVEL 2
# (SHOP_UNLOCK_LEVEL = 3, read as "available from level 3 onward", the same
# convention BOOSTER_UNLOCKS uses). Until then the pill is a plain coin counter:
# no cart badge, taps ignored, in BOTH the lobby and the level. The balance
# itself is always shown. (The guided first level suppresses the affordance on
# its own too — see firstlevel_test.py.)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errors = harness.launch(p, viewport=(750, 1334))

    OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(OUT, exist_ok=True)
    def snap(tag): page.screenshot(path=f"{OUT}/shopunlock_{tag}.png")

    def boot():
        page.wait_for_function("window.__game && window.__game.shopState", timeout=60000)
        time.sleep(0.6)
        page.evaluate("window.__game.closeTutorial()")  # no-op outside level 1

    def shop():  return page.evaluate("window.__game.shopState()")
    def st():    return page.evaluate("window.__game.state()")
    def open_():  return page.evaluate("window.__game.shopVisible()")

    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    boot()

    # 1) Brand-new player (dropped into the guided level 1): shop locked.
    s = shop()
    print("NEW PLAYER ->", s)
    assert s["unlockLevel"] == 3, ("unlock reads as 'from level 3 onward'", s)
    assert s["unlocked"] is False, s
    assert s["gameEnabled"] is False and s["lobbyEnabled"] is False, s
    assert s["lobbyCart"] is False, ("no cart badge while locked", s)

    # 2) Clearing level 1 is not enough — the gate is passing level TWO.
    page.evaluate("window.__game.completeLevel(1)")
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.5)
    s = shop()
    print("AFTER LEVEL 1 -> inLobby:", st()["inLobby"], s)
    snap("locked_lobby")
    assert st()["inLobby"] is True, "back on the lobby"
    assert s["completed"] == 1 and s["unlocked"] is False, s
    assert s["lobbyEnabled"] is False and s["lobbyCart"] is False, s
    # The coin counter itself stays — only the shop affordance is withheld.
    names = [c["name"] for c in page.evaluate("window.__game.controls()")
             if c["scene"] == "lobby"]
    assert "coinPill" in names, names
    assert page.evaluate("window.__game.coinPillText()")["lobby"] == "0", "balance still shown"
    # A tap on the pill does nothing.
    page.evaluate("window.__game.tapCoinPill('lobby')")
    time.sleep(0.3)
    assert open_() is False, "the locked pill must not open the shop"

    # ...and neither does entering a level: the in-level pill is inert too.
    page.evaluate("async () => { await window.__game.startLevel(2); }")
    time.sleep(0.6)
    s = shop()
    print("IN LEVEL 2 (not yet passed) ->", s)
    assert s["gameEnabled"] is False, s
    page.evaluate("window.__game.tapCoinPill('level')")
    time.sleep(0.3)
    assert open_() is False, "the locked in-level pill must not open the shop"

    # 3) Passing level 2 unlocks it — LIVE, while the level is still on screen.
    page.evaluate("window.__game.completeLevel(2)")
    time.sleep(0.3)
    s = shop()
    print("AFTER LEVEL 2 ->", s)
    assert s["unlocked"] is True and s["gameEnabled"] is True, s
    page.evaluate("window.__game.tapCoinPill('level')")
    time.sleep(0.4)
    assert open_() is True, "the unlocked pill opens the shop"
    snap("unlocked_shop")
    page.evaluate("window.__game.closeShop()")
    time.sleep(0.3)

    # The lobby's pill got the cart back too, without a reload.
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.5)
    s = shop()
    print("LOBBY AFTER UNLOCK ->", s)
    snap("unlocked_lobby")
    assert s["lobbyEnabled"] is True and s["lobbyCart"] is True, s
    page.evaluate("window.__game.tapCoinPill('lobby')")
    time.sleep(0.4)
    assert open_() is True, "the unlocked lobby pill opens the shop"
    page.evaluate("window.__game.closeShop()")
    time.sleep(0.3)

    # 4) It survives a reload (derived from the persisted progress record).
    page.reload()
    boot()
    s = shop()
    print("AFTER RELOAD ->", s)
    assert s["completed"] == 2 and s["unlocked"] is True and s["lobbyEnabled"] is True, s

    print("ERRORS:", len(errors))
    for e in errors[:10]:
        print("  ", e)
    assert not errors, "console errors during the shop unlock checks"
    print("ALL SHOP UNLOCK CHECKS PASSED")
    browser.close()