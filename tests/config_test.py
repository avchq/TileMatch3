import subprocess, time, sys, os, re, json
from playwright.sync_api import sync_playwright

# Every KEY PARAMETER of the game — feature gates, unlock schedules, progression
# thresholds and economy amounts — lives in ONE file, `src/config.js`, exposed to
# the debug API as `window.__game.config()`.
#
# This test is the guard on that arrangement. It checks three things:
#   1. the config ships the intended values (the table below mirrors config.js —
#      re-balancing the game means editing both, on purpose);
#   2. the LIVE game really behaves the way the config says (gates, grants,
#      starting inventory, tray capacity, win reward all read back from it), so
#      a value here is genuinely the single source of truth and not a copy that
#      drifted from a constant still buried in a module;
#   3. there is no SECOND source: the moved constants are gone from the modules
#      they used to live in, and the JSON prize tables no longer carry the gates.
#
# The expected values, mirroring src/config.js.
EXPECT = {
    "progression": {"tutorialLevel": 1, "autoComplete": {"minLevel": 2, "maxTiles": 12}},
    "features": {
        "shop": {"unlockLevel": 3},
        "fortuneWheel": {"unlockLevel": 5, "spinsPerCycle": 6, "headlinePrize": "lightning"},
        "dailyBonus": {"unlockLevel": 1},
        "tasks": {"unlockLevel": 10, "weeklyResetDay": 1},
    },
    "boosters": {
        "kinds": ["undo", "shuffle", "wand"],
        "startingInventory": {"undo": 0, "shuffle": 0, "wand": 0},
        "unlocks": {"undo": {"level": 2, "grant": 2},
                    "wand": {"level": 3, "grant": 2},
                    "shuffle": {"level": 5, "grant": 2}},
        "coach": {"enabled": True, "undoDelayMs": 250},
    },
    "economy": {"currencies": ["coins", "gems"],
                "startingWallet": {"coins": 0, "gems": 0},
                "coinWinReward": 25},
    "board": {"traySlots": 7},
    "persistence": {"saveDebounceMs": 400},
}

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

        def boot():
            page.wait_for_function("window.__game && window.__game.config", timeout=20000)
            time.sleep(0.6)

        def cfg():   return page.evaluate("window.__game.config()")
        def st():    return page.evaluate("window.__game.state()")
        def text(path): return page.evaluate(
            f"async () => (await fetch('{path}')).text()")

        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        boot()

        # ---- 1) the config is there, and ships the intended values -----------
        C = cfg()
        print("CONFIG SECTIONS ->", sorted(C.keys()))
        assert set(C.keys()) == set(EXPECT.keys()), (sorted(C.keys()), sorted(EXPECT.keys()))
        for section, want in EXPECT.items():
            assert C[section] == want, (section, C[section], want)

        # It is read-only: a stray assignment must not re-balance the game live.
        frozen = page.evaluate("""() => {
            const c = window.__game.config();
            try { c.features.shop.unlockLevel = 99; } catch (e) { return true; }
            return c.features.shop.unlockLevel !== 99;
        }""")
        assert frozen, "CONFIG must be frozen (deep) — it is read-only at runtime"

        # ---- 2) the live game reads those values ----------------------------
        # A brand-new player: wallet + helper inventory are exactly the config's
        # starting values, and every helper is locked behind its scheduled level.
        prof = page.evaluate("() => window.__game.store.user.toJSON()")
        print("NEW PROFILE ->", prof["wallet"], prof["boosters"])
        assert prof["wallet"] == C["economy"]["startingWallet"], prof["wallet"]
        assert prof["boosters"] == C["boosters"]["startingInventory"], prof["boosters"]
        for kind, u in C["boosters"]["unlocks"].items():
            lvl = page.evaluate(f"window.__game.boosterUnlockLevel('{kind}')")
            assert lvl == u["level"], (kind, lvl, u)
            assert page.evaluate(f"window.__game.boosterUnlocked('{kind}')") is False, kind

        # The shop's gate is the config's, not a constant of its own.
        s = page.evaluate("window.__game.shopState()")
        assert s["unlockLevel"] == C["features"]["shop"]["unlockLevel"], s

        # A brand-new player boots into the tutorial level, and that level (not
        # "is a new player") is what opens the How To Play popup.
        assert st()["level"] == C["progression"]["tutorialLevel"], st()
        assert page.evaluate("window.__game.tutorialState()")["visible"] is True
        page.evaluate("window.__game.closeTutorial()")
        time.sleep(0.4)

        # The tray really has `traySlots` slots laid out.
        slots = page.evaluate("window.__game.traySize()")["slotXs"]
        assert len(slots) == C["board"]["traySlots"], (len(slots), C["board"]["traySlots"])

        # Clearing enough levels pays out each helper's scheduled grant, exactly.
        page.evaluate("window.__game.completeLevel(5)")
        page.evaluate("window.__game.flushSave()")
        time.sleep(0.4)
        # Those helpers are now unlocked but never taught, so the next level would
        # open a coached first use and park the board (boostercoach_test.py owns
        # that). Mark it seen — this test is about the config, not the lesson.
        page.evaluate("window.__game.markBoosterCoached('all')")
        for kind, u in C["boosters"]["unlocks"].items():
            assert page.evaluate(f"window.__game.boosterUnlocked('{kind}')") is True, kind
            n = page.evaluate(f"window.__game.boosterCount('{kind}')")
            assert n == u["grant"], ("scheduled grant", kind, n, u["grant"])

        # The Fortune Wheel's gate + spin budget come from the config too.
        page.evaluate("window.__game.exitLevel()")
        time.sleep(0.5)
        wheel_lvl = C["features"]["fortuneWheel"]["unlockLevel"]
        page.evaluate(f"window.__game.setLevel({wheel_lvl - 1})")
        time.sleep(0.3)
        w = page.evaluate("window.__game.wheelState()")
        print("WHEEL BELOW GATE ->", w["unlocked"], w["buttonVisible"])
        assert w["unlocked"] is False and w["buttonVisible"] is False, w
        page.evaluate(f"window.__game.setLevel({wheel_lvl})")
        time.sleep(0.3)
        w = page.evaluate("window.__game.wheelState()")
        print("WHEEL AT GATE ->", w["unlocked"], w["spinsLeft"])
        assert w["unlocked"] is True, w
        assert w["spinsLeft"] == C["features"]["fortuneWheel"]["spinsPerCycle"], w

        # The Daily Bonus is gated the same way (shipped as 1 = from the start).
        d = page.evaluate("window.__game.dailyBonusState()")
        assert d["unlocked"] is (wheel_lvl >= C["features"]["dailyBonus"]["unlockLevel"]), d

        # Tasks reads its gate + weekly reset weekday from the config too. Its gate
        # follows the documented "cleared level N-1" convention (like the shop),
        # not the wheel's "reached level N" — so drive it with completeLevel.
        tasks_lvl = C["features"]["tasks"]["unlockLevel"]
        t = page.evaluate("window.__game.tasksState()")
        assert t["unlockLevel"] == tasks_lvl, t
        assert t["resetDay"] == C["features"]["tasks"]["weeklyResetDay"], t
        print("TASKS BELOW GATE ->", t["unlocked"], t["buttonVisible"])
        assert t["unlocked"] is False and t["buttonVisible"] is False, t
        page.evaluate(f"window.__game.completeLevel({tasks_lvl - 1})")
        time.sleep(0.3)
        t = page.evaluate("window.__game.tasksState()")
        print("TASKS AT GATE ->", t["unlocked"], t["buttonVisible"])
        assert t["unlocked"] is True and t["buttonVisible"] is True, t

        # Winning a level pays exactly `economy.coinWinReward`, and Auto Complete
        # is only ever offered inside the configured window.
        auto = C["progression"]["autoComplete"]
        page.evaluate("window.__game.credit('coins', 0)")
        before = page.evaluate("window.__game.balance('coins')")
        page.evaluate("async () => { await window.__game.startLevel(2); "
                      "window.__game.closeTutorial(); }")
        time.sleep(0.8)
        seen_auto = False
        for _ in range(400):
            a = page.evaluate("window.__game.autoState()")
            if a["available"]:
                seen_auto = True
                assert a["level"] >= auto["minLevel"], ("offered below minLevel", a)
                assert a["total"] <= auto["maxTiles"], ("offered above maxTiles", a)
                assert a["covered"] == 0, ("offered with covered tiles", a)
            if page.evaluate("window.__game.solveTap()") < 0:
                break
            time.sleep(0.02)
        page.wait_for_function("window.__game.state().boardCount === 0", timeout=15000)
        time.sleep(1.0)
        after = page.evaluate("window.__game.balance('coins')")
        print("WIN REWARD ->", before, "->", after)
        assert seen_auto, "the level-2 descent should pass through the Auto Complete window"
        assert after - before == C["economy"]["coinWinReward"], (before, after)
        page.screenshot(path=f"{OUT}/config_win.png")

        # ---- 3) no second source of truth -----------------------------------
        # The JSON prize tables hold prize DATA only; their gates moved to config.js.
        turntable = json.loads(text("assets/config/turntable.json"))
        daily_cfg = json.loads(text("assets/config/dailybonus.json"))
        for key in ("unlockLevel", "spinsPerCycle", "headlinePrize"):
            assert key not in turntable, ("turntable.json must not re-declare " + key)
        assert "unlockLevel" not in daily_cfg, "dailybonus.json must not re-declare unlockLevel"
        tasks_cfg = json.loads(text("assets/config/tasks.json"))
        for key in ("unlockLevel", "weeklyResetDay"):
            assert key not in tasks_cfg, ("tasks.json must not re-declare " + key)

        # …and the modules the constants came from must not re-declare them
        # either: a new tunable belongs in config.js, never inline in a module.
        FORBIDDEN = {
            "src/game.js": ["COIN_WIN_REWARD", "AUTO_MIN_LEVEL", "AUTO_MAX_TILES",
                            "TUTORIAL_LEVEL", "TRAY_SLOTS"],
            "src/user/User.js": ["BOOSTER_UNLOCKS", "SHOP_UNLOCK_LEVEL", "TASKS_UNLOCK_LEVEL"],
            "src/user/UserStore.js": ["SAVE_DEBOUNCE_MS"],
        }
        for path, names in FORBIDDEN.items():
            src = text(path)
            for name in names:
                m = re.search(r"^\s*(?:export\s+)?const\s+" + name + r"\s*=\s*(.+)$",
                              src, re.M)
                assert m, (path, name, "constant vanished — update this test")
                assert "CONFIG" in m.group(1), (
                    path, name, "must be derived from CONFIG (src/config.js), got: "
                    + m.group(1).strip())

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        assert not errors, "console errors during the config checks"
        print("ALL CONFIG CHECKS PASSED")
        browser.close()
finally:
    srv.terminate()
