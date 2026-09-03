import subprocess, time, sys, os, re, json
from playwright.sync_api import sync_playwright

import harness

# Every KEY PARAMETER of the game — feature gates, unlock schedules, progression
# thresholds and economy amounts — lives in ONE file, `src/config.js`, exposed to
# the debug API as `window.__game.config()`.
#
# This test is the guard on that arrangement. It checks three things:
#   1. the config ships the intended values (the table below mirrors config.js —
#      re-balancing the game means editing both, on purpose);
#   2. the LIVE game really behaves the way the config says (gates, grants,
#      starting inventory and tray capacity all read back from it), so
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
        "levelChest": {"repeatStart": 6},
    },
    "boosters": {
        "kinds": ["undo", "shuffle", "wand"],
        "startingInventory": {"undo": 0, "shuffle": 0, "wand": 0},
        "unlocks": {"undo": {"level": 2, "grant": 2},
                    "wand": {"level": 3, "grant": 2},
                    "shuffle": {"level": 5, "grant": 2}},
        "coach": {"enabled": True, "undoDelayMs": 250},
        # The Super Wand — the Wand's win-streak upgrade. unlockLevel is 10 rather
        # than the original's 20: only a genuinely NEW clear counts toward the
        # streak, and this port's campaign is 20 levels long, so a gate of 20 would
        # leave one qualifying win and the reward could never be earned at all.
        "superWand": {"unlockLevel": 10, "streakLength": 5,
                      "minTiles": 6, "extraRounds": 2},
    },
    "economy": {"currencies": ["coins", "gems"],
                "startingWallet": {"coins": 0, "gems": 0}},
    "board": {"traySlots": 7,
              "extraSlot": {"unlockLevel": 9, "grant": 1},
              "warnings": {"pulseAtFree": 2, "bubbleAtFree": 1}},
    "persistence": {"saveDebounceMs": 400},
    # Robustness bounds rather than gameplay tuning, but they are still knobs and
    # they still belong in one place: every fetch boot or a level load WAITS ON
    # goes through src/net.js and reads these. The rule they enforce is that a
    # request which never settles becomes a reportable failure instead of a
    # loading screen frozen at a percentage forever.
    "network": {"fetchTimeoutMs": 8000, "retryAttempts": 2, "retryBackoffMs": 400},
    # The two tunable parts of the localization. The 13 OFFERED codes are
    # deliberately NOT here — the spec has that list hard-coded in the program
    # (LANGUAGES in src/i18n.js), so adding a language stays three edits.
    "language": {"defaultLanguage": "en", "textDir": "assets/lang"},
}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errors = harness.launch(p, viewport=(750, 1334))

    OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
    os.makedirs(OUT, exist_ok=True)

    def boot():
        page.wait_for_function("window.__game && window.__game.config", timeout=60000)
        time.sleep(0.6)

    def cfg():   return page.evaluate("window.__game.config()")
    def st():    return page.evaluate("window.__game.state()")
    def text(path): return page.evaluate(
        f"async () => (await fetch('{path}')).text()")

    page.goto(f"{BASE}/index.html")
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

    # …because the 8th slot's own gate is still shut. Below it the extra cell
    # does not exist at all and the capacity is the configured base.
    xslot = C["board"]["extraSlot"]
    e = page.evaluate("window.__game.extraSlotState()")
    print("EXTRA SLOT BELOW GATE ->", e["unlocked"], e["drawn"], e["capacity"])
    assert e["unlockLevel"] == xslot["unlockLevel"], e
    assert e["unlocked"] is False and e["drawn"] is False, e
    assert e["capacity"] == C["board"]["traySlots"], e

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

    # The language layer reads its fallback and its folder from the config —
    # a brand-new player in an unrecognised locale lands on `defaultLanguage`
    # and the table really came from `textDir` (i18n_test.py owns the rest).
    lang = C["language"]
    assert page.evaluate("window.__game.mapTag('xx-YY')") is None
    assert page.evaluate("window.__game.detectLanguage()") == lang["defaultLanguage"]
    assert page.evaluate("window.__game.language()") == lang["defaultLanguage"]
    assert json.loads(text(f"{lang['textDir']}/{lang['defaultLanguage']}.json"))

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

    # Winning a level pays NO coins at all — the free faucets are the reward
    # features, not the clear itself — and Auto Complete is only ever offered
    # inside the configured window.
    auto = C["progression"]["autoComplete"]
    page.evaluate("window.__game.credit('coins', 0)")
    before = page.evaluate("window.__game.balance('coins')")
    page.evaluate("async () => { await window.__game.startLevel(2); "
                  "window.__game.closeTutorial(); }")
    time.sleep(0.8)

    # The Tasks gate above cleared level 9, which is past the 8th slot's gate
    # too — so the extra cell is now DRAWN (traySlots + grant cells) while the
    # capacity is still the base: the "+1" video is what raises it, and the
    # gate reads campaign progress, not the level 2 board on screen.
    e = page.evaluate("window.__game.extraSlotState()")
    t = page.evaluate("window.__game.traySize()")
    print("EXTRA SLOT AT GATE ->", e["unlocked"], e["drawn"], e["capacity"],
          "cells:", len(t["slotXs"]))
    assert e["unlocked"] is True and e["drawn"] is True, e
    assert e["capacity"] == C["board"]["traySlots"], ("still the base capacity", e)
    assert len(t["slotXs"]) == C["board"]["traySlots"] + xslot["grant"], t

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
    page.wait_for_function("window.__game.state().boardCount === 0", timeout=45000)
    time.sleep(1.0)
    after = page.evaluate("window.__game.balance('coins')")
    print("WIN REWARD ->", before, "->", after)
    assert seen_auto, "the level-2 descent should pass through the Auto Complete window"
    assert after == before, ("a level win credits no coins", before, after)
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
        "src/game.js": ["AUTO_MIN_LEVEL", "AUTO_MAX_TILES",
                        "TUTORIAL_LEVEL", "TRAY_SLOTS"],
        "src/user/User.js": ["BOOSTER_UNLOCKS", "SHOP_UNLOCK_LEVEL", "TASKS_UNLOCK_LEVEL",
                             "EXTRA_SLOT_UNLOCK_LEVEL"],
        "src/user/UserStore.js": ["SAVE_DEBOUNCE_MS"],
        # The language table's fetch bound. It reads CONFIG.network.fetchTimeoutMs
        # like src/net.js does, so every bounded fetch in the game agrees on what
        # "the connection is dead" means — but defensively, because i18n runs
        # before everything and must survive a stale cached config (see
        # boot_resilience_test.py guard 1).
        "src/i18n.js": ["LOAD_TIMEOUT_MS"],
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

    # src/net.js is the single place the network bounds are read, so it must
    # read them from CONFIG rather than carrying its own numbers as the truth.
    # (It keeps literal fallbacks for the stale-config case; the point is that
    # CONFIG wins whenever it is there.)
    net = text("src/net.js")
    assert "CONFIG.network" in net, "src/net.js must read its bounds from CONFIG.network"

    print("ERRORS:", len(errors))
    for e in errors[:10]:
        print("  ", e)
    assert not errors, "console errors during the config checks"
    print("ALL CONFIG CHECKS PASSED")
    browser.close()