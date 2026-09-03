import subprocess, time, sys, os
from collections import Counter
from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()
with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
        "--autoplay-policy=no-user-gesture-required"])
    page = browser.new_page(viewport={"width": 780, "height": 1334})
    harness.patient(page)
    reqs = Counter()
    errors = []
    page.on("request", lambda r: reqs.update([r.url.split(BASE.split("//")[1] + "/")[-1]]))
    page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

    page.goto(f"{BASE}/index.html")
    page.evaluate("localStorage.removeItem('tm3.level')")
    page.reload()
    page.wait_for_function("window.__game && window.__game.loadedGroups().length >= 4", timeout=60000)
    time.sleep(0.5)

    print("loaded groups on boot:", page.evaluate("window.__game.loadedGroups()"))

    # Register a hypothetical FUTURE level 4 in the live manifest, reusing
    # existing files as stand-in assets (level4.json / a background).
    page.evaluate("""() => {
          window.__game.manifest.level4 = {
            backgrounds: { 4: 'assets/bg/bg2.png' },
            levels: { 4: 'assets/levels/level3.json' },
          };
        }""")

    # It must NOT have been fetched yet (not part of preload).
    assert page.evaluate("window.__game.assets.hasLevel(4)") is True
    assert page.evaluate("window.__game.assets.levelData(4)") in (None, )  # undefined -> None
    print("level4 registered, not yet loaded ->", "level4" not in page.evaluate("window.__game.loadedGroups()"))

    # Trigger it on demand via ensureLevel (the progress-gated path).
    reqs.clear()
    page.evaluate("() => window.__game.assets.ensureLevel(4)")
    page.wait_for_function("window.__game.loadedGroups().includes('level4')", timeout=30000)
    time.sleep(0.3)
    fetched = {u: c for u, c in reqs.items() if u.startswith("assets/")}
    print("fetched on lazy ensureLevel(4):", fetched)
    assert reqs.get("assets/levels/level3.json", 0) >= 1, "level4 json should fetch on demand"
    assert page.evaluate("window.__game.assets.levelData(4)") is not None

    # Second ensure -> cached, no new fetch.
    reqs.clear()
    page.evaluate("() => window.__game.assets.ensureLevel(4)")
    time.sleep(0.3)
    again = {u: c for u, c in reqs.items() if u.startswith("assets/")}
    print("fetched on 2nd ensureLevel(4):", again or "NONE")
    assert not again, f"cached level should not refetch: {again}"

    # ================================================================
    #  The lobby's background prefetch
    # ================================================================
    # The lobby wears the art of the level it OFFERS, so that level's assets have
    # to be in memory or it falls back to level 1's background. Two paths cover
    # it: boot adds the group for the level the player is ON to the preload set,
    # and every later lobby fetches its own art behind itself and repaints.
    page.evaluate("() => { window.__game.setLevel(7); window.__game.flushSave(); }")
    page.reload()
    page.wait_for_function("window.__game && window.__game.inLobby()", timeout=60000)
    time.sleep(0.3)
    boot = page.evaluate("window.__game.bootGroups()")
    groups = page.evaluate("window.__game.loadedGroups()")
    bg = page.evaluate("window.__game.lobbyBackground()")
    print("booted at level 7 -> preloaded:", boot, "| loaded:", groups, "| background:", bg)
    # It must be part of the BOOT preload, not merely loaded by the time we look:
    # that is the difference between a lobby that is right on its first frame and
    # one that puts up the fallback and swaps art under the player.
    assert "level7" in boot, \
        ("the level the player is ON belongs to the boot preload", boot)
    assert bg == {"level": 7, "shown": 7, "loaded": True}, \
        ("the lobby must show level 7's own art, not the level-1 fallback", bg)
    # …and ONLY that one on top of the `preload: true` levels — boot must not drag
    # in the whole campaign.
    assert "level5" not in boot and "level6" not in boot and "level8" not in boot, \
        ("boot preloads the current level, not the ones around it", boot)
    assert "level5" not in groups and "level6" not in groups, \
        ("the levels in between stay lazy", groups)
    assert "level8" not in groups, ("nor does anything prefetch ahead", groups)

    # PREFETCH AHEAD — the reason the lobby after a win does not flash. Winning
    # level 7 lands on the lobby for level 8 immediately, so level 8's art has to
    # be in memory BEFORE that happens: playing a level fetches the next one's
    # group in the background, and a board lasts far longer than an image.
    page.evaluate("async () => { await window.__game.startLevel(7); }")
    page.wait_for_function("window.__game.loadedGroups().includes('level8')", timeout=30000)
    print("playing level 7 prefetched:", "level8")
    page.evaluate("window.__game.exitLevel()")
    page.wait_for_function("window.__game.inLobby()", timeout=30000)
    time.sleep(0.3)

    # THE FALLBACK IS NOT bg1. If a lobby is ever asked for a level whose art has
    # not landed (the prefetch above is a race it normally wins, not a guarantee),
    # it must HOLD THE PICTURE ALREADY UP rather than flashing level 1's
    # background and replacing it — the visible switch is the whole complaint.
    # Level 10 was never played or offered, so its group is still unfetched. Both
    # readings come from one evaluate, so no round-trip can spend the window.
    assert "level10" not in page.evaluate("window.__game.loadedGroups()"), "level 10 is cold"
    bg = page.evaluate("() => { window.__game.showLobby(10); return window.__game.lobbyBackground(); }")
    print("lobby moved to level 10, before its art lands:", bg)
    assert bg["level"] == 10 and bg["loaded"] is False, \
        ("the lobby is not held back waiting for its background", bg)
    assert bg["shown"] == 7, \
        ("it must keep the art already on screen, NOT fall back to level 1", bg)
    page.wait_for_function(
        "() => { const b = window.__game.lobbyBackground(); return b.level === 10 && b.shown === 10; }",
        timeout=30000)
    bg = page.evaluate("window.__game.lobbyBackground()")
    print("…and repainted once it did:", bg)
    assert bg["loaded"] is True, bg
    assert "level10" in page.evaluate("window.__game.loadedGroups()"), \
        "the lobby fetched level 10's group itself, without a loading screen"

    print("ERRORS:", len(errors))
    print("LAZY-LOAD CHECKS PASSED" if not errors else "COMPLETED WITH ERRORS")
    browser.close()