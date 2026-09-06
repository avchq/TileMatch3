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
    page.wait_for_function("window.__game && window.__game.settings", timeout=60000)
    # Boot into the LOBBY: a profile that never cleared level 1 is routed
    # straight into the level by the first-run flow (see newuser_test.py), so
    # record a level-1 clear before testing the lobby ⇄ level navigation.
    page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
    page.reload()
    page.wait_for_function("window.__game && window.__game.settings", timeout=60000)
    time.sleep(0.6)

    box = page.eval_on_selector("canvas", "c => { const r=c.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
    def click_design(dx, dy):
        page.mouse.click(box["x"] + box["w"] * (dx / 750), box["y"] + box["h"] * (dy / 1334))
        time.sleep(0.35)
    def snap(tag):
        page.screenshot(path=f"{SC}/back_{tag}.png")

    # design-space coords of the top-left HUD buttons
    COG = (60, 84)
    BACK = (148, 84)

    # -- Enter a level ----------------------------------------------------
    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.7)
    assert page.evaluate("window.__game.state()")["inLobby"] is False, "should be in the level"
    snap("in_level")

    # -- The moved cog (top-left) still opens settings from the level -----
    click_design(*COG)
    assert page.evaluate("window.__game.settingsVisible()") is True, "cog at (60,84) must open settings in-level"
    # close settings again (settings Back button, centre-bottom). The panel
    # grew downward to make room for the Language row, so Back sits lower
    # than it used to — see settings_test.py / languagepicker_test.py.
    click_design(375, 933)
    assert page.evaluate("window.__game.settingsVisible()") is False, "settings should close"
    assert page.evaluate("window.__game.state()")["inLobby"] is False, "still in level after closing settings"

    # -- Change the user record mid-level (must survive the Back press) ---
    coins_before = page.evaluate("window.__game.balance('coins')")
    page.evaluate("window.__game.credit('coins', 250)")
    coins_mid = page.evaluate("window.__game.balance('coins')")
    assert coins_mid == coins_before + 250, f"credit failed: {coins_before} -> {coins_mid}"
    level_before_back = page.evaluate("window.__game.currentLevel()")

    # -- Press the in-level Back button -----------------------------------
    click_design(*BACK)
    assert page.evaluate("window.__game.inLobby()") is True, "Back must return to the lobby"
    assert page.evaluate("window.__game.settingsVisible()") is False, "settings not involved"
    # Back must NOT advance the level (level was not completed)
    assert page.evaluate("window.__game.currentLevel()") == level_before_back, \
        "Back must not change the current level"
    # user-record change persists after Back
    assert page.evaluate("window.__game.balance('coins')") == coins_mid, \
        "coins credited mid-level must persist after Back"
    snap("after_back_lobby")

    # -- And persists across a save + reload ------------------------------
    page.evaluate("window.__game.flushSave()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.settings", timeout=60000)
    time.sleep(0.5)
    reloaded = page.evaluate("window.__game.balance('coins')")
    assert reloaded == coins_mid, f"coins must persist across reload: {reloaded} != {coins_mid}"
    assert page.evaluate("window.__game.inLobby()") is True, "reload lands on the lobby"

    # -- loadLevel must leave no stale effects on fxLayer ------------------
    # fxLayer is where the Auto Complete sweep stages its tiles
    # (game.js autoComplete) and where the Super Wand burst draws
    # (_spawnBurst). loadLevel clears overlayLayer, fxTopLayer and boardLayer;
    # if it does not also clear fxLayer, anything the previous board left in
    # flight survives into the new one. The reachable path is currently closed
    # (PRAC-01 disabled Back for the duration of a sweep), so this stages a
    # decoy directly rather than racing an animation it cannot interrupt —
    # the invariant is "a new board starts with an empty fx layer", however
    # the leftover got there.
    page.evaluate("""() => {
      const g = new PIXI.Graphics();
      g.beginFill(0xff0000).drawRect(0, 0, 10, 10).endFill();
      window.__game.scene.fxLayer.addChild(g);
    }""")
    staged = page.evaluate("window.__game.scene.fxLayer.children.length")
    assert staged >= 1, ("the decoy did not land on fxLayer", staged)
    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.7)
    left = page.evaluate("window.__game.scene.fxLayer.children.length")
    assert left == 0, (
        "loadLevel must clear fxLayer like it clears overlayLayer and fxTopLayer — "
        "a leftover effect from the previous board is still on screen", left)
    print("fxLayer across loadLevel:", staged, "->", left)

    print("coins:", coins_before, "->", coins_mid, "-> after reload", reloaded)
    print("PAGE ERRORS:", len(errs), errs[:5])
    assert not errs, f"console/page errors: {errs[:5]}"
    print("BACK BUTTON TEST PASSED")
    b.close()