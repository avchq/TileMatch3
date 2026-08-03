import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

# Helper (booster) PROGRESSION. Boosters are not available in the first levels:
# a new account is awarded none, and each helper unlocks at its own level —
# Undo from level 2, Wand from 3, Reshuffle from 5 (CONFIG.boosters.unlocks in
# src/config.js) — paying out its one-time stock the moment it unlocks, once
# and only once. "Unlocked at level N" means the player has cleared level N-1.
# The in-level look/behaviour of a locked helper is covered by firstlevel_test.py;
# the acquisition ladder for an UNLOCKED but empty helper by booster_test.py; and
# the guided first use each helper gets when it unlocks by boostercoach_test.py.
# This table mirrors the config — retiming a helper there means editing it here.
# It must stay sorted by level: step 3 clears levels in order.

UNLOCKS = [("undo", 2, 2), ("wand", 3, 2), ("shuffle", 5, 2)]  # kind, level, grant

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
        page = browser.new_page(viewport={"width": 780, "height": 1334})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        def boot():
            page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
            time.sleep(0.5)

        def inv():        return page.evaluate("window.__game.user().boosters")
        def unlocked(k):  return page.evaluate(f"window.__game.boosterUnlocked('{k}')")
        def complete(n):  page.evaluate(f"window.__game.completeLevel({n})"); time.sleep(0.2)

        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        boot()

        # 1) A brand-new account is awarded NOTHING, and every helper is locked.
        print("FRESH inventory:", inv())
        assert inv() == {"undo": 0, "shuffle": 0, "wand": 0}, inv()
        for kind, level, _ in UNLOCKS:
            assert unlocked(kind) is False, f"{kind} must start locked"
            assert page.evaluate(f"window.__game.boosterUnlockLevel('{kind}')") == level, kind

        # 2) Clearing level 1 (the guided first level) pays out only what is
        #    scheduled for level 2 — every later helper is still out of reach.
        complete(1)
        after1 = {k: (g if lvl <= 2 else 0) for k, lvl, g in UNLOCKS}
        print("after level 1:", inv())
        assert inv() == after1, (inv(), after1)
        for kind, level, _ in UNLOCKS:
            assert unlocked(kind) is (level <= 2), f"{kind} after clearing level 1"

        # 3) Each helper unlocks at its own level and is granted its stock right
        #    then — and only that helper.
        expect = {"undo": 0, "shuffle": 0, "wand": 0}
        for kind, level, grant in UNLOCKS:
            complete(level - 1)   # "usable from level N" == "cleared level N-1"
            expect[kind] = grant
            print(f"after clearing level {level - 1} -> {kind} unlocked:",
                  unlocked(kind), "inventory:", inv())
            assert unlocked(kind) is True, f"{kind} unlocks at level {level}"
            assert inv() == expect, (f"clearing level {level - 1} grants only {kind}", inv(), expect)

        # 4) The grant is one-time: spend it, clear more levels, and it stays spent.
        # Every helper is unlocked but untaught by now, so a level entry would open
        # a coached first use over the board (boostercoach_test.py owns that); this
        # test is about the grants, so take the lesson as read.
        page.evaluate("window.__game.markBoosterCoached('all')")
        page.evaluate("window.__game.startLevel(5)")
        time.sleep(0.6)
        shuffle_grant = dict((k, g) for k, _, g in UNLOCKS)["shuffle"]
        for _ in range(shuffle_grant):               # spend the whole shuffle grant
            page.evaluate("window.__game.reshuffle()")
            time.sleep(0.4)
        assert page.evaluate("window.__game.boosterCount('shuffle')") == 0, \
            ("the reshuffle grant was spent", inv())
        complete(9)
        print("after clearing more levels:", inv())
        assert page.evaluate("window.__game.boosterCount('shuffle')") == 0, \
            ("an already-paid unlock must not pay out again", inv())

        # 5) It all persists across a reload — inventory AND the paid-out record.
        page.evaluate("window.__game.flushSave()")
        time.sleep(0.2)
        page.reload()
        boot()
        prof = page.evaluate("window.__game.user()")
        print("AFTER RELOAD -> boosters:", prof["boosters"], "unlocks:", prof["boosterUnlocks"])
        assert prof["boosters"]["shuffle"] == 0, prof["boosters"]
        assert sorted(prof["boosterUnlocks"]) == ["shuffle", "undo", "wand"], prof["boosterUnlocks"]
        complete(10)
        assert page.evaluate("window.__game.boosterCount('shuffle')") == 0, \
            "the paid-out record survives a reload, so no re-grant"

        # 6) Resetting the profile puts every helper back behind its gate.
        page.evaluate("window.__game.reset()")
        time.sleep(0.4)
        prof = page.evaluate("window.__game.user()")
        print("AFTER RESET -> boosters:", prof["boosters"], "unlocks:", prof["boosterUnlocks"])
        assert prof["boosters"] == {"undo": 0, "shuffle": 0, "wand": 0}, prof["boosters"]
        assert prof["boosterUnlocks"] == [], prof["boosterUnlocks"]
        assert prof["boosterCoach"] == [], ("reset clears the coaching record too",
                                            prof["boosterCoach"])
        assert not any(unlocked(k) for k, _, _ in UNLOCKS), "reset re-locks every helper"

        # 7) Migration: an existing (v4) save keeps the stock it was given up front
        #    and is NOT handed a second grant, while anything still locked is zeroed.
        page.evaluate("""() => {
            const uid = localStorage.getItem('tilemaster.uid');
            localStorage.setItem('tilemaster.user:' + uid, JSON.stringify({
                version: 4, id: uid, platform: 'web', name: '',
                progress: { level: 4, completed: 3 },
                wallet: { coins: 10, gems: 0 },
                boosters: { undo: 3, shuffle: 3, wand: 3 },
                settings: { music: true, sound: true },
            }));
        }""")
        page.reload()
        boot()
        prof = page.evaluate("window.__game.user()")
        print("MIGRATED v4 -> version:", prof["version"], "boosters:", prof["boosters"],
              "unlocks:", prof["boosterUnlocks"])
        assert prof["version"] == 6, prof["version"]
        # Cleared level 3 -> Undo (L2) and Wand (L3) are reached, Reshuffle (L5) is not.
        assert unlocked("undo") is True and unlocked("wand") is True, prof
        assert unlocked("shuffle") is False, prof
        assert prof["boosters"] == {"undo": 3, "shuffle": 0, "wand": 3}, \
            ("owned stock kept for reached helpers, zeroed for the locked one", prof["boosters"])
        assert sorted(prof["boosterUnlocks"]) == ["undo", "wand"], prof["boosterUnlocks"]
        # v5->v6 leaves the coaching record EMPTY on purpose: a save that was
        # already past these gates is still owed every lesson, or the coaching
        # would never reach an existing player at all.
        assert prof["boosterCoach"] == [], \
            ("a migrated save is owed every coached first use", prof["boosterCoach"])
        shuffle_grant = dict((k, g) for k, _, g in UNLOCKS)["shuffle"]
        complete(4)   # reaches level 5 -> the Reshuffle unlock is paid out now, once
        assert page.evaluate("window.__game.boosterCount('shuffle')") == shuffle_grant, inv()
        assert page.evaluate("window.__game.boosterCount('undo')") == 3, \
            ("an already-reached helper is not re-granted on a later win", inv())

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        assert not errors, "console errors during the booster-unlock flow"
        print("ALL BOOSTER-UNLOCK CHECKS PASSED")
        browser.close()
finally:
    srv.terminate()
